import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const MAX_BYTES = 20_000_000;
const mimeByExtension = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export class PinError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function objectWith(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) {
    throw new PinError('INVALID_REQUEST', 'Unexpected request structure or fields.');
  }
  return value;
}

export function metadata(value) {
  const fields = { title: 100, description: 500, altText: 500, board: 100, destinationUrl: 2048 };
  objectWith(value, Object.keys(fields));
  const result = {};
  for (const [field, limit] of Object.entries(fields)) {
    const raw = field === 'destinationUrl' ? value[field] ?? '' : value[field];
    if (typeof raw !== 'string' || raw.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) {
      throw new PinError('INVALID_METADATA', field + ' must be text up to ' + limit + ' characters.');
    }
    result[field] = raw.replace(/\r\n?/g, '\n').trim();
    if (field !== 'destinationUrl' && !result[field]) {
      throw new PinError('INVALID_METADATA', field + ' is required.');
    }
    if (field !== 'description' && /[\n\t]/.test(result[field])) {
      throw new PinError('INVALID_METADATA', field + ' must be a single line.');
    }
  }
  if (result.destinationUrl) {
    let url;
    try { url = new URL(result.destinationUrl); } catch {}
    if (!url || !/^https?:\/\//i.test(result.destinationUrl) || /[\s\\]/.test(result.destinationUrl) ||
        url.username || url.password) {
      throw new PinError('INVALID_URL', 'Use an absolute HTTP or HTTPS destination URL without credentials.');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.href.length > fields.destinationUrl) {
      throw new PinError('INVALID_URL', 'Destination URL is unsupported or too long.');
    }
    result.destinationUrl = url.href;
  }
  return result;
}

export function mode(value) {
  if (!['dry-run', 'prepare'].includes(value)) {
    throw new PinError('INVALID_MODE', 'Mode must be dry-run or prepare.');
  }
  return value;
}

export function supportedName(filename) {
  return typeof filename === 'string' && Boolean(mimeByExtension[path.extname(filename).toLowerCase()]);
}

export async function inspectImage(filename, bytes) {
  if (!supportedName(filename) || filename.length > 240 || /[\\/:\x00-\x1f\x7f]/.test(filename)) {
    throw new PinError('INVALID_IMAGE_NAME', 'Use a JPEG, PNG or WebP filename without path separators.');
  }
  if (!bytes.length || bytes.length > MAX_BYTES) {
    throw new PinError('IMAGE_SIZE', 'Image must contain between 1 and 20,000,000 bytes.');
  }
  let info;
  try {
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000, unlimited: false });
    info = await decoder.metadata();
    if ('image/' + info.format !== mimeByExtension[path.extname(filename).toLowerCase()] ||
        (info.pages ?? 1) !== 1) throw new Error();
    await decoder.stats();
  } catch {
    throw new PinError('INVALID_IMAGE', 'Image must decode as a static JPEG, PNG or WebP matching its extension within 40 megapixels.');
  }
  return { filename, mime: 'image/' + info.format, width: info.width, height: info.height,
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function readImage(directory, imagePath) {
  if (typeof imagePath !== 'string' || !imagePath || imagePath.includes('\0')) {
    throw new PinError('INVALID_PATH', 'An image path is required.');
  }
  try {
    const root = await realpath(directory);
    const candidate = path.resolve(root, imagePath);
    if (!inside(root, candidate) || !supportedName(path.basename(candidate))) throw new Error();
    const file = await realpath(candidate);
    if (!inside(root, file)) throw new Error();
    const expected = await lstat(file);
    if (!expected.isFile() || expected.nlink !== 1 || expected.size > MAX_BYTES) throw new Error();
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.dev !== expected.dev ||
          current.ino !== expected.ino || await realpath(file) !== file) throw new Error();
      const bytes = Buffer.alloc(current.size <= MAX_BYTES ? current.size + 1 : 0);
      if (!bytes.length) throw new Error();
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      const atPath = await stat(file);
      if (length !== current.size || after.mtimeMs !== current.mtimeMs ||
          atPath.dev !== current.dev || atPath.ino !== current.ino) throw new Error();
      return { filename: path.basename(candidate), bytes: bytes.subarray(0, length) };
    } finally {
      await handle.close();
    }
  } catch {
    throw new PinError('IMAGE_ACCESS', 'Use a readable image file within the specified root, up to 20 MB.');
  }
}
