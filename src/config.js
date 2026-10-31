// Public configuration. Never put a secret key in this file.
//
// APP_KEY is the publishable "App Key" (pk_...) created at
// https://enter.pollinations.ai/keys -> Apps. It identifies the extension on
// the BYOP consent screen and attributes usage to its publisher. It is safe to
// ship: it can only ask the reader for permission, never spend anything.
export const APP_KEY = 'pk_STyG6Kv20IivBVEg';

export const DEFAULT_MODEL = 'openai/gpt-5.4-nano';

/** Deepest stretch level; keeps readers from drilling forever. */
export const MAX_LEVEL = 3;
/** Cache entries kept in chrome.storage.local (~250 tiny strings). */
export const MAX_CACHE_ENTRIES = 300;

export const DEFAULT_SETTINGS = Object.freeze({
  model: DEFAULT_MODEL,
  detail: 'normal',
  appKey: '',
  allowAnonymous: false,
  enabledHosts: {},
  maxExpansionsPerPage: 40,
});

export const AUTH_WINDOW = Object.freeze({ width: 520, height: 640 });
