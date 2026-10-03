// Staff and admin panels and their login (spec §19 Phase 9, docs/DECISIONS.md
// P9-6): when the network is gone, a page load shows a small offline page
// instead of the browser's error, and retries. Nothing is cached: signed-in
// pages stay fresh. It follows the device's dark setting (it can't read the
// theme cookie).
const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<meta name="color-scheme" content="light dark">
<title>You&rsquo;re offline</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font-family: system-ui, sans-serif; background: #faf8f5; color: #1c1917; }
  main { max-width: 28rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; }
  p { margin: 0 0 16px; line-height: 1.5; }
  a { display: inline-block; padding: 12px 20px; border-radius: 8px; background: #ff6606;
    color: #1c1917; text-decoration: none; font-weight: 600; }
  @media (prefers-color-scheme: dark) { body { background: #121110; color: #f5f2ee; } }
</style>
</head>
<body>
<main>
  <h1>You&rsquo;re offline</h1>
  <p>This page needs a connection. It tries again every 15 seconds.</p>
  <a href="">Try again</a>
</main>
</body>
</html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const path = new URL(request.url).pathname;
  if (request.mode !== 'navigate' || !/^\/(login|staff|admin)(\/|$)/.test(path)) return;
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    ),
  );
});
