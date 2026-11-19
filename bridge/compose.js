import { metadata, mode, objectWith, PinError } from './validation.js';

function observation(value, field, limit, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value) ||
      (required && !value.trim())) {
    throw new PinError('INVALID_OBSERVATION', field + ' must be plain text up to ' + limit + ' characters.');
  }
  return value.trim().replace(/[.!?]+$/, '');
}

function sentence(text) {
  return text ? text[0].toUpperCase() + text.slice(1) + '.' : '';
}

export function compose(entry) {
  const { imagePath, subject, setting, detail, board, destinationUrl, publishingMode } = objectWith(entry,
    ['imagePath', 'subject', 'setting', 'detail', 'board', 'destinationUrl', 'publishingMode']);
  if (typeof imagePath !== 'string' || !imagePath.trim() || imagePath.includes('\0')) {
    throw new PinError('INVALID_PATH', 'An image path is required.');
  }
  const observedSubject = observation(subject, 'subject', 100, true);
  const observedSetting = observation(setting, 'setting', 120);
  const observedDetail = observation(detail, 'detail', 180);
  const title = (observedSubject[0]?.toUpperCase() ?? '') + observedSubject.slice(1);
  const scene = [observedSubject, observedSetting].filter(Boolean).join(' ');
  const description = sentence(scene) + (observedDetail ? ' Visible details include ' + observedDetail + '.' : '');
  const altText = sentence(scene + (observedDetail ? ', with ' + observedDetail : ''));
  return { imagePath, ...metadata({ title, description, altText, board, destinationUrl }),
    publishingMode: mode(publishingMode ?? 'dry-run') };
}
