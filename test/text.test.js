import test from 'node:test';
import assert from 'node:assert/strict';
import { countWords, hashString, planSlice, splitSentences } from '../src/lib/text.js';

test('splitSentences finds plain sentences', () => {
  const sentences = splitSentences(
    'One thing happened. Then another thing happened! Did it really work?',
  );
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0].text.trim(), 'One thing happened.');
  assert.equal(sentences[2].text.trim(), 'Did it really work?');
});

test('splitSentences keeps offsets that map back to the source', () => {
  const source = 'First sentence here. Second sentence follows it.';
  for (const sentence of splitSentences(source)) {
    assert.equal(source.slice(sentence.start, sentence.end), sentence.text);
  }
});

test('splitSentences merges tiny fragments instead of making tiny targets', () => {
  const sentences = splitSentences('Yes. Dr. Smith arrived at the clinic.');
  assert.equal(sentences.length, 1);
  assert.match(sentences[0].text, /Dr\. Smith/);
});

test('splitSentences handles unpunctuated text and CJK', () => {
  assert.equal(splitSentences('just some words without a full stop').length, 1);
  const cjk = splitSentences('これは最初の文です。これは二番目の文です。', 'ja');
  assert.equal(cjk.length, 2);
});

test('splitSentences returns nothing for empty input', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
});

test('planSlice splits one range across text nodes', () => {
  const parts = planSlice(['Hello ', 'brave new ', 'world'], 3, 18);
  assert.deepEqual(parts, [
    { nodeIndex: 0, start: 3, end: 6 },
    { nodeIndex: 1, start: 0, end: 10 },
    { nodeIndex: 2, start: 0, end: 2 },
  ]);
});

test('planSlice ignores empty ranges', () => {
  assert.deepEqual(planSlice(['abc'], 2, 2), []);
  assert.deepEqual(planSlice([], 0, 5), []);
});

test('hashString is stable and short', () => {
  const first = hashString('model|more|1|same text');
  assert.equal(first, hashString('model|more|1|same text'));
  assert.notEqual(first, hashString('model|more|1|other text'));
  assert.match(first, /^[0-9a-z]+$/);
});

test('countWords handles spaced and unspaced scripts', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('two words'), 2);
  assert.equal(countWords('こんにちは世界'), 4);
});
