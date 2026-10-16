/**
 * Generise icon.ico (i icon.svg) bez ikakvih zavisnosti.
 * Slika se crta preko signed-distance funkcija (glatke ivice), pa se
 * kodira u PNG (zlib je ugradjen) i pakuje u ICO kontejner.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..');
const PUBLIC = path.join(OUT_DIR, 'public');

/* ------------------------------------------------------------ crtanje --- */

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BLUE = hex('#3987e5');
const BLUE_DEEP = hex('#1c5cab');
const WHITE = [255, 255, 255];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (d, edge) => clamp01(0.5 - d / edge); // pokrivenost iz distance

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function over(dst, i, rgb, a) {
  if (a <= 0) return;
  const ia = dst[i + 3] / 255;
  const na = a + ia * (1 - a);
  for (let c = 0; c < 3; c += 1) {
    dst[i + c] = Math.round((rgb[c] * a + dst[i + c] * ia * (1 - a)) / (na || 1));
  }
  dst[i + 3] = Math.round(na * 255);
}

/** Crta ikonicu velicine size x size i vraca RGBA bafer. */
function draw(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const s = size / 256;      // sve mere su definisane na 256px
  const aa = 1.35;           // sirina prelaza u pikselima

  // Putanja grafikona (rastuca linija) u koordinatama 256px.
  const pts = [[52, 186], [104, 118], [148, 150], [204, 66]];
  const strokeR = 15 * s;
  const dotR = 20 * s;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const cx = x + 0.5;
      const cy = y + 0.5;

      // 1. Zaobljena podloga sa blagim vertikalnim gradijentom.
      const dBg = sdRoundRect(cx, cy, size / 2, size / 2, size / 2, size / 2, 58 * s);
      const aBg = smooth(dBg, aa);
      if (aBg > 0) {
        const t = y / (size - 1);
        const bg = [
          Math.round(BLUE[0] + (BLUE_DEEP[0] - BLUE[0]) * t),
          Math.round(BLUE[1] + (BLUE_DEEP[1] - BLUE[1]) * t),
          Math.round(BLUE[2] + (BLUE_DEEP[2] - BLUE[2]) * t),
        ];
        over(px, i, bg, aBg);
      }

      if (aBg <= 0) continue;

      // 2. Linija grafikona.
      let dLine = Infinity;
      for (let k = 0; k < pts.length - 1; k += 1) {
        dLine = Math.min(dLine, sdSegment(
          cx, cy,
          pts[k][0] * s, pts[k][1] * s,
          pts[k + 1][0] * s, pts[k + 1][1] * s,
        ));
      }
      const aLine = smooth(dLine - strokeR, aa) * aBg;
      over(px, i, WHITE, aLine);

      // 3. Tacka na vrhu.
      const dDot = Math.hypot(cx - pts[3][0] * s, cy - pts[3][1] * s) - dotR;
      over(px, i, WHITE, smooth(dDot, aa) * aBg);
    }
  }
  return px;
}

/* --------------------------------------------------------------- PNG --- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Svaki red dobija filter bajt 0 (bez filtera).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- ICO --- */

function toIco(images) {
  const count = images.length;
  const dir = Buffer.alloc(6 + count * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);      // tip 1 = ikonica
  dir.writeUInt16LE(count, 4);

  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir[e] = img.size >= 256 ? 0 : img.size;
    dir[e + 1] = img.size >= 256 ? 0 : img.size;
    dir[e + 2] = 0;             // paleta
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);   // planes
    dir.writeUInt16LE(32, e + 6);  // bpp
    dir.writeUInt32LE(img.png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });

  return Buffer.concat([dir, ...images.map((i) => i.png)]);
}

/* -------------------------------------------------------------- upis --- */

const SIZES = [256, 64, 48, 32, 16];
const images = SIZES.map((size) => ({ size, png: toPng(draw(size), size) }));

fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), toIco(images));
fs.writeFileSync(path.join(PUBLIC, 'icon-256.png'), images[0].png);

// Vektorska verzija za favicon u prozoru aplikacije.
fs.writeFileSync(path.join(PUBLIC, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3987e5"/>
      <stop offset="1" stop-color="#1c5cab"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="58" fill="url(#g)"/>
  <path d="M52 186 L104 118 L148 150 L204 66" fill="none" stroke="#fff"
        stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="204" cy="66" r="20" fill="#fff"/>
</svg>
`);

console.log(`icon.ico (${SIZES.join(', ')} px), public/icon.svg i public/icon-256.png su napravljeni.`);
