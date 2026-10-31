import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));

async function exists(relative) {
  try {
    const info = await stat(path.join(ROOT, relative));
    return info.isFile();
  } catch {
    return false;
  }
}

async function walk(dir) {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(relative)));
    else files.push(relative);
  }
  return files;
}

test('manifest is a valid MV3 manifest', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.background.type, 'module');
  assert.ok(manifest.background.service_worker.endsWith('.js'));
});

test('every file the manifest points at exists', async () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action.default_icon || {}),
  ];
  for (const script of manifest.content_scripts) {
    files.push(...script.js, ...(script.css || []));
  }

  for (const file of files) {
    assert.ok(await exists(file), `missing file: ${file}`);
  }
});

test('content script runs on http and https pages only', () => {
  const matches = manifest.content_scripts.flatMap((script) => script.matches);
  assert.ok(matches.includes('http://*/*'));
  assert.ok(matches.includes('https://*/*'));
  assert.ok(matches.every((pattern) => /^https?:\/\//.test(pattern)));
});

test('extension pages load no inline or remote scripts', async () => {
  const pages = ['src/popup.html', 'src/options.html', 'src/auth.html'];
  for (const page of pages) {
    const html = await readFile(path.join(ROOT, page), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
    for (const [, attributes] of scripts) {
      assert.match(attributes, /\bsrc="/, `${page} has an inline script`);
      assert.doesNotMatch(attributes, /https?:\/\//, `${page} loads a remote script`);
    }
  }
});

test('icons are real PNGs with the declared sizes', async () => {
  for (const [size, file] of Object.entries(manifest.icons)) {
    const buffer = await readFile(path.join(ROOT, file));
    assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(buffer.readUInt32BE(16), Number(size), `${file} width`);
    assert.equal(buffer.readUInt32BE(20), Number(size), `${file} height`);
  }
});

test('no secret keys are committed', async () => {
  const files = ['manifest.json', 'README.md', 'package.json'];
  for (const dir of ['src', 'tools', 'test']) {
    for (const file of await walk(dir)) files.push(file);
  }

  const secret = /\bsk_[A-Za-z0-9]{12,}/;
  for (const file of files) {
    const text = await readFile(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, secret, `${file} contains a Pollen secret key`);
  }

  const config = await readFile(path.join(ROOT, 'src/config.js'), 'utf8');
  assert.match(config, /pk_/, 'app key placeholder should be documented');
});
