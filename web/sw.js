// @ts-nocheck — los tipos de un service worker chocan con los de la página (dom), así que este archivo no se revisa.
// Service worker: un programa chico que el navegador instala junto con la página. Se mete entre la página e
// internet, y guarda una copia de todo lo necesario para que ¿Tengo luz? abra aunque no haya señal
// (justo cuando se corta la luz suele caerse también el wifi).
//
// Estrategia:
// - Archivos de la página y datos: primero internet (siempre lo más nuevo). Si no hay red, o tarda más de
//   4 segundos, se usa la copia guardada.
// - Leaflet: primero la copia, porque esa dirección (con la versión) nunca cambia de contenido.
// - /api (reportes de vecinos) y el mapa de fondo: siempre en vivo, sin copia.

const VERSION = 'v3'; // cambiarla solo si cambia la lista PRECARGA: así se descarga de nuevo y se borra la vieja
const CACHE = `tengo-luz-${VERSION}`;
const PLAZO_MS = 4000;
const PRECARGA = [
  './',
  'estilos.css',
  'app.js',
  'estado.js',
  'iconos.js',
  'reclamo.js',
  'calendario.js',
  'dom.js',
  'tema.js',
  'fuentes/outfit-latin.woff2',
  'manifest.webmanifest',
  'icono-192.png',
  'data/barrios.geojson',
  'data/zonas.geojson',
  'data/mantenimientos.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECARGA)));
  self.skipWaiting(); // la versión nueva empieza a trabajar enseguida, sin esperar a que se cierren las pestañas
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(nombres.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (evento) => {
  const { request } = evento;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.origin === location.origin) evento.respondWith(primeroLaRed(evento));
  else if (url.hostname === 'unpkg.com') evento.respondWith(primeroLaCopia(request));
  // Todo lo demás (mapa de fondo de OpenStreetMap) lo maneja el navegador como siempre.
});

/** @param {FetchEvent} evento */
async function primeroLaRed(evento) {
  const { request } = evento;
  const cache = await caches.open(CACHE);
  const desdeLaRed = fetch(request).then((respuesta) => {
    if (respuesta.ok) cache.put(request, respuesta.clone());
    return respuesta;
  });
  evento.waitUntil(desdeLaRed.catch(() => {})); // que termine de guardar la copia aunque ya hayamos respondido
  const plazo = new Promise((resolver) => setTimeout(resolver, PLAZO_MS));
  try {
    const respuesta = await Promise.race([desdeLaRed, plazo]);
    if (respuesta) return respuesta;
  } catch {
    // Sin conexión: vamos a la copia.
  }
  const copia = (await cache.match(request, { ignoreSearch: true })) ?? (request.mode === 'navigate' ? await cache.match('./') : undefined);
  return copia ?? desdeLaRed; // sin copia, no queda otra que esperar a la red
}

/** @param {Request} request */
async function primeroLaCopia(request) {
  const cache = await caches.open(CACHE);
  const copia = await cache.match(request);
  if (copia) return copia;
  const respuesta = await fetch(request);
  if (respuesta.ok) cache.put(request, respuesta.clone());
  return respuesta;
}
