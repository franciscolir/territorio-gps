// seed-comunas.js
// Lee comunas RM desde ArcGIS FeatureServer (f=geojson) y las sube a Supabase.
// Uso:  npm install && npm run seed

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const ARCGIS_URL =
  'https://services7.arcgis.com/UeyripQFTg6pfUe5/ArcGIS/rest/services/' +
  'L%C3%ADmites_comunales_RM/FeatureServer/0/query' +
  '?where=1%3D1&outFields=*&outSR=4326&f=geojson';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------

// Normaliza Polygon → MultiPolygon (PostGIS lo espera así)
function toMultiPolygon(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  return null;
}

// Busca en las propiedades la clave que mejor coincida con un patrón
function pickProp(props, patterns) {
  if (!props) return null;
  const keys = Object.keys(props);
  for (const pat of patterns) {
    const re = new RegExp(pat, 'i');
    const found = keys.find((k) => re.test(k));
    if (found && props[found] != null && props[found] !== '') {
      return { key: found, value: props[found] };
    }
  }
  return null;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log('📥 Descargando comunas desde ArcGIS…');
  const res = await fetch(ARCGIS_URL);
  if (!res.ok) {
    throw new Error(`ArcGIS respondió ${res.status} ${res.statusText}`);
  }
  const geojson = await res.json();
  if (!geojson.features || !geojson.features.length) {
    throw new Error('El GeoJSON no trae features');
  }
  console.log(`✅ ${geojson.features.length} comunas descargadas`);

  // Detección dinámica de propiedades
  const sample = geojson.features[0].properties || {};
  console.log('🔎 Propiedades detectadas en el primer feature:');
  console.log(sample);

  const codProp = pickProp(sample, [
    '^cod.*comuna', '^cod_comuna', '^codigo.*comuna', '^cut', '^cod',
  ]);
  const nomProp = pickProp(sample, [
    '^nom.*comuna', '^nombre.*comuna', '^comuna', '^nom', '^nombre',
  ]);

  console.log('📌 Campo código  →', codProp ? codProp.key : '(no detectado)');
  console.log('📌 Campo nombre  →', nomProp ? nomProp.key : '(no detectado)');

  if (!nomProp) {
    throw new Error(
      'No pude detectar el campo de nombre de comuna. Revisa las propiedades.'
    );
  }

  // Transformar a filas
  const rows = geojson.features
    .map((f) => {
      const multi = toMultiPolygon(f.geometry);
      if (!multi) return null;
      const nombre = String(f.properties[nomProp.key]).trim();
      const codigo = codProp ? String(f.properties[codProp.key] ?? '').trim() : null;
      return {
        nombre,
        codigo_comuna: codigo || null,
        // PostgREST acepta GeoJSON si el tipo de columna es geometry/geography.
        // Para PostGIS vía REST, pasamos la geometría como GeoJSON string.
        geom: {
          type: 'MultiPolygon',
          coordinates: multi,
        },
      };
    })
    .filter(Boolean);

  console.log(`🧹 ${rows.length} filas listas para insertar`);

  // Limpiar tabla antes de sembrar (idempotente)
  console.log('🗑️  Vaciando tabla comunas_rm…');
  const { error: delErr } = await supabase
    .from('comunas_rm')
    .delete()
    .neq('id', 0);
  if (delErr) {
    console.warn('⚠️  No se pudo vaciar (¿RLS?):', delErr.message);
  }

  // Insert en chunks por si son muchas
  const CHUNK = 10;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // PostgREST no acepta objeto GeoJSON directamente para columnas geometry;
    // hay que enviarlo como EWKT/WKT o usar RPC. Usamos RPC al final.
    const { error } = await supabase.from('comunas_rm').insert(chunk);
    if (error) {
      console.error('❌ Error insertando chunk', i, error);
      // Fallback: intentar con WKT
      console.log('🔁 Reintentando con WKT…');
      const wktChunk = chunk.map((r) => ({
        nombre: r.nombre,
        codigo_comuna: r.codigo_comuna,
        geom: geojsonToWKT(r.geom),
      }));
      const { error: e2 } = await supabase.from('comunas_rm').insert(wktChunk);
      if (e2) {
        console.error('❌ Fallback WKT también falló:', e2);
        throw e2;
      }
    }
    inserted += chunk.length;
    process.stdout.write(`\r⬆️  ${inserted}/${rows.length}`);
  }
  console.log('\n✅ Seed completado');

  // Verificación
  const { count } = await supabase
    .from('comunas_rm')
    .select('*', { count: 'exact', head: true });
  console.log(`📊 Filas en comunas_rm: ${count}`);
}

// GeoJSON → WKT (MultiPolygon)
function geojsonToWKT(geom) {
  if (!geom || geom.type !== 'MultiPolygon') return null;
  const polys = geom.coordinates
    .map((poly) => {
      const rings = poly
        .map(
          (ring) =>
            '(' +
            ring.map(([x, y]) => `${x} ${y}`).join(', ') +
            ')'
        )
        .join(', ');
      return `(${rings})`;
    })
    .join(', ');
  return `MULTIPOLYGON(${polys})`;
}

main().catch((err) => {
  console.error('\n💥 Error fatal:', err);
  process.exit(1);
});