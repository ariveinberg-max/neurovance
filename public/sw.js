// Minimal service worker — exists only so Chrome/Edge treat the app as
// installable. No offline caching: everything here talks to live APIs
// (chat, memory, companion), so caching responses would just serve stale
// data. This just passes every request straight through to the network.
self.addEventListener('fetch', () => {});
