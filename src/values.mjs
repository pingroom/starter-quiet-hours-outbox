import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const jobId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
export const notificationId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export const exactKeys = (value, required, optional = []) => object(value) && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => [...required, ...optional].includes(key));

const jsonString = String.raw`"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"`;
const stringMember = String.raw`${jsonString}[ \t\r\n]*:[ \t\r\n]*${jsonString}`;
const stringObject = new RegExp(String.raw`^[ \t\r\n]*\{[ \t\r\n]*(?:${stringMember}(?:[ \t\r\n]*,[ \t\r\n]*${stringMember})*)?[ \t\r\n]*\}[ \t\r\n]*$`);

// Input jobs and configuration are flat string objects. Reject duplicate keys,
// including escaped spellings, before a producer's accidental edit can be hidden.
export function parseStrings(buffer) {
  let source;
  let value;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    value = JSON.parse(source);
  } catch { throw new Error('Expected valid UTF-8 JSON.'); }
  // Check the source: JSON.parse has already discarded overwritten values.
  if (!stringObject.test(source)) throw new Error('Expected a flat JSON object containing only strings.');
  const tokens = [...source.matchAll(new RegExp(jsonString, 'g'))].map(([token]) => JSON.parse(token));
  const keys = tokens.filter((_, index) => index % 2 === 0);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate JSON keys are not allowed.');
  return value;
}

export function validateJob(value) {
  if (!exactKeys(value, ['id', 'title', 'message', 'expiresAt'], ['url']) || !jobId(value.id)
    || !timestamp(value.expiresAt)) throw new Error('Job needs id, title, message, expiresAt, and optional url only. Use a canonical UTC expiry.');
  for (const [key, limit] of [['title', 40], ['message', 120]]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > limit || /[\x00-\x1f\x7f]/.test(value[key])) {
      throw new Error(`Job ${key} must be nonblank, without control characters, and at most ${limit} UTF-16 code units.`);
    }
  }
  if (value.url !== undefined) {
    let url;
    try { url = new URL(value.url); } catch { throw new Error('Job url is invalid.'); }
    if (typeof value.url !== 'string' || value.url.length > 2048 || /\s/.test(value.url) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Job url must be an HTTP(S) link without credentials or whitespace, at most 2048 characters.');
    }
  }
  return { id: value.id, title: value.title, message: value.message, expiresAt: value.expiresAt, ...(value.url !== undefined ? { url: value.url } : {}) };
}

export const jobHash = (job) => hash(JSON.stringify(validateJob(job)));
