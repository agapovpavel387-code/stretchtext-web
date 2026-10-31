// Pure text utilities shared by the content script (via tools/build-content.mjs)
// and by the extension's test suite.

// Sentence-final abbreviations that some segmenters split on.
const ABBREVIATION =
  /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|inc|ltd|co|no|vol|fig|al|approx|dept|est|e\.g|i\.e|cf)\.|\b[a-z]\.)$/i;

/**
 * Split text into sentence ranges without changing the text.
 * Uses Intl.Segmenter where available, with a punctuation fallback.
 *
 * @param {string} text
 * @param {string} lang BCP-47 tag, e.g. "en" or "ja"
 * @returns {{start:number,end:number,text:string}[]}
 */
export function splitSentences(text, lang = 'en') {
  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return [];

  let segments = [];

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter(lang || 'en', { granularity: 'sentence' });
      for (const part of segmenter.segment(source)) {
        segments.push({
          start: part.index,
          end: part.index + part.segment.length,
          text: part.segment,
        });
      }
    } catch {
      segments = [];
    }
  }

  if (segments.length === 0) {
    const pattern = /[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      segments.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      });
    }
  }

  // Merge fragments so we do not create one-syllable click targets: first
  // join segments that end on a known abbreviation ("Dr.", "e.g."), then fold
  // very short leftovers into their neighbour.
  const joined = [];
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    const previous = joined[joined.length - 1];
    if (previous && ABBREVIATION.test(previous.text.trim())) {
      previous.end = segment.end;
      previous.text = source.slice(previous.start, previous.end);
    } else {
      joined.push({ start: segment.start, end: segment.end, text: segment.text });
    }
  }

  const merged = [];
  for (const segment of joined) {
    const trimmed = segment.text.trim();
    if (!trimmed) continue;
    const previous = merged[merged.length - 1];
    const tiny = trimmed.length < 8 || !/[\p{L}\p{N}]/u.test(trimmed);
    if (previous && tiny) {
      previous.end = segment.end;
      previous.text = source.slice(previous.start, previous.end);
    } else {
      merged.push({ start: segment.start, end: segment.end, text: segment.text });
    }
  }

  if (merged.length > 1) {
    const first = merged[0];
    if (first.text.trim().length < 8) {
      merged[1].start = first.start;
      merged[1].text = source.slice(merged[1].start, merged[1].end);
      merged.shift();
    }
  }

  return merged.filter((segment) => /[\p{L}\p{N}]/u.test(segment.text));
}

/**
 * Map a [start, end) range in the concatenation of nodeStrings onto the
 * individual strings, returning per-node offsets.
 *
 * @param {string[]} nodeStrings
 * @param {number} start
 * @param {number} end
 * @returns {{nodeIndex:number,start:number,end:number}[]}
 */
export function planSlice(nodeStrings, start, end) {
  const parts = [];
  let offset = 0;
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || 0);

  for (let index = 0; index < nodeStrings.length; index += 1) {
    const length = nodeStrings[index].length;
    const localStart = Math.max(from, offset);
    const localEnd = Math.min(to, offset + length);
    if (localEnd > localStart) {
      parts.push({
        nodeIndex: index,
        start: localStart - offset,
        end: localEnd - offset,
      });
    }
    offset += length;
  }

  return parts;
}

/** Stable, short FNV-1a hash used for cache keys. */
export function hashString(input) {
  const value = String(input);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Count words in a way that works for scripts without spaces. */
export function countWords(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  const spaced = value.split(/\s+/).filter(Boolean).length;
  const cjk = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  return Math.max(spaced, Math.ceil(cjk / 2));
}
