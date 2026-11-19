const bridge = 'http://127.0.0.1:43179/browser/';
const builder = 'https://www.pinterest.com/pin-creation-tool/';
const dashboard = chrome.runtime.getURL('review.html');
const builderUrl = /^https:\/\/www\.pinterest\.com\/pin-(?:creation-tool|builder)\/(?:[?#].*)?$/;
const faults = new Set(['CHALLENGE', 'WRONG_PAGE', 'COMPOSER_NOT_CLEAN', 'FORM_LAYOUT',
  'UPLOAD_FAILED', 'UPLOAD_TIMEOUT', 'BOARD_NOT_FOUND', 'AMBIGUOUS_BOARD', 'FIELD_MISMATCH',
  'FORM_ERROR', 'NAVIGATION_FAILED', 'BROWSER_INTERRUPTED']);
let preparing = false;

function fault(code) {
  return Object.assign(new Error(code), { code });
}

async function api(session, action, data = {}) {
  let response;
  try {
    response = await fetch(bridge + action, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
      body: JSON.stringify({ ...data, owner: session.owner }),
    });
  } catch {
    throw fault('BRIDGE_OFFLINE');
  }
  const body = await response.json();
  if (!body.ok) throw fault(body.error.code);
  return body.data;
}

async function connect(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw fault('UNAUTHORIZED');
  const { session } = await chrome.storage.session.get('session');
  const next = { token, owner: session?.owner ?? crypto.randomUUID() };
  const pins = await api(next, 'list');
  await chrome.storage.session.set({ session: next });
  return pins;
}

async function sendToTab(tabId, message) {
  const tab = await chrome.tabs.get(tabId);
  if (!builderUrl.test(tab.url ?? '')) throw fault('WRONG_PAGE');
  const reply = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  if (!reply?.ok) throw fault(reply?.code ?? 'BROWSER_INTERRUPTED');
  return reply;
}

async function probe(tabId) {
  const deadline = Date.now() + 25_000;
  let delay = 100;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => { throw fault('NAVIGATION_FAILED'); });
    if (tab.status === 'complete' && tab.url && tab.url !== 'about:blank' && !builderUrl.test(tab.url) &&
        !builderUrl.test(tab.pendingUrl ?? '')) {
      if (/^https:\/\/www\.pinterest\.com\/(?:login|signup|challenge|security)(?:[/?#]|$)/.test(tab.url ?? '')) {
        throw fault('CHALLENGE');
      }
      throw fault('WRONG_PAGE');
    }
    if (builderUrl.test(tab.url ?? '')) {
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'probe' }, { frameId: 0 }).catch(() => null);
      if (reply?.ok) return;
      if (reply?.code) throw fault(reply.code);
    }
    // Retry message delivery while the browser injects the document-idle content script.
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 800);
  }
  throw fault('NAVIGATION_FAILED');
}

async function openComposer() {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  try {
    await chrome.tabs.update(tab.id, { url: builder });
    return tab.id;
  } catch {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw fault('NAVIGATION_FAILED');
  }
}

async function readBoards(session) {
  let tabId;
  let result;
  try {
    tabId = await openComposer();
    await probe(tabId);
    const { boards } = await sendToTab(tabId, { type: 'boards' });
    result = { boards, code: null };
  } catch (error) {
    const reported = ['CHALLENGE', 'WRONG_PAGE', 'FORM_LAYOUT', 'BOARD_NOT_FOUND', 'NAVIGATION_FAILED'];
    result = { boards: [], code: reported.includes(error.code) ? error.code : 'BROWSER_INTERRUPTED' };
  } finally {
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  }
  await api(session, 'reportboards', result);
}

async function prepareNext(session) {
  if (preparing) return;
  preparing = true;
  try {
    if (await api(session, 'claimboards')) {
      await readBoards(session);
      return;
    }
    const job = await api(session, 'claim');
    if (!job) return;
    const ticket = { id: job.id, receipt: job.receipt };
    try {
      const { base64 } = await api(session, 'image', ticket);
      const tabId = await openComposer();
      await probe(tabId);
      await sendToTab(tabId, { type: 'prepare', receipt: job.receipt, image: job.image, base64, fields: job.metadata });
      await api(session, 'prepared', { ...ticket, tabId });
    } catch (error) {
      await api(session, 'failed', { ...ticket, code: faults.has(error.code) ? error.code : 'BROWSER_INTERRUPTED' });
    }
  } finally {
    preparing = false;
  }
}

async function publish(session, ticket) {
  const job = await api(session, 'target', ticket);
  await sendToTab(job.tabId, { type: 'probe' });
  await api(session, 'approve', ticket);
  let result;
  try {
    ({ result } = await sendToTab(job.tabId, { type: 'publish', receipt: job.receipt }));
  } catch {
    result = { state: 'uncertain', code: 'PUBLISH_UNVERIFIED', pinUrl: null };
  }
  return api(session, 'outcome', { ...ticket, ...result });
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: dashboard });
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== dashboard || !message || typeof message.type !== 'string') return false;
  async function handle() {
    if (message.type === 'connect') return connect(message.token);
    const { session } = await chrome.storage.session.get('session');
    if (!session) throw fault('NOT_PAIRED');
    if (message.type === 'list') return api(session, 'list');
    if (message.type === 'tick') return prepareNext(session);
    const ticket = { id: message.id, receipt: message.receipt };
    if (message.type === 'image') return api(session, 'image', ticket);
    if (message.type === 'open') {
      const job = await api(session, 'target', ticket);
      await sendToTab(job.tabId, { type: 'probe' });
      await chrome.tabs.update(job.tabId, { active: true });
      return;
    }
    if (message.type === 'approve') return publish(session, ticket);
    throw fault('INVALID_REQUEST');
  }
  handle().then(data => respond({ ok: true, data }), error => respond({ ok: false, code: error.code ?? 'BROWSER_INTERRUPTED' }));
  return true;
});
