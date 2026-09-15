// Cloud Function: the server-side half of the ToDo app's reminder push notifications.
//
// The app itself (index.html) is a static, backend-less page — it can save "notify at this
// date/time" settings to Firestore and it can register this device for FCM, but nothing running
// only in a browser tab can reliably wake up and send a push once the tab/PWA has been fully
// closed. That requires a server watching the clock and calling the FCM Admin SDK, which is what
// this function does: it runs on a schedule, finds any ToDo whose notification moment has just
// arrived, and sends exactly one push to every registered device.
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
//   4. In the Firebase Console → Firestore → Rules, make sure the `fcmTokens` and `sentReminders`
//      collections are at least as permissive as `todoAppData` already is (this app has no auth, so
//      those collections need open read/write from the client for token registration to work) —
//      e.g. add `match /fcmTokens/{token} { allow read, write: if true; }` and
//      `match /sentReminders/{id} { allow read, write: if true; }` alongside the existing rules.
//      (The function itself uses the Admin SDK, which always bypasses these rules — only the
//      client's own token-registration write needs the rule.)

const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

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

// Runs every minute; looks back 5 minutes so a single missed/slow run can't silently drop a
// reminder, while `sentReminders` tombstones (keyed by todoId+moment) stop it from ever being sent
// twice across runs.
exports.sendDueReminders = onSchedule(
  { schedule: 'every 1 minutes', region: 'asia-northeast1', timeZone: 'Asia/Tokyo' },
  async () => {
    const mainDoc = await db.collection('todoAppData').doc('main').get();
    if (!mainDoc.exists) return;
    const data = mainDoc.data() || {};
    const todos = Array.isArray(data.todos) ? data.todos : [];
    const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    const now = Date.now();
    const LOOKBACK_MS = 5 * 60 * 1000;

    const due = todos
      .filter((t) => t && !t.done)
      .map((t) => ({ todo: t, momentMs: computeNotifyMomentMs(t) }))
      .filter(({ momentMs }) => momentMs != null && momentMs <= now && momentMs > now - LOOKBACK_MS);

    if (!due.length) return;

    const tokensSnap = await db.collection('fcmTokens').get();
    const tokens = tokensSnap.docs.map((d) => d.id);
    if (!tokens.length) return;

    for (const { todo, momentMs } of due) {
      const sentRef = db.collection('sentReminders').doc(`${todo.id}_${momentMs}`);
      const sentDoc = await sentRef.get();
      if (sentDoc.exists) continue;

      const workspace = workspaces.find((w) => w && w.id === todo.workspaceId);
      const title = `【${workspace ? workspace.name : 'ToDo'}】${todo.title}の期限です`;
      const body = `${todo.date} が期日です`;

      const response = await admin.messaging().sendEachForMulticast({
        notification: { title, body },
        data: { tag: `todo-${todo.id}` },
        tokens
      });

      // Drop tokens FCM says are no longer valid (app uninstalled, permission revoked, etc.) so the
      // token list doesn't grow unbounded with dead entries.
      const invalidTokens = [];
      response.responses.forEach((r, i) => {
        const code = r.error && r.error.code;
        if (!r.success && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')) {
          invalidTokens.push(tokens[i]);
        }
      });
      await Promise.all(invalidTokens.map((tok) => db.collection('fcmTokens').doc(tok).delete()));

      await sentRef.set({ sentAt: now, title });
    }
  }
);
