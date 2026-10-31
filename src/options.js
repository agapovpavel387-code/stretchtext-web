const $ = (id) => document.getElementById(id);

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

async function readSettings() {
  const stored = await chrome.storage.local.get('settings');
  return stored.settings || {};
}

function renderAuth(auth) {
  const pill = $('auth-pill');
  const line = $('auth-line');
  const connect = $('connect');
  const disconnect = $('disconnect');

  if (auth?.connected) {
    pill.textContent = 'Connected';
    pill.className = 'pill is-ok';
    const name = auth.username ? `@${auth.username}` : 'your account';
    line.textContent = `Signed in as ${name}. Your Pollen pays for each stretch.`;
    line.className = 'ok-text';
    connect.hidden = true;
    disconnect.hidden = false;
  } else {
    pill.textContent = 'No key';
    pill.className = 'pill is-warn';
    line.textContent = 'Not connected. Stretches need your Pollen key.';
    line.className = 'warn-text';
    connect.hidden = false;
    disconnect.hidden = true;
  }
}

async function renderSites() {
  const reply = await send({ type: 'stretch:sites' });
  const sites = reply?.sites || [];
  const list = $('sites');
  list.textContent = '';

  $('sites-count').textContent = String(sites.length);
  $('sites-empty').hidden = sites.length > 0;

  for (const host of sites) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = host;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link';
    remove.textContent = 'Turn off';
    remove.addEventListener('click', async () => {
      await send({ type: 'stretch:set-site', host, enabled: false });
      await renderSites();
    });

    item.append(name, remove);
    list.append(item);
  }
}

async function renderCache() {
  const reply = await send({ type: 'stretch:cache-info' });
  $('cache-count').textContent = `${reply?.entries || 0} cached`;
}

async function loadModels(selected) {
  const reply = await send({ type: 'stretch:models' });
  const models = reply?.models || [];
  const select = $('model');
  select.textContent = '';

  if (!models.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Model list unavailable';
    select.append(option);
    return;
  }

  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.name;
    option.textContent = `${model.title} · ${model.publisher || 'model'} · ${model.price} / 1k tok`;
    select.append(option);
  }
  if (selected) select.value = selected;
}

async function load() {
  const [settings, authReply] = await Promise.all([readSettings(), send({ type: 'stretch:auth-status' })]);

  $('detail').value = settings.detail || 'normal';
  $('limit').value = String(settings.maxExpansionsPerPage || 40);
  $('app-key').value = settings.appKey || '';
  $('anonymous').checked = Boolean(settings.allowAnonymous);

  renderAuth(authReply?.auth);
  await Promise.all([loadModels(settings.model), renderSites(), renderCache()]);

  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  if (location.hash === '#welcome') $('welcome').hidden = false;

  const commands = await chrome.commands.getAll().catch(() => []);
  const toggle = commands.find((command) => command.name === 'toggle-stretch');
  if (toggle?.shortcut) $('shortcut').textContent = toggle.shortcut;
}

$('detail').addEventListener('change', async (event) => {
  await send({ type: 'stretch:update-settings', patch: { detail: event.target.value } });
});

$('model').addEventListener('change', async (event) => {
  if (!event.target.value) return;
  await send({ type: 'stretch:update-settings', patch: { model: event.target.value } });
});

$('limit').addEventListener('change', async (event) => {
  await send({ type: 'stretch:update-settings', patch: { maxExpansionsPerPage: event.target.value } });
});

$('app-key').addEventListener('change', async (event) => {
  const value = event.target.value.trim();
  if (value && !/^pk_/.test(value)) {
    event.target.setCustomValidity?.('An app key starts with pk_');
    event.target.reportValidity?.();
    return;
  }
  event.target.setCustomValidity?.('');
  await send({ type: 'stretch:update-settings', patch: { appKey: value } });
  $('save-key').textContent = 'Saved';
  setTimeout(() => ($('save-key').textContent = 'Save'), 1400);
});

$('save-key').addEventListener('click', () => $('app-key').dispatchEvent(new Event('change')));

$('anonymous').addEventListener('change', async (event) => {
  await send({ type: 'stretch:update-settings', patch: { allowAnonymous: event.target.checked } });
});

$('connect').addEventListener('click', () => void send({ type: 'stretch:open-auth' }));
$('disconnect').addEventListener('click', async () => {
  await send({ type: 'stretch:disconnect' });
  await load();
});

$('clear-cache').addEventListener('click', async () => {
  await send({ type: 'stretch:clear-cache' });
  await renderCache();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || changes.auth)) void load();
});

void load();
