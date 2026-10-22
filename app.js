// ============================================================
// CONFIG — EDITA AQUÍ
// ============================================================
const SUPABASE_URL = 'https://yfdkyccmaseztypccoww.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_jmltUeff0VTuLXf2KrujcA_zktLmoSS';

// Vista inicial sin selección: Plaza de Armas (Santiago centro)
const SANTIAGO_CENTER = [-70.6506, -33.4410];
const SANTIAGO_ZOOM = 13;

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

// ============================================================
// CLIENTE SUPABASE
// ============================================================
const { createClient } = supabase;
// Cada app (escritorio / móvil) usa su propia clave de sesión: así pueden
// coexistir dos pestañas con usuarios distintos sin pisarse. Se usa el lock
// por defecto de supabase-js (navigator.locks), que serializa el refresh del
// token entre pestañas de la MISMA app (los refresh tokens son de un solo uso).
//
// OJO: no pasar la opción `accessToken` a createClient. Deja el cliente en
// modo "auth externa" y entonces `db.auth.signInWithPassword` (y el resto de
// los métodos de auth) lanzan. Aquí la sesión la gestiona supabase-js: el
// arranque espera `getSession()` antes de consultar, así que las peticiones
// salen con el token vigente sin necesidad de inyectarlo por petición.
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'gps-desktop-session',
  },
});

// ============================================================
// ESTADO GLOBAL
// ============================================================
let map = null;
let currentUser = null;
let isAdmin = false;
let allPoints = [];
let allComunas = [];
let comunaFeatures = null;
let pointMarkers = {};       // id -> Marker
let puntosScope = 'comuna';  // marcadores del mapa: region | comuna | territorio
try {
  const s = localStorage.getItem('puntosScope');
  if (s === 'region' || s === 'comuna' || s === 'territorio') puntosScope = s;
} catch (_) {}
let usuarios = [];           // [{id, email}] para asignar
let asignaciones = {};       // territorio_id -> { user_id, estado, devuelta_at }
let assignMode = null;        // toggle de la card de gestión: null | 'asignar' | 'reset'

// Preferencias que sobreviven entre sesiones (filtros). Nunca lanzan: en modo
// privado o con la cuota llena localStorage falla y eso no debe romper la app.
function prefGet(clave, defecto = '') {
  try {
    const v = localStorage.getItem(clave);
    return v === null ? defecto : v;
  } catch (_) { return defecto; }
}
function prefSet(clave, valor) {
  try { localStorage.setItem(clave, valor == null ? '' : String(valor)); } catch (_) {}
}

// Chip de estado activo en la lista (persistido; valor inválido = "Todos")
const CHIP_ESTADOS = ['', ...ESTADOS.map((e) => e[0])];
let estadoFiltro = CHIP_ESTADOS.includes(prefGet('estadoFiltro')) ? prefGet('estadoFiltro') : '';
let lastEstadoUndo = null;   // {id, prev} para el toast "Deshacer"
let currentView = 'territorios'; // vista activa: territorios | historial | usuarios
let histTab = 'territorios';     // pestaña del historial: territorios | puntos

let tempMarker = null;       // marker temporal al hacer clic
let refMarker = null;        // marker de referencia
let refRadiusTimer = null;   // debounce al cambiar el radio
let refMode = false;         // modo referencia activo
let editingId = null;        // id del punto que se edita
let refResultsIds = new Set();

// --- Territorios (dibujo manual) ---
let allTerritorios = [];        // territorios cargados de la DB
let drawActive = false;      // ¿modo dibujo activo?
let drawColor = '#3b82f6';   // color del territorio en curso
let drawVerts = [];          // vértices [[lng,lat], ...]
let drawHover = null;        // última posición del cursor (goma elástica)
let drawSnap = null;         // { a, b } arista de referencia con la que se enganchó
let snapRingsCache = null;   // anillos de referencia para el snap (comuna + territorios)
let pendingTerritorio = null;    // polígono cerrado esperando guardado
let territorioHoverId = null;    // territorio bajo el cursor
let territorioSelectedId = null; // territorio seleccionado (habilita marcar puntos)
let lastPlaceAt = 0;         // debounce: evita colocar dos veces en un doble clic
let territorioListError = null;  // mensaje de error al cargar (tabla ausente, etc.)

// --- Configuración (app_config) ---
let comunasActivas = null;   // Set de comunas activas; null = todas
let configError = null;      // error al cargar app_config (tabla ausente, etc.)
let setSaveTimer = null;     // debounce del guardado en app_config

const TERRITORIO_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#14b8a6', '#64748b',
];

// ============================================================
// TOAST
// ============================================================
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastIcon').textContent = isError ? 'error' : 'check_circle';
  t.className = 'visible' + (isError ? ' error' : '');
  setTimeout(() => (t.className = ''), 2600);
}

// Errores sin catch (red caída, WebGL, CDN) se muestran en pantalla:
// sin esto, un fallo en el arranque deja la app "en nada" y la consola
// puede quedar difícil de interpretar.
window.addEventListener('error', (e) => {
  if (e?.message) toast('Error: ' + e.message, true);
});
window.addEventListener('unhandledrejection', (e) => {
  const m = e?.reason?.message || (typeof e?.reason === 'string' ? e.reason : '');
  if (m) toast('Error: ' + m, true);
});

// ============================================================
// LOGIN
// ============================================================
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPass').value;
  const err   = document.getElementById('loginError');
  err.textContent = '';

  const { data, error } = await db.auth.signInWithPassword({ email, password: pass });
  if (error) { err.textContent = error.message; return; }
  await startApp(data.user);
}

// Inicializa la app UNA sola vez (login manual, sesión persistida o
// sesión abierta en otra pestaña): evita crear el mapa dos veces.
async function startApp(user) {
  if (currentUser) return;
  currentUser = user;
  await afterLogin();
}

async function afterLogin() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('appView').style.display = 'flex';
  document.getElementById('userInfo').textContent = currentUser.email;

  // ¿Es admin?
  const { data: prof } = await db
    .from('profiles')
    .select('is_admin')
    .eq('id', currentUser.id)
    .maybeSingle();
  isAdmin = !!prof?.is_admin;

  // T2: dibujar/editar/asignar territorios es solo administración (también lo
  // exige la DB): el botón de dibujar ni siquiera se muestra a los demás
  if (!isAdmin) document.getElementById('drawBtn').style.display = 'none';

  // Historial, Usuarios y Nueva actividad son solo de administración
  if (!isAdmin) {
    document
      .querySelectorAll('#mainNav button[data-view="historial"], #mainNav button[data-view="usuarios"], #mainNav button[data-view="actividad"]')
      .forEach((b) => { b.style.display = 'none'; });
  }

  // T8: en pantallas angostas el panel arranca colapsado (ver CSS responsive)
  applyInitialSidebarState();

  // Descarga la config y las comunas ANTES de crear el mapa, para poder
  // encuadrar la cámara en Santiago sin tener que moverla después.
  await loadConfig();
  await loadComunas();
  try {
    initMap();
  } catch (e) {
    console.error(e);
    toast('No se pudo iniciar el mapa: ' + e.message, true);
  }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await db.auth.signOut();
  location.reload();
});

// T4: si la sesión caduca o se revoca (otra pestaña, refresh fallido),
// volvemos al login en vez de dejar la UI operando con un cliente inválido.
// Con la opción accessToken el cliente principal NO permite onAuthStateChange
// (lanza en supabase-js ≥ 2.83): se usa un cliente de eventos ligero con el
// MISMO storageKey, que ve la misma sesión sin refrescar tokens él mismo.
const authEventos = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: false,
    storageKey: 'gps-desktop-session',
  },
});
authEventos.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    if (document.getElementById('appView').style.display === 'flex') location.reload();
    return;
  }
  if (event === 'SIGNED_IN' && session?.user) startApp(session.user);
});

// ============================================================
// VISTA SATÉLITE (toggle)
// ============================================================
// Foto de Esri encima del mapa base y debajo de todo lo nuestro: se inserta
// antes de la primera capa `symbol` del estilo, así los rótulos de calles
// siguen legibles sobre la foto y el polígono del territorio, los pines y el
// punto azul (capas añadidas después en el stack) quedan encima.
// Sin persistencia: al (re)crear el mapa se arranca en claro.
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTR = 'Esri, Maxar, Earthstar Geographics';
let sateliteActiva = false;

// Dónde insertar la foto: antes del primer rótulo del estilo base. Si el
// estilo no tuviera símbolos, justo encima del background (capa 0).
function antesDeLosRotulos() {
  const capas = map && map.getStyle() ? (map.getStyle().layers || []) : [];
  const i = capas.findIndex((l) => l.type === 'symbol');
  if (i >= 0) return capas[i].id;
  return capas.length > 1 ? capas[1].id : undefined;
}

function alternarSatelite() {
  if (!map) return;
  const btn = document.getElementById('btnSatelite');

  if (sateliteActiva) {
    if (map.getLayer('satelite')) map.removeLayer('satelite');
    if (map.getSource('satelite')) map.removeSource('satelite');
    sateliteActiva = false;
  } else {
    if (!map.getSource('satelite')) {
      map.addSource('satelite', {
        type: 'raster',
        tiles: [ESRI_IMAGERY],
        tileSize: 256,
        maxzoom: 19,   // más allá de z19 MapLibre hace overzoom solo
        attribution: ESRI_ATTR,
      });
    }
    if (!map.getLayer('satelite')) {
      map.addLayer({ id: 'satelite', type: 'raster', source: 'satelite' }, antesDeLosRotulos());
    }
    sateliteActiva = true;
  }
  if (btn) btn.classList.toggle('active', sateliteActiva);
}

// ============================================================
// MAPA
// ============================================================
function initMap() {
  const gl = document.createElement('canvas').getContext('webgl2')
    || document.createElement('canvas').getContext('webgl');
  if (!gl) throw new Error('WebGL no está disponible (activa la aceleración de hardware del navegador)');

  // Sin comuna ni territorio seleccionado el mapa arranca en Plaza de Armas:
  // evita cargar tiles de la comuna completa y abre más rápido. Si hay
  // selección guardada, onComunaChange()/setTerritorio la re-encuadra después.
  const options = { container: 'map', style: MAP_STYLE, center: SANTIAGO_CENTER, zoom: SANTIAGO_ZOOM };

  map = new maplibregl.Map(options);
  map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  // El satélite no persiste: cada mapa nuevo arranca en claro (también al
  // salir de sesión, que recarga la página).
  sateliteActiva = false;
  document.getElementById('btnSatelite').classList.remove('active');

  // Controles flotantes (reemplazan la NavigationControl nativa)
  document.getElementById('zoomInBtn').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoomOutBtn').addEventListener('click', () => map.zoomOut());
  document.getElementById('locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Geolocalización no disponible', true);
    toast('Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition(
      (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 15) }),
      () => toast('No se pudo obtener tu ubicación', true),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
  document.getElementById('fitViewBtn').addEventListener('click', () => {
    if (territorioSelectedId) return focusTerritorio(territorioSelectedId);
    const comuna = allComunas.find((c) => c.nombre === comunaSel.value);
    const b = comuna ? boundsFromGeometry(comuna.geom) : null;
    if (b && !b.isEmpty()) {
      map.fitBounds([[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]], { padding: 40 });
    } else {
      toast('Selecciona una comuna o territorio para ajustar la vista', true);
    }
  });
  document.getElementById('btnSatelite').addEventListener('click', alternarSatelite);

  map.on('load', async () => {
    // Se captura ANTES de onComunaChange(), que limpia la selección al
    // reconstruir el filtro de comuna.
    const terrGuardado = prefGet('territorioSel');

    await ensureComunasLoaded();
    await loadUsuarios();
    await loadAsignaciones();
    await loadPoints();
    initTerritorioLayers();
    await loadTerritorios();

    // Reaplica el filtro de comuna guardado (encuadre + capas + lista)
    if (comunaSel.value) onComunaChange();

    // Y deja seleccionado el territorio con el que se cerró la sesión
    const terr = allTerritorios.find((s) => s.id === terrGuardado);
    if (terr && terr.comuna && terr.comuna === comunaSel.value) setTerritorioSelected(terr.id);

    map.on('click', onMapClick);
    map.on('mousemove', onMapMove);
    map.on('dblclick', onMapDblClick);

    // Los grupos de marcadores se calculan en píxeles: al cambiar de zoom o
    // desplazar el mapa dejan de ser válidos y hay que volver a agrupar.
    // Solo si la pintura anterior agrupó, para no repintar de más.
    map.on('moveend', () => { if (clusterActivo) renderMarkers(); });
  });
}

// ============================================================
// COMUNAS RM
// ============================================================
async function loadComunas() {
  const { data, error } = await db.from('comunas_rm').select('*');
  if (error) { console.error(error); toast('Error cargando comunas', true); return; }

  allComunas = data.map((c) => ({ nombre: c.nombre, geom: c.geom }));
  snapRingsCache = null;
  populateComunaFilter();
  populateHistComunaFilter(); // el filtro del Historial no depende de "activas"

  // Construir FeatureCollection
  comunaFeatures = data.map((c) => ({
    type: 'Feature',
    properties: { nombre: c.nombre, codigo: c.codigo_comuna },
    geometry: c.geom, // PostGIS devuelve GeoJSON en la columna geom
  }));
}

// Dibuja la fuente/capas de comunas solo cuando ya existe el mapa
async function ensureComunasLoaded() {
  if (!comunaFeatures) await loadComunas();
  drawComunas();
}

function drawComunas() {
  if (!comunaFeatures || map.getLayer('comunas-fill')) return;

  map.addSource('comunas', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: comunaFeatures },
  });

  map.addLayer({
    id: 'comunas-fill',
    type: 'fill',
    source: 'comunas',
    paint: {
      'fill-color': '#3b82f6',
      'fill-opacity': 0.06,
    },
  });

  map.addLayer({
    id: 'comunas-outline',
    type: 'line',
    source: 'comunas',
    paint: {
      'line-color': '#1e40af',
      'line-width': 1,
      'line-opacity': 0.7,
    },
  });

  map.addLayer({
    id: 'comunas-labels',
    type: 'symbol',
    source: 'comunas',
    layout: {
      'text-field': ['get', 'nombre'],
      // text-font obligatorio: la pila por defecto (Open Sans) devuelve 404
      // en OpenFreeMap y eso deja TODOS los tiles de la fuente en "errored",
      // destruyendo también los polígonos de fill y outline.
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#1e3a8a',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
    },
  });
}

// ============================================================
// COMUNAS: SELECTOR, POLÍGONO Y VISTA
// ============================================================
const comunaSel = document.getElementById('comunaSel');
comunaSel.addEventListener('change', onComunaChange);

function populateComunaFilter() {
  // Arranca con la comuna guardada en la sesión anterior si sigue disponible
  const prev = comunaSel.value || prefGet('comunaSel');
  const names = allComunas
    .map((c) => c.nombre)
    .filter(Boolean)
    .filter(comunaActiva)
    .sort((a, b) => a.localeCompare(b, 'es'));
  comunaSel.innerHTML =
    '<option value="">Todas las comunas</option>' +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  // Conserva la selección si sigue activa; si fue desactivada, vuelve a ""
  comunaSel.value = names.includes(prev) ? prev : '';
  syncDrawBtn();
}

// El botón de dibujar vive en el riel del mapa y aparece solo con comuna elegida
function syncDrawBtn() {
  const b = document.getElementById('drawBtn');
  if (b) b.style.display = (isAdmin && comunaSel.value) ? '' : 'none';
}

function onComunaChange() {
  const nombre = comunaSel.value;
  prefSet('comunaSel', nombre);
  const comuna = allComunas.find((c) => c.nombre === nombre);
  const hayCapas = map && map.getLayer('comunas-fill');
  snapRingsCache = null;
  syncDrawBtn();

  if (hayCapas) {
    for (const layerId of ['comunas-fill', 'comunas-outline', 'comunas-labels']) {
      if (map.getLayer(layerId)) {
        map.setFilter(layerId, comuna ? ['==', ['get', 'nombre'], nombre] : null);
      }
    }

    if (comuna) {
      map.setPaintProperty('comunas-fill', 'fill-opacity', 0.18);
      map.setPaintProperty('comunas-outline', 'line-color', '#1d4ed8');
      map.setPaintProperty('comunas-outline', 'line-width', 3);
      map.setPaintProperty('comunas-outline', 'line-opacity', 1);
    } else {
      map.setPaintProperty('comunas-fill', 'fill-opacity', 0.06);
      map.setPaintProperty('comunas-outline', 'line-color', '#1e40af');
      map.setPaintProperty('comunas-outline', 'line-width', 1);
      map.setPaintProperty('comunas-outline', 'line-opacity', 0.7);
    }
  }

  renderList();
  renderMarkers();

  // Un territorio dibujado queda huérfano si cambias de comuna a mitad de trazo
  if (drawActive) stopDraw();
  // La selección no sobrevive al cambio de comuna
  if (territorioSelectedId) setTerritorioSelected(null);
  updateTerritoriosSource();
  renderTerritorioList();

  if (comuna) {
    const b = boundsFromGeometry(comuna.geom);
    if (b && !b.isEmpty()) {
      map.fitBounds(b, { padding: 60, duration: 1200 });
      return;
    }
    toast('No pude calcular los límites de la comuna', true);
  } else {
    fitSantiago(1200);
  }
}

function fitSantiago(duration = 0) {
  const santiago = allComunas.find((c) => c.nombre === 'Santiago');
  const b = santiago ? boundsFromGeometry(santiago.geom) : null;
  if (b && !b.isEmpty()) {
    map.fitBounds(b, { padding: 40, duration });
  } else {
    map.jumpTo({ center: SANTIAGO_CENTER, zoom: SANTIAGO_ZOOM });
  }
}

function boundsFromGeometry(geom) {
  if (!geom || !geom.coordinates) return null;
  const bounds = new maplibregl.LngLatBounds();
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      bounds.extend([coords[0], coords[1]]);
      return;
    }
    coords.forEach(walk);
  };
  walk(geom.coordinates);
  return bounds;
}


// Territorios visibles: solo existen si hay comuna elegida y el punto está dentro
function displayedPoints() {
  const nombre = comunaSel.value;
  if (!nombre) return [];
  const comuna = allComunas.find((c) => c.nombre === nombre);
  if (!comuna) return [];
  return allPoints.filter(
    (p) => p.lat != null && p.lng != null && pointInGeometry(p.lng, p.lat, comuna.geom)
  );
}

// ============================================================
// CONFIGURACIÓN (app_config: comunas activas, compartida)
// ============================================================
async function loadConfig() {
  const { data, error } = await db
    .from('app_config')
    .select('value')
    .eq('key', 'comunas_activas')
    .maybeSingle();

  if (error) {
    console.error('app_config:', error);
    const missing =
      error.code === '42P01' ||
      error.code === 'PGRST205' ||
      /does not exist|could not find the table/i.test(error.message || '');
    configError = missing
      ? 'Falta la tabla: ejecuta la sección 7 de schema.sql en Supabase'
      : 'Error cargando la configuración: ' + error.message;
    comunasActivas = null;
    return;
  }

  configError = null;
  const arr = data?.value;
  comunasActivas = Array.isArray(arr) && arr.length ? new Set(arr) : null;
}

// ¿La comuna está activa? (sin config = todas)
function comunaActiva(nombre) {
  return !comunasActivas || comunasActivas.has(nombre);
}

function todasLasComunas() {
  return allComunas.map((c) => c.nombre).filter(Boolean);
}

function comunasSeleccionadas() {
  const names = todasLasComunas();
  return comunasActivas ? names.filter((n) => comunasActivas.has(n)) : names;
}

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const setComunaFilter = document.getElementById('setComunaFilter');

settingsBtn.addEventListener('click', () => {
  setComunaFilter.value = '';
  document.getElementById('setErr').textContent = configError || '';
  document.querySelectorAll('#settingsModal input[name="mapScope"]').forEach((r) => {
    r.checked = r.value === puntosScope;
  });
  renderSettingsList();
  settingsModal.classList.add('visible');
});

document.getElementById('setCloseBtn').addEventListener('click', () => {
  settingsModal.classList.remove('visible');
});

setComunaFilter.addEventListener('input', renderSettingsList);
document.getElementById('setAllBtn').addEventListener('click', () => {
  if (!isAdmin) return toast('Solo administradores pueden cambiar la configuración', true);
  const prev = comunaSel.value;
  comunasActivas = null; // null = todas
  populateComunaFilter();
  if (prev !== comunaSel.value) onComunaChange();
  renderSettingsList();
  persistirConfig();
});

// Preferencia local: qué puntos se muestran en el mapa.
// Se controla desde el segmented del panel y desde Ajustes (mantenidos en espejo).
function syncScopeUI() {
  document.querySelectorAll('#scopeSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.scope === puntosScope);
  });
  document.querySelectorAll('#settingsModal input[name="mapScope"]').forEach((r) => {
    r.checked = r.value === puntosScope;
  });
}
function setPuntosScope(v) {
  if (v !== 'region' && v !== 'comuna' && v !== 'territorio') return;
  puntosScope = v;
  try { localStorage.setItem('puntosScope', puntosScope); } catch (_) {}
  syncScopeUI();
  renderMarkers();
}
document.querySelectorAll('#scopeSeg button').forEach((b) => {
  b.addEventListener('click', () => setPuntosScope(b.dataset.scope));
});
document.querySelectorAll('#settingsModal input[name="mapScope"]').forEach((r) => {
  r.addEventListener('change', () => { if (r.checked) setPuntosScope(r.value); });
});
syncScopeUI();

function renderSettingsList() {
  const box = document.getElementById('setComunaList');
  const txt = setComunaFilter.value.toLowerCase().trim();
  const names = todasLasComunas().sort((a, b) => a.localeCompare(b, 'es'));
  const shown = names.filter((n) => !txt || n.toLowerCase().includes(txt));

  box.innerHTML = shown.length
    ? shown
        .map(
          (n) => `
      <label class="set-item${comunaActiva(n) ? '' : ' off'}">
        <input type="checkbox" data-nombre="${escapeHtml(n)}" ${comunaActiva(n) ? 'checked' : ''} />
        <span>${escapeHtml(n)}</span>
      </label>`
        )
        .join('')
    : '<div class="set-empty">Sin coincidencias</div>';

  document.getElementById('comunaCount').textContent =
    `${comunasSeleccionadas().length} de ${names.length}`;

  box.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', onToggleComuna);
  });
}

function onToggleComuna(e) {
  if (!isAdmin) {
    e.target.checked = !e.target.checked;
    return toast('Solo administradores pueden cambiar la configuración', true);
  }

  const nombre = e.target.dataset.nombre;
  const names = todasLasComunas();
  const activas = comunasActivas ? new Set(comunasActivas) : new Set(names);

  if (e.target.checked) activas.add(nombre);
  else activas.delete(nombre);

  if (activas.size === 0) {
    e.target.checked = true;
    return toast('Debe quedar al menos una comuna activa', true);
  }

  const perdida = comunaSel.value && !activas.has(comunaSel.value);
  comunasActivas = activas.size === names.length ? null : activas;

  e.target.closest('.set-item').classList.toggle('off', !e.target.checked);
  document.getElementById('comunaCount').textContent =
    `${comunasSeleccionadas().length} de ${names.length}`;

  populateComunaFilter(); // el <select> se actualiza al instante
  if (perdida) onComunaChange(); // la comuna elegida ya no existe → resetear vista
  persistirConfig();
}

// Guardado con debounce (varios clics seguidos = una sola escritura)
function persistirConfig() {
  if (configError) return; // tabla ausente: el aviso ya se ve en el modal
  clearTimeout(setSaveTimer);
  setSaveTimer = setTimeout(async () => {
    const value = comunasActivas ? [...comunasActivas] : null;
    const { error } = await db.from('app_config').upsert(
      {
        key: 'comunas_activas',
        value,
        updated_by: currentUser ? currentUser.id : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );
    if (error) toast('No se pudo guardar la configuración: ' + error.message, true);
  }, 400);
}

// ============================================================
// CARGAR PUNTOS
// ============================================================
async function loadPoints() {
  const { data, error } = await db
    .from('puntos')
    .select('*')
    .is('deleted_at', null);

  if (error) { console.error(error); toast('Error cargando puntos', true); return; }

  // PostGIS devuelve geom como EWKB hex (o GeoJSON); extraemos lat/lng
  allPoints = data.map((p) => {
    const c = pointFromGeom(p.geom);
    return { ...p, lat: c ? c.lat : null, lng: c ? c.lng : null };
  });

  renderList();
  renderMarkers();
  renderTerritorioList(); // los contadores "N puntos" cambian con cada alta/baja
}

// ============================================================
// RENDER LISTA
// ============================================================
const filterText = document.getElementById('filterText');
filterText.value = prefGet('filtroTexto');
// T6: el filtro no repinta por cada tecla (con listas grandes era costoso)
let filterTimer = null;
filterText.addEventListener('input', () => {
  prefSet('filtroTexto', filterText.value);
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderList, 120);
});

// Chips de filtro por estado
const estadoChips = document.getElementById('estadoChips');
estadoChips.querySelectorAll('.chip-f').forEach((btn) => {
  if (btn.dataset.estado === estadoFiltro) btn.classList.add('active');
  btn.addEventListener('click', () => {
    estadoFiltro = btn.dataset.estado;
    prefSet('estadoFiltro', estadoFiltro);
    estadoChips.querySelectorAll('.chip-f').forEach((b) => b.classList.toggle('active', b === btn));
    renderList();
  });
});

// Ventana de la lista lateral (T14): se pintan tarjetas de a PAGINA_PUNTOS
// y el resto entra con «Cargar más», para que territorios con miles de puntos
// no construyan miles de tarjetas de golpe.
const PAGINA_PUNTOS = 100;
let listaClave = '';
let listaPagina = 1;

function renderList() {
  const list = document.getElementById('list');
  const sec = territorioSelected();

  if (!sec) {
    list.innerHTML = '<div class="empty">Selecciona un territorio para ver sus puntos</div>';
    listaClave = '';
    updateListScope();
    return;
  }

  const txt = filterText.value.toLowerCase().trim();
  const est = estadoFiltro;

  const base = pointsInTerritorio(sec);
  const filtered = base.filter((p) => {
    if (est && (p.estado || 'pendiente') !== est) return false;
    if (txt) {
      const blob = `${p.nombre || ''} ${p.direccion || ''}`.toLowerCase();
      if (!blob.includes(txt)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="empty">No hay puntos en este territorio</div>';
    listaClave = '';
    updateListScope();
    return;
  }

  // Cambiar de territorio o de filtro vuelve a la primera página.
  const clave = `${sec.id}|${est}|${txt}`;
  if (clave !== listaClave) { listaClave = clave; listaPagina = 1; }
  const visibles = filtered.slice(0, listaPagina * PAGINA_PUNTOS);
  const restan = filtered.length - visibles.length;

  const paginador = restan > 0
    ? `<button id="listMore" class="list-more" type="button"><span class="ms ms-sm">add</span>Cargar más · quedan ${restan}</button>`
    : '';

  list.innerHTML = visibles.map((p) => {
    const e = p.estado || 'pendiente';
    const seg = SEGMENTOS.map(([v, l, ic]) =>
      `<button data-estado="${v}" class="${e === v ? 'active' : ''}"><span class="ic ms">${ic}</span><span>${l}</span></button>`
    ).join('');
    const hasCoords = p.lat != null && p.lng != null;
    const coords = hasCoords
      ? `<span class="pc-coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>`
      : `<span class="pc-nogps"><span class="ms ms-sm">location_off</span>Sin GPS</span>`;
    const nav = hasCoords
      ? `<a class="pc-nav" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener" title="Cómo llegar"><span class="ms ms-sm">navigation</span></a>`
      : '';
    return `
    <div class="point-card" data-id="${p.id}">
      <div class="pc-top">
        <div class="pc-main">
          <div class="pc-tags"><span class="pc-id">${escapeHtml(String(p.id).slice(0, 8))}</span></div>
          <h3>${escapeHtml(p.nombre)}</h3>
          <div class="meta">${p.direccion ? escapeHtml(p.direccion) : '—'}</div>
        </div>
        <div class="pc-side">
          ${coords}
          ${nav}
          <button class="pd-btn">Detalles<span class="ms ms-sm">arrow_forward</span></button>
        </div>
      </div>
      <div class="seg">${seg}</div>
    </div>`;
  }).join('') + paginador;

  const more = document.getElementById('listMore');
  if (more) more.addEventListener('click', () => { listaPagina += 1; renderList(); });

  list.querySelectorAll('.point-card').forEach((el) => {
    const id = el.dataset.id;
    el.addEventListener('click', (ev) => { if (ev.target.closest('button') || ev.target.closest('a')) return; focusPoint(id); });
    el.querySelector('.pd-btn').addEventListener('click', (ev) => { ev.stopPropagation(); openPointDetail(id); });
    el.querySelectorAll('.seg button').forEach((b) => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); setEstadoPunto(id, b.dataset.estado); });
    });
  });

  updateListScope();
}



// ============================================================
// MARCADORES EN MAPA
// ============================================================
// Puntos que se muestran en el MAPA según la preferencia (region/comuna/territorio)
function mapScopePoints() {
  if (puntosScope === 'region') return allPoints;
  if (puntosScope === 'territorio') {
    const sec = territorioSelected();
    if (!sec) return [];
    return allPoints.filter((p) => p.lat != null && p.lng != null && pointInGeometry(p.lng, p.lat, sec.geom));
  }
  return displayedPoints();
}

// Marcadores agrupados (T14): solo con alcance «Toda RM» y muchos puntos.
const UMBRAL_CLUSTER = 150;  // por debajo de esto no se agrupa nada
const RADIO_CLUSTER = 60;    // px: hasta aquí se cae dentro de un grupo
let clusterActivo = false;   // ¿la última pintura agrupó? → recalcular al mover
let pinFocoId = null;        // punto resaltado por focusPoint
let groupMarkers = [];       // burbujas de agrupación

function renderMarkers() {
  // Limpiar todos
  Object.values(pointMarkers).forEach((m) => m.remove());
  pointMarkers = {};
  groupMarkers.forEach((m) => m.remove());
  groupMarkers = [];
  if (!map) return;

  const visibleIds = new Set(mapScopePoints().map((p) => p.id));
  const toShow = allPoints.filter(
    (p) => p.lat != null && p.lng != null && (visibleIds.has(p.id) || refResultsIds.has(p.id))
  );

  // El modo referencia va punto por punto: son los resultados de la búsqueda
  // por radio y tienen que distinguirse. Lo mismo para el punto que pidió
  // focusPoint: si fuiste a ese punto, tiene que verse aunque esté agrupado.
  const sueltos = toShow.filter((p) => refResultsIds.has(p.id) || p.id === pinFocoId);
  const idsSueltos = new Set(sueltos.map((p) => p.id));
  const enAlcance = toShow.filter((p) => !idsSueltos.has(p.id));

  clusterActivo = puntosScope === 'region' && enAlcance.length > UMBRAL_CLUSTER;
  const grupos = agruparPuntos(enAlcance, {
    radio: clusterActivo ? RADIO_CLUSTER : 0,
    proyectar: (p) => map.project([p.lng, p.lat]),
  });

  for (const g of grupos) {
    if (g.puntos.length === 1) agregarPin(g.puntos[0]);
    else agregarGrupo(g);
  }
  sueltos.forEach(agregarPin);

  resaltarPinFoco();
}

function agregarPin(p) {
  const el = document.createElement('div');
  const inRef = refResultsIds.has(p.id);
  const est = p.estado || 'pendiente';
  // Aureola «nueva actividad» (solo admin): punto nuevo sin aceptar o
  // erroneo/no_pasar puesto por un usuario a la espera del doble chequeo.
  const enActividad = isAdmin && (
    p.aceptado_at == null ||
    ((p.estado === 'erroneo' || p.estado === 'no_pasar') && !p.verificado)
  );
  // wrap (lo transforma MapLibre) + .pin interno (el dibujo, con hover)
  el.className = 'pin-wrap' + (inRef ? ' is-ref' : '') + (enActividad ? ' pin-act' : '');
  el.innerHTML = `<div class="pin" data-est="${est}"><span class="ms pin-ic">${PIN_ICONS[est] || 'schedule'}</span></div>`;
  // Sin popup: el clic abre la ficha de detalles (openPointDetail)
  const marker = new maplibregl.Marker({ element: el })
    .setLngLat([p.lng, p.lat])
    .addTo(map);
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openPointDetail(p.id);
  });
  pointMarkers[p.id] = marker;
}

// Burbuja de agrupación: cuenta de puntos en el centroide. El clic acerca el
// zoom; al acercarse los puntos se separan en pantalla y el grupo se abre solo.
function agregarGrupo(g) {
  const centro = map.unproject([g.x, g.y]);
  const el = document.createElement('div');
  el.className = 'pin-wrap pin-group-wrap';
  el.innerHTML = `<div class="pin-group"><span>${g.n}</span></div>`;
  const marker = new maplibregl.Marker({ element: el })
    .setLngLat(centro)
    .addTo(map);
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    map.flyTo({ center: centro, zoom: Math.min(map.getZoom() + 1.5, 18) });
  });
  groupMarkers.push(marker);
}

function resaltarPinFoco() {
  document.querySelectorAll('.pin-wrap.pin-focus').forEach((el) => el.classList.remove('pin-focus'));
  const m = pinFocoId != null ? pointMarkers[pinFocoId] : null;
  if (m) m.getElement().classList.add('pin-focus');
}

function focusPoint(id) {
  const p = allPoints.find((x) => x.id === id);
  if (!p) return;
  document.querySelectorAll('.point-card').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  if (p.lat == null || p.lng == null) {
    return toast('Este punto no tiene coordenadas válidas', true);
  }
  // El punto pedido siempre queda como pin suelto, aunque esté dentro de un
  // grupo: renderMarkers() lo repinta así en cada `moveend` del flyTo.
  pinFocoId = id;
  map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15) });
  resaltarPinFoco();
}

// ============================================================
// CLIC EN MAPA
// ============================================================
// Territorio (visible) bajo un lng/lat: hit-test geométrico preciso.
// OJO: queryRenderedFeatures con un punto sobre capas de fill da falsos
// positivos en MapLibre 4.7.1 (devuelve el territorio aunque estés fuera).
function territorioAtLngLat(lng, lat) {
  const s = allTerritorios.find((x) => territoriosVisible(x) && pointInGeometry(lng, lat, x.geom));
  return s ? s.id : null;
}

// Selección de territorio: feature-state en el mapa + clase en la tarjeta lateral
function setTerritorioSelected(id) {
  if (territorioSelectedId === id) return;
  if (map && map.getSource('territorios') && territorioSelectedId != null) {
    map.setFeatureState({ source: 'territorios', id: territorioSelectedId }, { selected: false });
  }
  territorioSelectedId = id;
  assignMode = null; // el toggle de gestión parte cerrado en cada territorio
  pinFocoId = null; // el resaltado no sobrevive a cambiar de territorio
  prefSet('territorioSel', id || '');
  if (map && map.getSource('territorios') && id != null) {
    map.setFeatureState({ source: 'territorios', id }, { selected: true });
  }
  syncSelectedCard();
  renderList();     // la lista muestra solo los puntos del territorio seleccionado
  renderMarkers();  // en modo "territorio" también cambian los marcadores del mapa
  renderTerritorioDetail();
  renderAssign();   // al deselectar se cierra la vista de asignación
  // Al elegir un territorio se abre la columna de puntos (B), mientras A siga
  // abierta (si el panel está vacío, el riel ofrece ► para reabrirlo)
  if (id != null && colAAbierta && !colBAbierta) {
    colBAbierta = true;
    pintarPanel();
  }
}

// Territorio seleccionado (o null)
function territorioSelected() {
  return territorioSelectedId ? allTerritorios.find((s) => s.id === territorioSelectedId) : null;
}

function updateListScope() {
  const head = document.getElementById('puntosHead');
  const btn = document.getElementById('allTerritoriosBtn');
  if (!head || !btn) return;
  const sec = territorioSelected();
  head.textContent = sec ? `Puntos · ${sec.nombre}` : 'Puntos';
  btn.style.display = sec ? '' : 'none';

  // Navegación en dos niveles (estilo front): lista de territorios <-> detalle
  const sel = !!sec;
  const listBox = document.getElementById('territorioList');
  const detail = document.getElementById('detailBlock');
  const fw = document.getElementById('filterWrap');
  const chips = document.getElementById('estadoChips');
  if (listBox) listBox.style.display = sel ? 'none' : '';
  if (detail) detail.style.display = sel ? '' : 'none';
  if (fw) fw.style.display = sel ? '' : 'none';
  if (chips) chips.style.display = sel ? '' : 'none';
  if (!sel && assignMode) {
    assignMode = null;
    renderAssign();
  }
}

function syncSelectedCard() {
  document.querySelectorAll('#territorioList .territorio-card').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === territorioSelectedId);
  });
}

// Marker temporal + popup "Guardar punto aquí".
// El marker se REUSA (setLngLat + setHTML) en vez de destruirlo: quitarlo
// dentro del dispatch del click dispara el listener del marker retirado
// (togglePopup con _map undefined → TypeError en MapLibre 4.7.1, el mismo
// crash que ya existía en producción con el doble clic).
function placeTempMarker(lng, lat) {
  const now = Date.now();
  if (now - lastPlaceAt < 300) return; // dos clics del doble clic = una sola marca
  lastPlaceAt = now;

  const html = `
      <b>Punto seleccionado</b><br>
      <small>${lat.toFixed(6)}, ${lng.toFixed(6)}</small><br>
      <button id="popupSaveBtn">Guardar punto aquí</button>`;

  if (!tempMarker) {
    const el = document.createElement('div');
    el.className = 'pin-wrap';
    el.innerHTML = '<div class="pin pin-temp" data-est="temp"></div>';
    tempMarker = new maplibregl.Marker({ element: el })
      .setLngLat([lng, lat])
      .setPopup(new maplibregl.Popup({ closeButton: true }).setHTML(html))
      .addTo(map);
  } else {
    tempMarker.setLngLat([lng, lat]);
    tempMarker.getPopup().setHTML(html);
  }

  // Abre y enlaza el popup FUERA del dispatch: así ningún handler
  // closeOnClick del propio click lo cierra ni crash.
  setTimeout(() => {
    if (!tempMarker) return;
    const popup = tempMarker.getPopup();
    if (!popup.isOpen()) tempMarker.togglePopup();
    const btn = document.getElementById('popupSaveBtn');
    if (btn) btn.addEventListener('click', () => {
      popup.remove();
      openNewModal(lat, lng);
    });
  }, 0);
}

// Punto visible (marcador en pantalla) a menos de 16 px del clic: si se clickea
// encima de un punto ya existente se muestran sus detalles, nunca "guardar aquí".
function nearbyVisiblePointId(pt) {
  let best = null;
  let bestDist = 16;
  for (const [id, m] of Object.entries(pointMarkers)) {
    const c = map.project(m.getLngLat());
    const d = Math.hypot(c.x - pt.x, c.y - pt.y);
    if (d < bestDist) { bestDist = d; best = id; }
  }
  return best;
}

function onMapClick(e) {
  // T8: en móvil el panel es overlay: el primer clic en el mapa lo cierra
  if (isNarrow() && (colAAbierta || colBAbierta)) {
    colAAbierta = false;
    colBAbierta = false;
    pintarPanel();
    return;
  }

  // Modo dibujo: cada clic agrega un vértice del territorio
  if (drawActive) { handleDrawClick(e); return; }

  const { lng, lat } = e.lngLat;

  if (refMode) {
    setReferencePoint(lng, lat);
    return;
  }

  // Clic sobre un punto ya marcado → detalles (nunca ofrecer guardar ahí)
  const nearId = nearbyVisiblePointId(e.point);
  if (nearId) {
    openPointDetail(nearId);
    return;
  }

  const territorioId = territorioAtLngLat(lng, lat);

  if (territorioId) {
    if (territorioId === territorioSelectedId) {
      // Territorio ya seleccionado: el clic marca el punto
      placeTempMarker(lng, lat);
    } else {
      // Territorio distinto (o ninguno seleccionado): cambia/selecciona
      setTerritorioSelected(territorioId);
    }
    return;
  }

  // Sin territorio debajo
  if (territorioSelectedId) {
    // Clic en zona vacía: deselecciona (el punto se marca con doble clic)
    setTerritorioSelected(null);
  }
  // Sin selección: el clic simple no hace nada (marcar = doble clic)
}

// ============================================================
// MODAL NUEVO/EDITAR
// ============================================================
const modal = document.getElementById('modal');
document.getElementById('modalCancel').addEventListener('click', closeModal);
document.getElementById('modalSave').addEventListener('click', savePoint);

function openNewModal(lat = null, lng = null) {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Nuevo punto';
  document.getElementById('fNombre').value = '';
  document.getElementById('fDireccion').value = '';
  document.getElementById('fEstado').value = 'pendiente';
  document.getElementById('fNotas').value = '';
  document.getElementById('fLat').value = lat ?? '';
  document.getElementById('fLng').value = lng ?? '';
  // Si el punto viene de una búsqueda de dirección, precargarla
  if (lat != null && lng != null && lastGeocode &&
      Math.abs(lastGeocode.lat - lat) < 1e-6 && Math.abs(lastGeocode.lng - lng) < 1e-6) {
    document.getElementById('fDireccion').value = lastGeocode.direccion || '';
  }
  document.getElementById('modalError').textContent = '';
  modal.classList.add('visible');
}

function openEditModal(id) {
  if (!isAdmin) return toast('Solo administradores pueden editar', true);
  const p = allPoints.find((x) => x.id === id);
  if (!p) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Editar punto';
  document.getElementById('fNombre').value = p.nombre || '';
  document.getElementById('fDireccion').value = p.direccion || '';
  document.getElementById('fEstado').value = p.estado || 'pendiente';
  document.getElementById('fNotas').value = p.notas || '';
  document.getElementById('fLat').value = p.lat;
  document.getElementById('fLng').value = p.lng;
  document.getElementById('modalError').textContent = '';
  modal.classList.add('visible');
}

function closeModal() {
  modal.classList.remove('visible');
  editingId = null;
}

async function savePoint() {
  const nombre = document.getElementById('fNombre').value.trim();
  const direccion = document.getElementById('fDireccion').value.trim();
  const estado = document.getElementById('fEstado').value || 'pendiente';
  const notas = document.getElementById('fNotas').value.trim();
  const lat = parseFloat(document.getElementById('fLat').value);
  const lng = parseFloat(document.getElementById('fLng').value);
  const err = document.getElementById('modalError');

  if (!nombre) { err.textContent = 'El nombre es obligatorio'; return; }
  if (isNaN(lat) || isNaN(lng)) { err.textContent = 'Latitud/longitud inválidas'; return; }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { err.textContent = 'Coordenadas fuera de rango'; return; }

  // Mismo nombre a menos de 10 m: casi seguro un punto repetido
  const dup = duplicadoCercano(allPoints, nombre, lat, lng, DUP_METROS, editingId);
  if (dup && !confirm(`Ya existe "${dup.punto.nombre}" a ${dup.metros} m de este punto.\n\n¿Guardar el duplicado de todos modos?`)) {
    return;
  }

  const editId = editingId;
  const { data: savedId, error } = await db.rpc('guardar_punto', {
    p_id: editId,
    p_nombre: nombre,
    p_direccion: direccion,
    p_estado: estado,
    p_notas: notas,
    p_lat: lat,
    p_lng: lng,
  });

  if (error) { err.textContent = error.message; return; }

  closeModal();
  if (tempMarker) { tempMarker.remove(); tempMarker = null; }

  // T6: se actualiza el registro local en vez de volver a bajar TODOS los
  // puntos (antes cada alta/baja recargaba la tabla completa).
  const prev = editId ? allPoints.find((x) => x.id === editId) : null;
  const rec = {
    id: savedId || editId,
    user_id: prev?.user_id ?? currentUser?.id ?? null,
    nombre,
    direccion: direccion || null,
    estado,
    notas: notas || null,
    lat,
    lng,
    created_at: prev?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    territorio_id: territorioAtLngLat(lng, lat),
  };
  if (prev) Object.assign(prev, rec); else allPoints.push(rec);

  refreshPointsViews();
  toast(editId ? 'Punto actualizado' : 'Punto guardado');
}

// Repinta lista, marcadores y contadores de territorios tras un cambio local
function refreshPointsViews() {
  renderList();
  renderMarkers();
  renderTerritorioList();
}

// ============================================================
// ELIMINAR
// ============================================================
async function deletePoint(id) {
  if (!isAdmin) return toast('Solo administradores pueden eliminar', true);
  const p = allPoints.find((x) => x.id === id);
  if (!confirm(`¿Eliminar "${p?.nombre}"?`)) return;
  const { error } = await db.rpc('eliminar_punto', { p_id: id });
  if (error) return toast(error.message, true);
  // T6: baja local en vez de recargar la tabla completa
  allPoints = allPoints.filter((x) => x.id !== id);
  refResultsIds.delete(id);
  toast('Punto eliminado');
  refreshPointsViews();
}

// ============================================================
// DETALLE DE PUNTO
// ============================================================
let pdId = null;

function openPointDetail(id) {
  const p = allPoints.find((x) => x.id === id);
  if (!p) return;
  pdId = id;
  const e = p.estado || 'pendiente';
  const gmapsUrl = p.lat != null && p.lng != null
    ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`
    : null;
  document.getElementById('pdBody').innerHTML = `
    <div class="pd-row"><b>Nombre:</b> ${escapeHtml(p.nombre)}</div>
    <div class="pd-row"><b>Dirección:</b> ${p.direccion ? escapeHtml(p.direccion) : '—'}</div>
    <div class="pd-row"><b>Estado:</b> <span class="estado-tag ${estadoClass(e)}">${estadoLabel(e)}</span></div>
    <div class="pd-row"><b>Coordenadas:</b> ${p.lat != null && p.lng != null ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : '—'}</div>
    ${gmapsUrl ? `<a class="pd-gmaps" href="${gmapsUrl}" target="_blank" rel="noopener"><span class="ms" style="font-size:16px">near_me</span>Abrir en Google Maps</a>` : ''}
    <div class="pd-notas">
      <label for="pdNotas">Notas</label>
      <textarea id="pdNotas" rows="3" placeholder="Sin notas" ${isAdmin ? '' : 'disabled'}>${escapeHtml(p.notas || '')}</textarea>
      ${isAdmin
        ? '<button class="pd-save" id="pdNotasSave">Guardar nota</button><div class="pd-hint" id="pdNotasHint"></div>'
        : '<div class="pd-hint">Solo administradores pueden editar notas</div>'}
    </div>`;
  if (isAdmin) {
    document.getElementById('pdNotasSave').addEventListener('click', savePdNotas);
  }
  document.getElementById('pdEdit').style.display = isAdmin ? '' : 'none';
  document.getElementById('pdDelete').style.display = isAdmin ? '' : 'none';
  document.getElementById('pointDetail').classList.add('visible');
}

async function savePdNotas() {
  if (!pdId || !isAdmin) return;
  const id = pdId;
  const val = document.getElementById('pdNotas').value.trim();
  const hint = document.getElementById('pdNotasHint');
  const { error } = await db
    .from('puntos')
    .update({ notas: val || null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    if (hint) { hint.textContent = 'No se pudo guardar la nota'; hint.style.color = 'var(--error)'; }
    return toast('Error guardando nota', true);
  }
  const p = allPoints.find((x) => x.id === id);
  if (p) p.notas = val || null;
  if (hint) { hint.textContent = 'Nota guardada'; hint.style.color = 'var(--on-green)'; }
  toast('Nota guardada');
}

function closePointDetail() {
  document.getElementById('pointDetail').classList.remove('visible');
  pdId = null;
}

document.getElementById('pdClose').addEventListener('click', closePointDetail);
document.getElementById('pdEdit').addEventListener('click', () => {
  if (!pdId) return;
  const id = pdId;
  closePointDetail();
  openEditModal(id);
});
document.getElementById('pdDelete').addEventListener('click', () => {
  if (!pdId) return;
  const id = pdId;
  closePointDetail();
  deletePoint(id);
});

// ============================================================
// TERRITORIOS: CAPAS, CARGA Y LISTA
// ============================================================
function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

function initTerritorioLayers() {
  if (!map.getSource('territorios')) {
    map.addSource('territorios', { type: 'geojson', data: emptyFC(), promoteId: 'id' });
  }
  if (!map.getLayer('territorios-fill')) {
    map.addLayer({
      id: 'territorios-fill',
      type: 'fill',
      source: 'territorios',
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': ['case',
          ['boolean', ['feature-state', 'selected'], false], 0.38,
          ['boolean', ['feature-state', 'hover'], false], 0.30,
          0.18],
        'fill-opacity-transition': { duration: 150 },
      },
    });
  }
  if (!map.getLayer('territorios-outline')) {
    map.addLayer({
      id: 'territorios-outline',
      type: 'line',
      source: 'territorios',
      paint: {
        // Trazo punteado estilo front (6 2 sobre ancho 2.5)
        'line-dasharray': [2.4, 0.8],
        'line-color': ['case',
          ['boolean', ['feature-state', 'selected'], false], '#1d4ed8',
          ['get', 'color']],
        'line-width': ['case',
          ['boolean', ['feature-state', 'selected'], false], 4,
          ['boolean', ['feature-state', 'hover'], false], 3.5,
          2.5],
        'line-color-transition': { duration: 150 },
        'line-width-transition': { duration: 150 },
      },
    });
  }
  if (!map.getLayer('territorios-labels')) {
    map.addLayer({
      id: 'territorios-labels',
      type: 'symbol',
      source: 'territorios',
      layout: {
        'text-field': ['get', 'nombre'],
        // text-font obligatorio: Open Sans da 404 en OpenFreeMap y deja la
        // fuente entera en "errored" (nada de esa fuente se dibuja)
        'text-font': ['Noto Sans Regular'],
        'text-size': 13,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.04,
      },
      paint: {
        'text-color': '#00223d',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    });
  }

  // Trazo en curso (polígono + línea de goma elástica)
  if (!map.getSource('draw-preview')) {
    map.addSource('draw-preview', { type: 'geojson', data: emptyFC() });
  }
  if (!map.getLayer('draw-fill')) {
    map.addLayer({
      id: 'draw-fill',
      type: 'fill',
      source: 'draw-preview',
      paint: { 'fill-color': drawColor, 'fill-opacity': 0.18 },
    });
  }
  if (!map.getLayer('draw-line')) {
    map.addLayer({
      id: 'draw-line',
      type: 'line',
      source: 'draw-preview',
      paint: { 'line-color': drawColor, 'line-width': 3, 'line-dasharray': [2, 1.5] },
    });
  }

  // Vértices
  if (!map.getSource('draw-verts')) {
    map.addSource('draw-verts', { type: 'geojson', data: emptyFC() });
  }
  if (!map.getLayer('draw-vert-dots')) {
    map.addLayer({
      id: 'draw-vert-dots',
      type: 'circle',
      source: 'draw-verts',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'first'], true], 8, 6],
        'circle-color': drawColor,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
  }

  // Arista de referencia enganchada por el snap
  if (!map.getSource('snap-edge')) {
    map.addSource('snap-edge', { type: 'geojson', data: emptyFC() });
  }
  if (!map.getLayer('snap-edge')) {
    map.addLayer({
      id: 'snap-edge',
      type: 'line',
      source: 'snap-edge',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#f97316', 'line-width': 5 },
    });
  }
}

function setDrawColor(c) {
  if (!map) return;
  if (map.getLayer('draw-fill')) map.setPaintProperty('draw-fill', 'fill-color', c);
  if (map.getLayer('draw-line')) map.setPaintProperty('draw-line', 'line-color', c);
  if (map.getLayer('draw-vert-dots')) map.setPaintProperty('draw-vert-dots', 'circle-color', c);
}


function countPointsInRing(ring) {
  let n = 0;
  for (const p of allPoints) {
    if (p.lat != null && p.lng != null && inRing(p.lng, p.lat, ring)) n++;
  }
  return n;
}

function countPointsInTerritorio(s) {
  const ring = s.geom && s.geom.coordinates && s.geom.coordinates[0];
  return ring ? countPointsInRing(ring) : 0;
}

// Puntos dentro de un territorio.
// T6: si el punto trae territorio_id (lo calcula la DB con un trigger) basta
// comparar ids; solo se cae al hit-test geométrico cuando no está asignado
// (fuera de todo territorio o columna aún sin poblar).
function pointsInTerritorio(s) {
  if (!s) return [];
  return allPoints.filter((p) => {
    if (p.territorio_id) return p.territorio_id === s.id;
    return p.lat != null && p.lng != null && pointInGeometry(p.lng, p.lat, s.geom);
  });
}

// Desglose por estado (para la barra multicolor)
function territorioBreakdown(s) {
  const pts = pointsInTerritorio(s);
  const total = pts.length;
  const c = { pendiente: 0, visitado: 0, erroneo: 0, no_pasar: 0 };
  pts.forEach((p) => { const e = p.estado || 'pendiente'; c[e] = (c[e] || 0) + 1; });
  const hechos = total - c.pendiente;
  return {
    total,
    visitado: c.visitado,
    erroneo: c.erroneo,
    no_pasar: c.no_pasar,
    pendiente: c.pendiente,
    hechos,
    pct: total ? Math.round((hechos / total) * 100) : 0,
  };
}

function progressBarHtml(b) {
  const w = (n) => (b.total ? (n / b.total) * 100 : 0);
  return `<div class="progress multi">` +
    `<i class="seg-visited" style="width:${w(b.visitado)}%"></i>` +
    `<i class="seg-erroneo" style="width:${w(b.erroneo)}%"></i>` +
    `<i class="seg-no_pasar" style="width:${w(b.no_pasar)}%"></i>` +
    `</div>`;
}

function emailDe(userId) {
  const u = usuarios.find((x) => x.id === userId);
  return u ? u.email : '';
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('es-CL');
}

async function loadUsuarios() {
  // T3: la lista de correos solo la pide el admin (la RPC la niega a los demás)
  if (!isAdmin) { usuarios = []; return; }
  const { data, error } = await db.rpc('usuarios_asignables');
  if (error) { console.error('usuarios:', error); usuarios = []; return; }
  usuarios = data || [];
}

async function loadAsignaciones() {
  const { data, error } = await db
    .from('territorios_asignaciones')
    .select('territorio_id, user_id, estado, assigned_at, devuelta_at, completado_at, notas, puntos_base');
  if (error) {
    // Si falla (tabla/columna ausente, RLS), se avisa: con la lista vacía la
    // UI no podría mostrar procesos en curso y el admin creería que el
    // territorio está libre
    console.error('asignaciones:', error);
    if (isAdmin) toast('No se pudo cargar el historial de asignaciones: ' + error.message, true);
    asignaciones = {};
    return;
  }
  // Historial completo por territorio: cada fila es un proceso de trabajo
  asignaciones = {};
  (data || []).forEach((r) => {
    (asignaciones[r.territorio_id] = asignaciones[r.territorio_id] || []).push(r);
  });
}

// Proceso en curso de un territorio (las devueltos no cuentan: el territorio queda
// libre para un nuevo proceso y desaparece de la app del colaborador)
function asigActiva(territorioId) {
  const arr = asignaciones[territorioId] || [];
  return arr.find((a) => a.estado === 'activa') || null;
}

async function loadTerritorios() {
  const { data, error } = await db.from('territorios').select('*');
  if (error) {
    console.error('territorios:', error);
    const missing =
      error.code === '42P01' ||
      error.code === 'PGRST205' ||
      /does not exist|could not find the table/i.test(error.message || '');
    territorioListError = missing
      ? 'Falta la tabla: ejecuta la sección 6 de schema.sql en Supabase'
      : 'Error cargando territorios';
    renderTerritorioList();
    return;
  }
  territorioListError = null;
  allTerritorios = data || [];
  snapRingsCache = null;
  if (territorioSelectedId && !allTerritorios.some((s) => s.id === territorioSelectedId)) {
    territorioSelectedId = null; // el territorio seleccionado ya no existe
  }
  updateTerritoriosSource();
  renderTerritorioList();
  updateListScope();
}

function territoriosVisible(s) {
  const sel = comunaSel.value;
  // Solo se muestran territorios de la comuna seleccionada; sin comuna, ninguno
  return !!sel && s.comuna === sel;
}

function updateTerritoriosSource() {
  if (!map || !map.getSource('territorios')) return;
  const features = allTerritorios.filter(territoriosVisible).map((s) => ({
    type: 'Feature',
    properties: {
      id: s.id,
      nombre: s.nombre,
      color: s.color,
      ...(s.comuna ? { comuna: s.comuna } : {}),
    },
    geometry: s.geom,
  }));
  map.getSource('territorios').setData({ type: 'FeatureCollection', features });
  // setData puede descartar los feature-states: reafirma la selección
  if (territorioSelectedId != null) {
    map.setFeatureState({ source: 'territorios', id: territorioSelectedId }, { selected: true });
  }
}

function renderTerritorioList() {
  const box = document.getElementById('territorioList');
  if (!box) return;

  // Sin comuna elegida: resumen de los territorios con proceso en curso, para
  // abrir su comuna y el territorio de un clic sin tener que elegir comuna antes.
  if (!comunaSel.value) return renderTerritorioResumen(box);

  const visible = allTerritorios.filter(territoriosVisible);

  if (!visible.length) {
    box.innerHTML = territorioListError
      ? `<div class="empty">${escapeHtml(territorioListError)}</div>`
      : '<div class="empty">Aún no hay territorios · dibuja uno con ✏️</div>';
    renderTerritorioDetail();
    renderAssign();
    return;
  }

  box.innerHTML = visible.map((s) => {
    const st = territorioBreakdown(s);
    const act = asigActiva(s.id);
    const quien = act ? emailDe(act.user_id) : '';
    const chip = quien
      ? `<span class="who">${escapeHtml(quien)}</span>`
      : `<span class="who none"><span class="ms ms-sm">warning</span>Sin asignar</span>`;
    return `
      <div class="territorio-card${s.id === territorioSelectedId ? ' selected' : ''}" data-id="${s.id}">
        <div class="s-top">
          <span class="dot" style="background:${escapeHtml(s.color || '#1d4ed8')}"></span>
          <b>${escapeHtml(s.nombre)}</b>
          ${chip}
        </div>
        <small>${s.comuna ? escapeHtml(s.comuna) + ' · ' : ''}${st.total} punto${st.total === 1 ? '' : 's'}</small>
        <div class="s-adv">
          <span>Avance ${st.hechos} / ${st.total}</span>
          <span class="s-pct">${st.pct}%</span>
        </div>
        ${progressBarHtml(st)}
      </div>`;
  }).join('');

  box.querySelectorAll('.territorio-card').forEach((el) => {
    const id = el.dataset.id;
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      focusTerritorio(id);
    });
    el.addEventListener('mouseenter', () => setTerritorioHover(id, true));
    el.addEventListener('mouseleave', () => setTerritorioHover(id, false));
  });

  syncSelectedCard();
  renderTerritorioDetail();
  renderAssign();
}

// Resumen sin comuna: tarjetas de los territorios con proceso (asignación)
// activo, con su comuna; al pulsar uno se abre esa comuna y el territorio.
function renderTerritorioResumen(box) {
  const asignados = allTerritorios.filter(
    (s) => s.comuna && comunaActiva(s.comuna) && asigActiva(s.id)
  );

  if (!asignados.length) {
    box.innerHTML = territorioListError
      ? `<div class="empty">${escapeHtml(territorioListError)}</div>`
      : '<div class="empty">Sin territorios asignados · elige una comuna para ver todos</div>';
    renderTerritorioDetail();
    renderAssign();
    return;
  }

  const cards = asignados.map((s) => {
    const st = territorioBreakdown(s);
    const act = asigActiva(s.id);
    return `
      <div class="territorio-card" data-id="${escapeHtml(s.id)}" data-comuna="${escapeHtml(s.comuna)}">
        <div class="s-top">
          <span class="dot" style="background:${escapeHtml(s.color || '#1d4ed8')}"></span>
          <b>${escapeHtml(s.nombre)}</b>
          <span class="who">${escapeHtml(emailDe(act.user_id) || '—')}</span>
        </div>
        <small>${escapeHtml(s.comuna)} · ${st.total} punto${st.total === 1 ? '' : 's'}</small>
        <div class="s-adv">
          <span>Avance ${st.hechos} / ${st.total}</span>
          <span class="s-pct">${st.pct}%</span>
        </div>
        ${progressBarHtml(st)}
      </div>`;
  }).join('');

  box.innerHTML = `
    <div class="activos-frame">
      <div class="sect-resumen-head">
        <span class="ms ms-sm">bolt</span>
        <span>Territorios activos</span>
        <span class="activos-count">${asignados.length}</span>
      </div>
      ${cards}
    </div>`;

  box.querySelectorAll('.territorio-card').forEach((el) => {
    el.addEventListener('click', () => abrirComunaTerritorio(el.dataset.comuna, el.dataset.id));
  });

  renderTerritorioDetail();
  renderAssign();
}

// Desde el resumen: cambia el selector a la comuna del territorio y lo enfoca.
// onComunaChange() limpia la selección anterior y encuadra la comuna; luego
// focusTerritorio vuela al polígono y lo deja seleccionado.
function abrirComunaTerritorio(comuna, territorioId) {
  if (comuna && comunaSel.value !== comuna) {
    comunaSel.value = comuna;
    onComunaChange();
  }
  focusTerritorio(territorioId);
}

// Card completa del territorio seleccionado
function renderTerritorioDetail() {
  const box = document.getElementById('territorioDetail');
  if (!box) return;
  const s = territorioSelected();
  if (!s) { box.innerHTML = ''; return; }
  const st = territorioBreakdown(s);
  const act = asigActiva(s.id);
  const quien = act ? emailDe(act.user_id) : '';
  const asigTitle = asignaciones[s.id] && !act && asignaciones[s.id].devuelta_at
    ? ` title="Devuelta el ${new Date(asignaciones[s.id].devuelta_at).toLocaleDateString('es-CL')}"`
    : '';
  const palette = isAdmin ? `
      <div class="sd-palette" id="sdPalette" style="display:none">
        ${TERRITORIO_COLORS.map((c) => `
          <button class="chip${c === s.color ? ' selected' : ''}" data-color="${c}"
                  style="background:${c}" title="Color"></button>`).join('')}
      </div>` : '';
  box.innerHTML = `
    <div class="detail-card">
      <div class="dc-top">
        <div class="dc-names">
          <span class="dc-comuna">${s.comuna ? escapeHtml(s.comuna) : '—'}</span>
          <h3><span class="dot" style="background:${escapeHtml(s.color || '#1d4ed8')}"></span>${escapeHtml(s.nombre)}</h3>
        </div>
        <div class="dc-tools">
          <span class="who${quien ? '' : ' none'}"${asigTitle}>${escapeHtml(quien || (asigTitle ? 'Devuelta' : 'Sin asignar'))}</span>
          <div class="sd-menu-wrap">
            <button id="sdMenu" class="sd-iconbtn" title="Opciones del territorio" aria-label="Opciones del territorio"><span class="ms ms-sm">more_vert</span></button>
            <div class="sd-menu-pop" id="sdMenuPop">
              <button id="sdExportGeo"><span class="ms ms-sm">map</span>Exportar GeoJSON</button>
              <button id="sdExportCsv"><span class="ms ms-sm">list</span>Exportar puntos (CSV)</button>
              ${isAdmin ? `
              <div class="sd-menu-sep"></div>
              <button id="sdAssign"><span class="ms ms-sm">group_add</span>Asignar</button>
              <button id="sdRename"><span class="ms ms-sm">edit</span>Renombrar</button>
              <button id="sdEdit"><span class="ms ms-sm">palette</span>Editar</button>
              <button id="sdDel" class="danger-text"><span class="ms ms-sm">delete</span>Eliminar</button>` : ''}
            </div>
          </div>
          <button id="sdFocus" class="sd-iconbtn" title="Ver en el mapa" aria-label="Ver en el mapa"><span class="ms ms-sm">center_focus_strong</span></button>
        </div>
      </div>
      <div class="stats4">
        <div><span>Total</span><b>${st.total}</b></div>
        <div class="st-v"><span>Visitados</span><b>${st.visitado}</b></div>
        <div class="st-e"><span>Erróneos</span><b>${st.erroneo}</b></div>
        <div class="st-b"><span>No pasar</span><b>${st.no_pasar}</b></div>
      </div>
      <div class="dc-prog-head">
        <span>Avance consolidado</span>
        <span class="s-pct">${st.pct}% Completado</span>
      </div>
      ${progressBarHtml(st)}
      ${palette}
    </div>`;
  const f = document.getElementById('sdFocus');
  if (f) f.addEventListener('click', () => focusTerritorio(s.id));
  const menuBtn = document.getElementById('sdMenu');
  const menuPop = document.getElementById('sdMenuPop');
  if (menuBtn && menuPop) {
    // Los items dependen del rol (solo admin aparecen Asignar/Renombrar/…),
    // así que se enganchan por id y se ignora el que no esté en el DOM.
    const onItem = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        menuPop.classList.remove('visible');
        fn();
      });
    };
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menuPop.classList.toggle('visible');
    });
    onItem('sdExportGeo', () => exportarTerritorioGeojson(s));
    onItem('sdExportCsv', () => exportarTerritorioCsv(s));
    onItem('sdAssign', () => { assignMode = assignMode === 'asignar' ? null : 'asignar'; renderAssign(); });
    onItem('sdRename', () => renameTerritorio(s.id));
    onItem('sdDel', () => deleteTerritorio(s.id));
    onItem('sdEdit', () => {
      const pal = document.getElementById('sdPalette');
      if (pal) pal.style.display = pal.style.display === 'none' ? 'flex' : 'none';
    });
    const pal = document.getElementById('sdPalette');
    if (pal) {
      pal.querySelectorAll('.chip').forEach((chip) => {
        chip.addEventListener('click', (e) => { e.stopPropagation(); changeTerritorioColor(s.id, chip.dataset.color); });
      });
    }
  }
}

// Cierra el menú de opciones del territorio al hacer clic fuera
document.addEventListener('click', (e) => {
  if (!e.target.closest('.sd-menu-wrap')) {
    document.querySelectorAll('.sd-menu-pop.visible').forEach((p) => p.classList.remove('visible'));
  }
});

// Vista de asignación del territorio elegido: proceso en curso + historial.
// Cada fila de territorios_asignaciones es un proceso de trabajo del territorio
// (asignado → devuelto); al devolver, el proceso se cierra y el territorio
// queda a la espera de un nuevo proceso.

// Puntos de un territorio. Usa pointsInTerritorio para no depender de que
// allPoints tenga ya el territorio_id: al crear un territorio la DB reasigna
// los puntos por geometría, pero el array en memoria puede quedar obsoleto.
function puntosDeTerritorio(territorioId) {
  const t = allTerritorios.find((x) => x.id === territorioId);
  return t ? pointsInTerritorio(t) : allPoints.filter((p) => p.territorio_id === territorioId);
}

// Puntos 'pendiente' actuales de un territorio (sobre ellos se calcula el
// avance de cada proceso; ver migración 019)
function pendientesDe(territorioId) {
  return puntosDeTerritorio(territorioId)
    .filter((p) => p.estado === 'pendiente' && !p.deleted_at).length;
}

// Puntos que quedarán 'pendiente' al abrir un proceso: el trigger de 019
// reinicia los 'visitado' del proceso anterior antes de contar, así que un
// territorio con solo visitados SÍ puede reasignarse. 'erroneo' y 'no_pasar'
// se heredan y no cuentan como trabajo nuevo.
function asignablesDe(territorioId) {
  return puntosDeTerritorio(territorioId)
    .filter((p) => !p.deleted_at && (p.estado === 'pendiente' || p.estado === 'visitado')).length;
}

// Desglose para la validación al reasignar un territorio ya trabajado.
function reasignacionDe(territorioId) {
  const pts = puntosDeTerritorio(territorioId).filter((p) => !p.deleted_at);
  const cuenta = (estado) => pts.filter((p) => p.estado === estado).length;
  return {
    visitados: cuenta('visitado'),
    erroneos: cuenta('erroneo'),
    noPasar: cuenta('no_pasar'),
  };
}

// Card de gestión de la asignación del territorio elegido (bajo la ficha en
// la columna A): toggle [Asignar] → vista de procesos (nuevo/actual +
// historial, la que antes reemplazaba a la ficha); toggle [Reset] → devuelve
// los 'visitado' a 'pendiente' ('erroneo' y 'no_pasar' se mantienen).
function renderAssign() {
  const card = document.getElementById('assignCard');
  const detail = document.getElementById('territorioDetail');
  if (!card) return;
  const s = territorioSelected();
  if (!s) {
    card.style.display = 'none';
    card.innerHTML = '';
    if (detail) detail.style.display = '';
    return;
  }
  if (detail) detail.style.display = '';
  card.style.display = '';

  const act = asigActiva(s.id);
  const hist = (asignaciones[s.id] || [])
    .slice()
    .sort((a, b) => new Date(b.assigned_at || 0) - new Date(a.assigned_at || 0));
  const reasig = reasignacionDe(s.id);
  const fila = (a) => {
    const est = ESTADO_ASIG[a.estado] ? a.estado : 'activa';
    const cierre = est === 'completado' ? a.completado_at : est === 'devuelta' ? a.devuelta_at : null;
    return `
    <tr>
      <td>${escapeHtml(emailDe(a.user_id) || '—')}</td>
      <td>${fmtFecha(a.assigned_at)}</td>
      <td>${cierre ? fmtFecha(cierre) : '—'}</td>
      <td><span class="chip-est ${est}">${ESTADO_ASIG[est]}</span></td>
    </tr>`;
  };

  let cuerpo;
  if (assignMode === 'reset') {
    const permiteReset = reasig.visitados > 0 || !!act;
    const detalle = [
      reasig.visitados
        ? `${reasig.visitados} visitado${reasig.visitados === 1 ? '' : 's'} volverá${reasig.visitados === 1 ? '' : 'n'} a pendiente`
        : 'Sin visitados por reiniciar',
      act ? 'el proceso activo queda cerrado y el territorio libre' : 'no hay proceso que liberar',
    ].join(' · ');
    cuerpo = `
      <p class="assign-hint">Reinicia los <b>visitado</b> a <b>pendiente</b> y libera el proceso activo, si hay, en un solo paso. Los <b>erróneo</b> y <b>no pasar</b> se mantienen.</p>
      <p class="assign-hint"><b>${detalle}.</b></p>
      <div class="asig-actions">
        <button id="asigResetConfirm" class="danger-text"${permiteReset ? '' : ' disabled'}>Reiniciar</button>
        <button id="asigResetCancel">Cancelar</button>
      </div>`;
  } else if (assignMode === 'asignar') {
    const opts = '<option value="">— elegir usuario —</option>' +
      usuarios.map((u) => `<option value="${u.id}">${escapeHtml(u.email)}</option>`).join('');
    cuerpo = act ? `
      <div class="asig-actual">
        <div class="asig-quien">
          <b>${escapeHtml(emailDe(act.user_id) || '—')}</b>
          <small>Asignado el ${fmtFecha(act.assigned_at)}</small>
          ${act.puntos_base ? `<small>Avance: ${Math.max(0, act.puntos_base - pendientesDe(s.id))} de ${act.puntos_base} pendientes gestionados</small>` : ''}
        </div>
        <div class="asig-actions">
          <button id="asigCompletar" class="primary" title="Cerrar el proceso como completado">Completar</button>
          <button id="asigDevolver" class="danger-text" title="Cerrar el proceso y liberar el territorio">Devolver</button>
        </div>
      </div>` : `
      <div class="asig-nueva">
        <p class="assign-count">${asignablesDe(s.id)} puntos pendientes de gestión</p>
        <select id="asigUserSel">${opts}</select>
        <button id="asigAsignar" class="primary"${asignablesDe(s.id) ? '' : ' disabled'}>Asignar</button>
      </div>
      ${reasig.visitados ? `<p class="assign-hint">Al asignar se reiniciarán ${reasig.visitados} punto${reasig.visitados === 1 ? '' : 's'} visitado${reasig.visitados === 1 ? '' : 's'} a pendiente${reasig.erroneos || reasig.noPasar ? `; se mantienen ${reasig.erroneos} erróneo${reasig.erroneos === 1 ? '' : 's'} y ${reasig.noPasar} no pasar` : ''}.</p>` : ''}
      ${asignablesDe(s.id) ? '' : '<p class="assign-warn">Este territorio no tiene puntos pendientes de gestión: no puede asignarse.</p>'}`;
    cuerpo += `
      <p class="assign-hint">Cada fila es un proceso de trabajo sobre el territorio: al devolverlo el proceso se cierra y el territorio queda libre para un nuevo proceso.</p>
      <table>
        <thead><tr><th>Usuario</th><th>Asignado</th><th>Devuelto</th><th>Estado</th></tr></thead>
        <tbody>${hist.length ? hist.map(fila).join('') : '<tr><td colspan="4">Sin procesos registrados</td></tr>'}</tbody>
      </table>`;
  } else {
    cuerpo = `<p class="assign-hint">${act
      ? `Proceso activo: <b>${escapeHtml(emailDe(act.user_id) || '—')}</b>`
      : `Sin proceso activo · ${asignablesDe(s.id)} punto(s) disponible${asignablesDe(s.id) === 1 ? '' : 's'}`}</p>`;
  }

  card.innerHTML = `
    <div class="asig-head">
      <b>Gestión de asignación</b>
      <div class="as-toggles">
        <button id="asigToggleAsignar" class="as-toggle${assignMode === 'asignar' ? ' active' : ''}" aria-pressed="${assignMode === 'asignar'}">Asignar</button>
        <button id="asigToggleReset" class="as-toggle${assignMode === 'reset' ? ' active' : ''}" aria-pressed="${assignMode === 'reset'}">Reset</button>
      </div>
    </div>
    <div class="as-box assign-panel">${cuerpo}</div>`;

  document.getElementById('asigToggleAsignar').addEventListener('click', () => {
    assignMode = assignMode === 'asignar' ? null : 'asignar';
    renderAssign();
  });
  document.getElementById('asigToggleReset').addEventListener('click', () => {
    assignMode = assignMode === 'reset' ? null : 'reset';
    renderAssign();
  });
  const resetOk = document.getElementById('asigResetConfirm');
  if (resetOk) resetOk.addEventListener('click', () => resetTerritorioPuntos(s));
  const resetNo = document.getElementById('asigResetCancel');
  if (resetNo) resetNo.addEventListener('click', () => { assignMode = null; renderAssign(); });
  const asignar = document.getElementById('asigAsignar');
  if (asignar) asignar.addEventListener('click', () => {
    const uid = document.getElementById('asigUserSel').value;
    if (!uid) return toast('Elige un usuario para asignar el territorio', true);
    assignTerritorio(s.id, uid);
  });
  const dev = document.getElementById('asigDevolver');
  if (dev) dev.addEventListener('click', () => assignTerritorio(s.id, ''));
  const comp = document.getElementById('asigCompletar');
  if (comp) comp.addEventListener('click', () => completarTerritorio(s.id));
}

// Reset manual del territorio (toggle Reset): 1 RPC transaccional en el
// servidor (migración 021) reinicia los 'visitado' a 'pendiente' ('erroneo'
// y 'no_pasar' se conservan) y cierra el proceso activo como 'devuelta'.
async function resetTerritorioPuntos(s) {
  if (!isAdmin) return toast('Solo administradores pueden reiniciar territorios', true);
  const { data, error } = await db.rpc('reiniciar_territorio', { p_territorio: s.id });
  if (error) return toast(error.message, true);
  await loadPoints();
  await loadAsignaciones();
  toast(+data > 0
    ? `Reiniciado${+data === 1 ? '' : 's'} ${+data} punto${+data === 1 ? '' : 's'} a pendiente`
    : 'Territorio reiniciado (no había visitados)');
  renderAssign();
  renderTerritorioList();
  renderTerritorioDetail();
}

// Cierre manual del proceso (admin): RPC completar_territorio + notas
async function completarTerritorio(territorioId) {
  if (!isAdmin) return toast('Solo administradores pueden completar territorios', true);
  const notas = prompt('Notas del proceso (opcional):', '');
  if (notas === null) return;
  const { error } = await db.rpc('completar_territorio', {
    p_territorio: territorioId,
    p_notas: notas.trim() || null,
  });
  if (error) return toast(error.message, true);
  toast('Proceso completado');
  await loadAsignaciones();
  renderAssign();
  renderTerritorioList();
  renderTerritorioDetail();
}

async function assignTerritorio(territorioId, userId) {
  if (!isAdmin) return toast('Solo administradores pueden asignar territorios', true);
  if (!userId) {
    // Devolver: cierra el proceso en curso; la fila se conserva como historial
    const { error } = await db.from('territorios_asignaciones').update({
      estado: 'devuelta',
      devuelta_at: new Date().toISOString(),
      devuelta_por: currentUser ? currentUser.id : null,
    }).eq('territorio_id', territorioId).eq('estado', 'activa');
    if (error) return toast(error.message, true);
    toast('Proceso cerrado: el territorio quedó libre');
  } else {
    // Revisión en el servidor: un territorio con proceso en curso no se puede
    // asignar a otro; tras devolverlo sí (el historial admite varios procesos)
    const { data: act, error: errAct } = await db
      .from('territorios_asignaciones')
      .select('user_id')
      .eq('territorio_id', territorioId)
      .eq('estado', 'activa')
      .maybeSingle();
    if (errAct) return toast(errAct.message, true);
    if (act) return toast('El territorio ya está asignado a ' + (emailDe(act.user_id) || 'otro usuario'), true);

    // Regla de negocio: sin puntos pendientes (tras reiniciar los visitados
    // del proceso anterior) no hay trabajo que abrir; la migración 019
    // también lo exige en la BD.
    if (asignablesDe(territorioId) === 0) {
      return toast('Este territorio no tiene puntos pendientes de gestión: no puede asignarse', true);
    }

    // Validación al reasignar un territorio ya trabajado (completado o
    // devuelto): el nuevo proceso reinicia los 'visitado' a pendiente.
    // 'erroneo' y 'no_pasar' se conservan (migración 019).
    const reasig = reasignacionDe(territorioId);
    if (reasig.visitados > 0) {
      const conserva = reasig.erroneos || reasig.noPasar
        ? ` Se mantendrán ${reasig.erroneos} erróneo(s) y ${reasig.noPasar} no pasar.`
        : '';
      const ok = confirm(
        'Este territorio ya fue trabajado.\n\n'
        + `Se reiniciarán ${reasig.visitados} punto(s) visitado(s) a pendiente.${conserva}\n\n`
        + '¿Asignar y reiniciar los visitados?'
      );
      if (!ok) return;
    }

    // Nuevo proceso: INSERT (el territorio puede tener varios procesos en el
    // historial; los índices parciales garantizan 1 activo por territorio/usuario)
    const { error } = await db.from('territorios_asignaciones').insert({
      territorio_id: territorioId,
      user_id: userId,
      assigned_by: currentUser ? currentUser.id : null,
      assigned_at: new Date().toISOString(),
      estado: 'activa',
    });
    if (error) {
      const msg = error.code === '23505'
        ? 'Ese usuario o ese territorio ya tiene un proceso en curso'
        : error.message;
      return toast(msg, true);
    }
    toast('Proceso de trabajo iniciado');
  }
  await loadAsignaciones();
  // El trigger de la DB reinicia los visitados y recalcula puntos_base; se
  // recargan los puntos para que la UI refleje el nuevo proceso al instante.
  await loadPoints();
  renderAssign();
  renderTerritorioList();
  renderTerritorioDetail();
}

// ============================================================
// ESTADO DEL PUNTO
// ============================================================
function refreshAfterEstado() {
  renderList();
  renderTerritorioList();
  renderTerritorioDetail();
}

// T1: marcar estado vía RPC (security definer). Cualquier usuario autenticado
// puede marcar puntos en terreno; la DB garantiza que SOLO cambia estado.
async function setEstadoPunto(id, estado, silent) {
  const p = allPoints.find((x) => x.id === id);
  if (!p) return;
  const prev = p.estado || 'pendiente';
  if (prev === estado) return;
  const { error } = await db.rpc('marcar_estado', { p_id: id, p_estado: estado });
  if (error) return toast(error.message, true);
  p.estado = estado;
  refreshAfterEstado();
  if (silent) {
    hideUndoToast();
  } else {
    lastEstadoUndo = { id, prev };
    showUndoToast(`Punto marcado como ${estadoLabel(estado)}`, undoEstado);
  }
}

function undoEstado() {
  const u = lastEstadoUndo;
  lastEstadoUndo = null;
  if (u) setEstadoPunto(u.id, u.prev, true);
}

let undoToastTimer = null;
function showUndoToast(msg, onUndo) {
  const el = document.getElementById('undoToast');
  document.getElementById('undoMsg').textContent = msg;
  el.classList.add('visible');
  clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(hideUndoToast, 5000);
  window.__undoHandler = onUndo;
}
function hideUndoToast() {
  document.getElementById('undoToast').classList.remove('visible');
}
document.getElementById('undoBtn').addEventListener('click', () => {
  const h = window.__undoHandler;
  hideUndoToast();
  if (h) h();
});

// ============================================================
// TERRITORIOS: FOCO
// ============================================================
function setTerritorioHover(id, on) {
  if (!map || !map.getSource('territorios') || !id) return;
  map.setFeatureState({ source: 'territorios', id }, { hover: on });
}

function focusTerritorio(id) {
  const s = allTerritorios.find((x) => x.id === id);
  if (!s || !s.geom) return;
  const b = boundsFromGeometry(s.geom);
  if (b && !b.isEmpty()) map.fitBounds(b, { padding: 60, duration: 800 });
  // La tarjeta también deja el territorio listo para marcar puntos
  setTerritorioSelected(id);
}

async function renameTerritorio(id) {
  if (!isAdmin) return toast('Solo administradores pueden editar territorios', true);
  const s = allTerritorios.find((x) => x.id === id);
  if (!s) return;
  const nombre = prompt('Nombre del territorio:', s.nombre);
  if (nombre === null) return;
  const trimmed = nombre.trim();
  if (!trimmed || trimmed === s.nombre) return;
  const { error } = await db.from('territorios').update({ nombre: trimmed }).eq('id', id);
  if (error) return toast(error.message, true);
  await loadTerritorios();
}

async function changeTerritorioColor(id, color) {
  if (!isAdmin) return toast('Solo administradores pueden editar territorios', true);
  const { error } = await db.from('territorios').update({ color }).eq('id', id);
  if (error) return toast(error.message, true);
  await loadTerritorios();
}

async function deleteTerritorio(id) {
  if (!isAdmin) return toast('Solo administradores pueden eliminar territorios', true);
  const s = allTerritorios.find((x) => x.id === id);
  if (!confirm(`¿Eliminar "${s?.nombre}"?`)) return;
  const { error } = await db.from('territorios').delete().eq('id', id);
  if (error) return toast(error.message, true);
  toast('Territorio eliminado');
  if (territorioSelectedId === id) setTerritorioSelected(null);
  await loadTerritorios();
  // Al borrar, la DB devuelve sus puntos a "sin territorio"; recargar para
  // que los contadores y el panel de asignación no queden obsoletos.
  await loadPoints();
}

// ============================================================
// DIBUJO DE TERRITORIOS
// ============================================================
function startDraw() {
  if (drawActive) { stopDraw(); return; }
  // T2: la DB rechaza el insert si no es admin; se avisa antes de dibujar.
  if (!isAdmin) return toast('Solo administradores pueden dibujar territorios', true);
  if (!comunaSel.value) return toast('Elige una comuna antes de dibujar un territorio', true);

  drawActive = true;
  drawVerts = [];
  drawHover = null;
  snapRingsCache = null;
  pendingTerritorio = null;

  // El modo referencia pisaría el primer clic: lo apagamos
  if (refMode) {
    refMode = false;
    const rb = document.getElementById('refBtn');
    rb.classList.remove('active');
    rb.title = 'Modo referencia';
    clearReference();
  }

  document.getElementById('territorioModal').classList.remove('visible');
  document.getElementById('drawToolbar').classList.add('visible');
  document.getElementById('drawBtn').classList.add('active');
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  updateDraw();
  toast('Clic para agregar vértices · doble clic o primer vértice para cerrar');
}

function stopDraw() {
  drawActive = false;
  drawVerts = [];
  drawHover = null;
  setDrawSnap(null);
  pendingTerritorio = null;

  if (map) {
    if (map.getSource('draw-preview')) map.getSource('draw-preview').setData(emptyFC());
    if (map.getSource('draw-verts')) map.getSource('draw-verts').setData(emptyFC());
    map.doubleClickZoom.enable();
    map.getCanvas().style.cursor = '';
  }
  document.getElementById('territorioModal').classList.remove('visible');
  document.getElementById('drawToolbar').classList.remove('visible');
  document.getElementById('drawBtn').classList.remove('active');
  document.getElementById('drawCount').textContent = '—';
}

function distPx(a, point) {
  const p = map.project(a);
  return Math.hypot(p.x - point.x, p.y - point.y);
}

function updateDraw() {
  if (!map || !map.getSource('draw-preview')) return;

  const line = drawHover && drawVerts.length ? drawVerts.concat([drawHover]) : drawVerts.slice();

  const preview = [];
  if (line.length >= 2) {
    preview.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
    if (line.length >= 3) {
      preview.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [line.concat([line[0]])] },
      });
    }
  }
  map.getSource('draw-preview').setData({ type: 'FeatureCollection', features: preview });

  map.getSource('draw-verts').setData({
    type: 'FeatureCollection',
    features: drawVerts.map((c, i) => ({
      type: 'Feature',
      properties: { first: i === 0 },
      geometry: { type: 'Point', coordinates: c },
    })),
  });

  // Contador en vivo: puntos que caerían dentro del territorio
  const badge = document.getElementById('drawCount');
  if (line.length >= 3) {
    const n = countPointsInRing(line);
    badge.textContent = `${n} punto${n === 1 ? '' : 's'}`;
  } else {
    badge.textContent = '—';
  }
}

// ============================================================
// SNAP A BORDES EXISTENTES (comuna + territorios) mientras dibujas
// ============================================================
const SNAP_PX = 14;

function snapRefRings() {
  if (snapRingsCache) return snapRingsCache;
  const rings = [];
  const push = (g) => {
    if (!g || !g.coordinates) return;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    for (const poly of polys) for (const ring of poly) rings.push(ring);
  };
  const sel = comunaSel.value;
  if (sel) {
    const c = allComunas.find((x) => x.nombre === sel);
    if (c) push(c.geom);
  } else {
    for (const c of allComunas) push(c.geom);
  }
  for (const s of allTerritorios) if (territoriosVisible(s)) push(s.geom);
  snapRingsCache = rings;
  return rings;
}

// Engancha (lng, lat) al vértice/arista de referencia más cercano (≤ SNAP_PX).
// Vértices ganan siempre: son coordenadas exactas del polígono de referencia.
// Proyección en espacio de pantalla: es donde MapLibre pinta las líneas.
function snapDrawPoint(lng, lat, point) {
  const rings = snapRefRings();
  if (!rings.length) return null;

  const p0 = map.unproject([point.x, point.y]);
  const pX = map.unproject([point.x + SNAP_PX, point.y]);
  const pY = map.unproject([point.x, point.y + SNAP_PX]);
  const mLng = Math.abs(pX.lng - p0.lng);
  const mLat = Math.abs(pY.lat - p0.lat);
  const cos0 = Math.cos((lat * Math.PI) / 180);

  let bestV = null;
  let bestE = null;

  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      // Filtro AABB barato en grados (ventana + margen de tolerancia)
      if (
        Math.min(a[0], b[0]) - mLng > lng || Math.max(a[0], b[0]) + mLng < lng ||
        Math.min(a[1], b[1]) - mLat > lat || Math.max(a[1], b[1]) + mLat < lat
      ) continue;

      const dvx = (a[0] - lng) * cos0;
      const dvy = a[1] - lat;
      const dv2 = dvx * dvx + dvy * dvy;
      if (!bestV || dv2 < bestV.d2) bestV = { d2: dv2, coord: a };

      // Proyección del cursor sobre la arista (lineal en lng/lat, como el GeoJSON)
      const dx = (b[0] - a[0]) * cos0;
      const dy = b[1] - a[1];
      const dd = dx * dx + dy * dy;
      const px = (lng - a[0]) * cos0;
      const py = lat - a[1];
      let t = dd > 0 ? (px * dx + py * dy) / dd : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const sx = a[0] + t * (b[0] - a[0]);
      const sy = a[1] + t * (b[1] - a[1]);
      const dex = (sx - lng) * cos0;
      const dey = sy - lat;
      const de2 = dex * dex + dey * dey;
      if (!bestE || de2 < bestE.d2) bestE = { d2: de2, coord: [sx, sy], a, b };
    }
  }

  const toPx = (c) => {
    const p = map.project(c);
    return Math.hypot(p.x - point.x, p.y - point.y);
  };
  if (bestV && toPx(bestV.coord) <= SNAP_PX) return { coord: bestV.coord, edge: null };
  if (bestE && toPx(bestE.coord) <= SNAP_PX) return { coord: bestE.coord, edge: [bestE.a, bestE.b] };
  return null;
}

function setDrawSnap(edge) {
  const has = !!edge;
  const changed = has !== !!drawSnap || (has && (drawSnap.a !== edge[0] || drawSnap.b !== edge[1]));
  if (!changed) return;
  drawSnap = has ? { a: edge[0], b: edge[1] } : null;
  if (!map || !map.getSource('snap-edge')) return;
  map.getSource('snap-edge').setData(
    drawSnap
      ? {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: [drawSnap.a, drawSnap.b] },
            },
          ],
        }
      : emptyFC()
  );
}

function handleDrawClick(e) {
  // Con el modal abierto el mapa queda "congelado" (evita vértices fantasma)
  if (document.getElementById('territorioModal').classList.contains('visible')) return;

  // Clic sobre el primer vértice = cerrar el territorio
  if (drawVerts.length >= 3 && distPx(drawVerts[0], e.point) <= 12) {
    drawHover = null;
    closeDraw();
    return;
  }

  const snap = snapDrawPoint(e.lngLat.lng, e.lngLat.lat, e.point);
  drawVerts.push(snap ? snap.coord : [e.lngLat.lng, e.lngLat.lat]);
  updateDraw();
}

function onMapMove(e) {
  if (drawActive) {
    const snap = snapDrawPoint(e.lngLat.lng, e.lngLat.lat, e.point);
    drawHover = snap ? snap.coord : [e.lngLat.lng, e.lngLat.lat];
    setDrawSnap(snap ? snap.edge : null);
    map.getCanvas().style.cursor = 'crosshair';
    updateDraw();
    return;
  }

  const id = territorioAtLngLat(e.lngLat.lng, e.lngLat.lat);

  if (id !== territorioHoverId) {
    setTerritorioHover(territorioHoverId, false);
    setTerritorioHover(id, true);
    territorioHoverId = id;
  }
  // Feedback: pointer sobre territorio, crosshair donde se puede marcar
  map.getCanvas().style.cursor = id ? 'pointer' : 'crosshair';
}

function onMapDblClick(e) {
  if (drawActive) {
    if (document.getElementById('territorioModal').classList.contains('visible')) return;
    e.preventDefault();

    // Los clics previos al doble clic dejaron vértices repetidos en la misma
    // ubicación: los quitamos (solo si son duplicados entre sí)
    while (
      drawVerts.length >= 4 &&
      distPx(drawVerts[drawVerts.length - 1], e.point) <= 12 &&
      distPx(drawVerts[drawVerts.length - 1], map.project(drawVerts[drawVerts.length - 2])) <= 12
    ) {
      drawVerts.pop();
    }
    drawHover = null;
    closeDraw();
    return;
  }

  if (refMode) return; // modo referencia: sin cambios

  // Modo normal: corta el zoom de MapLibre. Si hay territorio, los clics previos
  // ya resolvieron (seleccionar/marcar); sin territorio, el doble clic marca.
  e.preventDefault();
  if (territorioAtLngLat(e.lngLat.lng, e.lngLat.lat)) return;
  placeTempMarker(e.lngLat.lng, e.lngLat.lat);
}

function closeDraw() {
  if (drawVerts.length < 3) {
    toast('Necesitas al menos 3 vértices para cerrar un territorio', true);
    return;
  }

  const ring = drawVerts.concat([drawVerts[0]]);
  if (Math.abs(ringArea(ring)) < 1e-11) {
    toast('El polígono es demasiado pequeño', true);
    return;
  }

  const count = countPointsInRing(ring);
  pendingTerritorio = { ring, color: drawColor, comuna: comunaSel.value || null, count };

  document.getElementById('territorioNombre').value = `Territorio ${allTerritorios.length + 1}`;
  document.getElementById('territorioCount').innerHTML =
    `<span class="swatch" style="background:${escapeHtml(drawColor)}"></span>` +
    `${count} punto${count === 1 ? '' : 's'} incluido${count === 1 ? '' : 's'}`;
  document.getElementById('territorioErr').textContent = '';
  document.getElementById('territorioModal').classList.add('visible');

  drawHover = null;
  setDrawSnap(null);
  updateDraw();
}


async function saveTerritorio() {
  if (!pendingTerritorio) return;
  const err = document.getElementById('territorioErr');
  const nombre =
    document.getElementById('territorioNombre').value.trim() || `Territorio ${allTerritorios.length + 1}`;

  // guardar_territorio recorta en el servidor: contra la comuna (nunca sale)
  // y contra los territorios existentes (cero solapes)
  const { data, error } = await db.rpc('guardar_territorio', {
    p_comuna: pendingTerritorio.comuna,
    p_nombre: nombre,
    p_color: pendingTerritorio.color,
    p_geom: ringToEwkt(pendingTerritorio.ring),
  });
  if (error) {
    const missing = /could not find the function|does not exist/i.test(error.message || '');
    err.textContent = missing
      ? 'Falta la función SQL: ejecuta la sección 8 de schema.sql en Supabase'
      : (error.message || 'No se pudo guardar el territorio');
    return;
  }

  pendingTerritorio = null;
  document.getElementById('territorioModal').classList.remove('visible');
  stopDraw();
  await loadTerritorios();
  // La DB reasigna los puntos incluidos (trigger por geometría); recargarlos
  // evita que el panel de asignación los vea sin territorio_id.
  await loadPoints();

  // Recién tras el recorte se cuentan los puntos que quedaron dentro
  const saved = data && data.id ? allTerritorios.find((s) => s.id === data.id) : null;
  const n = saved ? countPointsInTerritorio(saved) : 0;
  const pts = `· ${n} punto${n === 1 ? '' : 's'} incluido${n === 1 ? '' : 's'}`;
  if (data && data.recortado) {
    toast(`Territorio guardado recortado a los límites · ${data.pct}% del área dibujada ${pts}`);
  } else {
    toast(`Territorio guardado ${pts}`);
  }
}

// --- Toolbar y atajos ---
const drawPalette = document.getElementById('drawPalette');
TERRITORIO_COLORS.forEach((c) => {
  const chip = document.createElement('button');
  chip.className = 'chip' + (c === drawColor ? ' selected' : '');
  chip.style.background = c;
  chip.title = 'Color del territorio';
  chip.addEventListener('click', () => {
    drawColor = c;
    drawPalette.querySelectorAll('.chip').forEach((x) => x.classList.remove('selected'));
    chip.classList.add('selected');
    setDrawColor(c);
  });
  drawPalette.appendChild(chip);
});

document.getElementById('drawBtn').addEventListener('click', startDraw);
document.getElementById('drawUndo').addEventListener('click', () => { drawVerts.pop(); updateDraw(); });
document.getElementById('drawCancel').addEventListener('click', () => stopDraw());
document.getElementById('drawClose').addEventListener('click', () => { drawHover = null; closeDraw(); });
document.getElementById('territorioCancelBtn').addEventListener('click', () => {
  pendingTerritorio = null;
  document.getElementById('territorioModal').classList.remove('visible');
});
document.getElementById('territorioSaveBtn').addEventListener('click', saveTerritorio);
document.getElementById('allTerritoriosBtn').addEventListener('click', () => setTerritorioSelected(null));

// --- Accesibilidad de modales ---------------------------------------------
// Tab/Shift+Tab giran dentro del panel abierto, el foco entra al abrir y
// vuelve al botón que lo abrió al cerrar. Para cerrar, Esc está en el
// listener que sigue a este bloque.
const MODALES = ['modal', 'pointDetail', 'territorioModal', 'settingsModal', 'puntoHistorial'];
const FOCOABLE = 'a[href], button:not([disabled]), input:not([disabled]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function modalVisible() {
  for (const id of MODALES) {
    const el = document.getElementById(id);
    if (el && el.classList.contains('visible')) return el;
  }
  return null;
}

function enfocarPrimero(cont) {
  const el = [...cont.querySelectorAll(FOCOABLE)]
    .find((x) => x.offsetParent !== null);   // los ocultos no reciben foco
  if (el) el.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const cont = modalVisible();
  if (!cont) return;
  const items = [...cont.querySelectorAll(FOCOABLE)].filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const primero = items[0];
  const ultimo = items[items.length - 1];
  const activo = document.activeElement;
  if (cont.contains(activo)) {
    if (e.shiftKey && activo === primero) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && activo === ultimo) { e.preventDefault(); primero.focus(); }
  } else {
    e.preventDefault();
    (e.shiftKey ? ultimo : primero).focus();
  }
});

// Al cambiar la clase .visible: guardar quién tenía el foco, enfocar el
// panel; al cerrar, devolverlo. Un único observer para los cinco modales.
let modalActual = null;
let modalOpener = null;
const modalObs = new MutationObserver(() => {
  const cont = modalVisible();
  if (cont && cont !== modalActual) {
    modalOpener = document.activeElement;
    modalActual = cont;
    enfocarPrimero(cont);
  } else if (!cont && modalActual) {
    const volver = modalOpener;
    modalActual = null;
    modalOpener = null;
    if (volver && volver !== document.body && document.contains(volver)) volver.focus();
  }
});
MODALES.forEach((id) => {
  const el = document.getElementById(id);
  if (el) modalObs.observe(el, { attributes: true, attributeFilter: ['class'] });
});

document.addEventListener('keydown', (e) => {
  const typing = e.target && e.target.matches && e.target.matches('input, textarea');

  if (e.key === 'Escape') {
    if (assignMode) {
      assignMode = null;
      renderAssign();
      return;
    }
    if (document.getElementById('puntoHistorial').classList.contains('visible')) {
      cerrarHistorialPunto();
      return;
    }
    if (document.getElementById('pointDetail').classList.contains('visible')) {
      closePointDetail();
      return;
    }
    if (settingsModal.classList.contains('visible')) {
      settingsModal.classList.remove('visible');
      return;
    }
    if (document.getElementById('territorioModal').classList.contains('visible')) {
      pendingTerritorio = null;
      document.getElementById('territorioModal').classList.remove('visible');
      return;
    }
    if (drawActive) { stopDraw(); return; }
    if (territorioSelectedId) setTerritorioSelected(null);
    return;
  }

  if (!typing && drawActive && (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    drawVerts.pop();
    updateDraw();
  }
});


// ============================================================
// BUSCADOR UNIFICADO (dirección · coordenadas · link Google Maps)
// Vuela al lugar, marca el punto con el popup "Guardar punto aquí"
// (mismo flujo que un clic en el mapa dentro de un territorio).
// ============================================================
let lastGeocode = null; // { lat, lng, direccion } para precargar el modal

const searchFab = document.getElementById('searchFab');
const searchOverlay = document.getElementById('searchOverlay');
const smartSearch = document.getElementById('smartSearch');

searchFab.addEventListener('click', () => {
  const open = !searchOverlay.classList.contains('visible');
  searchOverlay.classList.toggle('visible', open);
  if (open) smartSearch.focus();
});
document.getElementById('searchCloseBtn').addEventListener('click', closeSearchOverlay);
function closeSearchOverlay() {
  searchOverlay.classList.remove('visible');
}
smartSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSmartSearch();
  if (e.key === 'Escape') closeSearchOverlay();
});

async function doSmartSearch() {
  const q = smartSearch.value.trim();
  if (!q) return;

  // 1) Link de Google Maps (contiene dominio o @lat,lng)
  if (/google\.com|goo\.gl|maps\.app|@-?\d/.test(q)) {
    return searchFromLink(q);
  }

  // 2) Coordenadas sueltas: "-33.45, -70.66" (coma, punto y coma o espacio)
  const c = parseCoordQuery(q);
  if (c) return flyMarkAndToast(c.lng, c.lat, `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);

  // 3) Texto libre → geocodificar con Nominatim (Chile), con caché y ≤1 req/s
  try {
    const data = await geocodificar(q);
    if (!data.length) return toast('Dirección no encontrada', true);
    const { lat, lon, display_name } = data[0];
    lastGeocode = { lat: parseFloat(lat), lng: parseFloat(lon), direccion: display_name };
    flyMarkAndToast(parseFloat(lon), parseFloat(lat), display_name);
  } catch (_err) {
    toast('Error en la búsqueda', true);
  }
}

// --- Geocodificación (T15): caché local + espacio mínimo entre peticiones --
const GEO_LS = 'gps_geo_cache';
let geoCache = geoCargarCache();
let geoUltimaPet = 0;

function geoCargarCache() {
  try {
    const v = JSON.parse(localStorage.getItem(GEO_LS));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

function geoGuardarCache() {
  try {
    localStorage.setItem(GEO_LS, JSON.stringify(geoCache));
  } catch (_) {}
}

// Misma query repetida → respuesta del caché sin salir de la máquina.
// Si toca petición, espera lo que falte para respetar 1 petición/s y guarda
// el resultado (también los vacíos: una dirección inexistente no debe volver
// a consultarse).
async function geocodificar(q) {
  const ahora = Date.now();
  const hit = geoCacheLeer(geoCache, q, ahora);
  if (hit) return hit;

  const espera = GEO_MIN_MS - (ahora - geoUltimaPet);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=cl&q=${encodeURIComponent(q)}`;
  geoUltimaPet = Date.now();
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);

  const data = await res.json();
  geoCache = geoCachePoner(geoCache, q, data, Date.now());
  geoGuardarCache();
  return Array.isArray(data) ? data : [];
}

function searchFromLink(url) {
  const c = coordsFromLink(url);
  if (!c) return toast('No pude extraer coordenadas del link', true);
  flyMarkAndToast(c.lng, c.lat, `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);
}

function flyMarkAndToast(lng, lat, label) {
  map.flyTo({ center: [lng, lat], zoom: 16 });
  placeTempMarker(lng, lat);
  toast(`Ubicación encontrada: ${label}`);
}

// ============================================================
// MODO REFERENCIA
// ============================================================
const refBtn = document.getElementById('refBtn');
const refPanel = document.getElementById('refPanel');
const refRadius = document.getElementById('refRadius');
const refRadiusVal = document.getElementById('refRadiusVal');

refBtn.addEventListener('click', () => {
  refMode = !refMode;
  refBtn.classList.toggle('active', refMode);
  refBtn.title = refMode ? 'Modo referencia (activo) — haz clic en el mapa' : 'Modo referencia';
  if (!refMode) {
    clearReference();
  } else {
    toast('Haz clic en el mapa para marcar la referencia');
  }
});

document.getElementById('refClose').addEventListener('click', () => {
  clearReference();
  refMode = false;
  refBtn.classList.remove('active');
  refBtn.title = 'Modo referencia';
});

refRadius.addEventListener('input', () => {
  const r = parseInt(refRadius.value);
  refRadiusVal.textContent = r >= 1000 ? (r / 1000).toFixed(1) + ' km' : r + ' m';
  if (!refMarker) return;
  updateRefCircle();
  clearTimeout(refRadiusTimer);
  refRadiusTimer = setTimeout(() => {
    if (!refMarker) return;
    const c = refMarker.getLngLat();
    searchInRadius(c.lat, c.lng, r);
  }, 250);
});

function setReferencePoint(lng, lat) {
  if (refMarker) refMarker.remove();

  const el = document.createElement('div');
  el.className = 'pin-wrap';
  el.innerHTML = '<div class="pin" data-est="ref"><span class="ms pin-ic">my_location</span></div>';
  refMarker = new maplibregl.Marker({ element: el })
    .setLngLat([lng, lat])
    .addTo(map);

  document.getElementById('refCoord').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  refPanel.classList.add('visible');
  updateRefCircleAndSearch();
}

function updateRefCircle() {
  if (!refMarker) return null;
  const center = refMarker.getLngLat();
  const radius = parseInt(refRadius.value);

  // Círculo (reemplaza la fuente si ya existe)
  if (map.getLayer('ref-circle-fill')) map.removeLayer('ref-circle-fill');
  if (map.getLayer('ref-circle-line')) map.removeLayer('ref-circle-line');
  if (map.getSource('ref-circle')) map.removeSource('ref-circle');

  const circleGeoJSON = createCircle(center.lng, center.lat, radius);
  map.addSource('ref-circle', { type: 'geojson', data: circleGeoJSON });
  map.addLayer({
    id: 'ref-circle-fill',
    type: 'fill',
    source: 'ref-circle',
    paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 },
  });
  map.addLayer({
    id: 'ref-circle-line',
    type: 'line',
    source: 'ref-circle',
    paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [3,2] },
  });

  return { center, radius };
}

function updateRefCircleAndSearch() {
  const ctx = updateRefCircle();
  if (ctx) searchInRadius(ctx.center.lat, ctx.center.lng, ctx.radius);
}


async function searchInRadius(lat, lng, radio) {
  const { data, error } = await db.rpc('puntos_en_radio', {
    lat, lng, radio_m: radio,
  });

  const results = document.getElementById('refResults');
  if (error) { results.innerHTML = `<div class="empty">Error: ${escapeHtml(error.message || '')}</div>`; return; }

  refResultsIds = new Set((data || []).map((p) => p.id));
  renderMarkers();
  renderList();

  if (!data || !data.length) {
    results.innerHTML = '<div class="empty">Sin direcciones cercanas</div>';
    return;
  }

  results.innerHTML =
    `<div class="count">${data.length} punto${data.length === 1 ? '' : 's'} en radio</div>` +
    data.map((p) => `
    <div class="item" data-id="${p.id}">
      <b>${escapeHtml(p.nombre)}</b><br>
      <small>${escapeHtml(p.direccion || '')}</small>
    </div>
  `).join('');

  results.querySelectorAll('.item').forEach((el) => {
    el.addEventListener('click', () => focusPoint(el.dataset.id));
  });
}

function clearReference() {
  if (refMarker) { refMarker.remove(); refMarker = null; }
  if (map.getLayer('ref-circle-fill')) map.removeLayer('ref-circle-fill');
  if (map.getLayer('ref-circle-line')) map.removeLayer('ref-circle-line');
  if (map.getSource('ref-circle')) map.removeSource('ref-circle');
  refPanel.classList.remove('visible');
  refResultsIds = new Set();
  renderMarkers();
  renderList();
}

// ============================================================
// BOTONES GLOBALES
// ============================================================
document.getElementById('newPointFab').addEventListener('click', () => openNewModal());

// T8: responsive — el panel es overlay en pantallas angostas
function isNarrow() {
  return window.matchMedia('(max-width: 860px)').matches;
}

// ============================================================
// PANEL A/B: comuna·territorio (A) y puntos (B), con riel de flechas
// Cada columna ocupa su ancho propio (X); cerrada desaparece por completo,
// sin espacio fantasma. Con ambas cerradas el mapa ocupa toda la pantalla.
// Estados del riel: A abierta+B cerrada (default) → ◄► · B abierta → ◄
// (cierra B) · A y B cerradas → ► (reabre A).
// ============================================================
let colAAbierta = true;
let colBAbierta = false;

function pintarPanel() {
  document.getElementById('colTerr').classList.toggle('collapsed', !colAAbierta);
  document.getElementById('colPuntos').classList.toggle('collapsed', !colBAbierta);
  const vacio = !colAAbierta && !colBAbierta;
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('main');
  sidebar.classList.toggle('sin-panel', vacio);
  main.style.setProperty('--panel-w', vacio ? '0px' : sidebar.offsetWidth + 'px');
  const izq = document.getElementById('railIzq');
  const der = document.getElementById('railDer');
  if (colBAbierta) { izq.hidden = false; der.hidden = true; }
  else if (colAAbierta) { izq.hidden = false; der.hidden = false; }
  else { izq.hidden = true; der.hidden = false; }
  setTimeout(() => map && map.resize(), 60);
}

document.getElementById('railIzq').addEventListener('click', () => {
  if (isNarrow()) closeSearchOverlay();
  if (colBAbierta) colBAbierta = false;
  else colAAbierta = false;
  pintarPanel();
});
document.getElementById('railDer').addEventListener('click', () => {
  if (!colAAbierta) colAAbierta = true;
  else colBAbierta = true;
  pintarPanel();
});

// Default al abrir: columna A visible, columna B cerrada
function applyInitialSidebarState() {
  pintarPanel();
}

// ============================================================
// VISTAS: TERRITORIOS · HISTORIAL · USUARIOS
// ============================================================
function setView(name) {
  const views = { territorios: 'main', historial: 'viewHistorial', usuarios: 'viewUsuarios', actividad: 'viewActividad' };
  if (!views[name]) return;
  const cambio = currentView !== name;
  currentView = name;

  document.querySelectorAll('#mainNav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  document.getElementById('main').style.display = name === 'territorios' ? 'flex' : 'none';
  document.getElementById('viewHistorial').style.display = name === 'historial' ? 'flex' : 'none';
  document.getElementById('viewUsuarios').style.display = name === 'usuarios' ? 'flex' : 'none';
  document.getElementById('viewActividad').style.display = name === 'actividad' ? 'flex' : 'none';

  if (name === 'territorios') {
    if (map && cambio) map.resize();   // el contenedor estaba oculto
  } else if (name === 'historial') {
    loadHistorial();
  } else if (name === 'usuarios') {
    loadUsuariosView();
  } else if (name === 'actividad') {
    loadActividad();
  }
}

function fmtFechaHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d)
    ? '—'
    : d.toLocaleDateString('es-CL') + ' · ' +
      d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

// ============================================================
// NUEVA ACTIVIDAD: doble chequeo de erroneo/no_pasar + puntos nuevos
// El campo «estado» lo pone el usuario de terreno; «verificado» lo maneja el
// admin (directo o vía tarea especial asignada a un usuario X).
// ============================================================
let actTareas = {};    // punto_id -> tarea pendiente { id, user_id }
let actUsuarios = [];  // [{id, email}] para asignar y mostrar el autor

// Clasificación de un punto para esta vista (null = no corresponde)
function puntoRequiereActividad(p) {
  if (p.aceptado_at == null) return 'nuevo';
  if ((p.estado === 'erroneo' || p.estado === 'no_pasar') && !p.verificado) return 'verificar';
  return null;
}

async function loadActividad() {
  if (!isAdmin) return;
  if (!actUsuarios.length) {
    try { actUsuarios = (await db.rpc('listar_usuarios')).data || []; }
    catch (_) { actUsuarios = []; }
  }
  const { data: tareas, error: errT } = await db
    .from('tareas_verificacion')
    .select('id, punto_id, user_id, estado')
    .eq('estado', 'pendiente');
  if (errT) toast('No se pudieron cargar las tareas: ' + errT.message, true);
  actTareas = {};
  (tareas || []).forEach((t) => { actTareas[t.punto_id] = t; });

  // Feed de actividad reciente (tabla mensajes, disparada por triggers)
  const { data: msgs, error: errM } = await db
    .from('mensajes')
    .select('id, tipo, titulo, detalle, actor, territorio_id, punto_id, leido, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (errM) toast('No se pudo cargar la actividad: ' + errM.message, true);
  renderMensajes(msgs || []);
  actualizarBadge(msgs || []);

  renderActividadTabla(
    allPoints.filter((p) => puntoRequiereActividad(p) === 'nuevo'),
    allPoints.filter((p) => puntoRequiereActividad(p) === 'verificar')
  );

  // Solicitudes de puntos nuevos enviadas desde el móvil
  const { data: sols, error: errS } = await db
    .from('puntos_solicitudes')
    .select('id, user_id, nombre, direccion, notas, lat, lng, created_at')
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: false });
  if (errS) toast('No se pudieron cargar las solicitudes: ' + errS.message, true);
  renderSolicitudes(sols || []);
}

function renderSolicitudes(sols) {
  const box = document.getElementById('actSolicitudes');
  if (!box) return;
  const fila = (s) => `<tr data-sol="${s.id}">
      <td><b>${escapeHtml(s.nombre || 'Sin nombre')}</b>
        <small>${escapeHtml(s.direccion || `${Number(s.lat).toFixed(5)}, ${Number(s.lng).toFixed(5)}`)}</small>
        ${s.notas ? `<small>Notas: ${escapeHtml(s.notas)}</small>` : ''}
        <small>Enviada por ${escapeHtml(emailDeUsuario(s.user_id))}</small>
      </td>
      <td class="act-acc">
        <button type="button" class="secondary" data-sol-ok="${s.id}">Confirmar</button>
        <button type="button" class="ghost" data-sol-no="${s.id}">Rechazar</button>
        <a class="ghost icon" href="https://www.google.com/maps?q=${Number(s.lat)},${Number(s.lng)}"
           target="_blank" rel="noopener" title="Ver en el mapa" aria-label="Ver en el mapa"><span class="ms ms-sm">map</span></a>
      </td>
    </tr>`;
  box.innerHTML = `
    <h3 class="act-h">Solicitudes de puntos nuevos <span class="act-count">${sols.length}</span></h3>
    ${sols.length
      ? `<table class="act-tabla"><thead><tr><th>Punto (solicitante)</th><th class="act-th-acc">Acciones</th></tr></thead><tbody>${sols.map(fila).join('')}</tbody></table>`
      : '<div class="empty">No hay solicitudes de puntos pendientes</div>'}`;

  box.querySelectorAll('[data-sol-ok]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const { error } = await db.rpc('confirmar_solicitud', { p_solicitud: b.dataset.solOk });
    if (error) { toast(error.message, true); b.disabled = false; return; }
    toast('Solicitud confirmada: punto creado');
    await loadPoints();
    loadActividad();
  }));

  box.querySelectorAll('[data-sol-no]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const motivo = prompt('Motivo del rechazo (opcional):') ?? '';
    const { error } = await db.rpc('rechazar_solicitud', { p_solicitud: b.dataset.solNo, p_motivo: motivo });
    if (error) { toast(error.message, true); b.disabled = false; return; }
    toast('Solicitud rechazada');
    loadActividad();
  }));
}

function emailDeUsuario(uid) {
  const u = actUsuarios.find((x) => x.id === uid);
  return u ? (u.email || 'usuario') : 'usuario';
}

function fmtRel(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return 'hace ' + min + ' min';
  const h = Math.floor(min / 60);
  if (h < 24) return 'hace ' + h + ' h';
  const d = Math.floor(h / 24);
  return 'hace ' + d + ' d';
}

const MSG_ICONS = {
  asignacion: 'assignment_turn_in',
  devolucion: 'assignment_return',
  completado: 'task_alt',
  solicitud: 'add_circle',
  solicitud_resuelta: 'rule',
  verificacion: 'rule',
  punto_nuevo: 'add_pin',
  punto_aceptado: 'check_circle',
};

function actualizarBadge(msgs) {
  const badge = document.getElementById('actBadge');
  if (!badge) return;
  const n = msgs.filter((m) => !m.leido).length;
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
}

function renderMensajes(msgs) {
  const box = document.getElementById('actMensajes');
  if (!box) return;
  const fila = (m) => `<div class="msg${m.leido ? '' : ' unread'}" data-msg="${m.id}">
      <span class="ms msg-ic" aria-hidden="true">${MSG_ICONS[m.tipo] || 'info'}</span>
      <div class="msg-body">
        <b>${escapeHtml(m.titulo)}</b>
        ${m.detalle ? `<small>${escapeHtml(m.detalle)}</small>` : ''}
        <small class="msg-time">${fmtRel(m.created_at)}</small>
      </div>
      <div class="msg-acc">
        ${m.leido ? '' : `<button type="button" class="ghost" data-msg-leer="${m.id}">Leído</button>`}
        <button type="button" class="ghost icon" data-msg-borrar="${m.id}" title="Borrar mensaje" aria-label="Borrar mensaje"><span class="ms ms-sm">delete</span></button>
      </div>
    </div>`;
  box.innerHTML = `
    <h3 class="act-h">Actividad reciente <span class="act-count">${msgs.length}</span></h3>
    ${msgs.length
      ? `<div class="msg-feed">${msgs.map(fila).join('')}</div>`
      : '<div class="empty">Sin actividad registrada</div>'}`;

  box.querySelectorAll('[data-msg-leer]').forEach((b) => b.addEventListener('click', async () => {
    const { error } = await db.from('mensajes').update({ leido: true }).eq('id', b.dataset.msgLeer);
    if (error) return toast(error.message, true);
    loadActividad();
  }));

  box.querySelectorAll('[data-msg-borrar]').forEach((b) => b.addEventListener('click', async () => {
    const { error } = await db.from('mensajes').delete().eq('id', b.dataset.msgBorrar);
    if (error) return toast(error.message, true);
    loadActividad();
  }));
}

function renderActividadTabla(nuevos, verificar) {
  const box = document.getElementById('actTabla');
  if (!box) return;
  const opcionesUsuarios = actUsuarios
    .map((u) => `<option value="${u.id}">${escapeHtml(u.email)}</option>`)
    .join('');

  const filaVerificar = (p) => {
    const tarea = actTareas[p.id];
    const asignacion = tarea
      ? `<span class="who">Tarea: ${escapeHtml(emailDeUsuario(tarea.user_id))}</span>
         <button type="button" class="ghost" data-cancelar="${tarea.id}">Cancelar tarea</button>`
      : `<select class="act-user" aria-label="Asignar verificación"><option value="">Asignar a…</option>${opcionesUsuarios}</select>
         <button type="button" class="ghost" data-asignar="${p.id}">Asignar</button>`;
    return `<tr data-punto="${p.id}">
      <td><b>${escapeHtml(p.nombre || 'Sin nombre')}</b><small>${escapeHtml(p.direccion || '—')}</small></td>
      <td><span class="estado-tag ${estadoClass(p.estado)}">${estadoLabel(p.estado)}</span></td>
      <td class="act-acc">${asignacion}
        <button type="button" class="secondary" data-resolver="${p.id}" data-res="confirmado">Confirmar</button>
        <button type="button" class="ghost" data-resolver="${p.id}" data-res="rechazado">Rechazar</button>
        <button type="button" class="ghost icon" data-vermapa="${p.id}" title="Ver en el mapa" aria-label="Ver en el mapa"><span class="ms ms-sm">map</span></button>
      </td>
    </tr>`;
  };

  const filaNuevo = (p) => `<tr data-punto="${p.id}">
      <td><b>${escapeHtml(p.nombre || 'Sin nombre')}</b><small>${escapeHtml(p.direccion || '—')}</small></td>
      <td><span class="estado-tag ${estadoClass(p.estado || 'pendiente')}">${estadoLabel(p.estado || 'pendiente')}</span></td>
      <td class="act-acc">
        <button type="button" class="secondary" data-aceptar="${p.id}">Aceptar</button>
        <button type="button" class="ghost icon" data-vermapa="${p.id}" title="Ver en el mapa" aria-label="Ver en el mapa"><span class="ms ms-sm">map</span></button>
      </td>
    </tr>`;

  box.innerHTML = `
    <h3 class="act-h">Por verificar <span class="act-count">${verificar.length}</span></h3>
    ${verificar.length
      ? `<table class="act-tabla"><thead><tr><th>Punto</th><th>Estado (usuario)</th><th class="act-th-acc">Doble chequeo</th></tr></thead><tbody>${verificar.map(filaVerificar).join('')}</tbody></table>`
      : '<div class="empty">Nada pendiente de verificación</div>'}
    <h3 class="act-h">Puntos nuevos <span class="act-count">${nuevos.length}</span></h3>
    ${nuevos.length
      ? `<table class="act-tabla"><thead><tr><th>Punto</th><th>Estado</th><th class="act-th-acc">Acciones</th></tr></thead><tbody>${nuevos.map(filaNuevo).join('')}</tbody></table>`
      : '<div class="empty">No hay puntos nuevos por aceptar</div>'}`;

  box.querySelectorAll('[data-aceptar]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const { error } = await db.rpc('aceptar_punto', { p_punto: b.dataset.aceptar });
    if (error) { toast(error.message, true); b.disabled = false; return; }
    toast('Punto aceptado');
    await loadPoints();
    loadActividad();
  }));

  box.querySelectorAll('[data-resolver]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const { error } = await db.rpc('resolver_verificacion', {
      p_punto: b.dataset.resolver,
      p_resultado: b.dataset.res,
    });
    if (error) { toast(error.message, true); b.disabled = false; return; }
    toast(b.dataset.res === 'confirmado' ? 'Estado confirmado' : 'Rechazado: el punto volvió a pendiente');
    await loadPoints();
    loadActividad();
  }));

  box.querySelectorAll('[data-asignar]').forEach((b) => b.addEventListener('click', async () => {
    const sel = b.closest('td').querySelector('.act-user');
    if (!sel || !sel.value) return toast('Elige un usuario primero', true);
    b.disabled = true;
    const { error } = await db.from('tareas_verificacion').insert({
      punto_id: b.dataset.asignar,
      user_id: sel.value,
      asignado_por: currentUser.id,
    });
    if (error) { toast(error.message, true); b.disabled = false; return; }
    toast('Tarea de verificación asignada');
    loadActividad();
  }));

  box.querySelectorAll('[data-cancelar]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const { error } = await db.from('tareas_verificacion').delete().eq('id', b.dataset.cancelar);
    if (error) { toast(error.message, true); b.disabled = false; return; }
    toast('Tarea cancelada');
    loadActividad();
  }));

  box.querySelectorAll('[data-vermapa]').forEach((b) => b.addEventListener('click', () => {
    setView('territorios');
    focusPoint(b.dataset.vermapa);
  }));
}

document.getElementById('actRefreshBtn').addEventListener('click', () => loadActividad());

// "Marcar todo leído" y "Vaciar actividad" (solo admin: la RLS lo exige)
document.getElementById('actLeerTodoBtn')?.addEventListener('click', async () => {
  const { error } = await db.from('mensajes').update({ leido: true }).eq('leido', false);
  if (error) return toast(error.message, true);
  toast('Actividad marcada como leída');
  loadActividad();
});
document.getElementById('actVaciarBtn')?.addEventListener('click', async () => {
  if (!confirm('¿Vaciar toda la actividad registrada?')) return;
  // PostgREST exige WHERE en todo DELETE: filtro siempre-verdadero (ningún id
  // es el uuid cero) para vaciar la tabla completa
  const { error } = await db.from('mensajes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return toast(error.message, true);
  toast('Actividad vaciada');
  loadActividad();
});

// Etiquetas del ciclo de vida de una asignación (En proceso / Devuelto / Completado)
const ESTADO_ASIG = { activa: 'En proceso', devuelta: 'Devuelto', completado: 'Completado' };

function loadHistorial() {
  return histTab === 'territorios' ? loadHistorialTerritorios() : loadHistorialPuntos();
}

// ============================================================
// FILTRO POR COMUNA DEL HISTORIAL
// ============================================================
// Aplica a las dos pestañas (Territorios y Puntos) y también al CSV, para que
// lo que exportas es lo que ves. Va en el <select> del encabezado y se
// recuerda en la sesión. Va con TODAS las comunas, no solo con las activas:
// desactivar una comuna no debería ocultar su historial.
const histComunaSel = document.getElementById('histComunaSel');

function populateHistComunaFilter() {
  const prev = histComunaSel.value || prefGet('histComuna');
  const names = todasLasComunas()
    .slice()
    .sort((a, b) => a.localeCompare(b, 'es'));
  histComunaSel.innerHTML =
    '<option value="">Todas las comunas</option>' +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  histComunaSel.value = names.includes(prev) ? prev : '';
}

// Comuna elegida (vacío = todas)
function histComuna() {
  return histComunaSel.value || '';
}

// ============================================================
// EXPORTACIÓN (Historial · Usuarios · modales · territorio)
// ============================================================
// El escapado (csvEscape) y el armado del GeoJSON viven en lib.js: son puros
// y están testeados. Aquí solo está el disparo de la descarga.

function descargarBlob(nombre, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// CSV con BOM, para que Excel abra bien los acentos
function descargarCsv(nombreBase, cabeceras, filas) {
  const csv = [cabeceras, ...filas]
    .map((f) => f.map(csvEscape).join(','))
    .join('\r\n');
  descargarBlob(
    `${nombreBase}-${new Date().toISOString().slice(0, 10)}.csv`,
    new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }),
  );
}

function descargarJson(nombreBase, objeto) {
  descargarBlob(
    `${nombreBase}-${new Date().toISOString().slice(0, 10)}.geojson`,
    new Blob([JSON.stringify(objeto, null, 2)], { type: 'application/geo+json;' }),
  );
}

// Último dataset cargado en el modal (#phExport)
let phCsv = null;

async function exportarHistorialCsv() {
  const esTerr = histTab === 'territorios';

  if (esTerr) {
    const [rt, ra] = await Promise.all([
      db.from('territorios').select('id, nombre, comuna'),
      db.from('territorios_asignaciones')
        .select('territorio_id, user_id, assigned_at, estado, notas, devuelta_at, completado_at'),
    ]);
    const error = rt.error || ra.error;
    if (error) return toast(error.message, true);

    const porId = new Map((rt.data || []).map((t) => [t.id, t]));
    const cabeceras = ['Comuna', 'Territorio', 'Proceso', 'Usuario', 'Asignado', 'Cierre', 'Estado', 'Notas'];

    // Todos los procesos, agrupados por territorio y numerados cronológicamente
    const porTerr = new Map();
    for (const a of ra.data || []) {
      if (!porTerr.has(a.territorio_id)) porTerr.set(a.territorio_id, []);
      porTerr.get(a.territorio_id).push(a);
    }

    const comuna = histComuna();
    const filas = [];
    // Solo los territorios de la comuna elegida (el select del encabezado)
    const entradas = [...porTerr.entries()].filter(([tid]) => {
      const t = porId.get(tid);
      return t && (!comuna || t.comuna === comuna);
    });
    for (const [tid, lista] of entradas.sort(
      (x, y) => {
        const a = porId.get(x[0]), b = porId.get(y[0]);
        return String(a?.comuna || '').localeCompare(String(b?.comuna || ''), 'es')
          || String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es');
      },
    )) {
      const t = porId.get(tid) || {};
      const orden = lista.slice().sort(
        (a, b) => new Date(a.assigned_at || 0) - new Date(b.assigned_at || 0),
      );
      orden.forEach((a, i) => {
        const est = ESTADO_ASIG[a.estado] ? a.estado : 'activa';
        const cierre = est === 'completado' ? a.completado_at
          : est === 'devuelta' ? a.devuelta_at : null;
        filas.push([
          t.comuna || '', t.nombre || '', i + 1, emailDe(a.user_id) || '',
          a.assigned_at || '', cierre || '', ESTADO_ASIG[est], a.notas || '',
        ]);
      });
    }
    descargarCsv(comuna ? `historial-territorios-${slugNombre(comuna)}` : 'historial-territorios', cabeceras, filas);
    return;
  }

  // Pestaña Puntos
  const { data, error } = await db
    .from('puntos')
    .select('nombre, estado, ultima_visita, notas, territorio_id, territorios(nombre, comuna)')
    .is('deleted_at', null)
    .order('nombre');
  if (error) return toast(error.message, true);

  const comuna = histComuna();
  const cabeceras = ['Comuna', 'Territorio', 'Punto', 'Última visita', 'Estado', 'No pasar', 'Erróneo', 'Activo', 'Notas'];
  const filas = (data || [])
    .filter((p) => !comuna || (p.territorios && p.territorios.comuna) === comuna)
    .map((p) => {
      const t = p.territorios;
      const est = p.estado || 'pendiente';
      const activo = est !== 'erroneo' && est !== 'no_pasar';
      return [
        (t && t.comuna) || '', (t && t.nombre) || '', p.nombre || '',
        p.ultima_visita || '', estadoLabel(est),
        est === 'no_pasar' ? 'Sí' : '', est === 'erroneo' ? 'Sí' : '',
        activo ? 'Sí' : 'No', p.notas || '',
      ];
    });
  descargarCsv(comuna ? `historial-puntos-${slugNombre(comuna)}` : 'historial-puntos', cabeceras, filas);
}

async function exportarUsuariosCsv() {
  const { data, error } = await db.rpc('listar_usuarios');
  if (error) return toast(error.message, true);
  const cabeceras = ['Email', 'Rol', 'Territorio en curso', 'Desde'];
  const filas = (data || []).map((u) => [
    u.email || '', u.is_admin ? 'Administrador' : 'Usuario',
    u.territorio || '', u.desde || '',
  ]);
  descargarCsv('usuarios', cabeceras, filas);
}

// --- Territorio seleccionado: polígono + puntos (T12) -------------------
// Los puntos salen de allPoints (ya tienen lat/lng calculados de geom) y el
// polígono de s.geom, que PostGIS devuelve como GeoJSON.
function puntosDelTerritorio(id) {
  return allPoints.filter((p) => p.territorio_id === id);
}

function slugNombre(v) {
  return String(v || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sin-nombre';
}

function baseTerritorioExport(s) {
  return `territorio-${slugNombre(s.comuna)}-${slugNombre(s.nombre)}`;
}

function exportarTerritorioGeojson(s) {
  const pts = puntosDelTerritorio(s.id);
  descargarJson(baseTerritorioExport(s), territorioFeatureCollection(s, pts));
  toast(`GeoJSON: polígono + ${pts.length} punto${pts.length === 1 ? '' : 's'}`);
}

function exportarTerritorioCsv(s) {
  const pts = puntosDelTerritorio(s.id);
  const cabeceras = ['Punto', 'Dirección', 'Estado', 'Última visita', 'Notas', 'Lat', 'Lng'];
  const filas = pts.map((p) => [
    p.nombre || '', p.direccion || '', estadoLabel(p.estado),
    p.ultima_visita || '', p.notas || '',
    p.lat == null ? '' : p.lat, p.lng == null ? '' : p.lng,
  ]);
  descargarCsv(baseTerritorioExport(s), cabeceras, filas);
  toast(`${filas.length} punto${filas.length === 1 ? '' : 's'} exportado${filas.length === 1 ? '' : 's'}`);
}

document.getElementById('histExportBtn').addEventListener('click', exportarHistorialCsv);
document.getElementById('usuariosExportBtn').addEventListener('click', exportarUsuariosCsv);
document.getElementById('phExport').addEventListener('click', () => {
  if (phCsv) descargarCsv(phCsv.nombre, phCsv.cabeceras, phCsv.filas);
});

async function loadHistorialTerritorios() {
  const box = document.getElementById('histTerritorios');
  if (!box) return;
  box.innerHTML = '<div class="empty">Cargando…</div>';

  const [rt, ra] = await Promise.all([
    db.from('territorios').select('id, nombre, comuna'),
    db.from('territorios_asignaciones')
      .select('territorio_id, user_id, assigned_at, estado, notas, devuelta_at, completado_at'),
  ]);
  const error = rt.error || ra.error;
  if (error) { box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }

  const comuna = histComuna();
  const territorios = (rt.data || [])
    .filter((t) => !comuna || t.comuna === comuna)
    .sort((a, b) => (a.comuna || '').localeCompare(b.comuna || '', 'es')
      || (a.nombre || '').localeCompare(b.nombre || '', 'es'));
  if (!territorios.length) {
    box.innerHTML = `<div class="empty">${comuna ? `Sin territorios en ${escapeHtml(comuna)}` : 'Sin territorios'}</div>`;
    return;
  }

  // Proceso más relevante por territorio: la activa si existe, si no el más reciente.
  const rank = (a) => (a.estado === 'activa' ? 0 : 1);
  const asigPorTerr = new Map();
  for (const a of ra.data || []) {
    const prev = asigPorTerr.get(a.territorio_id);
    if (!prev
      || rank(a) < rank(prev)
      || (rank(a) === rank(prev) && new Date(a.assigned_at) > new Date(prev.assigned_at))) {
      asigPorTerr.set(a.territorio_id, a);
    }
  }

  const filas = territorios.map((t) => {
    const a = asigPorTerr.get(t.id);
    const est = a ? (ESTADO_ASIG[a.estado] ? a.estado : 'activa') : null;
    const cierre = !a ? null
      : est === 'completado' ? a.completado_at
      : est === 'devuelta' ? a.devuelta_at
      : null;
    return `<tr>
      <td>${escapeHtml(t.comuna || '—')}</td>
      <td><b>${escapeHtml(t.nombre || '—')}</b></td>
      <td>${a ? escapeHtml(emailDe(a.user_id) || '—') : '<span class="muted">Sin asignar</span>'}</td>
      <td>${a ? fmtFecha(a.assigned_at) : '—'}</td>
      <td>${a ? `<span class="chip-est ${est}">${ESTADO_ASIG[est]}</span>` : '<span class="muted">Libre</span>'}</td>
      <td>${cierre ? fmtFecha(cierre) : '—'}</td>
      <td class="notas">${a ? escapeHtml(a.notas || '') : ''}</td>
      <td class="col-ver"><button type="button" class="ver-btn" data-territorio="${escapeHtml(t.id)}" data-nombre="${escapeHtml(t.nombre || '')}">Ver</button></td>
    </tr>`;
  }).join('');

  box.innerHTML = `<table class="hist-table">
    <thead><tr>
      <th>Comuna</th><th>Territorio</th><th>Usuario</th><th>Asignado</th>
      <th>Estado</th><th>Cierre</th><th>Notas</th>
      <th class="col-ver-h"></th>
    </tr></thead>
    <tbody>${filas}</tbody>
  </table>`;
}

async function loadHistorialPuntos() {
  const box = document.getElementById('histPuntos');
  if (!box) return;
  box.innerHTML = '<div class="empty">Cargando…</div>';

  const { data, error } = await db
    .from('puntos')
    .select('id, nombre, estado, ultima_visita, notas, territorio_id, territorios(nombre, comuna)')
    .is('deleted_at', null)
    .order('nombre');

  if (error) { box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }

  const comunaFiltro = histComuna();
  const puntosFiltrados = (data || []).filter((p) => !comunaFiltro || (p.territorios && p.territorios.comuna) === comunaFiltro);
  if (!puntosFiltrados.length) {
    box.innerHTML = `<div class="empty">${comunaFiltro ? `Sin puntos en ${escapeHtml(comunaFiltro)}` : 'Sin puntos'}</div>`;
    return;
  }

  // Agrupa: comuna -> territorio -> puntos (para filas combinadas con rowspan)
  const porComuna = new Map();
  for (const p of puntosFiltrados) {
    const t = p.territorios;
    const comuna = (t && t.comuna) || null;
    const terrId = p.territorio_id || null;
    if (!porComuna.has(comuna)) porComuna.set(comuna, new Map());
    const porTerr = porComuna.get(comuna);
    if (!porTerr.has(terrId)) porTerr.set(terrId, { nombre: (t && t.nombre) || null, puntos: [] });
    porTerr.get(terrId).puntos.push(p);
  }

  // Claves alfabéticas; las vacías (Sin comuna / Sin territorio) van al final.
  const ordenarClaves = (m) => {
    const keys = [...m.keys()];
    const llenas = keys.filter((k) => k !== null && k !== '').sort((a, b) => String(a).localeCompare(String(b), 'es'));
    const vacias = keys.filter((k) => k === null || k === '');
    return [...llenas, ...vacias];
  };

  const si = '<span class="mark yes">✓</span>';
  const no = '<span class="mark no">—</span>';
  const filas = [];
  let banda = false;   // alterna el color de fondo de un territorio a otro

  for (const comunaKey of ordenarClaves(porComuna)) {
    const porTerr = porComuna.get(comunaKey);
    const totalComuna = [...porTerr.values()].reduce((n, t) => n + t.puntos.length, 0);
    let comunaPuesta = false;

    for (const terrKey of ordenarClaves(porTerr)) {
      const terr = porTerr.get(terrKey);
      const pts = terr.puntos.slice().sort(
        (a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'),
      );
      const enBanda = banda;
      let terrPuesta = false;

      for (const p of pts) {
        const est = p.estado || 'pendiente';
        const activo = est !== 'erroneo' && est !== 'no_pasar';   // "activo" = no erróneo ni no pasar
        filas.push(`<tr${enBanda ? ' class="band"' : ''}>
          ${comunaPuesta ? '' : `<td class="grp comuna" rowspan="${totalComuna}"><span>${escapeHtml(comunaKey || 'Sin comuna')}</span></td>`}
          ${terrPuesta ? '' : `<td class="grp terr" rowspan="${pts.length}"><span>${escapeHtml(terrKey === null || !terr.nombre ? 'Sin territorio' : terr.nombre)}</span></td>`}
          <td><b>${escapeHtml(p.nombre || '—')}</b></td>
          <td>${p.ultima_visita ? fmtFechaHora(p.ultima_visita) : '—'}</td>
          <td><span class="estado-tag ${estadoClass(est)}">${estadoLabel(est)}</span></td>
          <td>${est === 'no_pasar' ? si : no}</td>
          <td>${est === 'erroneo' ? si : no}</td>
          <td>${activo ? si : no}</td>
          <td class="notas">${escapeHtml(p.notas || '')}</td>
          <td class="col-ver"><button type="button" class="ver-btn" data-punto="${escapeHtml(String(p.id))}" data-nombre="${escapeHtml(p.nombre || '')}">Ver</button></td>
        </tr>`);
        comunaPuesta = true;
        terrPuesta = true;
      }
      banda = !banda;   // el siguiente territorio cambia de color
    }
  }

  if (!filas.length) { box.innerHTML = '<div class="empty">Sin puntos</div>'; return; }

  box.innerHTML = `<table class="hist-table hist-grp">
    <thead><tr>
      <th class="grp-h">Comuna</th><th class="grp-h">Territorio</th>
      <th>Punto</th><th>Última visita</th><th>Estado</th>
      <th>No pasar</th><th>Erróneo</th><th>Activo</th><th>Notas</th>
      <th class="col-ver-h"></th>
    </tr></thead>
    <tbody>${filas.join('')}</tbody>
  </table>`;
}

// Etiquetas de la bitácora de movimientos (punto_historial)
const TIPO_LOG = {
  creado: 'Creación',
  estado: 'Estado',
  territorio: 'Territorio',
  borrado: 'Borrado',
  restaurado: 'Restaurado',
  nota: 'Notas',
  asignado: 'Asignación',
  devuelto: 'Devolución',
  completado: 'Completado',
};

// Log de un punto: cada movimiento registrado por usuario o admin
async function abrirHistorialPunto(puntoId, nombre) {
  const overlay = document.getElementById('puntoHistorial');
  const body = document.getElementById('phBody');
  document.getElementById('phTitle').textContent = 'Historial · ' + (nombre || 'punto');
  document.getElementById('phExport').style.display = 'none';
  phCsv = null;
  body.innerHTML = '<div class="empty">Cargando…</div>';
  overlay.classList.add('visible');

  const { data, error } = await db.rpc('punto_historial', { p_punto: puntoId });
  if (error) { body.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }

  const filas = data || [];
  if (!filas.length) { body.innerHTML = '<div class="empty">Sin movimientos registrados</div>'; return; }

  body.innerHTML = `<table class="hist-table log-table">
    <thead><tr><th>Fecha</th><th>Movimiento</th><th>Detalle</th><th>Usuario</th></tr></thead>
    <tbody>${filas.map((r) => `<tr>
      <td>${fmtFechaHora(r.ev_at)}</td>
      <td><span class="log-tipo ${escapeHtml(r.ev_tipo || '')}">${escapeHtml(TIPO_LOG[r.ev_tipo] || r.ev_tipo || '—')}</span></td>
      <td class="log-det">${escapeHtml(r.ev_detalle || '')}</td>
      <td>${escapeHtml(r.ev_actor || '—')}</td>
    </tr>`).join('')}</tbody>
  </table>`;

  phCsv = {
    nombre: 'bitacora-punto',
    cabeceras: ['Fecha', 'Movimiento', 'Detalle', 'Usuario'],
    filas: filas.map((r) => [
      r.ev_at || '', TIPO_LOG[r.ev_tipo] || r.ev_tipo || '', r.ev_detalle || '', r.ev_actor || '',
    ]),
  };
  document.getElementById('phExport').style.display = '';
}

function cerrarHistorialPunto() {
  document.getElementById('puntoHistorial').classList.remove('visible');
}

// Historial completo de un territorio: cada proceso de asignación como una
// entrada de log (fecha de asignación, usuario, cierre y notas).
async function abrirHistorialTerritorio(territorioId, nombre) {
  const overlay = document.getElementById('puntoHistorial');
  const body = document.getElementById('phBody');
  document.getElementById('phTitle').textContent = 'Historial · ' + (nombre || 'territorio');
  document.getElementById('phExport').style.display = 'none';
  phCsv = null;
  body.innerHTML = '<div class="empty">Cargando…</div>';
  overlay.classList.add('visible');

  const { data, error } = await db
    .from('territorios_asignaciones')
    .select('user_id, assigned_at, estado, notas, devuelta_at, completado_at')
    .eq('territorio_id', territorioId)
    .order('assigned_at', { ascending: false });

  if (error) { body.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }
  const procesos = data || [];
  if (!procesos.length) { body.innerHTML = '<div class="empty">Sin procesos registrados</div>'; return; }

  const n = procesos.length;
  const filas = procesos.map((a, i) => {
    const est = ESTADO_ASIG[a.estado] ? a.estado : 'activa';
    const cierre = est === 'completado' ? a.completado_at : est === 'devuelta' ? a.devuelta_at : null;
    return `<tr>
      <td class="log-num">${n - i}</td>
      <td>${fmtFechaHora(a.assigned_at)}</td>
      <td>${escapeHtml(emailDe(a.user_id) || '—')}</td>
      <td>${cierre ? fmtFechaHora(cierre) : '<span class="muted">—</span>'}</td>
      <td><span class="chip-est ${est}">${ESTADO_ASIG[est]}</span></td>
      <td class="notas">${escapeHtml(a.notas || '')}</td>
    </tr>`;
  }).join('');

  body.innerHTML = `<table class="hist-table log-table">
    <thead><tr>
      <th>#</th><th>Asignado</th><th>Usuario</th><th>Cierre</th><th>Estado</th><th>Notas</th>
    </tr></thead>
    <tbody>${filas}</tbody>
  </table>
  <p class="ph-leyenda">${n} proceso${n === 1 ? '' : 's'} de trabajo sobre este territorio. El #${n} es el más reciente.</p>`;

  phCsv = {
    nombre: 'historial-territorio',
    cabeceras: ['#', 'Asignado', 'Usuario', 'Cierre', 'Estado', 'Notas'],
    filas: procesos.map((a, i) => {
      const est = ESTADO_ASIG[a.estado] ? a.estado : 'activa';
      const cierra = est === 'completado' ? a.completado_at
        : est === 'devuelta' ? a.devuelta_at : null;
      return [n - i, a.assigned_at || '', emailDe(a.user_id) || '',
        cierra || '', ESTADO_ASIG[est], a.notas || ''];
    }),
  };
  document.getElementById('phExport').style.display = '';
}

async function loadUsuariosView() {
  const box = document.getElementById('usuariosList');
  if (!box) return;
  box.innerHTML = '<div class="empty">Cargando…</div>';

  const { data, error } = await db.rpc('listar_usuarios');
  if (error) { box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }
  const lista = data || [];
  if (!lista.length) { box.innerHTML = '<div class="empty">Sin usuarios</div>'; return; }

  const filas = lista.map((u) => `
    <tr>
      <td>${escapeHtml(u.email || '—')}</td>
      <td>${u.is_admin ? 'Administrador' : 'Usuario'}</td>
      <td>${u.territorio ? escapeHtml(u.territorio) : '<span class="muted">Libre</span>'}</td>
      <td>${u.desde ? fmtFecha(u.desde) : '—'}</td>
    </tr>`).join('');

  box.innerHTML = `<table class="hist-table">
    <thead><tr><th>Email</th><th>Rol</th><th>Territorio en curso</th><th>Desde</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>`;
}

// Alta de usuarios de terreno (nunca admin) vía Edge Function con service_role
async function crearUsuario(ev) {
  ev.preventDefault();
  const email = document.getElementById('newUserEmail').value.trim();
  const pass = document.getElementById('newUserPass').value;
  const errEl = document.getElementById('userFormErr');
  const btn = document.getElementById('newUserBtn');
  errEl.textContent = '';
  if (!email || pass.length < 6) {
    errEl.textContent = 'Email válido y contraseña de al menos 6 caracteres';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creando…';
  try {
    const { data, error } = await db.functions.invoke('crear-usuario', { body: { email, password: pass } });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    toast('Usuario creado');
    document.getElementById('userForm').reset();
    await loadUsuarios();       // refresca los correos para la asignación
    await loadUsuariosView();
  } catch (ex) {
    errEl.textContent = (ex && ex.message) || 'No se pudo crear el usuario';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crear usuario';
  }
}

document.querySelectorAll('#mainNav button').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view));
});
document.getElementById('histTabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (!b) return;
  histTab = b.dataset.tab;
  document.querySelectorAll('#histTabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.getElementById('histTerritorios').style.display = histTab === 'territorios' ? '' : 'none';
  document.getElementById('histPuntos').style.display = histTab === 'puntos' ? '' : 'none';
  loadHistorial();
});
// Filtro por comuna del historial: recarga la pestaña activa y lo recuerda
histComunaSel.addEventListener('change', () => {
  prefSet('histComuna', histComunaSel.value);
  loadHistorial();
});
document.getElementById('userForm').addEventListener('submit', crearUsuario);

// Historial de un punto: botón "Ver" de la tabla (delegación en el contenedor)
document.getElementById('histPuntos').addEventListener('click', (ev) => {
  const b = ev.target.closest('button.ver-btn');
  if (!b) return;
  abrirHistorialPunto(b.dataset.punto, b.dataset.nombre);
});
// Historial de un territorio: botón "Ver" de la pestaña Territorios
document.getElementById('histTerritorios').addEventListener('click', (ev) => {
  const b = ev.target.closest('button.ver-btn');
  if (!b) return;
  abrirHistorialTerritorio(b.dataset.territorio, b.dataset.nombre);
});
document.getElementById('phClose').addEventListener('click', cerrarHistorialPunto);
document.getElementById('puntoHistorial').addEventListener('click', (ev) => {
  if (ev.target.id === 'puntoHistorial') cerrarHistorialPunto();   // clic fuera del box
});

// ============================================================
// ARRANQUE
// ============================================================
(async () => {
  try {
    const { data } = await db.auth.getSession();
    if (data?.session?.user) await startApp(data.session.user);
  } catch (e) {
    console.error(e);
    toast('No se pudo recuperar la sesión: ' + e.message, true);
  }
})();
