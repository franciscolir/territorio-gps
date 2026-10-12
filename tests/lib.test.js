import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// lib.js es un script clásico (se carga con <script src="lib.js"> en el
// navegador, sin export). Para testearlo se evalúa su fuente y se capturan
// las funciones declaradas en el ámbito del wrapper.
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib.js'),
  'utf8'
);
const lib = new Function(
  `${src}
   return {
     SEGMENTOS, ESTADOS, PIN_ICONS, estadoLabel, estadoClass,
     escapeHtml, pointFromGeom, pointInGeometry, inRing,
     ringArea, ringToEwkt, createCircle, coordsFromLink, parseCoordQuery,
     nuevaOpCola, colaAgregar, colaQuitar, colaResumen, territorioAvance,
     distMeters, duplicadoCercano, DUP_METROS, csvEscape,
   };`
)();

// EWKB (hex) de un Point con SRID 4326 little-endian, como lo escribe PostGIS
function ewkbPoint(lng, lat) {
  const b = Buffer.alloc(1 + 4 + 4 + 16);
  b.writeUInt8(1, 0);
  b.writeUInt32LE(0x20000001, 1); // tipo Point + flag SRID
  b.writeUInt32LE(4326, 5);
  b.writeDoubleLE(lng, 9);
  b.writeDoubleLE(lat, 17);
  return b.toString('hex');
}

const cuadrado = (x0, y0, x1, y1) => ({
  type: 'Polygon',
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

describe('escapeHtml', () => {
  it('escapa los caracteres peligrosos', () => {
    expect(lib.escapeHtml('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  });
  it(' tolera null/undefined', () => {
    expect(lib.escapeHtml(null)).toBe('');
    expect(lib.escapeHtml(undefined)).toBe('');
  });
  it('no rompe texto normal con acentos', () => {
    expect(lib.escapeHtml('Territorio Ñuñoa · visitado')).toBe('Territorio Ñuñoa · visitado');
  });
});

describe('pointFromGeom', () => {
  it('lee EWKB hex de PostGIS', () => {
    const c = lib.pointFromGeom(ewkbPoint(-70.66, -33.45));
    expect(c).not.toBeNull();
    expect(c.lng).toBeCloseTo(-70.66, 9);
    expect(c.lat).toBeCloseTo(-33.45, 9);
  });
  it('acepta GeoJSON', () => {
    expect(lib.pointFromGeom({ type: 'Point', coordinates: [-70.6, -33.4] }))
      .toEqual({ lat: -33.4, lng: -70.6 });
  });
  it('rechaza basura', () => {
    expect(lib.pointFromGeom(null)).toBeNull();
    expect(lib.pointFromGeom('')).toBeNull();
    expect(lib.pointFromGeom('zzzz')).toBeNull();
    expect(lib.pointFromGeom({ type: 'Point' })).toBeNull();
    expect(lib.pointFromGeom(12345)).toBeNull();
  });
  it('rechaza EWKB que no es Point', () => {
    const b = Buffer.alloc(9);
    b.writeUInt8(1, 0);
    b.writeUInt32LE(2, 1); // LineString
    b.writeUInt32LE(0, 5);
    expect(lib.pointFromGeom(b.toString('hex'))).toBeNull();
  });
});

describe('pointInGeometry / inRing', () => {
  const g = cuadrado(0, 0, 10, 10);

  it('detecta el interior y el exterior', () => {
    expect(lib.pointInGeometry(5, 5, g)).toBe(true);
    expect(lib.pointInGeometry(15, 5, g)).toBe(false);
    expect(lib.pointInGeometry(-1, -1, g)).toBe(false);
  });

  it('respeta los agujeros (holes)', () => {
    const conAgujero = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
      ],
    };
    expect(lib.pointInGeometry(5, 5, conAgujero)).toBe(false); // dentro del agujero
    expect(lib.pointInGeometry(1, 1, conAgujero)).toBe(true);  // anillo principal
  });

  it('soporta MultiPolygon', () => {
    const multi = {
      type: 'MultiPolygon',
      coordinates: [[cuadrado(0, 0, 10, 10).coordinates[0]], [cuadrado(20, 20, 30, 30).coordinates[0]]],
    };
    expect(lib.pointInGeometry(25, 25, multi)).toBe(true);
    expect(lib.pointInGeometry(15, 15, multi)).toBe(false);
  });

  it('con geometría rota devuelve false (no truena)', () => {
    expect(lib.pointInGeometry(1, 1, null)).toBe(false);
    expect(lib.pointInGeometry(1, 1, {})).toBe(false);
  });
});

describe('ringArea', () => {
  it('da el área firmada de un cuadrado 10x10', () => {
    const ring = cuadrado(0, 0, 10, 10).coordinates[0];
    expect(Math.abs(lib.ringArea(ring))).toBeCloseTo(100, 9);
  });
  it('invierte el signo si el anillo va al revés', () => {
    const horario = cuadrado(0, 0, 10, 10).coordinates[0].slice().reverse();
    const antihorario = cuadrado(0, 0, 10, 10).coordinates[0];
    expect(Math.sign(lib.ringArea(horario))).toBe(-Math.sign(lib.ringArea(antihorario)));
  });
});

describe('ringToEwkt', () => {
  it('genera EWKT con SRID 4326', () => {
    const ring = [[-70.5, -33.5], [-70.4, -33.5], [-70.4, -33.4], [-70.5, -33.5]];
    expect(lib.ringToEwkt(ring)).toBe(
      'SRID=4326;POLYGON((-70.5 -33.5,-70.4 -33.5,-70.4 -33.4,-70.5 -33.5))'
    );
  });
});

describe('createCircle', () => {
  it('cierra el polígono y respeta el radio', () => {
    const c = lib.createCircle(-70.6, -33.45, 500);
    const ring = c.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]); // anillo cerrado
    expect(ring).toHaveLength(65);

    const dLng = (ring[0][0] + 70.6) * 111320 * Math.cos((33.45 * Math.PI) / 180);
    const dLat = (ring[0][1] + 33.45) * 110540;
    expect(Math.hypot(dLng, dLat)).toBeCloseTo(500, 0);
  });
});

describe('coordsFromLink', () => {
  it('lee el formato @lat,lng', () => {
    expect(lib.coordsFromLink('https://www.google.com/maps/place/X/@-33.4512,-70.6612,17z'))
      .toEqual({ lat: -33.4512, lng: -70.6612 });
  });
  it('lee ?q=lat,lng y ?ll=lat,lng', () => {
    expect(lib.coordsFromLink('https://maps.google.com/?q=-33.5,-70.6'))
      .toEqual({ lat: -33.5, lng: -70.6 });
    expect(lib.coordsFromLink('https://maps.google.com/?ll=-33.6,-70.7'))
      .toEqual({ lat: -33.6, lng: -70.7 });
  });
  it('devuelve null si no hay coordenadas', () => {
    expect(lib.coordsFromLink('https://google.com/maps/place/Santiago')).toBeNull();
    expect(lib.coordsFromLink('')).toBeNull();
    expect(lib.coordsFromLink(null)).toBeNull();
  });
});

describe('parseCoordQuery', () => {
  it('acepta coma, punto y coma y espacio', () => {
    expect(lib.parseCoordQuery('-33.45, -70.66')).toEqual({ lat: -33.45, lng: -70.66 });
    expect(lib.parseCoordQuery('-33.45;-70.66')).toEqual({ lat: -33.45, lng: -70.66 });
    expect(lib.parseCoordQuery('-33.45 -70.66')).toEqual({ lat: -33.45, lng: -70.66 });
  });
  it('descarta texto libre y rangos inválidos', () => {
    expect(lib.parseCoordQuery('avenida providencia 1234')).toBeNull();
    expect(lib.parseCoordQuery('-33.45')).toBeNull();
    expect(lib.parseCoordQuery('120.5, -70.66')).toBeNull(); // lat > 90
    expect(lib.parseCoordQuery('')).toBeNull();
    expect(lib.parseCoordQuery(null)).toBeNull();
  });
});

describe('estados', () => {
  it('mapea estado → etiqueta y clase CSS', () => {
    expect(lib.estadoLabel('visitado')).toBe('Visitado');
    expect(lib.estadoLabel('no_pasar')).toBe('No pasar');
    expect(lib.estadoLabel('desconocido')).toBe('Pendiente');
    expect(lib.estadoClass('erroneo')).toBe('estado-erroneo');
    expect(lib.estadoClass('desconocido')).toBe('estado-pendiente');
  });
  it('los 4 estados del segmento coinciden con los chips', () => {
    expect(lib.SEGMENTOS.map(([v]) => v)).toEqual(['pendiente', 'visitado', 'erroneo', 'no_pasar']);
    expect(lib.ESTADOS.map(([v]) => v)).toEqual(['pendiente', 'visitado', 'erroneo', 'no_pasar']);
  });
  it('cada estado tiene ícono Material', () => {
    for (const [v] of lib.ESTADOS) expect(lib.PIN_ICONS[v]).toBeTruthy();
  });
});

describe('cola offline (nuevaOpCola / colaAgregar / colaQuitar / colaResumen)', () => {
  it('nuevaOpCola construye la operación con id y datos copiados', () => {
    const datos = { estado: 'visitado' };
    const op = lib.nuevaOpCola('estado', 'p1', datos, 'op-1', 1000);
    expect(op).toEqual({
      id: 'op-1', tipo: 'estado', clave: 'p1',
      datos: { estado: 'visitado' }, creadoEn: 1000,
    });
    datos.estado = 'erroneo'; // no debe afectar a la copia
    expect(op.datos.estado).toBe('visitado');
  });

  it('colaAgregar no muta la lista original', () => {
    const ops = [];
    const out = lib.colaAgregar(ops, lib.nuevaOpCola('estado', 'p1', { estado: 'visitado' }, 'a', 1));
    expect(ops).toHaveLength(0);
    expect(out).toHaveLength(1);
  });

  it('colaAgregar reemplaza la operación previa del mismo tipo y clave', () => {
    let ops = [];
    ops = lib.colaAgregar(ops, lib.nuevaOpCola('estado', 'p1', { estado: 'visitado' }, 'a', 1));
    ops = lib.colaAgregar(ops, lib.nuevaOpCola('estado', 'p1', { estado: 'erroneo' }, 'b', 2));
    ops = lib.colaAgregar(ops, lib.nuevaOpCola('editar', 'p1', { nombre: 'X' }, 'c', 3));
    expect(ops).toHaveLength(2);
    expect(ops.find((o) => o.tipo === 'estado').datos.estado).toBe('erroneo');
  });

  it('colaQuitar elimina por id', () => {
    const ops = [
      lib.nuevaOpCola('estado', 'p1', {}, 'a', 1),
      lib.nuevaOpCola('estado', 'p2', {}, 'b', 2),
    ];
    expect(lib.colaQuitar(ops, 'a').map((o) => o.id)).toEqual(['b']);
    expect(lib.colaQuitar(ops, 'no-existe')).toHaveLength(2);
  });

  it('colaResumen cuenta por tipo', () => {
    const ops = [
      lib.nuevaOpCola('estado', 'p1', {}, 'a', 1),
      lib.nuevaOpCola('estado', 'p2', {}, 'b', 2),
      lib.nuevaOpCola('crear', 'local-1', {}, 'c', 3),
      lib.nuevaOpCola('borrar', 'p3', {}, 'd', 4),
    ];
    expect(lib.colaResumen(ops)).toEqual({
      total: 4, estado: 2, crear: 1, editar: 0, borrar: 1,
    });
    expect(lib.colaResumen([])).toEqual({
      total: 0, estado: 0, crear: 0, editar: 0, borrar: 0,
    });
  });
});

describe('territorioAvance', () => {
  it('cuenta estados y calcula el porcentaje de visitados', () => {
    const puntos = [
      { estado: 'visitado' }, { estado: 'visitado' }, { estado: 'visitado' },
      { estado: 'erroneo' }, { estado: 'no_pasar' }, { estado: 'pendiente' },
    ];
    expect(lib.territorioAvance(puntos)).toEqual({
      total: 6, pendiente: 1, visitado: 3, erroneo: 1, no_pasar: 1, pct: 50,
    });
  });
  it('trata lo vacío o desconocido como pendiente', () => {
    expect(lib.territorioAvance([])).toEqual({
      total: 0, pendiente: 0, visitado: 0, erroneo: 0, no_pasar: 0, pct: 0,
    });
    const r = lib.territorioAvance([{}, { estado: 'raro' }]);
    expect(r.pendiente).toBe(2);
    expect(r.pct).toBe(0);
  });
});

describe('distMeters', () => {
  it('da 0 en el mismo punto', () => {
    expect(lib.distMeters(-33.45, -70.66, -33.45, -70.66)).toBe(0);
  });
  it('mide ~8,8 m para 0,00008° de latitud', () => {
    const d = lib.distMeters(-33.45, -70.66, -33.45008, -70.66);
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(10);
  });
  it('es simétrica', () => {
    const a = lib.distMeters(-33.45, -70.66, -33.451, -70.661);
    const b = lib.distMeters(-33.451, -70.661, -33.45, -70.66);
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
  });
});

describe('duplicadoCercano', () => {
  const puntos = [
    { id: 'a', nombre: 'Farmacia', lat: -33.45, lng: -70.66 },
    { id: 'b', nombre: 'Farmacia Los Andes', lat: -33.45, lng: -70.66 },
    { id: 'c', nombre: ' farmacia ', lat: -33.45005, lng: -70.66 },
    { id: 'd', nombre: 'Almacén', lat: -33.46, lng: -70.66 },
    { id: 'e', nombre: 'Sin GPS', lat: null, lng: null },
    { id: 'f', nombre: 'Farmacia', lat: -33.45, lng: -70.66, deleted_at: '2026-01-01' },
  ];

  it('detecta el mismo nombre a menos de 10 m (mayúsculas y espacios aparte)', () => {
    const r = lib.duplicadoCercano(puntos, '  FARMACIA ', -33.45001, -70.66);
    expect(r).not.toBeNull();
    expect(r.punto.id).toBe('a');
    expect(r.metros).toBeLessThan(10);
  });

  it('devuelve null con nombre distinto', () => {
    expect(lib.duplicadoCercano(puntos, 'Cafetería', -33.45, -70.66)).toBeNull();
  });

  it('devuelve null si el nombre coincide pero está a más de 10 m', () => {
    expect(lib.duplicadoCercano(puntos, 'Almacén', -33.45, -70.66)).toBeNull();
  });

  it('ignora borrados, puntos sin GPS y el propio punto al editar', () => {
    const solo = [{ id: 'x', nombre: 'Solo', lat: -33.45, lng: -70.66 }];
    expect(lib.duplicadoCercano(solo, 'Solo', -33.45, -70.66)?.punto.id).toBe('x');
    expect(lib.duplicadoCercano(solo, 'Solo', -33.45, -70.66, 10, 'x')).toBeNull();
    expect(lib.duplicadoCercano(puntos, 'Farmacia', null, -70.66)).toBeNull();
    expect(lib.duplicadoCercano(puntos, '', -33.45, -70.66)).toBeNull();
    expect(lib.duplicadoCercano(puntos, 'Sin GPS', -33.45, -70.66)).toBeNull();
    expect(lib.duplicadoCercano(puntos, 'Farmacia', -33.45, -70.66, 10, 'f').punto.id)
      .not.toBe('f');
  });

  it('el umbral es estricto: a 10 m exactos no cuenta', () => {
    const enLimite = [{ id: 'z', nombre: 'Z', lat: -33.45, lng: -70.66 }];
    // ~11 m de desplazamiento → fuera del umbral por defecto
    expect(lib.duplicadoCercano(enLimite, 'Z', -33.4501, -70.66)).toBeNull();
    expect(lib.duplicadoCercano(enLimite, 'Z', -33.4501, -70.66, 20)).not.toBeNull();
  });
});

describe('csvEscape', () => {
  it('deja lo simple y los números negativos tal cual', () => {
    expect(lib.csvEscape('Punto A')).toBe('Punto A');
    expect(lib.csvEscape(-33.457)).toBe('-33.457');
    expect(lib.csvEscape(0)).toBe('0');
    expect(lib.csvEscape(null)).toBe('');
    expect(lib.csvEscape(undefined)).toBe('');
  });

  it('comilla lo que lleva comas, comillas o saltos de línea', () => {
    expect(lib.csvEscape('a,b')).toBe('"a,b"');
    expect(lib.csvEscape('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(lib.csvEscape('l1\nl2')).toBe('"l1\nl2"');
    expect(lib.csvEscape('con "coma", y salto\n')).toBe('"con ""coma"", y salto\n"');
  });

  it('neutraliza las fórmulas de Excel (=, +, @, tab)', () => {
    expect(lib.csvEscape('=1+1')).toBe("'=1+1");
    expect(lib.csvEscape('@SUMA(A1)')).toBe("'@SUMA(A1)");
    expect(lib.csvEscape('\t=cmd')).toBe("'\t=cmd");
    // y siguen comillándose si además llevan coma
    expect(lib.csvEscape('=1,2')).toBe("\"'=1,2\"");
  });
});
