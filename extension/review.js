const pairing = document.querySelector('#pair');
const code = document.querySelector('#code');
const status = document.querySelector('#status');
const pinsNode = document.querySelector('#pins');
const titles = {
  queued: 'Queued', preparing: 'Preparing in Pinterest', ready: 'Ready for review',
  failed: 'Preparation failed', publishing: 'Checking publication', published: 'Published',
  uncertain: 'Publication unverified', blocked: 'Publish blocked before click',
  interrupted: 'Preparation interrupted', discarded: 'Discarded', reconciled: 'Manually reconciled',
};
const messages = {
  NOT_PAIRED: 'Enter the pairing code printed in the bridge terminal.',
  UNAUTHORIZED: 'Pairing failed. Check the extension ID and the current bridge pairing code.',
  BRIDGE_OFFLINE: 'The local bridge is offline or unreachable.',
  WRONG_PAGE: 'The prepared tab is no longer on the Pinterest composer.',
  CHALLENGE: 'Pinterest requires login or a manual security check.',
  BROWSER_INTERRUPTED: 'The browser connection was interrupted. Check the pin status before proceeding.',
  STATE_CONFLICT: 'The pin state changed. Check the updated status.',
};
const cards = new Map();
let connected = false;
let busy = false;
let refreshing = false;
let working = false;

async function request(type, data = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...data });
  if (!reply?.ok) throw new Error(reply?.code ?? 'BROWSER_INTERRUPTED');
  return reply.data;
}

function note(error) {
  status.textContent = messages[error.message] ?? 'Operation failed (' + error.message + ').';
  if (['UNAUTHORIZED', 'BRIDGE_OFFLINE', 'NOT_PAIRED'].includes(error.message)) {
    connected = false;
    pairing.hidden = false;
  }
}

function node(tag, text) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

function addDetails(card, entries) {
  const list = node('dl');
  for (const [label, value] of entries) {
    list.append(node('dt', label), node('dd', value));
  }
  card.append(list);
}

function reviewActions(panel, pin) {
  const controls = node('div');
  controls.className = 'actions';
  const open = node('button', 'Open Pinterest draft');
  open.addEventListener('click', event => {
    if (event.isTrusted) request('open', { id: pin.id, receipt: pin.reviewKey }).catch(note);
  });
  const publish = node('button', 'Approve and publish this pin');
  publish.className = 'publish';
  publish.disabled = true;
  publish.addEventListener('click', async event => {
    if (!event.isTrusted || busy || publish.disabled) return;
    busy = true;
    publish.disabled = true;
    status.textContent = 'Checking publication for ' + pin.metadata.title + '…';
    try {
      const result = await request('approve', { id: pin.id, receipt: pin.reviewKey });
      status.textContent = titles[result.state];
    } catch (error) {
      note(error);
    } finally {
      busy = false;
      await refresh();
      if (panel.isConnected && panel.open && !panel.querySelector('img').hidden) publish.disabled = false;
    }
  });
  controls.append(open, publish);
  panel.append(controls);
  return publish;
}

function addPreview(entry, pin) {
  const panel = node('details');
  panel.name = 'pin-preview';
  const img = node('img');
  img.className = 'preview';
  img.alt = pin.metadata.altText;
  img.hidden = true;
  const feedback = node('p');
  feedback.setAttribute('role', 'status');
  panel.append(node('summary', 'Preview and approval'), feedback, img);
  const approve = reviewActions(panel, pin);
  let revision = 0;
  panel.addEventListener('toggle', async () => {
    const pending = ++revision;
    approve.disabled = true;
    img.hidden = true;
    img.removeAttribute('src');
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = null;
    if (!panel.open) return;
    feedback.textContent = 'Loading image preview…';
    const current = () => pending === revision && panel.open && cards.get(pin.id) === entry;
    try {
      const { base64 } = await request('image', { id: pin.id, receipt: pin.reviewKey });
      if (!current()) return;
      const bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(base64) :
        Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      entry.url = URL.createObjectURL(new Blob([bytes], { type: pin.image.mime }));
      img.src = entry.url;
      await img.decode();
      if (!current()) return;
      img.hidden = false;
      feedback.textContent = '';
      approve.disabled = false;
    } catch (error) {
      if (current()) {
        feedback.textContent = 'Could not load this pin’s image preview.';
        note(error);
      }
    }
  });
  entry.card.append(panel);
}

function render(pins) {
  for (const [id, entry] of cards) {
    if (!pins.some(pin => pin.id === id && pin.state === entry.state && pin.reviewKey === entry.reviewKey)) {
      entry.card.remove();
      if (entry.url) URL.revokeObjectURL(entry.url);
      cards.delete(id);
    }
  }
  for (const pin of pins) {
    if (cards.has(pin.id)) continue;
    const card = node('article');
    const entry = { card, state: pin.state, reviewKey: pin.reviewKey };
    cards.set(pin.id, entry);
    card.append(node('h2', pin.metadata.title), node('p', titles[pin.state] + (pin.error ? ' · ' + pin.error : '')));
    const fields = pin.metadata;
    addDetails(card, [['Image', pin.image.filename + ' · ' + pin.image.width + ' × ' + pin.image.height],
      ['Board', fields.board], ['Description', fields.description], ['Alt text', fields.altText],
      ['Destination', fields.destinationUrl || '(none)'], ['Pin ID', pin.id]]);
    if (pin.pinUrl) {
      const link = node('a', 'View published pin');
      link.href = pin.pinUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      card.append(link);
    }
    if (pin.state === 'ready') addPreview(entry, pin);
    pinsNode.append(card);
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    render(await request('list'));
    if (!connected) {
      status.textContent = 'Connected. Queued pins will appear here.';
      connected = true;
      pairing.hidden = true;
    }
    if (!working) {
      working = true;
      request('tick').catch(note).finally(() => { working = false; });
    }
  } catch (error) {
    note(error);
  } finally {
    refreshing = false;
  }
}

pairing.addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.isTrusted) return;
  try {
    render(await request('connect', { token: code.value }));
    code.value = '';
    await refresh();
  } catch (error) { note(error); }
});
refresh();
setInterval(() => { if (connected) refresh(); }, 1800);
