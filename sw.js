/* Service worker de la app de terreno (T11 · PWA).
 *
 * Estrategias
 *  · Instalación  → precache del shell (movil.html + lib.js + movil.js + manifest + iconos)
 *  · Navegación   → primero red; sin red, la caché de esa URL; y si es la app
 *                   de terreno, el shell guardado (así abre aunque no haya señal)
 *  · Supabase     → primero red con caché de respaldo: offline se ve la última
 *                   carga; las ESCRITURAS no pasan por aquí (son POST/PATCH y la
 *                   app de terreno las encola en localStorage)
 *  · Resto (CDN y tiles) → stale-while-revalidate: sirve de caché y refresca
 *                   en segundo plano (fuentes, maplibre, tailwind,
 *                   supabase-js y el estilo/tiles del mapa)
 *
 * La caché está versionada: al subir una versión nueva, `activate` borra las
 * anteriores. `scripts/gen-icons.js` genera los iconos del manifest.
 */

const CACHE = 'terreno-v1';
const SHELL = './movil.html';

const PRECACHE = [
  './movil.html',
  './lib.js',
  './movil.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// Cualquiera de estos orígenes es estático: se sirve de caché y se refresca
// en segundo plano. Google Fonts llega en dos pasos (CSS → gstatic).
const ESTATICO = [
  'https://fonts.googleapis.com/',
  'https://fonts.gstatic.com/',
  'https://unpkg.com/',
  'https://cdn.jsdelivr.net/',
  'https://cdn.tailwindcss.com/',
  'https://tiles.openfreemap.org/',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (ev) => {
  if (ev.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return; // escrituras: siempre a la red (la cola local se encarga)
  ev.respondWith(responder(req));
});

// Los `<script>`/`<link>`/`<img>` pedidos sin `crossorigin` llegan como
// respuestas *opacas* (status 0, ok=false): también hay que guardarlas, o los
// CDN y los tiles nunca quedarían cacheados y no habría offline real.
function cacheable(resp) {
  return !!resp && (resp.ok || resp.type === 'opaque');
}

async function cachearYDevolver(req, resp) {
  if (cacheable(resp)) {
    const c = await caches.open(CACHE);
    // El llenado de la caché puede fallar (cuota); la respuesta no depende de eso.
    c.put(req, resp.clone()).catch(() => null);
  }
  return resp;
}

// Devuelve la respuesta (red o caché) o `undefined` si no hay ninguna.
async function primeroRed(req) {
  try {
    return await cachearYDevolver(req, await fetch(req));
  } catch (_) {
    return caches.match(req);
  }
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(CACHE);
  const guardado = await c.match(req);
  if (guardado) {
    // Refresco en segundo plano: si falla, seguimos con la copia vieja.
    fetch(req)
      .then((r) => (cacheable(r) ? c.put(req, r.clone()).catch(() => null) : null))
      .catch(() => null);
    return guardado;
  }
  try {
    return await cachearYDevolver(req, await fetch(req));
  } catch (_) {
    return undefined;
  }
}

async function shellMovil() {
  const c = await caches.open(CACHE);
  return (await c.match(SHELL))
    || (await c.match(new URL('movil.html', self.registration.scope)));
}

async function responder(req) {
  const url = new URL(req.url);

  // Navegación (F5, link, app instalada): primero red
  if (req.mode === 'navigate') {
    try {
      return await cachearYDevolver(req, await fetch(req));
    } catch (_) {
      const guardado = await caches.match(req);
      if (guardado) return guardado;
      // Solo la app de terreno tiene shell propio; el escritorio no debe
      // recibir movil.html en lugar de index.html.
      if (url.pathname.endsWith('/movil.html')) {
        const shell = await shellMovil();
        if (shell) return shell;
      }
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Sin conexión</title>' +
        '<body style="font:16px system-ui;padding:2rem;color:#0d1c2e">' +
        '<h1>Sin conexión</h1><p>No hay red y esta página no está guardada. ' +
        'Abre <b>Terreno</b> (movil.html), que sí funciona sin señal.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }
  }

  // Datos de Supabase: red con respaldo en caché
  if (url.hostname.endsWith('.supabase.co')) {
    const guardado = await primeroRed(req);
    if (guardado) return guardado;
    return new Response(
      JSON.stringify({ message: 'Sin conexión: se muestran los últimos datos cargados', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Estáticos locales o de CDN
  if (url.origin === self.location.origin || ESTATICO.some((p) => req.url.startsWith(p))) {
    const guardado = await staleWhileRevalidate(req);
    if (guardado) return guardado;
    return new Response('', { status: 503, statusText: 'Sin conexión' });
  }

  return fetch(req);
}
