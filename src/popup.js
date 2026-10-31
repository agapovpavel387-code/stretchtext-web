const $ = (id) => document.getElementById(id);

let settings = null;
let auth = { connected: false, username: '' };
let tab = { id: null, url: '', supported: false, host: '' };
let page = { enabled: false, expansions: 0, hasSegments: false };
let modelsLoaded = false;

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

function renderHeader() {
  $('host').textContent = tab.host || 'This page';
  $('host').title = tab.url || '';

  const status = $('status');
  if (auth.connected) {
    status.textContent = auth.username ? `@${auth.username}` : 'Connected';
    status.className = 'pill is-ok';
    status.title = 'Readers pay with their own Pollen';
  } else {
    status.textContent = 'Not connected';
    status.className = 'pill is-warn';
    status.title = 'Connect Pollinations to grow text';
  }
}

function renderToggle() {
  const button = $('toggle');
  const on = Boolean(page.enabled);
  button.setAttribute('aria-pressed', String(on));
  button.textContent = on ? 'On for this site — turn off' : 'Turn on for this site';
  button.disabled = !tab.supported;
}

function renderAuth() {
  const line = $('auth-line');
  const button = $('auth-btn');
  if (auth.connected) {
    line.textContent = auth.username ? `@${auth.username} · your Pollen` : 'Your Pollen';
    line.className = 'ok-text';
    button.textContent = 'Manage Pollen';
  } else {
    line.textContent = 'Not connected';
    line.className = 'warn-text';
    button.textContent = 'Connect Pollinations';
  }
}

function renderPageStats() {
  const count = Number(page.expansions) || 0;
  $('page-stats').textContent =
    count === 0
      ? 'No stretches on this page yet.'
      : `${count} stretch${count === 1 ? '' : 'es'} on this page.`;
  $('shrink').hidden = !page.hasSegments;
}

function renderHint() {
  const hint = $('hint');
  if (!tab.supported) {
    hint.textContent = 'Stretch only runs on regular web pages (http and https).';
    return;
  }
  hint.textContent = page.enabled
    ? 'Click a sentence to grow it. Shift-click a paragraph to shrink it. Esc shrinks the last stretch.'
    : 'Turn Stretch on for this site, then click any sentence to grow it.';
}

async function loadModels() {
  if (modelsLoaded) return;
  const reply = await send({ type: 'stretch:models' });
  const models = reply?.models || [];
  if (!models.length) return;

  const select = $('model');
  select.textContent = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.name;
    option.textContent = model.title;
    option.title = `${model.publisher || 'model'} · ${model.price} Pollen / 1k tokens`;
    select.append(option);
  }
  modelsLoaded = true;
  if (settings?.model) select.value = settings.model;
}

async function refresh() {
  const init = await send({ type: 'stretch:init' });
  if (init?.ok) {
    settings = init.settings;
    auth = init.auth;
  }

  const tabReply = await send({ type: 'stretch:tab-state' });
  if (tabReply?.ok) {
    tab = tabReply.tab || tab;
    try {
      tab.host = new URL(tab.url).hostname;
    } catch {
      tab.host = '';
    }
    page = tabReply.state ? { ...page, ...tabReply.state } : { ...page, enabled: false };
  }

  renderHeader();
  renderToggle();
  renderAuth();
  renderPageStats();
  renderHint();

  if (settings) {
    $('detail').value = settings.detail || 'normal';
  }
  await loadModels();
  if (settings?.model) $('model').value = settings.model;
}

$('toggle').addEventListener('click', async () => {
  const enabled = !page.enabled;
  const reply = await send({ type: 'stretch:tab-apply', enabled });
  if (!reply?.ok) {
    $('hint').textContent = reply?.error?.message || 'Could not reach this page. Reload it and try again.';
    return;
  }
  page = { ...page, ...(reply.state || {}), enabled };
  renderToggle();
  renderPageStats();
  renderHint();
});

$('detail').addEventListener('change', async (event) => {
  const detail = event.target.value;
  settings = { ...settings, detail };
  await send({ type: 'stretch:update-settings', patch: { detail } });
});

$('model').addEventListener('change', async (event) => {
  const model = event.target.value;
  settings = { ...settings, model };
  await send({ type: 'stretch:update-settings', patch: { model } });
});

$('auth-btn').addEventListener('click', () => {
  if (auth.connected) {
    void send({ type: 'stretch:open-url', url: 'https://enter.pollinations.ai/keys' });
    return;
  }
  void send({ type: 'stretch:open-auth' });
});

$('shrink').addEventListener('click', async () => {
  const reply = await send({ type: 'stretch:tab-collapse' });
  page = { ...page, ...(reply?.state || {}), hasSegments: false, expansions: 0 };
  renderPageStats();
});

$('options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

window.addEventListener('focus', () => void refresh());
setInterval(() => void refresh(), 2500);

void refresh();
