// Minimal service worker: enables Notification API's showNotification() to be called
// via the service worker registration, and focuses/opens the app when a notification is tapped.
// No caching/offline logic is implemented — this app relies on network fetches for Firebase sync.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

// Best-effort background reminders: the page sends the list of upcoming, not-yet-fired
// notifications whenever it goes to the background (see scheduleServiceWorkerNotifications()
// in index.html), and this worker holds a setTimeout per item so it can call showNotification()
// on its own even if the page's own JS timers get throttled/suspended while backgrounded.
//
// Important limitation: a service worker itself can be terminated by the browser/OS at any point
// while idle (this is especially aggressive on iOS Safari), so this is NOT equivalent to a real
// push notification and cannot guarantee delivery once the app has been fully closed/swiped away
// for an extended period. True "closed app" delivery would require server-side push (APNs/FCM)
// with a backend, which this static, backend-less app does not have.
const scheduledTimers = new Map(); // id -> timeoutId

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'schedule-notifications' && Array.isArray(msg.items)) {
    msg.items.forEach((item) => {
      if (!item || !item.id) return;
      const existing = scheduledTimers.get(item.id);
      if (existing) clearTimeout(existing);
      const delay = Math.max(0, item.delayMs || 0);
      const timerId = setTimeout(() => {
        scheduledTimers.delete(item.id);
        self.registration.showNotification(item.title, {
          body: item.body,
          tag: item.tag,
          renotify: true
        });
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
          clientList.forEach((client) => client.postMessage({ type: 'sw-notified', id: item.id, momentMs: item.momentMs }));
        });
      }, delay);
      scheduledTimers.set(item.id, timerId);
    });
  } else if (msg.type === 'cancel-notifications' && Array.isArray(msg.ids)) {
    msg.ids.forEach((id) => {
      const existing = scheduledTimers.get(id);
      if (existing) { clearTimeout(existing); scheduledTimers.delete(id); }
    });
  }
});
