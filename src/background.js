import {
  APP_KEY,
  AUTH_WINDOW,
  DEFAULT_SETTINGS,
  MAX_CACHE_ENTRIES,
  MAX_LEVEL,
} from './config.js';
import {
  buildMessages,
  isUsefulExpansion,
  sanitizeExpansion,
} from './lib/prompt.js';
import {
  PollinationsError,
  devicePoll,
  deviceStart,
  generate,
  getUserinfo,
  listModels,
} from './lib/pollinations.js';
import { hashString } from './lib/text.js';

const FALLBACK_MODELS = [{ name: DEFAULT_SETTINGS.model, title: 'GPT-5.4 Nano', price: 0 }];

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const saved = stored.settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    enabledHosts: { ...(saved.enabledHosts || {}) },
  };
}

async function getAuth() {
  const stored = await chrome.storage.local.get('auth');
  const auth = stored.auth;
  if (!auth || !auth.accessToken) return null;
  if (auth.expiresAt && auth.expiresAt <= Date.now()) return null;
  return auth;
}

async function getAuthStatus() {
  const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
  return {
    connected: Boolean(auth),
    username: auth?.username || '',
    expiresAt: auth?.expiresAt || 0,
    anonymous: Boolean(settings.allowAnonymous),
  };
}

function publicSettings(settings) {
  const { appKey: _appKey, ...rest } = settings;
  return rest;
}

function toErrorPayload(error) {
  if (error instanceof PollinationsError) {
    return {
      code: error.code,
      message: error.message,
      retryAfter: error.retryAfter || null,
    };
  }
  return {
    code: 'unknown',
    message: error?.message || 'Something went wrong.',
  };
}

async function rememberAuth({ accessToken, tokenType, expiresIn, scope }) {
  const [info, settings] = await Promise.all([getUserinfo(accessToken), getSettings()]);
  const username = info?.preferred_username || info?.name || '';
  const auth = {
    accessToken,
    tokenType: tokenType || 'bearer',
    scope: scope || '',
    username,
    connectedAt: Date.now(),
    expiresAt: Date.now() + (Number(expiresIn) || 7 * 24 * 60 * 60) * 1000,
  };
  await chrome.storage.local.set({ auth });
  await chrome.storage.local.remove('authError');
  void settings;
  return auth;
}

async function cacheKeyFor({ model, mode, level, detail, origin, sentence, block }) {
  return hashString(
    [model, mode, level, detail, origin || '', sentence, String(block || '').slice(0, 700)].join(
      '\u0001',
    ),
  );
}

async function readCache(key) {
  const { cache } = await chrome.storage.local.get('cache');
  return cache?.[key]?.text || '';
}

async function writeCache(key, text) {
  const { cache } = await chrome.storage.local.get('cache');
  const next = { ...(cache || {}), [key]: { text, ts: Date.now() } };
  const entries = Object.entries(next)
    .filter(([, value]) => value && typeof value.text === 'string')
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
    .slice(0, MAX_CACHE_ENTRIES);
  await chrome.storage.local.set({ cache: Object.fromEntries(entries) });
}

async function handleGenerate(payload = {}) {
  const settings = await getSettings();
  const auth = await getAuth();
  const token = auth?.accessToken || '';

  if (!token && !settings.allowAnonymous) {
    throw new PollinationsError('auth_required', 'Connect Pollinations to grow text.');
  }

  const mode = payload.mode === 'less' ? 'less' : 'more';
  const level = Math.max(1, Math.min(MAX_LEVEL, Number(payload.level) || 1));
  const detail = settings.detail || 'normal';
  const sentence = String(payload.sentence || '').trim();
  const block = String(payload.block || '').trim();

  if (!sentence && mode === 'more') {
    throw new PollinationsError('input', 'There is no sentence to expand.');
  }
  if (!block) {
    throw new PollinationsError('input', 'There is no text to work with.');
  }

  const { messages, temperature, maxTokens } = buildMessages({
    mode,
    sentence,
    block,
    heading: payload.heading,
    title: payload.title,
    level,
    detail,
  });

  const cacheKey = await cacheKeyFor({
    model: token ? settings.model : 'anonymous',
    mode,
    level,
    detail,
    origin: payload.origin,
    sentence: sentence || block.slice(0, 300),
    block,
  });

  const cached = await readCache(cacheKey);
  if (cached) {
    return { ok: true, text: cached, cached: true, usage: null };
  }

  const result = await generate({
    token,
    anonymous: settings.allowAnonymous,
    model: settings.model,
    messages,
    temperature,
    maxTokens,
  });

  const text = sanitizeExpansion(result.text);
  if (!text || !isUsefulExpansion(text, sentence || block, mode)) {
    throw new PollinationsError('short', 'The model answer was too short. Try again.');
  }

  await writeCache(cacheKey, text);
  return { ok: true, text, cached: false, usage: result.usage || null };
}

async function handleDeviceStart() {
  const settings = await getSettings();
  const candidate = String(settings.appKey || APP_KEY || '').trim();
  const configured = candidate.startsWith('pk_') && !candidate.startsWith('pk_replace');
  const device = await deviceStart(configured ? candidate : '');
  return {
    ok: true,
    device,
    appKeyConfigured: configured,
  };
}

async function handleDevicePoll(deviceCode) {
  if (!deviceCode) throw new PollinationsError('input', 'Missing device code.');
  const result = await devicePoll(deviceCode);
  if (result.status === 'pending') {
    return { ok: true, status: 'pending', slowDown: Boolean(result.slowDown) };
  }

  const auth = await rememberAuth({
    accessToken: result.accessToken,
    tokenType: result.tokenType,
    expiresIn: result.expiresIn,
    scope: result.scope,
  });

  return { ok: true, status: 'connected', username: auth.username, expiresAt: auth.expiresAt };
}

async function handleSetToken(token) {
  const value = String(token || '').trim();
  if (!/^(?:plln_)?sk_[A-Za-z0-9._-]{8,}$/.test(value)) {
    throw new PollinationsError('input', 'That does not look like a Pollinations secret key (sk_…).');
  }
  const auth = await rememberAuth({ accessToken: value });
  return { ok: true, username: auth.username, expiresAt: auth.expiresAt };
}

async function handleModels() {
  const stored = await chrome.storage.local.get('modelsCache');
  const cached = stored.modelsCache;
  if (cached?.ts && Date.now() - cached.ts < 24 * 60 * 60 * 1000 && Array.isArray(cached.models)) {
    return { ok: true, models: cached.models, cached: true };
  }

  try {
    const models = await listModels();
    if (!models.length) throw new Error('empty model list');
    await chrome.storage.local.set({ modelsCache: { ts: Date.now(), models } });
    return { ok: true, models, cached: false };
  } catch (error) {
    if (cached?.models?.length) {
      return { ok: true, models: cached.models, cached: true, degraded: true };
    }
    return { ok: false, models: FALLBACK_MODELS, error: toErrorPayload(error) };
  }
}

async function openAuthWindow() {
  const url = chrome.runtime.getURL('src/auth.html');
  const windows = await chrome.windows.getAll({ populate: true });
  const existing = windows.find((window) => window.tabs?.some((tab) => tab.url === url));
  if (existing?.id) {
    await chrome.windows.update(existing.id, { focused: true });
    return { ok: true, reused: true };
  }
  await chrome.windows.create({
    url,
    type: 'popup',
    width: AUTH_WINDOW.width,
    height: AUTH_WINDOW.height,
  });
  return { ok: true, reused: false };
}

async function updateSite(host, enabled) {
  const value = String(host || '').trim();
  if (!value) throw new PollinationsError('input', 'Missing site host.');
  const settings = await getSettings();
  if (enabled) settings.enabledHosts[value] = true;
  else delete settings.enabledHosts[value];
  await chrome.storage.local.set({ settings });
  return { ok: true, enabled: Boolean(enabled) };
}

const PATCHABLE = new Set(['model', 'detail', 'appKey', 'allowAnonymous', 'maxExpansionsPerPage']);

async function updateSettings(patch = {}) {
  const settings = await getSettings();
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!PATCHABLE.has(key)) continue;
    if (key === 'maxExpansionsPerPage') {
      settings[key] = Math.max(1, Math.min(200, Number(raw) || 40));
    } else if (key === 'allowAnonymous') {
      settings[key] = Boolean(raw);
    } else {
      settings[key] = String(raw).slice(0, 300);
    }
  }
  await chrome.storage.local.set({ settings });
  return { ok: true, settings: publicSettings(settings), appKey: settings.appKey || '' };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isWebTab(tab) {
  return Boolean(tab?.id) && /^https?:\/\//i.test(tab?.url || '');
}

async function cacheInfo() {
  const { cache } = await chrome.storage.local.get('cache');
  return { ok: true, entries: Object.keys(cache || {}).length };
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'stretch:init': {
      const [settings, auth] = await Promise.all([getSettings(), getAuthStatus()]);
      return { ok: true, settings: publicSettings(settings), auth };
    }
    case 'stretch:auth-status':
      return { ok: true, auth: await getAuthStatus() };
    case 'stretch:generate':
      return handleGenerate(message.payload);
    case 'stretch:device-start':
      return handleDeviceStart();
    case 'stretch:device-poll':
      return handleDevicePoll(message.deviceCode);
    case 'stretch:set-token':
      return handleSetToken(message.token);
    case 'stretch:disconnect':
      await chrome.storage.local.remove('auth');
      return { ok: true };
    case 'stretch:models':
      return handleModels();
    case 'stretch:open-auth':
      return openAuthWindow();
    case 'stretch:open-url': {
      const url = String(message.url || '');
      if (!/^https:\/\/enter\.pollinations\.ai\//.test(url)) {
        throw new PollinationsError('input', 'That link is not allowed.');
      }
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    case 'stretch:set-site':
      return updateSite(message.host, Boolean(message.enabled));
    case 'stretch:update-settings':
      return updateSettings(message.patch);
    case 'stretch:sites': {
      const settings = await getSettings();
      return { ok: true, sites: Object.keys(settings.enabledHosts).sort() };
    }
    case 'stretch:cache-info':
      return cacheInfo();
    case 'stretch:clear-cache':
      await chrome.storage.local.remove('cache');
      return { ok: true };
    case 'stretch:tab-state': {
      const tab = await activeTab();
      const state = isWebTab(tab) ? await sendToTab(tab.id, { type: 'stretch:page-state' }) : null;
      return {
        ok: true,
        tab: {
          id: tab?.id ?? null,
          url: tab?.url || '',
          supported: isWebTab(tab),
        },
        state: state || null,
      };
    }
    case 'stretch:tab-apply': {
      const tab = await activeTab();
      if (!isWebTab(tab)) {
        throw new PollinationsError('input', 'Stretch only runs on regular web pages.');
      }
      const host = new URL(tab.url).hostname;
      const enabled = Boolean(message.enabled);
      await updateSite(host, enabled);
      const state = await sendToTab(tab.id, { type: 'stretch:apply', enabled });
      return { ok: Boolean(state), enabled, state: state || null };
    }
    case 'stretch:tab-collapse': {
      const tab = await activeTab();
      if (!isWebTab(tab)) return { ok: false, state: null };
      const state = await sendToTab(tab.id, { type: 'stretch:collapse-all' });
      return { ok: Boolean(state), state: state || null };
    }
    case 'stretch:set-badge': {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') return { ok: true };
      if (message.on) {
        await chrome.action.setBadgeText({ tabId, text: 'on' });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: '#E8B04B' });
        if (chrome.action.setBadgeTextColor) {
          await chrome.action.setBadgeTextColor({ tabId, color: '#14110F' });
        }
      } else {
        await chrome.action.setBadgeText({ tabId, text: '' });
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: { code: 'unknown_message', message: 'Unknown request.' } };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: toErrorPayload(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get('settings');
  const saved = stored.settings || {};
  await chrome.storage.local.set({
    settings: {
      ...DEFAULT_SETTINGS,
      ...saved,
      enabledHosts: { ...(saved.enabledHosts || {}) },
    },
  });

  if (details?.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html#welcome') });
  }
});

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      return null;
    }
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-stretch') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await sendToTab(tab.id, { type: 'stretch:toggle' });
});
