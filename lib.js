// ============================================================
// LIB — funciones puras (sin DOM ni estado global).           =
// Se cargan antes de app.js y se prueban con Vitest (tests/). =
// ============================================================

const SEGMENTOS = [
  ['pendiente', 'Pendiente', 'schedule'],
  ['visitado', 'Visitado', 'check'],
  ['erroneo', 'Erróneo', 'error'],
  ['no_pasar', 'No pasar', 'block'],
];

const ESTADOS = [
  ['pendiente', 'Pendiente'],
  ['visitado', 'Visitado'],
  ['erroneo', 'Erróneo'],
  ['no_pasar', 'No pasar'],
];
// Icono Material del pin de mapa por estado (diseño front)
const PIN_ICONS = { pendiente: 'schedule', visitado: 'check', erroneo: 'priority_high', no_pasar: 'block' };
function estadoLabel(e) {
  const x = ESTADOS.find((k) => k[0] === e);
  return x ? x[1] : 'Pendiente';
}
function estadoClass(e) {
  return 'estado-' + (ESTADOS.some((k) => k[0] === e) ? e : 'pendiente');
}
// ¿El punto (lng, lat) cae dentro del polígono/multipolígono de la comuna?
function pointInGeometry(lng, lat, geom) {
  if (!geom || !geom.coordinates) return false;
  const polygons = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  return polygons.some(
    (poly) => inRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lng, lat, hole))
  );
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
// PostGIS devuelve la columna `geography` como EWKB hexadecimal
// (ej: "0101000020E6100000..." = byte order + type con flag SRID + 4326 + X + Y).
// También acepta GeoJSON por si el backend cambia el formato.
function pointFromGeom(geom) {
  if (!geom) return null;

  if (typeof geom === 'object' && Array.isArray(geom.coordinates)) {
    const [lng, lat] = geom.coordinates;
    return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
  }

  if (typeof geom !== 'string') return null;
  const hex = geom.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 18 || hex.length % 2 !== 0) return null;

  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

    const view = new DataView(bytes.buffer);
    const little = bytes[0] === 1;
    const type = view.getUint32(1, little);
    const baseType = type & 0x1fffffff;          // quita flags EWKB (SRID/Z/M)
    if (baseType !== 1) return null;             // solo Point

    const offset = 5 + ((type & 0x20000000) ? 4 : 0);  // 4 bytes extra si hay SRID
    if (bytes.length < offset + 16) return null;

    const lng = view.getFloat64(offset, little);
    const lat = view.getFloat64(offset + 8, little);
    return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return sum / 2;
}
function ringToEwkt(ring) {
  return 'SRID=4326;POLYGON((' + ring.map(([lng, lat]) => `${lng} ${lat}`).join(',') + '))';
}
function createCircle(lng, lat, radiusMeters) {
  const points = 64;
  const coords = [];
  const distanceX = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  const distanceY = radiusMeters / 110540;
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * (2 * Math.PI);
    coords.push([lng + distanceX * Math.cos(theta), lat + distanceY * Math.sin(theta)]);
  }
  coords.push(coords[0]);
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

// Extrae {lat,lng} de un link de Google Maps (o null si no se puede).
function coordsFromLink(url) {
  if (!url) return null;
  let m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  m = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  m = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  return null;
}

// Coordenadas sueltas: "-33.45, -70.66" (coma, punto y coma o espacio).
function parseCoordQuery(q) {
  const m = (q || '').match(/^(-?\d{1,3}\.\d+)\s*[,; ]\s*(-?\d{1,3}\.\d+)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// ============================================================
// COLA OFFLINE (app móvil) — funciones puras e inmutables.
// La cola vive en localStorage; el id y el timestamp los aporta el
// caller para que estas funciones sean deterministas en los tests.
// ============================================================

// Operación pendiente: tipo ('estado' | 'crear' | 'editar' | 'borrar'),
// clave (id del punto, o id local en 'crear') y datos de la operación.
function nuevaOpCola(tipo, clave, datos, id, creadoEn) {
  return { id, tipo, clave, datos: { ...datos }, creadoEn };
}

// Agrega reemplazando operaciones previas del mismo tipo sobre la misma
// clave (p. ej. dos cambios de estado del mismo punto = solo el último).
function colaAgregar(ops, op) {
  const resto = ops.filter((o) => !(o.tipo === op.tipo && o.clave === op.clave));
  return [...resto, op];
}

function colaQuitar(ops, opId) {
  return ops.filter((o) => o.id !== opId);
}

// Conteo por tipo para el botón "Sincronizar ahora (N pendientes)".
function colaResumen(ops) {
  const r = { total: ops.length, estado: 0, crear: 0, editar: 0, borrar: 0 };
  for (const o of ops) {
    if (Object.prototype.hasOwnProperty.call(r, o.tipo)) r[o.tipo]++;
  }
  return r;
}

// Avance de un territorio a partir de sus puntos (mismos estados que la app
// de escritorio; pct = visitados sobre el total).
function territorioAvance(puntos) {
  const r = { total: puntos.length, pendiente: 0, visitado: 0, erroneo: 0, no_pasar: 0, pct: 0 };
  for (const p of puntos) {
    const e = p && p.estado && Object.prototype.hasOwnProperty.call(r, p.estado)
      ? p.estado
      : 'pendiente';
    r[e]++;
  }
  r.pct = r.total ? Math.round((r.visitado / r.total) * 100) : 0;
  return r;
}

// ============================================================
// DUPLICADOS AL CREAR UN PUNTO
// ============================================================

// Radio (m) por debajo del cual dos puntos con el mismo nombre se consideran
// duplicados al crearlos.
const DUP_METROS = 10;

// Distancia en metros entre dos coordenadas (haversine).
function distMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ¿Existe ya un punto vivo con el MISMO nombre a menos de `metros`?
// Devuelve { punto, metros } del más cercano, o null. `excluirId` deja fuera
// el propio punto cuando se está editando.
function duplicadoCercano(puntos, nombre, lat, lng, metros = 10, excluirId = null) {
  const clave = String(nombre == null ? '' : nombre).trim().toLowerCase();
  if (!clave || lat == null || lng == null || isNaN(lat) || isNaN(lng)) return null;

  let mejor = null;
  let mejorD = metros;
  for (const p of puntos || []) {
    if (!p || p.deleted_at) continue;
    if (excluirId && p.id === excluirId) continue;
    if (p.lat == null || p.lng == null) continue;
    if (String(p.nombre == null ? '' : p.nombre).trim().toLowerCase() !== clave) continue;
    const d = distMeters(lat, lng, p.lat, p.lng);
    if (d < mejorD) { mejorD = d; mejor = p; }
  }
  return mejor ? { punto: mejor, metros: Math.round(mejorD) } : null;
}

// ============================================================
// EXPORTACIÓN CSV
// ============================================================

// Escapa un valor para una celda CSV. Las celdas que empiezan por = + @ o
// tabulador se prefijan con ' para que Excel no las ejecute como fórmula
// (CSV injection). El guion se deja estar: las coordenadas negativas
// (-33.45) son números y deben seguir siéndolo.
function csvEscape(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// FeatureCollection GeoJSON con el polígono del territorio y sus puntos
// (estado, notas, última visita) para compartir con quien no usa la app:
// se abre en QGIS, geojson.io o Google Earth sin nada más.
// El polígono va primero para que un visor simple muestre el contorno.
function territorioFeatureCollection(territorio, puntos) {
  const t = territorio || {};
  const features = [];

  if (t.geom && t.geom.type && t.geom.coordinates) {
    features.push({
      type: 'Feature',
      properties: {
        tipo: 'territorio',
        id: t.id || null,
        nombre: t.nombre || '',
        comuna: t.comuna || '',
        color: t.color || null,
      },
      geometry: { type: t.geom.type, coordinates: t.geom.coordinates },
    });
  }

  for (const p of puntos || []) {
    if (p == null || p.lat == null || p.lng == null) continue;
    features.push({
      type: 'Feature',
      properties: {
        tipo: 'punto',
        id: p.id || null,
        nombre: p.nombre || '',
        direccion: p.direccion || null,
        estado: p.estado || 'pendiente',
        notas: p.notas || null,
        ultima_visita: p.ultima_visita || null,
      },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    });
  }

  return { type: 'FeatureCollection', features };
}
