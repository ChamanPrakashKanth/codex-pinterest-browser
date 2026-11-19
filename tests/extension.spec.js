import { expect, test, chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { startBridge } from '../bridge/server.js';

const exec = promisify(execFile);
const extension = fileURLToPath(new URL('../extension', import.meta.url));
const cliScript = fileURLToPath(new URL('../scripts/pin.js', import.meta.url));
const html = await readFile(new URL('./mock-pinterest.html', import.meta.url), 'utf8');
const composer = 'https://www.pinterest.com/pin-creation-tool/';
const metadata = {
  title: 'Bicycle on a city street', description: 'A city bicycle beside a brick wall.',
  altText: 'Bicycle standing next to a brick wall.', destinationUrl: 'https://example.org/photos',
  board: 'City cycling',
};

test('side-loaded extension prepares, verifies, and requires trusted review approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinterest-browser-'));
  let context;
  let bridge;
  try {
    context = await chromium.launchPersistentContext(join(dir, 'profile'), {
      channel: 'chromium', headless: true,
      proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' },
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    await context.route('https://www.pinterest.com/**', route => route.request().url() === composer ?
      route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    bridge = await startBridge({ directory: dir, extensionId });
    const review = await context.newPage();
    await review.goto('chrome-extension://' + extensionId + '/review.html');
    await review.getByLabel('Bridge pairing code').fill(bridge.browserToken);
    await review.getByRole('button', { name: 'Connect' }).click();
    await expect(review.getByText('Connected. Queued pins will appear here.')).toBeVisible();

    async function cli(...args) {
      const { stdout } = await exec(process.execPath, [cliScript, ...args], {
        env: { ...process.env, PINTEREST_BROWSER_STATE_DIR: dir },
      });
      return JSON.parse(stdout);
    }

    const fixtures = [
      ['success.png', '#228833', 'Success'],
      ['reject.png', '#664433', 'Upload failure'],
      ['edit.webp', '#447799', 'Edited draft'],
      ['uncertain.jpeg', '#993366', 'Uncertain result'],
    ];
    for (const [filename, background] of fixtures) {
      await sharp({ create: { width: 5, height: 8, channels: 3, background } }).toFile(join(dir, filename));
    }
    const manifest = join(dir, 'batch.json');
    await writeFile(manifest, JSON.stringify(fixtures.map(([imagePath, , title]) =>
      ({ ...metadata, imagePath, title, publishingMode: 'prepare' }))));
    const dry = await cli('submit', '--root', dir, '--manifest', manifest, '--mode', 'dry-run');
    expect(dry.every(pin => pin.state === 'dry-run')).toBe(true);
    expect(context.pages().filter(page => page.url() === composer)).toHaveLength(0);
    expect((await cli('boards', '--refresh')).state).toBe('queued');
    await expect.poll(async () => (await cli('boards')).boards).toEqual(['City cycling', 'Cycling Routes']);
    const [success, rejected, edited, uncertain] = await cli('submit', '--root', dir, '--manifest', manifest);
    const card = title => review.locator('article').filter({ has: review.getByRole('heading', { name: title, exact: true }) });
    const draft = async name => {
      let match;
      await expect.poll(async () => {
        for (const page of context.pages().filter(page => page.url() === composer)) {
          if (await page.evaluate(() => window.fileName) === name) match = page;
        }
        return Boolean(match);
      }).toBe(true);
      return match;
    };

    async function reviewPin(title) {
      const item = card(title);
      const preview = item.getByText('Preview and approval', { exact: true });
      await expect(preview).toBeVisible({ timeout: 22_000 });
      await preview.click();
      const approve = item.getByRole('button', { name: 'Approve and publish this pin' });
      await expect(approve).toBeEnabled();
      return approve;
    }

    const good = card('Success');
    const approve = await reviewPin('Success');
    const first = await draft('success.png');
    await expect(first.getByLabel('Title')).toHaveValue('Success');
    await expect(first.getByLabel('Description')).toHaveText(metadata.description);
    await expect(first.getByLabel('Link')).toHaveValue(metadata.destinationUrl);
    await expect(first.getByLabel('Alt text')).toHaveValue(metadata.altText);
    await expect(first.locator('[data-test-id="board-dropdown-select-button"]')).toHaveText(metadata.board);
    await expect(good.locator('img')).toBeVisible();
    await approve.evaluate(el => el.click());
    expect(await first.evaluate(() => window.publishClicks)).toBe(0);
    expect((await cli('status', '--id', success.id)).state).toBe('ready');
    await approve.click();
    await expect(good.getByRole('link', { name: 'View published pin' })).toHaveAttribute('href', 'https://www.pinterest.com/pin/987654/');
    expect(await first.evaluate(() => window.publishClicks)).toBe(1);
    expect((await cli('status', '--id', success.id)).state).toBe('published');

    await expect(card('Upload failure').getByText(/UPLOAD_FAILED/)).toBeVisible({ timeout: 18_000 });
    expect((await cli('status', '--id', rejected.id)).state).toBe('failed');
    const changedPin = await reviewPin('Edited draft');
    const changed = await draft('edit.webp');
    await changed.getByLabel('Title').fill('A different title');
    await changedPin.click();
    await expect(card('Edited draft').getByText(/DRAFT_CHANGED/)).toBeVisible();
    expect(await changed.evaluate(() => window.publishClicks)).toBe(0);
    expect((await cli('status', '--id', edited.id)).state).toBe('blocked');

    const final = await reviewPin('Uncertain result');
    await final.click();
    await expect(card('Uncertain result').getByText(/PINTEREST_ERROR/)).toBeVisible();
    expect((await cli('status', '--id', uncertain.id)).state).toBe('uncertain');
    expect(await (await draft('uncertain.jpeg')).evaluate(() => window.publishClicks)).toBe(1);

    const repeated = await cli('submit', '--root', dir, '--manifest', manifest);
    expect(repeated.map(pin => pin.state)).toEqual(['published', 'failed', 'blocked', 'uncertain']);
    expect(repeated.every(pin => pin.duplicate)).toBe(true);
  } finally {
    await context?.close();
    await bridge?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 4 });
  }
});
