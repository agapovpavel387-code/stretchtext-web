// GENERATED FILE — do not edit.
// Source: src/content.src.js + src/lib/text.js. Rebuild with: npm run build
(function () {
'use strict';

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
function splitSentences(text, lang = 'en') {
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
function planSlice(nodeStrings, start, end) {
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
function hashString(input) {
  const value = String(input);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Count words in a way that works for scripts without spaces. */
function countWords(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  const spaced = value.split(/\s+/).filter(Boolean).length;
  const cjk = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  return Math.max(spaced, Math.ceil(cjk / 2));
}

// Body of the content script. `npm run build` wraps this file with the shared
// helpers from src/lib/text.js into src/content.js (a classic content script,
// because Manifest V3 content scripts cannot use ES modules).
//
// Requires: splitSentences, planSlice (from src/lib/text.js).

if (window.__strxLoaded) return;
window.__strxLoaded = true;

const BLOCK_SELECTOR = 'p, li, blockquote, dd, figcaption, td, th, h1, h2, h3, h4, h5, h6';
const SKIP_CLOSEST =
  '.strx-ui, code, pre, kbd, samp, textarea, script, style, noscript, svg, math, [contenteditable=""], [contenteditable="true"]';
const MIN_BLOCK_CHARS = 40;
const MAX_SENTENCE_CHARS = 1200;
const HIGHLIGHT_NAME = 'strx-sentence';

let settings = null;
let enabled = false;
let expansionCount = 0;
const busy = new WeakSet();
const segments = new Set();

let highlightSupported = false;
try {
  highlightSupported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
} catch {
  highlightSupported = false;
}

let hoverRaf = 0;
let lastPoint = null;
let toastEl = null;
let toastTimer = 0;

// ---------------------------------------------------------------- messaging

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply || null);
      });
    } catch {
      resolve(null);
    }
  });
}

// --------------------------------------------------------------- text model

function collectTextNodes(block) {
  const nodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue;
    const parent = node.parentElement;
    if (value && value.trim() && parent && !parent.closest(SKIP_CLOSEST)) nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function firstTextNode(element) {
  if (!element) return null;
  if (element.nodeType === 3) return element;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return walker.nextNode();
}

function caretAt(x, y) {
  try {
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (position?.offsetNode) return { node: position.offsetNode, offset: position.offset };
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range?.startContainer) return { node: range.startContainer, offset: range.startOffset };
    }
  } catch {
    // Some pages throw from hit-testing; treat as a miss.
  }
  return null;
}

/** Resolve a pointer position to a sentence inside a readable block. */
function locate(x, y) {
  const caret = caretAt(x, y);
  if (!caret?.node) return null;

  const startElement = caret.node.nodeType === 1 ? caret.node : caret.node.parentElement;
  if (!startElement || startElement.closest(SKIP_CLOSEST)) return null;

  const block = startElement.closest(BLOCK_SELECTOR);
  if (!block || block.closest('.strx-ui')) return null;

  const nodes = collectTextNodes(block);
  if (!nodes.length) return null;

  const text = nodes.map((node) => node.nodeValue).join('');
  if (text.trim().length < MIN_BLOCK_CHARS) return null;

  let node = caret.node;
  let offset = caret.offset;

  if (node.nodeType !== 3) {
    const child = node.childNodes[Math.min(offset, node.childNodes.length - 1)];
    const found = firstTextNode(child);
    if (!found) return null;
    node = found;
    offset = 0;
  }
  if (!nodes.includes(node)) return null;

  let index = 0;
  for (const candidate of nodes) {
    if (candidate === node) break;
    index += candidate.nodeValue.length;
  }

  return { block, nodes, text, offset: index + Math.min(offset, node.nodeValue.length), node };
}

function sentenceAt(loc) {
  const sentences = splitSentences(loc.text, document.documentElement.lang || 'en');
  if (!sentences.length) return null;

  const sentence =
    sentences.find((item) => loc.offset >= item.start && loc.offset < item.end) ||
    sentences.find((item) => Math.abs(item.start - loc.offset) <= 2) ||
    sentences[sentences.length - 1];

  if (!sentence) return null;
  if (sentence.text.trim().length < 3) return null;
  if (sentence.text.length > MAX_SENTENCE_CHARS) return null;
  return sentence;
}

function rangeFor(nodes, sentence) {
  const plan = planSlice(
    nodes.map((node) => node.nodeValue),
    sentence.start,
    sentence.end,
  );
  if (!plan.length) return null;

  const first = plan[0];
  const last = plan[plan.length - 1];
  const range = document.createRange();
  try {
    range.setStart(nodes[first.nodeIndex], first.start);
    range.setEnd(nodes[last.nodeIndex], last.end);
  } catch {
    return null;
  }
  return range;
}

/** How many stretches deep this position already is. */
function depthAt(node) {
  let depth = 1;
  let element = node.nodeType === 1 ? node : node.parentElement;
  while (element) {
    if (element.classList?.contains('strx-add')) depth += 1;
    element = element.parentElement;
  }
  return depth;
}

function headingFor(block) {
  let element = block.previousElementSibling;
  let hops = 0;
  while (element && hops < 12) {
    if (/^H[1-6]$/.test(element.tagName)) return element.textContent.trim().slice(0, 200);
    element = element.previousElementSibling;
    hops += 1;
  }
  const section = block.closest('section, article, main');
  const heading = section?.querySelector('h1, h2, h3');
  return heading ? heading.textContent.trim().slice(0, 200) : '';
}

function contextText(block) {
  return collectTextNodes(block)
    .map((node) => node.nodeValue)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

// -------------------------------------------------------------------- chips

function makeChip(label, title, onClick) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'strx-ui strx-chip';
  chip.textContent = label;
  chip.title = title;
  chip.setAttribute('aria-label', title);
  chip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  chip.addEventListener('mousedown', (event) => event.preventDefault());
  return chip;
}

function showToast(message, options = {}) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'strx-ui strx-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
  }
  toastEl.textContent = String(message);
  toastEl.dataset.tone = options.tone || 'info';
  if (!toastEl.isConnected) document.documentElement.appendChild(toastEl);
  toastEl.classList.add('strx-toast-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('strx-toast-visible'), 4200);
}

function errorMessage(error) {
  switch (error?.code) {
    case 'auth_required':
      return 'Connect Pollinations in the Stretch popup to grow text.';
    case 'no_pollen':
      return 'Out of Pollen for this key. Top up or finish a quest at enter.pollinations.ai.';
    case 'rate_limited':
      return 'Pollinations is rate limiting. Try again in a moment.';
    case 'timeout':
      return 'The model took too long. Try again.';
    case 'short':
    case 'empty':
      return 'That answer was too thin to show. Try again.';
    default:
      return error?.message || 'Could not grow that sentence.';
  }
}

// ---------------------------------------------------------------- segments

function openSentenceSegment(block, range) {
  const original = document.createElement('span');
  original.className = 'strx-orig';
  original.appendChild(range.extractContents());
  range.insertNode(original);

  const addition = document.createElement('span');
  addition.className = 'strx-add strx-pending';
  addition.setAttribute('aria-live', 'polite');

  const segment = { block, original, addition, chip: null, closed: false, level: 1 };
  const chip = makeChip('−', 'Shrink back', () => closeSegment(segment));
  segment.chip = chip;

  original.after(addition);
  addition.after(chip);
  segments.add(segment);
  return segment;
}

function openBlockSegment(block) {
  const original = document.createElement('span');
  original.className = 'strx-orig strx-hidden';
  while (block.firstChild) original.appendChild(block.firstChild);

  const addition = document.createElement('span');
  addition.className = 'strx-add strx-summary strx-pending';
  addition.setAttribute('aria-live', 'polite');

  const segment = { block, original, addition, chip: null, closed: false, level: 1, mode: 'less' };
  const chip = makeChip('+', 'Show the full text', () => closeSegment(segment));
  segment.chip = chip;

  block.append(original, addition, chip);
  segments.add(segment);
  return segment;
}

function fillSegment(segment, text, level) {
  segment.addition.classList.remove('strx-pending');
  segment.addition.textContent = text;
  segment.addition.dataset.level = String(level || 1);
  segment.addition.classList.add('strx-grown');
}

function closeSegment(segment) {
  if (!segment || segment.closed) return;
  segment.closed = true;

  const parent = segment.original.parentNode;
  if (parent) {
    segment.original.replaceWith(...segment.original.childNodes);
    parent.normalize();
  }
  segment.addition.remove();
  segment.chip?.remove();
  segments.delete(segment);
}

function collapseLast() {
  const list = [...segments];
  const segment = list[list.length - 1];
  if (segment) closeSegment(segment);
}

function collapseAll() {
  for (const segment of [...segments]) closeSegment(segment);
  segments.clear();
  expansionCount = 0;
  clearHighlight();
}

// ------------------------------------------------------------------ actions

async function grow(loc, sentence) {
  if (!settings) return;

  const limit = Number(settings.maxExpansionsPerPage) || 40;
  if (expansionCount >= limit) {
    showToast('Page limit reached. Reload the page to keep stretching.');
    return;
  }

  const level = depthAt(loc.node);
  if (level > 3) {
    showToast('This is as deep as the stretch goes.');
    return;
  }

  const block = loc.block;
  const range = rangeFor(loc.nodes, sentence);
  if (!range) return;

  const payload = {
    mode: 'more',
    sentence: sentence.text.trim(),
    block: contextText(block),
    heading: headingFor(block),
    title: document.title,
    level,
    origin: location.origin,
  };

  busy.add(block);
  const segment = openSentenceSegment(block, range);
  segment.level = level;

  const reply = await send({ type: 'stretch:generate', payload });
  busy.delete(block);

  if (!reply?.ok) {
    closeSegment(segment);
    showToast(errorMessage(reply?.error), { tone: 'warn' });
    return;
  }

  fillSegment(segment, reply.text, level);
  countExpansion();
}

async function condense(block) {
  if (!settings) return;

  const limit = Number(settings.maxExpansionsPerPage) || 40;
  if (expansionCount >= limit) {
    showToast('Page limit reached. Reload the page to keep stretching.');
    return;
  }
  if (busy.has(block)) return;

  const payload = {
    mode: 'less',
    block: contextText(block),
    heading: headingFor(block),
    title: document.title,
    level: 1,
    origin: location.origin,
  };

  busy.add(block);
  const segment = openBlockSegment(block);

  const reply = await send({ type: 'stretch:generate', payload });
  busy.delete(block);

  if (!reply?.ok) {
    closeSegment(segment);
    showToast(errorMessage(reply?.error), { tone: 'warn' });
    return;
  }

  fillSegment(segment, reply.text, 1);
  countExpansion();
}

function countExpansion() {
  expansionCount += 1;
  clearHighlight();
}

// ------------------------------------------------------------------ events

function updateHighlight() {
  if (!enabled || !highlightSupported || !lastPoint) return;

  const loc = locate(lastPoint.x, lastPoint.y);
  const sentence = loc ? sentenceAt(loc) : null;
  const range = sentence ? rangeFor(loc.nodes, sentence) : null;

  if (!range) {
    clearHighlight();
    return;
  }

  try {
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
  } catch {
    highlightSupported = false;
  }
}

function clearHighlight() {
  if (!highlightSupported) return;
  try {
    CSS.highlights.delete(HIGHLIGHT_NAME);
  } catch {
    // ignore
  }
}

function onPointerMove(event) {
  if (!enabled) return;
  lastPoint = { x: event.clientX, y: event.clientY };
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    updateHighlight();
  });
}

function onClick(event) {
  if (!enabled || event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const selection = window.getSelection();
  // Shift-click condenses a paragraph, so a live selection is harmless there;
  // for a plain click a selection means the reader is copying, not stretching.
  if (!event.shiftKey && selection && !selection.isCollapsed) return;

  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.strx-ui')) return;
  if (target.closest('a[href], button, input, textarea, select, label, summary, audio, video')) {
    return;
  }

  const loc = locate(event.clientX, event.clientY);
  if (!loc) return;

  const sentence = sentenceAt(loc);
  if (!sentence) return;
  if (busy.has(loc.block)) return;

  event.preventDefault();
  event.stopPropagation();

  const action = event.shiftKey ? condense(loc.block) : grow(loc, sentence);
  action.catch(() => showToast('Something went wrong. Try again.'));
}

function onKeyDown(event) {
  if (!enabled) return;
  if (event.key === 'Escape' && segments.size) {
    collapseLast();
    event.stopPropagation();
  }
}

// ------------------------------------------------------------------- state

function setBadge(on) {
  void send({ type: 'stretch:set-badge', on });
}

function setEnabled(on, options = {}) {
  const next = Boolean(on);
  if (next === enabled && !options.force) return;
  enabled = next;
  document.documentElement.classList.toggle('strx-on', next);

  if (!next) {
    collapseAll();
    clearHighlight();
  }
  setBadge(next);

  if (!options.silent) {
    showToast(next ? 'Stretch is on: click a sentence to grow it.' : 'Stretch is off.');
  }
}

async function persistSite(on) {
  await send({ type: 'stretch:set-site', host: location.hostname, enabled: on });
}

function pageState() {
  return {
    ok: true,
    enabled,
    expansions: expansionCount,
    hasSegments: segments.size > 0,
    highlight: highlightSupported,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'stretch:apply': {
      setEnabled(Boolean(message.enabled));
      sendResponse(pageState());
      return false;
    }
    case 'stretch:toggle': {
      const next = !enabled;
      setEnabled(next);
      void persistSite(next);
      sendResponse({ ...pageState(), enabled: next });
      return false;
    }
    case 'stretch:page-state': {
      sendResponse(pageState());
      return false;
    }
    case 'stretch:collapse-all': {
      collapseAll();
      sendResponse(pageState());
      return false;
    }
    default:
      return false;
  }
});

document.addEventListener('mousemove', onPointerMove, { passive: true, capture: true });
document.addEventListener('click', onClick, true);
document.addEventListener('keydown', onKeyDown, true);
window.addEventListener('scroll', clearHighlight, { passive: true });
document.addEventListener('mouseleave', clearHighlight, true);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settings = changes.settings.newValue || settings;
  const host = location.hostname;
  setEnabled(Boolean(settings?.enabledHosts?.[host]), { silent: true });
});

(async function boot() {
  const reply = await send({ type: 'stretch:init' });
  if (!reply?.ok) return;
  settings = reply.settings;
  setEnabled(Boolean(settings?.enabledHosts?.[location.hostname]), { silent: true });
})();
})();
