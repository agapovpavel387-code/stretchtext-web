import { countWords } from './text.js';

export const DETAIL_PRESETS = Object.freeze({
  cozy: { multiplier: 1.5, words: 60, maxTokens: 180 },
  normal: { multiplier: 2.2, words: 90, maxTokens: 260 },
  nerdy: { multiplier: 3.2, words: 140, maxTokens: 380 },
});

const MAX_CONTEXT_CHARS = 1400;
const MAX_OUTPUT_CHARS = 1600;

export function detailPreset(detail) {
  return DETAIL_PRESETS[detail] || DETAIL_PRESETS.normal;
}

/**
 * Keep the part of the paragraph around the clicked sentence so long articles
 * do not spend the reader's Pollen on context the model does not need.
 */
export function contextWindow(block, sentence, maxChars = MAX_CONTEXT_CHARS) {
  const text = String(block || '');
  if (text.length <= maxChars) return text;

  const needle = String(sentence || '').trim();
  const index = needle ? text.indexOf(needle) : -1;
  if (index === -1) return text.slice(0, maxChars);

  const half = Math.max(0, Math.floor((maxChars - needle.length) / 2));
  const start = Math.max(0, Math.min(index - half, text.length - maxChars));
  return text.slice(start, start + maxChars);
}

function cleanLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Build the chat request for one stretch. Everything from the page stays in
 * the user message; the system message never interpolates page text.
 */
export function buildMessages({
  mode = 'more',
  sentence = '',
  block = '',
  heading = '',
  title = '',
  level = 1,
  detail = 'normal',
} = {}) {
  const preset = detailPreset(detail);
  const pageTitle = cleanLine(title);
  const section = cleanLine(heading);
  const context = contextWindow(block, sentence);

  if (mode === 'less') {
    const system = [
      'You are the condense half of a stretchtext reading tool.',
      'Replace the paragraph with one or two sentences of at most 45 words that keep its key facts and meaning.',
      "Keep the author's voice and language. Do not add commentary, labels, markdown or quotation marks.",
      'Return only the replacement text.',
    ].join(' ');

    const user = [
      `PAGE TITLE: ${pageTitle || '(untitled)'}`,
      `SECTION: ${section || '(none)'}`,
      'PARAGRAPH:',
      context || '(empty)',
      '',
      'Condense this paragraph.',
    ].join('\n');

    return {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      maxTokens: 180,
      preset,
    };
  }

  const depthNote =
    level > 1
      ? ` This is level ${level} of the same stretch: go one level deeper with narrower, more concrete specifics instead of restating the sentence.`
      : '';

  const system = [
    'You are the expand half of a stretchtext reading tool.',
    'The reader clicked one sentence. Replace it with a longer version that adds concrete, specific detail and helps understanding.',
    "Keep the author's voice, tense, point of view and language. Stay consistent with the surrounding paragraph and do not invent facts that contradict it.",
    'Do not add a preamble, labels, markdown, quotation marks or commentary.',
    `Return only the replacement text, about ${preset.multiplier}x the original length and no more than ${preset.words} words.`,
    depthNote,
  ]
    .join(' ')
    .trim();

  const user = [
    `PAGE TITLE: ${pageTitle || '(untitled)'}`,
    `SECTION: ${section || '(none)'}`,
    'PARAGRAPH:',
    context || '(empty)',
    '',
    'SELECTED SENTENCE:',
    String(sentence || '').trim() || '(empty)',
  ].join('\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.6,
    maxTokens: preset.maxTokens,
    preset,
  };
}

const REFUSAL = /^(i (?:can'?t|cannot|won'?t)|sorry,? i (?:can'?t|cannot)|i'm sorry,? but)/i;

/**
 * Model output is untrusted. Strip formatting, control characters and
 * runaway length; the DOM layer inserts the result with textContent only.
 */
export function sanitizeExpansion(raw, maxChars = MAX_OUTPUT_CHARS) {
  if (typeof raw !== 'string') return '';

  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/```[a-zA-Z0-9_-]*\s*/g, '')
    .replace(/```/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:expanded|rewritten|answer|replacement)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();

  if (REFUSAL.test(text)) return '';
  if (!text) return '';

  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).replace(/\s+\S*$/, '')}…`;
  }

  return text;
}

/** Reject answers that are suspiciously short compared with the request. */
export function isUsefulExpansion(text, original, mode = 'more') {
  const value = String(text || '').trim();
  if (countWords(value) < (mode === 'less' ? 6 : 8)) return false;
  if (mode === 'less') return true;
  return value.length >= Math.min(40, String(original || '').trim().length * 0.7);
}
