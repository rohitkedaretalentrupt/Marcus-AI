/**
 * Generates PLACEHOLDER PWA icons in the brand style: the logo's "i" — a white
 * stem with a red dot — on black
 * using only Node built-ins. Replace public/icons/* with real artwork before launch.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const BLACK = [0x00, 0x00, 0x00];
const WHITE = [0xff, 0xff, 0xff];
const RED = [0xec, 0x0a, 0x14];

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** `scale` < 1 shrinks the glyph to stay inside the maskable safe zone. */
function brandGlyph(size, scale) {
  const stemW = size * 0.09 * scale;
  const stemH = size * 0.36 * scale;
  const dotR = size * 0.075 * scale;
  const cx = size / 2;
  const stemTop = size / 2 - stemH * 0.3;
  const dotCy = stemTop - dotR * 2.1;

  return (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    if ((px - cx) ** 2 + (py - dotCy) ** 2 <= dotR ** 2) return RED;
    if (Math.abs(px - cx) <= stemW / 2 && py >= stemTop && py <= stemTop + stemH) return WHITE;
    return BLACK;
  };
}

const icons = [
  { file: "icon-192.png", size: 192, scale: 1 },
  { file: "icon-512.png", size: 512, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, scale: 0.75 },
  { file: "apple-touch-icon.png", size: 180, scale: 1 },
];

mkdirSync(outDir, { recursive: true });
for (const { file, size, scale } of icons) {
  writeFileSync(join(outDir, file), encodePng(size, brandGlyph(size, scale)));
  console.log(`wrote public/icons/${file}`);
}
