import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const ADDRESS = '127.0.0.1';
export const PORT = 43179;
export const ENDPOINT = 'http://' + ADDRESS + ':' + PORT;
export const STATE_DIR = resolve(process.env.PINTEREST_BROWSER_STATE_DIR ||
  join(homedir(), '.codex-pinterest-browser'));
