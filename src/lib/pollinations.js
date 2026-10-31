import { API_BASE, CLASSIC_BASE, ENTER_BASE } from '../config.js';

export class PollinationsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PollinationsError';
    this.code = code;
    this.retryAfter = extra.retryAfter || null;
    this.status = extra.status || 0;
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function friendlyStatus(status, data) {
  const detail = data?.error?.message || data?.message || '';
  if (status === 401) {
    return new PollinationsError('auth_required', 'Connect Pollinations to grow text.', { status });
  }
  if (status === 402) {
    return new PollinationsError('no_pollen', 'This request needs more Pollen than your key has left.', {
      status,
    });
  }
  if (status === 429) {
    return new PollinationsError('rate_limited', 'Pollinations is rate limiting requests. Try again shortly.', {
      status,
    });
  }
  if (status === 403) {
    return new PollinationsError('forbidden', detail || 'This key is not allowed to use that model.', {
      status,
    });
  }
  return new PollinationsError('upstream', detail || `Pollinations returned HTTP ${status}.`, { status });
}

/**
 * One chat completion. `token` is the reader's BYOP key; `anonymous` is the
 * explicit developer/test fallback and never the default.
 */
export async function generate({
  token = '',
  anonymous = false,
  model,
  messages,
  temperature = 0.5,
  maxTokens = 260,
  timeoutMs = 60000,
}) {
  const useAnonymous = !token && anonymous;
  const url = useAnonymous ? `${CLASSIC_BASE}/openai` : `${API_BASE}/v1/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const body = {
    model: useAnonymous ? 'openai' : model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new PollinationsError('timeout', 'Pollinations took too long to answer. Try again.');
    }
    throw new PollinationsError('network', 'Could not reach Pollinations. Check your connection.');
  }

  const data = await readJson(response);
  if (!response.ok) {
    const friendly = friendlyStatus(response.status, data);
    friendly.retryAfter = response.headers.get('retry-after');
    throw friendly;
  }

  const content = data?.choices?.[0]?.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join(' ');
  }

  if (!text.trim()) {
    throw new PollinationsError('empty', 'The model returned an empty answer. Try again.');
  }

  return { text: text.trim(), usage: data?.usage || null, model: data?.model || body.model };
}

export async function deviceStart(clientId) {
  const body = {};
  if (clientId) body.client_id = clientId;

  let response;
  try {
    response = await fetch(`${ENTER_BASE}/api/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new PollinationsError('network', 'Could not reach Pollinations to start sign-in.');
  }

  const data = await readJson(response);
  if (!response.ok || !data?.device_code) {
    throw friendlyStatus(response.status, data);
  }
  return data;
}

export async function devicePoll(deviceCode) {
  let response;
  try {
    response = await fetch(`${ENTER_BASE}/api/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new PollinationsError('network', 'Could not reach Pollinations while waiting for approval.');
  }

  const data = await readJson(response);

  if (response.ok && data?.access_token) {
    return {
      status: 'connected',
      accessToken: data.access_token,
      tokenType: data.token_type || 'bearer',
      expiresIn: Number(data.expires_in) || 7 * 24 * 60 * 60,
      scope: data.scope || '',
    };
  }

  const code = data?.error;
  if (code === 'authorization_pending' || code === 'slow_down') {
    return { status: 'pending', slowDown: code === 'slow_down' };
  }
  if (code === 'expired_token') {
    throw new PollinationsError('expired', 'This sign-in code expired. Start again.');
  }
  if (code === 'access_denied') {
    throw new PollinationsError('denied', 'Sign-in was declined.');
  }

  throw friendlyStatus(response.status, data);
}

export async function getUserinfo(token) {
  try {
    const response = await fetch(`${ENTER_BASE}/api/device/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const data = await readJson(response);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export async function listModels() {
  let response;
  try {
    response = await fetch(`${API_BASE}/models`, {
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new PollinationsError('network', 'Could not load the model list.');
  }

  const data = await readJson(response);
  if (!response.ok || !Array.isArray(data)) {
    throw friendlyStatus(response.status, data);
  }

  const models = data
    .filter((model) => model && model.category === 'text')
    .map((model) => {
      const prompt = Number(model.pricing?.promptTextTokens) || 0;
      const completion = Number(model.pricing?.completionTextTokens) || 0;
      return {
        name: model.name,
        title: model.title || model.name,
        publisher: model.publisher || '',
        // Pollen per 1k input + 1k output tokens: a comparable, readable number.
        price: Math.round((prompt + completion) * 1000 * 1000) / 1000,
        context: model.context_length || 0,
      };
    })
    .sort((a, b) => a.price - b.price);

  return models.slice(0, 120);
}
