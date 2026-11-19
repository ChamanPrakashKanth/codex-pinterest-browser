import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ENDPOINT, STATE_DIR } from '../bridge/config.js';
import { compose } from '../bridge/compose.js';
import { metadata, mode, objectWith, PinError, readImage, supportedName } from '../bridge/validation.js';

const usage = `Usage
  npm run pin -- scan --root DIRECTORY
  node scripts/pin.js generate --observations FILE
  npm run pin -- submit --root DIRECTORY --manifest FILE [--mode dry-run|prepare]
  npm run pin -- status [--id PIN_ID]
  npm run pin -- boards [--refresh]
  npm run pin -- retry --id PIN_ID
  npm run pin -- discard --id PIN_ID
  npm run pin -- reconcile --id PIN_ID --url CANONICAL_PIN_URL`;

async function request(action, body) {
  let connection;
  try {
    connection = JSON.parse(await readFile(join(STATE_DIR, 'connection.local.json'), 'utf8'));
  } catch {
    throw new PinError('BRIDGE_OFFLINE', 'Start the local bridge first.');
  }
  if (connection.endpoint !== ENDPOINT || !/^[a-f0-9]{64}$/.test(connection.token ?? '')) {
    throw new PinError('INVALID_CONNECTION', 'Bridge connection file is invalid.');
  }
  let response;
  try {
    response = await fetch(ENDPOINT + '/cli/' + action, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + connection.token },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PinError('BRIDGE_OFFLINE', 'Bridge did not respond. Check status before resubmitting.');
  }
  const result = await response.json();
  if (!result.ok) throw new PinError(result.error.code, result.error.message);
  return result.data;
}

async function scan(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return { root: resolve(root), images: entries.filter(entry => entry.isFile() && supportedName(entry.name))
    .map(entry => entry.name).sort() };
}

async function entriesFrom(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > 256_000) throw new PinError('INVALID_MANIFEST', 'Use a JSON file up to 256 KB.');
  let parsed;
  try { parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new PinError('INVALID_MANIFEST', 'Input is not valid JSON.'); }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length < 1 || entries.length > 20) throw new PinError('INVALID_MANIFEST', 'Include 1 to 20 entries.');
  return entries;
}

async function submit({ root, manifest, mode: override }) {
  const entries = await entriesFrom(manifest);
  if (override !== undefined) mode(override);
  const results = [];
  for (const entry of entries) {
    try {
      const { imagePath, publishingMode, ...fields } = objectWith(entry, [
        'imagePath', 'publishingMode', 'title', 'description', 'altText', 'destinationUrl', 'board',
      ]);
      const selected = mode(override ?? publishingMode ?? 'dry-run');
      const validated = metadata(fields);
      const image = await readImage(root, imagePath);
      results.push({ imagePath, ...await request('submit', { filename: image.filename,
        base64: image.bytes.toString('base64'), fields: validated, publishingMode: selected }) });
    } catch (error) {
      results.push({ imagePath: typeof entry?.imagePath === 'string' ? entry.imagePath : null, state: 'error',
        error: { code: error instanceof PinError ? error.code : 'CLI_ERROR',
          message: error instanceof PinError ? error.message : 'Could not process this entry.' } });
    }
  }
  if (results.some(pin => pin.state === 'error')) process.exitCode = 1;
  return results;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') return console.log(usage);
  const commands = {
    scan: ['root'], generate: ['observations'], submit: ['root', 'manifest', 'mode'], status: ['id'],
    retry: ['id'], discard: ['id'], reconcile: ['id', 'url'], boards: ['refresh'],
  };
  if (!Object.hasOwn(commands, command)) throw new PinError('INVALID_COMMAND', 'Unknown command. See --help.');
  const { values } = parseArgs({ args,
    options: Object.fromEntries(commands[command].map(key => [key, { type: key === 'refresh' ? 'boolean' : 'string' }])) });
  const optional = { submit: ['mode'], status: ['id'], boards: ['refresh'] }[command] ?? [];
  if (commands[command].some(key => !optional.includes(key) && !values[key])) {
    throw new PinError('MISSING_ARGUMENT', 'A required option is missing. See --help.');
  }
  let result;
  if (command === 'scan') result = await scan(values.root);
  else if (command === 'generate') result = (await entriesFrom(values.observations)).map(compose);
  else if (command === 'submit') result = await submit(values);
  else result = await request(command, { id: values.id, pinUrl: values.url, refresh: values.refresh });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: {
    code: error instanceof PinError ? error.code : error.code || 'CLI_ERROR',
    message: error instanceof PinError ? error.message : 'Command failed. Check the arguments and local files.',
  } }));
  process.exitCode = 1;
});
