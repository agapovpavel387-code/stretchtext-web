const $ = (id) => document.getElementById(id);

let device = null;
let interval = 5;
let expiresAt = 0;
let pollTimer = 0;
let tickTimer = 0;
let stopped = false;

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

function panel(name) {
  for (const id of ['connected', 'start', 'waiting', 'error']) {
    $(id).hidden = id !== name;
  }
}

function showError(message) {
  $('error-text').textContent = message;
  panel('error');
}

function showConnected({ username, expiresAt: expiry }) {
  panel('connected');
  $('connected-who').textContent = username ? `@${username}` : 'this browser';
  const days = Math.max(1, Math.round(((expiry || Date.now() + 7 * 864e5) - Date.now()) / 864e5));
  $('connected-expiry').textContent = `The key expires in about ${days} day${days === 1 ? '' : 's'}. Revoke it any time in the Pollinations dashboard.`;
}

function stopTimers() {
  stopped = true;
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
}

function startCountdown() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(left / 60);
    const seconds = String(left % 60).padStart(2, '0');
    $('countdown').textContent = `${minutes}:${seconds}`;
    if (left <= 0) {
      stopTimers();
      showError('That code expired. Start again to get a fresh one.');
    }
  }, 1000);
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay);
}

async function poll() {
  if (stopped || !device) return;
  const reply = await send({ type: 'stretch:device-poll', deviceCode: device.device_code });

  if (!reply) {
    schedulePoll(3000);
    return;
  }
  if (reply.ok && reply.status === 'connected') {
    stopTimers();
    showConnected({ username: reply.username, expiresAt: reply.expiresAt });
    return;
  }
  if (reply.ok && reply.status === 'pending') {
    if (reply.slowDown) interval += 5;
    schedulePoll(interval * 1000);
    return;
  }

  const code = reply.error?.code;
  if (code === 'rate_limited') {
    schedulePoll(8000);
    return;
  }
  stopTimers();
  showError(reply.error?.message || 'Sign-in failed. Try again.');
}

async function begin() {
  stopped = false;
  clearTimeout(pollTimer);
  clearInterval(tickTimer);

  const reply = await send({ type: 'stretch:device-start' });
  if (!reply?.ok) {
    showError(reply?.error?.message || 'Could not reach Pollinations. Check your connection.');
    return;
  }

  device = reply.device;
  interval = Math.max(3, Number(device.interval) || 5);
  expiresAt = Date.now() + (Number(device.expires_in) || 900) * 1000;

  $('code').textContent = device.user_code || '••••-••••';
  $('wait-state').textContent = reply.appKeyConfigured
    ? 'Waiting for approval…'
    : 'Waiting for approval… (no app key set: the consent screen shows the extension origin)';
  panel('waiting');

  const target = device.verification_uri_complete || device.verification_uri;
  if (target) chrome.tabs.create({ url: target });

  startCountdown();
  schedulePoll(1500);
}

$('begin').addEventListener('click', () => void begin());
$('retry').addEventListener('click', () => {
  panel('start');
});

$('approve').addEventListener('click', () => {
  const target = device?.verification_uri_complete || device?.verification_uri;
  if (target) chrome.tabs.create({ url: target });
});

$('cancel').addEventListener('click', () => {
  stopTimers();
  device = null;
  panel('start');
});

$('close').addEventListener('click', () => window.close());

$('revoke').addEventListener('click', async () => {
  await send({ type: 'stretch:disconnect' });
  panel('start');
});

$('manual-save').addEventListener('click', async () => {
  const value = $('manual-key').value.trim();
  const reply = await send({ type: 'stretch:set-token', token: value });
  if (!reply?.ok) {
    showError(reply?.error?.message || 'That key was rejected.');
    return;
  }
  $('manual-key').value = '';
  showConnected({ username: reply.username, expiresAt: reply.expiresAt });
});

(async function init() {
  document.documentElement.dataset.stretchAuth = 'ready';
  const reply = await send({ type: 'stretch:auth-status' });
  if (reply?.auth?.connected) showConnected({ username: reply.auth.username, expiresAt: reply.auth.expiresAt });
  else panel('start');
})();
