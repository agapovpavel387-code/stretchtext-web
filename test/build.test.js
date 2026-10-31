import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, bundleContent } from '../tools/build-content.mjs';

test('committed src/content.js matches its sources', async () => {
  const expected = await bundleContent();
  const actual = await readFile(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.equal(actual, expected, 'run `npm run build` and commit src/content.js');
});

test('bundled content script exposes no module syntax', async () => {
  const bundle = await bundleContent();
  assert.doesNotMatch(bundle, /^\s*(import|export)\s/m);
  assert.match(bundle, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(bundle, /function splitSentences/);
});
