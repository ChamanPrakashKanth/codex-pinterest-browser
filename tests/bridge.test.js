import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import sharp from 'sharp';
import { startBridge } from '../bridge/server.js';
import { compose } from '../bridge/compose.js';
import { inspectImage, metadata, mode, readImage } from '../bridge/validation.js';

const extensionId = 'a'.repeat(32);
const origin = 'chrome-extension://' + extensionId;
const owner = randomUUID();
const fields = {
  title: 'Green bicycle parked beside a brick wall',
  description: 'A green city bicycle against a red brick wall.',
  altText: 'Green bicycle leaning against a red brick wall.',
  destinationUrl: 'https://example.org/bicycles',
  board: 'City cycling',
};
const image = (format = 'png', background = '#118822') => sharp({
  create: { width: 6, height: 9, channels: 3, background },
})[format]().toBuffer();

test('validates image bytes, hashes, formats, truncation, and scoped filesystem reads', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await image(format);
    const info = await inspectImage('photo.' + format, bytes);
    assert.equal(info.mime, 'image/' + format);
    assert.equal(info.width, 6);
    assert.equal(info.height, 9);
    assert.match(info.sha256, /^[a-f0-9]{64}$/);
  }
  const bytes = await image();
  await assert.rejects(inspectImage('photo.webp', bytes), { code: 'INVALID_IMAGE' });
  await assert.rejects(inspectImage('photo.png', bytes.subarray(0, 30)), { code: 'INVALID_IMAGE' });
  await assert.rejects(inspectImage('../photo.png', bytes), { code: 'INVALID_IMAGE_NAME' });
  const root = await mkdtemp(join(tmpdir(), 'pin-root-'));
  try {
    const file = join(root, 'ok.png');
    await writeFile(file, bytes);
    assert.deepEqual((await readImage(root, 'ok.png')).bytes, bytes);
    await assert.rejects(readImage(root, '../ok.png'), { code: 'IMAGE_ACCESS' });
    await link(file, join(root, 'alias.png'));
    await assert.rejects(readImage(root, 'alias.png'), { code: 'IMAGE_ACCESS' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validates and normalizes manual or agent-supplied metadata', () => {
  assert.deepEqual(metadata({ ...fields, title: '  ' + fields.title, description: 'Line one\r\nLine two' }),
    { ...fields, description: 'Line one\nLine two' });
  assert.equal(metadata({ ...fields, destinationUrl: undefined }).destinationUrl, '');
  for (const destinationUrl of ['javascript:alert(1)', '//example.org/', 'https://a:b@example.org/', 'https://invalid host']) {
    assert.throws(() => metadata({ ...fields, destinationUrl }), { code: 'INVALID_URL' });
  }
  assert.throws(() => metadata({ ...fields, altText: '' }), { code: 'INVALID_METADATA' });
  assert.throws(() => metadata({ ...fields, title: 'x'.repeat(101) }), { code: 'INVALID_METADATA' });
  assert.throws(() => metadata({ ...fields, tags: [] }), { code: 'INVALID_REQUEST' });
  assert.throws(() => mode('publish'), { code: 'INVALID_MODE' });
});

test('composes metadata using only supplied visible observations', () => {
  assert.deepEqual(compose({ imagePath: 'bike.png', subject: 'green bicycle',
    setting: 'beside a brick wall', detail: 'a rear rack and upright handlebars', board: 'City cycling' }), {
    imagePath: 'bike.png', title: 'Green bicycle',
    description: 'Green bicycle beside a brick wall. Visible details include a rear rack and upright handlebars.',
    altText: 'Green bicycle beside a brick wall, with a rear rack and upright handlebars.',
    destinationUrl: '', board: 'City cycling', publishingMode: 'dry-run',
  });
  assert.throws(() => compose({ imagePath: 'bike.png', subject: '', board: 'City cycling' }),
    { code: 'INVALID_OBSERVATION' });
});

function client(bridge, role, action, body, override = {}) {
  return fetch(bridge.endpoint + '/' + role + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (role === 'cli' ? bridge.cliToken : bridge.browserToken),
      ...(role === 'browser' ? { Origin: origin } : {}), ...override },
    body: JSON.stringify(body),
  }).then(response => response.json());
}

const payload = async (background, publishingMode = 'prepare') =>
  ({ filename: 'image.png', fields, publishingMode, base64: (await image('png', background)).toString('base64') });

test('authenticates both roles and enforces approval, deduplication, and restart recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pin-bridge-'));
  let bridge = await startBridge({ directory, extensionId, port: 0 });
  const cli = (action, body, headers) => client(bridge, 'cli', action, body, headers);
  const browser = (action, body, headers) => client(bridge, 'browser', action, { owner, ...body }, headers);
  try {
    assert.equal((await cli('status', {}, { Origin: 'https://www.pinterest.com' })).error.code, 'UNAUTHORIZED');
    const badHost = await new Promise((resolve, reject) => {
      const req = httpRequest(bridge.endpoint + '/cli/status', {
        method: 'POST', headers: { Host: 'example.org', 'Content-Length': 2 },
      }, response => {
        let raw = '';
        response.setEncoding('utf8').on('data', chunk => { raw += chunk; });
        response.on('end', () => resolve(JSON.parse(raw)));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(badHost.error.code, 'INVALID_HOST');
    assert.equal((await browser('list', {}, { Origin: 'chrome-extension://' + 'b'.repeat(32) })).error.code, 'UNAUTHORIZED');
    assert.equal((await browser('list', {}, { Authorization: 'Bearer ' + bridge.cliToken })).error.code, 'UNAUTHORIZED');
    assert.equal((await browser('list', {}, { Origin: '' })).error.code, 'UNAUTHORIZED');
    assert.equal((await browser('claim', { path: 'C:/secrets' })).error.code, 'INVALID_REQUEST');

    const dry = await cli('submit', await payload('#118822', 'dry-run'));
    assert.equal(dry.data.state, 'dry-run');
    assert.deepEqual((await cli('status', {})).data, []);
    const submitted = await payload('#118822');
    const [a, b] = await Promise.all([cli('submit', submitted), cli('submit', { ...submitted, filename: 'renamed.png' })]);
    const id = a.data.id;
    assert.equal(b.data.id, id);
    assert.equal([a.data, b.data].filter(pin => pin.duplicate).length, 1);
    const claim = (await browser('claim', {})).data;
    const ticket = { id, receipt: claim.receipt };
    assert.equal(claim.id, id);
    assert.equal((await browser('claim', {})).data, null);
    assert.equal((await browser('image', ticket)).data.base64, submitted.base64);
    assert.equal((await browser('image', { ...ticket, owner: randomUUID() })).error.code, 'STATE_CONFLICT');
    assert.equal((await browser('approve', ticket)).error.code, 'STATE_CONFLICT');
    assert.equal((await browser('prepared', { ...ticket, tabId: 42 })).data.state, 'ready');
    assert.equal((await browser('list', {})).data[0].reviewKey, claim.receipt);
    assert.equal((await cli('status', { id })).data.reviewKey, undefined);
    assert.equal((await browser('target', { ...ticket, receipt: randomUUID() })).error.code, 'STATE_CONFLICT');
    assert.equal((await cli('approve', ticket)).error.code, 'INVALID_ROUTE');
    assert.equal((await browser('approve', { ...ticket, receipt: randomUUID() })).error.code, 'STATE_CONFLICT');
    const result = { ...ticket, state: 'published', code: null, pinUrl: 'https://www.pinterest.com/pin/1234/' };
    assert.equal((await browser('outcome', result)).error.code, 'STATE_CONFLICT');
    assert.equal((await browser('approve', ticket)).data.state, 'publishing');
    assert.equal((await browser('approve', ticket)).error.code, 'STATE_CONFLICT');
    assert.equal((await browser('outcome', { ...result, pinUrl: 'https://example.org/pin/1234/' })).error.code, 'INVALID_PIN_URL');

    const draft = (await cli('submit', await payload('#775599'))).data;
    const pending = (await browser('claim', {})).data;
    await browser('prepared', { id: pending.id, receipt: pending.receipt, tabId: 43 });
    await bridge.close();
    bridge = await startBridge({ directory, extensionId, port: 0 });
    assert.equal((await cli('status', { id })).data.state, 'uncertain');
    assert.equal((await cli('retry', { id })).error.code, 'STATE_CONFLICT');
    assert.equal((await cli('submit', submitted)).data.duplicate, true);
    assert.equal((await cli('reconcile', { id, pinUrl: result.pinUrl })).data.state, 'reconciled');
    assert.equal((await cli('status', { id: draft.id })).data.state, 'interrupted');
    assert.equal((await cli('retry', { id: draft.id })).data.state, 'queued');
    assert.equal((await cli('discard', { id: draft.id })).data.state, 'discarded');
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
