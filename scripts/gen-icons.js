// Genera los iconos PWA del proyecto sin dependencias: un "pin" blanco sobre
// el color primario (#00223d), dibujado por muestreo y escrito como PNG
// (IHDR/IDAT/IEND con CRC32 propio).
//
//   node scripts/gen-icons.js
//
// Salida: icons/icon-192.png · icons/icon-512.png · icons/icon-maskable-512.png
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const NAVY = [0x00, 0x22, 0x3d];   // --primary
const WHITE = [0xff, 0xff, 0xff];
const SUB = 4;                      // muestras por eje (antialiasing)

// ---------- PNG mínimo ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(tipo, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo), 0);
  return Buffer.concat([len, cuerpo, crc]);
}

function png(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const fila = y * stride;
    raw[fila] = 0; // filtro: None
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = fila + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- El arte, en unidades de diseño de 512×512 ----------
// Círculo + triángulo = pin; con un agujero circular en el centro.
// El pin es círculo ∪ triángulo isósceles: la base del triángulo cae justo en
// el ecuador del círculo (misma semianchura, 96), de modo que la silueta pasa
// del arco al cono sin escalones. El agujero es otro círculo concéntrico.
function dentroDelPin(dx, dy) {
  const cx = 256;
  const cy = 230;
  const r = 96;
  const enCirculo = (dx - cx) ** 2 + (dy - cy) ** 2 <= r * r;

  let enTriangulo = false;
  if (dy >= cy && dy <= 390) {
    const t = (dy - cy) / (390 - cy);          // 0 en la base, 1 en el ápice
    enTriangulo = Math.abs(dx - cx) <= r * (1 - t);
  }

  const enHueco = (dx - cx) ** 2 + (dy - cy) ** 2 <= 38 * 38;
  return (enCirculo || enTriangulo) && !enHueco;
}

// `relleno` escala el arte alrededor del centro: 1 para el icono normal y
// ~0.78 para el maskable (todo el arte debe caber en el 80 % central).
function fabricar(size, relleno) {
  const escala = size / 512;
  return (x, y) => {
    let blanco = 0;
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const px = (x + (sx + 0.5) / SUB) / escala;
        const py = (y + (sy + 0.5) / SUB) / escala;
        const dx = 256 + (px - 256) * relleno;
        const dy = 256 + (py - 256) * relleno;
        if (dentroDelPin(dx, dy)) blanco++;
      }
    }
    const a = blanco / (SUB * SUB);
    return [
      Math.round(NAVY[0] + (WHITE[0] - NAVY[0]) * a),
      Math.round(NAVY[1] + (WHITE[1] - NAVY[1]) * a),
      Math.round(NAVY[2] + (WHITE[2] - NAVY[2]) * a),
    ];
  };
}

fs.mkdirSync(OUT, { recursive: true });
const salida = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.78],
];

for (const [nombre, size, relleno] of salida) {
  const buf = png(size, fabricar(size, relleno));
  fs.writeFileSync(path.join(OUT, nombre), buf);
  // Lectura de vuelta para confirmar firma y dimensiones
  const ok = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  console.log(`${nombre.padEnd(24)} ${w}×${h}  ${buf.length} bytes  png:${ok ? 'ok' : 'FALLO'}`);
}
