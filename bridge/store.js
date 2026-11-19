import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { PinError } from './validation.js';

const conflict = () => new PinError('STATE_CONFLICT', 'The pin is no longer in the expected state.', 409);
const storageCodes = new Set([
  'CHALLENGE', 'WRONG_PAGE', 'COMPOSER_NOT_CLEAN', 'FORM_LAYOUT', 'UPLOAD_FAILED', 'UPLOAD_TIMEOUT',
  'BOARD_NOT_FOUND', 'AMBIGUOUS_BOARD', 'FIELD_MISMATCH', 'FORM_ERROR', 'DRAFT_CHANGED',
  'NAVIGATION_FAILED', 'BROWSER_INTERRUPTED', 'PUBLISH_UNVERIFIED', 'PINTEREST_ERROR',
]);

export function pinUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/www\.pinterest\.com\/pin\/\d+\/$/.test(value)) {
    throw new PinError('INVALID_PIN_URL', 'A canonical Pinterest pin URL is required.');
  }
  return value;
}

function brief(row) {
  if (!row) return null;
  return { id: row.id, state: row.state, image: JSON.parse(row.image),
    metadata: JSON.parse(row.metadata), error: row.error, pinUrl: row.pin_url,
    updatedAt: new Date(row.updated).toISOString() };
}

export class Ledger {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS pins (
        id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, state TEXT NOT NULL,
        image TEXT NOT NULL, metadata TEXT NOT NULL, bytes BLOB, error TEXT, pin_url TEXT,
        owner TEXT, receipt TEXT, tab_id INTEGER, updated INTEGER NOT NULL
      );
    `);
  }

  recover(now = Date.now()) {
    this.db.prepare(`UPDATE pins SET state = 'interrupted', error = 'BROWSER_INTERRUPTED', updated = ?
      WHERE state IN ('preparing', 'ready')`).run(now);
    this.db.prepare(`UPDATE pins SET state = 'uncertain', error = 'PUBLISH_UNVERIFIED', bytes = NULL, updated = ?
      WHERE state = 'publishing'`).run(now);
  }

  expire(now = Date.now()) {
    this.db.prepare(`UPDATE pins SET state = 'interrupted', error = 'BROWSER_INTERRUPTED', updated = ?
      WHERE state = 'preparing' AND updated < ?`).run(now, now - 150_000);
    this.db.prepare(`UPDATE pins SET state = 'uncertain', error = 'PUBLISH_UNVERIFIED', bytes = NULL, updated = ?
      WHERE state = 'publishing' AND updated < ?`).run(now, now - 90_000);
  }

  submit(image, metadata, bytes, mode) {
    const duplicate = this.db.prepare('SELECT id, state, image, metadata, error, pin_url, updated FROM pins WHERE fingerprint = ?').get(image.sha256);
    if (duplicate) return { ...brief(duplicate), duplicate: true, submittedFilename: image.filename };
    if (mode === 'dry-run') return { state: 'dry-run', image, metadata };
    const active = this.db.prepare('SELECT count(*) AS total FROM pins WHERE bytes IS NOT NULL').get();
    if (active.total >= 20) throw new PinError('QUEUE_FULL', 'The bridge can retain 20 active images.', 409);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO pins (id, fingerprint, state, image, metadata, bytes, updated)
      VALUES (?, ?, 'queued', ?, ?, ?, ?)`).run(id, image.sha256, JSON.stringify(image), JSON.stringify(metadata), bytes, Date.now());
    return brief(this.row(id));
  }

  row(id) {
    const row = this.db.prepare(`SELECT id, state, image, metadata, error, pin_url, owner, receipt, tab_id, updated
      FROM pins WHERE id = ?`).get(id);
    if (!row) throw new PinError('NOT_FOUND', 'No pin with that ID.', 404);
    return row;
  }

  status(id) {
    if (id) return brief(this.row(id));
    return this.db.prepare(`SELECT id, state, image, metadata, error, pin_url, updated FROM pins
      ORDER BY rowid DESC LIMIT 100`).all().map(brief);
  }

  browserList(owner) {
    return this.db.prepare(`SELECT id, state, image, metadata, error, pin_url, receipt, updated FROM pins
      WHERE owner = ? OR state IN ('queued', 'interrupted') ORDER BY rowid DESC LIMIT 100`)
      .all(owner).map(row => row.state === 'ready' ? { ...brief(row), reviewKey: row.receipt } : brief(row));
  }

  change(sql, ...args) {
    if (this.db.prepare(sql).run(...args).changes !== 1) throw conflict();
  }

  retry(id) {
    this.change(`UPDATE pins SET state = 'queued', error = NULL, owner = NULL, receipt = NULL,
      tab_id = NULL, updated = ? WHERE id = ? AND bytes IS NOT NULL
      AND state IN ('failed', 'interrupted', 'ready', 'blocked')`, Date.now(), id);
    return this.status(id);
  }

  discard(id) {
    this.change(`UPDATE pins SET state = 'discarded', bytes = NULL, fingerprint = NULL, updated = ?
      WHERE id = ? AND state IN ('queued', 'failed', 'interrupted', 'ready', 'blocked')`, Date.now(), id);
    return this.status(id);
  }

  claim(owner) {
    const row = this.db.prepare(`SELECT id FROM pins WHERE state = 'queued'
      AND NOT EXISTS (SELECT 1 FROM pins WHERE state = 'preparing') ORDER BY rowid LIMIT 1`).get();
    if (!row) return null;
    this.change(`UPDATE pins SET state = 'preparing', owner = ?, receipt = ?, updated = ? WHERE id = ?`,
      owner, randomUUID(), Date.now(), row.id);
    const claimed = this.row(row.id);
    return { ...brief(claimed), receipt: claimed.receipt };
  }

  image(id, owner, receipt) {
    const row = this.db.prepare(`SELECT bytes FROM pins WHERE id = ? AND owner = ? AND receipt = ?
      AND state IN ('preparing', 'ready')`).get(id, owner, receipt);
    if (!row?.bytes) throw conflict();
    return { base64: Buffer.from(row.bytes).toString('base64') };
  }

  prepared(id, owner, receipt, tabId) {
    this.change(`UPDATE pins SET state = 'ready', tab_id = ?, updated = ?
      WHERE id = ? AND owner = ? AND receipt = ? AND state = 'preparing'`, tabId, Date.now(), id, owner, receipt);
    return this.status(id);
  }

  failed(id, owner, receipt, code) {
    if (!storageCodes.has(code)) throw new PinError('INVALID_ERROR', 'Unknown browser error.');
    this.change(`UPDATE pins SET state = 'failed', error = ?, updated = ?
      WHERE id = ? AND owner = ? AND receipt = ? AND state = 'preparing'`, code, Date.now(), id, owner, receipt);
    return this.status(id);
  }

  target(id, owner, receipt) {
    const row = this.row(id);
    if (row.state !== 'ready' || row.owner !== owner || row.receipt !== receipt) throw conflict();
    return { ...brief(row), receipt: row.receipt, tabId: row.tab_id };
  }

  approve(id, owner, receipt) {
    this.change(`UPDATE pins SET state = 'publishing', updated = ?
      WHERE id = ? AND owner = ? AND receipt = ? AND state = 'ready'`, Date.now(), id, owner, receipt);
    return this.status(id);
  }

  outcome(id, owner, receipt, state, code, url) {
    if (state === 'published') {
      if (code !== null) throw new PinError('INVALID_OUTCOME', 'Published pins cannot carry an error.');
      url = pinUrl(url);
    } else if (!['uncertain', 'blocked'].includes(state) || !storageCodes.has(code) || url !== null) {
      throw new PinError('INVALID_OUTCOME', 'Invalid publishing outcome.');
    }
    this.change(`UPDATE pins SET state = ?, error = ?, pin_url = ?, bytes = CASE WHEN ? = 'blocked' THEN bytes ELSE NULL END, updated = ?
      WHERE id = ? AND owner = ? AND receipt = ? AND state = 'publishing'`,
    state, code, url, state, Date.now(), id, owner, receipt);
    return this.status(id);
  }

  reconcile(id, url) {
    this.change(`UPDATE pins SET state = 'reconciled', pin_url = ?, error = NULL, updated = ?
      WHERE id = ? AND state = 'uncertain'`, pinUrl(url), Date.now(), id);
    return this.status(id);
  }
}
