// Generates the extension icons (16/32/48/128) as real PNG files with no
// dependencies: the shapes are drawn into a supersampled buffer and encoded
// with zlib.deflateSync.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from './lib/crc32.mjs';
import { ROOT } from './build-content.mjs';

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const INK = [20, 17, 15];
const GOLD = [232, 176, 75];

function blend(buffer, width, x, y, [r, g, b, a]) {
  const index = (y * width + x) * 4;
  const alpha = a / 255;
  buffer[index] = Math.round(r * alpha + buffer[index] * (1 - alpha));
  buffer[index + 1] = Math.round(g * alpha + buffer[index + 1] * (1 - alpha));
  buffer[index + 2] = Math.round(b * alpha + buffer[index + 2] * (1 - alpha));
  buffer[index + 3] = Math.max(buffer[index + 3], a);
}

function fillRoundRect(buffer, width, height, box, radius, color) {
  const [x0, y0, x1, y1] = box;
  const halfWidth = (x1 - x0) / 2;
  const halfHeight = (y1 - y0) / 2;
  const cx = x0 + halfWidth;
  const cy = y0 + halfHeight;
  const r = Math.min(radius, halfWidth, halfHeight);

  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y += 1) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x += 1) {
      const dx = Math.abs(x + 0.5 - cx) - (halfWidth - r);
      const dy = Math.abs(y + 0.5 - cy) - (halfHeight - r);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
      if (outside <= 0) blend(buffer, width, x, y, color);
    }
  }
}

function drawIcon(size) {
  const scale = SUPERSAMPLE;
  const width = size * scale;
  const height = width;
  const buffer = new Uint8Array(width * height * 4);

  // Card
  fillRoundRect(
    buffer,
    width,
    height,
    [width * 0.02, height * 0.02, width * 0.98, height * 0.98],
    width * 0.24,
    [...INK, 255],
  );

  // Three bars growing wider: the middle one is the stretch.
  const barHeight = height * 0.11;
  const radius = barHeight / 2;
  const left = width * 0.2;
  const rows = [
    { y: 0.3, w: 0.32, a: 150 },
    { y: 0.445, w: 0.6, a: 255 },
    { y: 0.59, w: 0.42, a: 150 },
  ];

  for (const row of rows) {
    const top = height * row.y;
    fillRoundRect(
      buffer,
      width,
      height,
      [left, top, left + width * row.w, top + barHeight],
      radius,
      [...GOLD, row.a],
    );
  }

  // Downsample
  const out = Buffer.alloc(size * size * 4);
  const samples = scale * scale;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = ((y * scale + sy) * width + (x * scale + sx)) * 4;
          r += buffer[index];
          g += buffer[index + 1];
          b += buffer[index + 2];
          a += buffer[index + 3];
        }
      }
      const offset = (y * size + x) * 4;
      out[offset] = Math.round(r / samples);
      out[offset + 1] = Math.round(g / samples);
      out[offset + 2] = Math.round(b / samples);
      out[offset + 3] = Math.round(a / samples);
    }
  }

  return out;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const target = path.join(ROOT, 'assets');
await mkdir(target, { recursive: true });

for (const size of SIZES) {
  const png = encodePng(size, drawIcon(size));
  await writeFile(path.join(target, `icon-${size}.png`), png);
  console.log(`assets/icon-${size}.png (${png.length} bytes)`);
}
