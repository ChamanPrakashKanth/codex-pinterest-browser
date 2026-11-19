import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ADDRESS, PORT, STATE_DIR } from './config.js';
import { Ledger } from './store.js';
import { inspectImage, MAX_BYTES, metadata, mode, objectWith, PinError } from './validation.js';

const secret = () => randomBytes(32).toString('hex');
const headerSafe = (provided, expected) => typeof provided === 'string' &&
  provided.length === expected.length && timingSafeEqual(Buffer.from(provided, 'latin1'), Buffer.from(expected));
const uuid = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) {
    throw new PinError('INVALID_ID', 'Expected a valid operation identifier.');
  }
  return value;
};

async function json(req, max) {
  const length = Number(req.headers['content-length']);
  if (req.headers['content-type'] !== 'application/json' || !Number.isSafeInteger(length) || length < 2 || length > max) {
    throw new PinError('INVALID_BODY', 'Send a bounded JSON body with Content-Length.', 413);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PinError('INVALID_JSON', 'Invalid JSON body.');
  }
}

async function dispatch(ledger, catalog, role, action, body) {
  if (['boards', 'claimboards', 'reportboards'].includes(action)) {
    return boardCatalog(catalog, action, body);
  }
  if (role === 'cli') {
    if (action === 'submit') {
      const { filename, base64, fields, publishingMode } = objectWith(body, ['filename', 'base64', 'fields', 'publishingMode']);
      const validated = metadata(fields);
      const selectedMode = mode(publishingMode);
      if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_BYTES / 3) * 4) {
        throw new PinError('INVALID_IMAGE_DATA', 'Expected a bounded base64 image.');
      }
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64) throw new PinError('INVALID_IMAGE_DATA', 'Invalid base64 encoding.');
      return ledger.submit(await inspectImage(filename, bytes), validated, bytes, selectedMode);
    }
    if (action === 'reconcile') {
      objectWith(body, ['id', 'pinUrl']);
      return ledger.reconcile(uuid(body.id), body.pinUrl);
    }
    objectWith(body, ['id']);
    if (action === 'status') return ledger.status(body.id === undefined ? undefined : uuid(body.id));
    if (action === 'retry') return ledger.retry(uuid(body.id));
    return ledger.discard(uuid(body.id));
  }

  if (action === 'claim' || action === 'list') {
    objectWith(body, ['owner']);
    const owner = uuid(body.owner);
    if (action === 'claim') return ledger.claim(owner);
    return ledger.browserList(owner);
  }
  const extra = {
    prepared: ['receipt', 'tabId'], failed: ['receipt', 'code'],
    target: ['receipt'], image: ['receipt'], approve: ['receipt'],
    outcome: ['receipt', 'state', 'code', 'pinUrl'],
  };
  objectWith(body, ['id', 'owner', ...(extra[action] ?? [])]);
  const id = uuid(body.id);
  const owner = uuid(body.owner);
  const receipt = uuid(body.receipt);
  if (action === 'target') return ledger.target(id, owner, receipt);
  if (action === 'image') return ledger.image(id, owner, receipt);
  if (action === 'prepared') {
    if (!Number.isSafeInteger(body.tabId) || body.tabId <= 0) throw new PinError('INVALID_TAB', 'Invalid browser tab.');
    return ledger.prepared(id, owner, receipt, body.tabId);
  }
  if (action === 'failed') return ledger.failed(id, owner, receipt, body.code);
  if (action === 'approve') return ledger.approve(id, owner, receipt);
  return ledger.outcome(id, owner, receipt, body.state, body.code, body.pinUrl);
}

const boardErrors = new Set(['CHALLENGE', 'WRONG_PAGE', 'FORM_LAYOUT', 'BOARD_NOT_FOUND',
  'NAVIGATION_FAILED', 'BROWSER_INTERRUPTED']);

function boardCatalog(catalog, action, body) {
  if (catalog.state === 'reading' && Date.now() - catalog.started > 60_000) {
    Object.assign(catalog, { state: 'failed', error: 'BROWSER_INTERRUPTED', owner: null });
  }
  if (action === 'boards') {
    objectWith(body, ['refresh']);
    if (body.refresh !== undefined && typeof body.refresh !== 'boolean') {
      throw new PinError('INVALID_REQUEST', 'Expected a boolean refresh flag.');
    }
    if (body.refresh && !['queued', 'reading'].includes(catalog.state)) {
      Object.assign(catalog, { state: 'queued', boards: [], error: null });
    }
    return { state: catalog.state, boards: catalog.boards, error: catalog.error };
  }
  if (action === 'claimboards') {
    objectWith(body, ['owner']);
    const owner = uuid(body.owner);
    if (catalog.state !== 'queued') return false;
    Object.assign(catalog, { state: 'reading', owner, started: Date.now() });
    return true;
  }
  objectWith(body, ['owner', 'boards', 'code']);
  if (uuid(body.owner) !== catalog.owner || catalog.state !== 'reading') {
    throw new PinError('STATE_CONFLICT', 'The board request is no longer active.', 409);
  }
  if (body.code === null && Array.isArray(body.boards) && body.boards.length <= 100 &&
      body.boards.every(name => typeof name === 'string' && name.trim() === name &&
        name.length >= 1 && name.length <= 100 && !/[\x00-\x1f\x7f]/.test(name))) {
    Object.assign(catalog, { state: 'ready', boards: [...new Set(body.boards)], error: null, owner: null });
  } else if (boardErrors.has(body.code) && Array.isArray(body.boards) && body.boards.length === 0) {
    Object.assign(catalog, { state: 'failed', boards: [], error: body.code, owner: null });
  } else {
    throw new PinError('INVALID_REQUEST', 'Invalid board scan result.');
  }
  return true;
}

const actions = {
  cli: new Set(['submit', 'status', 'retry', 'discard', 'reconcile', 'boards']),
  browser: new Set(['list', 'claim', 'target', 'image', 'prepared', 'failed', 'approve', 'outcome',
    'claimboards', 'reportboards']),
};

export async function startBridge({ directory, extensionId, port = PORT }) {
  if (!/^[a-p]{32}$/.test(extensionId ?? '')) throw new Error('Use --extension-id with the ID shown in the browser extension manager.');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const state = await realpath(directory);
  const descriptor = join(state, 'connection.local.json');
  const cliToken = secret();
  const browserToken = secret();
  const browserOrigin = 'chrome-extension://' + extensionId;
  const catalog = { state: 'idle', boards: [], error: null };
  let ledger;
  let activeUploads = 0;
  let address;
  const server = createServer({ requestTimeout: 35_000, headersTimeout: 10_000 }, async (req, res) => {
    const respond = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Connection': 'close' });
      res.end(JSON.stringify(value));
    };
    try {
      if (!ledger || req.headers.host !== address || req.socket.remoteAddress !== ADDRESS) {
        throw new PinError('INVALID_HOST', 'Requests must use the configured loopback address.', 403);
      }
      const [, role, action] = /^\/(cli|browser)\/([a-z]+)$/.exec(req.url) ?? [];
      if (req.method !== 'POST' || !actions[role]?.has(action)) {
        throw new PinError('INVALID_ROUTE', 'Unknown bridge route.', 404);
      }
      const origin = role === 'browser' ? browserOrigin : undefined;
      const token = role === 'browser' ? browserToken : cliToken;
      if (req.headers.origin !== origin || !headerSafe(req.headers.authorization, 'Bearer ' + token)) {
        throw new PinError('UNAUTHORIZED', 'Bridge authentication failed.', 401);
      }
      const upload = role === 'cli' && action === 'submit';
      if (upload && activeUploads >= 2) throw new PinError('BUSY', 'Two images are already being validated.', 429);
      if (upload) activeUploads++;
      try {
        const max = upload ? Math.ceil(MAX_BYTES / 3) * 4 + 16_384 : action === 'reportboards' ? 48_000 : 16_384;
        const body = await json(req, max);
        ledger.expire();
        respond(200, { ok: true, data: await dispatch(ledger, catalog, role, action, body) });
      } finally {
        if (upload) activeUploads--;
      }
    } catch (error) {
      const known = error instanceof PinError;
      respond(known ? error.status : 500, { ok: false, error: {
        code: known ? error.code : 'BRIDGE_ERROR',
        message: known ? error.message : 'Bridge operation failed.',
      } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, ADDRESS, resolve);
  });
  address = ADDRESS + ':' + server.address().port;
  const endpoint = 'http://' + address;
  const temp = descriptor + '.' + secret().slice(0, 12);
  try {
    ledger = new Ledger(join(state, 'pins.sqlite'));
    ledger.recover();
    await writeFile(temp, JSON.stringify({ endpoint, token: cliToken }), { mode: 0o600, flag: 'wx' });
    await rename(temp, descriptor);
  } catch (error) {
    server.close();
    ledger?.db.close();
    await rm(temp, { force: true });
    throw error;
  }
  return { endpoint, cliToken, browserToken, async close() {
    // While the port is held, no replacement bridge can rewrite this descriptor.
    try {
      await rm(descriptor, { force: true });
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      ledger.db.close();
    }
  } };
}

async function main() {
  const { values } = parseArgs({ options: { 'extension-id': { type: 'string' } } });
  const bridge = await startBridge({ directory: STATE_DIR, extensionId: values['extension-id'] });
  console.log('Bridge listening at ' + bridge.endpoint);
  console.log('Paste this pairing code into the extension dashboard. Keep this terminal private.');
  console.log(bridge.browserToken);
  const stop = () => { bridge.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.code === 'EADDRINUSE' ? 'The bridge port is already in use.' :
      error.code ? 'Could not start the local bridge (' + error.code + ').' : error.message);
    process.exitCode = 1;
  });
}
