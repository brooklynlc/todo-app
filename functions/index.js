// Cloud Function: the server-side half of the ToDo app's reminder push notifications.
//
// The app itself (index.html) is a static, backend-less page — it can save "notify at this
// date/time" settings to Firestore and it can register this device for FCM, but nothing running
// only in a browser tab can reliably wake up and send a push once the tab/PWA has been fully
// closed. That requires a server watching the clock and calling the FCM Admin SDK, which is what
// this function does: every minute it scans for a ToDo whose notification moment has just arrived
// and is not yet `notified`, sends it to every registered device, and marks it `notified: true`.
//
// ── Deployment (must be done by a project owner with the Firebase CLI — this code is not deployed
//    automatically just by being in this repo) ──
//   1. `npm install -g firebase-tools` (if not already installed), then `firebase login`.
//   2. From the todo-app directory: `firebase deploy --only functions`
//      (this reads firebase.json + this functions/ folder; if firebase.json / .firebaserc don't
//      exist yet, run `firebase init functions` first and point it at the existing project
//      "our-family-todo", choosing "use an existing project").
//   3. Requires the Blaze (pay-as-you-go) plan — Cloud Functions and Cloud Scheduler are not
//      available on the free Spark plan. Realistic cost for two devices checking once a minute is
//      well within the free tier's monthly quota, but Blaze must still be enabled to deploy at all.
//   4. In the Firebase Console → Firestore → Rules, make sure the `fcmTokens` collection is at
//      least as permissive as `todoAppData` already is (this app has no auth, so it needs open
//      read/write from the client for token registration to work) — e.g. add
//      `match /fcmTokens/{token} { allow read, write: if true; }` alongside the existing rules.
//      (This function itself uses the Admin SDK, which always bypasses these rules — only the
//      client's own token-registration write needs the rule. Writes to `todoAppData/main`, incl.
//      the `notified` flag this function sets, already work under whatever rule lets the app sync.)

const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const mainRef = db.collection('todoAppData').doc('main');

const NOTIFY_ADVANCE_MS = { onTime: 0, '1day': 86400000, '2day': 172800000, '1week': 604800000 };

// This app's "notifyDate"/"notifyTime" fields are picked by the user as Japan-local wall-clock
// time (the app's UI is Japanese and its users are in Japan). Cloud Functions run in UTC by
// default, so the date/time components are converted to a UTC epoch by explicitly treating them
// as JST (UTC+9, Japan has no DST) rather than relying on the server process's local timezone.
const JST_OFFSET_MS = 9 * 3600 * 1000;

function computeNotifyMomentMs(todo){
  if (!todo || !todo.notifyAdvance || todo.notifyAdvance === 'none') return null;
  const dateStr = todo.notifyDate || todo.date;
  if (!dateStr || typeof dateStr !== 'string') return null;
  const timeStr = (typeof todo.notifyTime === 'string' && todo.notifyTime) ? todo.notifyTime : '09:00';
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if (!y || !mo || !d) return null;
  const utcIfJstWereUtc = Date.UTC(y, mo - 1, d, h || 0, mi || 0, 0, 0);
  const jstMomentAsUtcMs = utcIfJstWereUtc - JST_OFFSET_MS;
  const offset = NOTIFY_ADVANCE_MS[todo.notifyAdvance] || 0;
  return jstMomentAsUtcMs - offset;
}

// Transactionally flips `notified` from falsy to true for one specific todo id and returns the
// freshly-read (post-claim) todo object, or null if it can't be claimed (already notified, marked
// done, or deleted since the outer scan ran). Doing this claim BEFORE sending — rather than sending
// first and marking after — means two overlapping function invocations (or a retry after a crash
// mid-send) can never both send the same reminder: only one of them will win the transactional
// write. Reading the document fresh inside the transaction (Firestore retries automatically on
// contention) also means this never clobbers a concurrent edit the client made to some other field
// on the same todo, or to a different todo in the same array — only the matched item's `notified`/
// `notifiedAt` fields are touched, and every other item is written back exactly as just read.
async function claimReminder(todoId){
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(mainRef);
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const todos = Array.isArray(data.todos) ? data.todos : [];
    const idx = todos.findIndex((t) => t && t.id === todoId);
    if (idx === -1) return null;
    const todo = todos[idx];
    if (todo.done || todo.notified) return null; // already handled, or claimed by a concurrent run
    // updatedAt must be bumped here too, not just notifiedAt: the client's own sync merge
    // (mergeTodoState in index.html) picks whichever copy of a todo has the LATER updatedAt, and
    // favors the local copy on a tie. If this claim left updatedAt unchanged, a client pushing its
    // own still-`notified:false` copy with that same old updatedAt shortly after would win the tie
    // and silently flip `notified` back to false — causing this function to send the same reminder
    // again on its next run.
    const now = Date.now();
    const claimed = Object.assign({}, todo, { notified: true, notifiedAt: now, updatedAt: now });
    const updatedTodos = todos.slice();
    updatedTodos[idx] = claimed;
    tx.update(mainRef, { todos: updatedTodos });
    return claimed;
  });
}

// Runs every minute: finds ToDos whose notification moment fell within the last 5 minutes (so one
// missed/slow run can't silently drop a reminder) and that aren't already `notified`, claims each
// one, then sends it to every registered device token with admin.messaging().send().
exports.sendDueReminders = onSchedule(
  { schedule: 'every 1 minutes', region: 'asia-northeast1', timeZone: 'Asia/Tokyo' },
  async () => {
    const mainDoc = await mainRef.get();
    if (!mainDoc.exists) return;
    const data = mainDoc.data() || {};
    const todos = Array.isArray(data.todos) ? data.todos : [];
    const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    const now = Date.now();
    const LOOKBACK_MS = 5 * 60 * 1000;

    const dueIds = todos
      .filter((t) => t && !t.done && !t.notified)
      .map((t) => ({ id: t.id, momentMs: computeNotifyMomentMs(t) }))
      .filter(({ momentMs }) => momentMs != null && momentMs <= now && momentMs > now - LOOKBACK_MS)
      .map(({ id }) => id);

    if (!dueIds.length) return;

    const claimedTodos = [];
    for (const id of dueIds) {
      const claimed = await claimReminder(id);
      if (claimed) claimedTodos.push(claimed);
    }
    if (!claimedTodos.length) return;

    const tokensSnap = await db.collection('fcmTokens').get();
    const tokens = tokensSnap.docs.map((d) => d.id);
    if (!tokens.length) {
      console.log('due reminders found but no fcmTokens registered:', claimedTodos.map((t) => t.title));
      return;
    }

    const invalidTokens = new Set();
    for (const todo of claimedTodos) {
      const workspace = workspaces.find((w) => w && w.id === todo.workspaceId);
      const title = `【${workspace ? workspace.name : 'ToDo'}】${todo.title}の期限です`;
      const body = `${todo.date} が期日です`;

      for (const token of tokens) {
        try {
          await admin.messaging().send({
            token,
            notification: { title, body },
            data: { tag: `todo-${todo.id}` }
          });
          console.log('sent reminder', todo.id, 'to token', token.slice(0, 12) + '…');
        } catch (err) {
          console.error('send failed for token', token.slice(0, 12) + '…', ':', err.code || err.message);
          if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
            invalidTokens.add(token);
          }
        }
      }
    }

    // Drop tokens FCM says are no longer valid (app uninstalled, permission revoked, etc.) so the
    // token list doesn't grow unbounded with dead entries.
    await Promise.all(Array.from(invalidTokens).map((tok) => db.collection('fcmTokens').doc(tok).delete()));
  }
);
