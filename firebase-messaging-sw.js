// Single Service Worker for this app: handles Firebase Cloud Messaging background push delivery
// (onBackgroundMessage) and the tap-to-focus behavior for any notification it shows. This replaces
// the previous sw.js, which drove its own local setTimeout-based reminders — that mechanism could
// fire independently of (and duplicate) a real push, so it has been removed in favor of a single
// source of truth: a server-side Cloud Function sends one FCM push per due reminder, and this
// worker's only job is to display it.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// This worker runs independently of the page, so it needs its own copy of the Firebase config —
// it can't read the page's localStorage. Hardcoded to the app's built-in family database. If you
// ever switch to a different Firebase project via the app's sync settings, background push requires
// updating this file to match (there is no way to hand the worker a page-supplied config before the
// first push arrives).
firebase.initializeApp({
  apiKey: "AIzaSyA2Uaj4RfbAESV4WQE2qFmoRojnQYAzOHM",
  authDomain: "our-family-todo.firebaseapp.com",
  projectId: "our-family-todo",
  storageBucket: "our-family-todo.firebasestorage.app",
  messagingSenderId: "114118372482",
  appId: "1:114118372482:web:8dc97c5f889579587cd89b"
});

const messaging = firebase.messaging();

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Fires when a push arrives while no page/tab for this app is in the foreground (backgrounded or
// fully closed, as long as the OS/browser hasn't evicted this worker — see the README note in
// functions/index.js about this not being a 100% delivery guarantee). Web Audio API is not
// available inside a service worker, so a background push plays only the OS's default notification
// sound, not this app's custom alarm beep — the beep only plays for foreground messages (see
// messaging.onMessage in index.html).
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const notification = payload.notification || {};
  const title = notification.title || data.title || 'ToDo';
  const body = notification.body || data.body || '';
  const tag = data.tag || 'todo-fcm';
  self.registration.showNotification(title, { body, tag, renotify: true });
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
