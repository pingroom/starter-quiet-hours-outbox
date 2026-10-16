import { binding } from './config.mjs';
import { quietNow } from './policy.mjs';
import { readBounded, readState, withLock, writeState } from './storage.mjs';
import { exactKeys, jobHash, jobId, notificationId, parseStrings, timestamp, validateJob } from './values.mjs';
import { sendJob } from './cli.mjs';

export const MAX_PENDING = 1000;
export const MAX_HISTORY = 10000;
const pending = (record) => ['queued', 'sending'].includes(record.status);
const iso = (now) => {
  const value = new Date(now()).toISOString();
  if (!timestamp(value)) throw new Error('Clock must return a valid epoch time.');
  return value;
};

export function validateState(state) {
  const bad = () => { throw new Error('Invalid outbox state; preserve it and restore a trusted backup.'); };
  if (!exactKeys(state, ['version', 'binding', 'jobs']) || state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.binding)
    || !Array.isArray(state.jobs) || state.jobs.length > MAX_HISTORY) bad();
  const ids = new Set();
  for (const record of state.jobs) {
    if (!exactKeys(record, ['job', 'payloadHash', 'queuedAt', 'status'], ['attemptedAt', 'settledAt', 'notificationId']) || !timestamp(record.queuedAt)) bad();
    try { validateJob(record.job); } catch { bad(); }
    if (record.payloadHash !== jobHash(record.job) || ids.has(record.job.id)) bad();
    ids.add(record.job.id);
    const hasAttempt = Object.hasOwn(record, 'attemptedAt');
    const hasSettled = Object.hasOwn(record, 'settledAt');
    const hasNotification = Object.hasOwn(record, 'notificationId');
    if ((hasAttempt && !timestamp(record.attemptedAt)) || (hasSettled && !timestamp(record.settledAt))) bad();
    if (record.status === 'queued' && (hasAttempt || hasSettled || hasNotification)) bad();
    else if (record.status === 'sending' && (!hasAttempt || hasSettled || hasNotification)) bad();
    else if (record.status === 'expired' && (hasAttempt || !hasSettled || hasNotification)) bad();
    else if (record.status === 'sent' && (!hasAttempt || !hasSettled || !notificationId(record.notificationId))) bad();
    else if (['confirmed', 'abandoned'].includes(record.status) && (!hasAttempt || !hasSettled || hasNotification)) bad();
    else if (!['queued', 'sending', 'expired', 'sent', 'confirmed', 'abandoned'].includes(record.status)) bad();
  }
  if (state.jobs.filter(pending).length > MAX_PENDING) bad();
  return state;
}

async function openState(config, connection) {
  const expected = binding(config, connection);
  const state = validateState(await readState(config.stateDirectory) ?? { version: 1, binding: expected, jobs: [] });
  if (state.binding !== expected) throw new Error('Quiet-hours policy or PingRoom connection changed. Restore the original settings; do not discard queued jobs or receipts.');
  return state;
}

export async function readJob(path) {
  return validateJob(parseStrings((await readBounded(path, 8192)).buffer));
}

export async function enqueue(config, connection, input, { now = Date.now } = {}) {
  const job = validateJob(input);
  return withLock(config.stateDirectory, async () => {
    const state = await openState(config, connection);
    const existing = state.jobs.find((record) => record.job.id === job.id);
    if (existing) {
      if (existing.payloadHash !== jobHash(job)) throw new Error('Job ID already exists with different immutable content. Use a new ID for a new notification.');
      return { id: job.id, status: existing.status, duplicate: true };
    }
    const queuedAt = iso(now);
    if (job.expiresAt <= queuedAt) throw new Error('New job is already expired.');
    if (state.jobs.length >= MAX_HISTORY || state.jobs.filter(pending).length >= MAX_PENDING) throw new Error('Outbox capacity reached. Preserve existing jobs and receipts before adding more.');
    state.jobs.push({ job, payloadHash: jobHash(job), status: 'queued', queuedAt });
    await writeState(config.stateDirectory, state);
    return { id: job.id, status: 'queued', duplicate: false };
  });
}

function summary(state) {
  return {
    queued: state.jobs.filter((record) => record.status === 'queued').length,
    unresolved: state.jobs.filter((record) => record.status === 'sending').map((record) => record.job.id),
  };
}

export async function drain(config, connection, { now = Date.now, send = sendJob } = {}) {
  return withLock(config.stateDirectory, async () => {
    const state = await openState(config, connection);
    let sent = 0;
    let expired = 0;
    let attempts = 0;
    const expire = (record, at) => {
      record.status = 'expired'; record.settledAt = at; delete record.attemptedAt; expired++;
    };
    const startedAt = iso(now);
    for (const record of state.jobs) if (record.status === 'queued' && record.job.expiresAt <= startedAt) expire(record, startedAt);
    await writeState(config.stateDirectory, state);
    for (const record of state.jobs) {
      if (record.status !== 'queued') continue;
      const at = iso(now);
      if (record.job.expiresAt <= at) { expire(record, at); await writeState(config.stateDirectory, state); continue; }
      if (attempts >= 20 || quietNow(config, Date.parse(at))) break;
      record.status = 'sending'; record.attemptedAt = at;
      await writeState(config.stateDirectory, state);
      // Recheck after the durable write, immediately before the external effect.
      const finalAt = iso(now);
      if (record.job.expiresAt <= finalAt) {
        expire(record, finalAt); await writeState(config.stateDirectory, state); continue;
      }
      if (quietNow(config, Date.parse(finalAt))) {
        record.status = 'queued'; delete record.attemptedAt;
        await writeState(config.stateDirectory, state); break;
      }
      attempts++;
      let result;
      try {
        result = await send(record.job, connection);
        if (!notificationId(result?.notificationId)) throw new Error('No valid notification ID.');
      } catch { continue; } // Retain sending, even after expiry: the remote result is unknown.
      record.status = 'sent'; record.notificationId = result.notificationId; record.settledAt = iso(now);
      await writeState(config.stateDirectory, state);
      sent++;
    }
    return { sent, expired, ...summary(state), quiet: quietNow(config, now()) };
  });
}

export async function status(config, connection) {
  return withLock(config.stateDirectory, async () => {
    const state = await openState(config, connection);
    return { ...summary(state), jobs: state.jobs.map((record) => ({ id: record.job.id, status: record.status, expiresAt: record.job.expiresAt,
      ...(record.notificationId ? { notificationId: record.notificationId } : {}) })) };
  });
}

export async function resolveJob(config, connection, id, resolution, { now = Date.now } = {}) {
  if (!jobId(id) || !['confirmed', 'abandoned'].includes(resolution)) throw new Error('Use npm run resolve -- <job-id> confirmed|abandoned.');
  return withLock(config.stateDirectory, async () => {
    const state = await openState(config, connection);
    const record = state.jobs.find((item) => item.job.id === id);
    if (record?.status !== 'sending') throw new Error('Only unresolved sending records can be resolved.');
    record.status = resolution; record.settledAt = iso(now);
    await writeState(config.stateDirectory, state);
    return { id, status: resolution };
  });
}
