// Bundles the content script: src/lib/text.js + src/content.src.js -> src/content.js
//
// Manifest V3 content scripts are classic scripts, so the shared text helpers
// cannot be imported. They are inlined here instead. src/content.js is
// committed so the extension can be loaded unpacked without running Node;
// test/build.test.js fails when the committed file is out of date.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * @param {string} rootDir
 * @returns {Promise<string>} the bundled content script source
 */
export async function bundleContent(rootDir = ROOT) {
  const [lib, body] = await Promise.all([
    readFile(path.join(rootDir, 'src/lib/text.js'), 'utf8'),
    readFile(path.join(rootDir, 'src/content.src.js'), 'utf8'),
  ]);

  const helpers = lib
    .replace(/^export\s+/gm, '')
    .replace(/^\s*\/\/ Pure text utilities[\s\S]*?\n\n/, '');

  return [
    '// GENERATED FILE — do not edit.',
    '// Source: src/content.src.js + src/lib/text.js. Rebuild with: npm run build',
    '(function () {',
    "'use strict';",
    '',
    helpers.trim(),
    '',
    body.trim(),
    '})();',
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = await bundleContent();
  const target = path.join(ROOT, 'src/content.js');
  await writeFile(target, source, 'utf8');
  console.log(`content.js written (${source.length} bytes)`);
}
