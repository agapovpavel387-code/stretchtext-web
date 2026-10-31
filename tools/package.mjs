// Packs the loadable extension into dist/stretch-<version>.zip.
// Minimal ZIP writer (stored entries, no dependencies) so the repo stays
// dependency-free.

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from './lib/crc32.mjs';
import { ROOT } from './build-content.mjs';

const INCLUDE_DIRS = ['src', 'assets'];
const INCLUDE_FILES = ['manifest.json', 'LICENSE'];
const SKIP = /\.src\.js$/;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (!SKIP.test(entry.name)) files.push(full);
  }
  return files;
}

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));

const files = [];
for (const name of INCLUDE_FILES) files.push(path.join(ROOT, name));
for (const dir of INCLUDE_DIRS) files.push(...(await walk(path.join(ROOT, dir))));

const entries = [];
for (const file of files) {
  const data = await readFile(file);
  const info = await stat(file);
  entries.push({
    name: path.relative(ROOT, file).split(path.sep).join('/'),
    data,
    mtime: info.mtime,
  });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const local = [];
const central = [];
let offset = 0;

for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const { time, day } = dosDateTime(entry.mtime);
  const crc = crc32(entry.data);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(day, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);

  local.push(header, name, entry.data);

  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(0, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(time, 12);
  record.writeUInt16LE(day, 14);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(entry.data.length, 20);
  record.writeUInt32LE(entry.data.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt16LE(0, 30);
  record.writeUInt16LE(0, 32);
  record.writeUInt16LE(0, 34);
  record.writeUInt16LE(0, 36);
  record.writeUInt32LE(0, 38);
  record.writeUInt32LE(offset, 42);

  central.push(record, name);
  offset += header.length + name.length + entry.data.length;
}

const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...local, centralBuffer, end]);

const outDir = path.join(ROOT, 'dist');
await mkdir(outDir, { recursive: true });
const target = path.join(outDir, `stretch-${manifest.version}.zip`);
await writeFile(target, zip);

console.log(
  `dist/stretch-${manifest.version}.zip — ${entries.length} files, ${(zip.length / 1024).toFixed(1)} KB`,
);
