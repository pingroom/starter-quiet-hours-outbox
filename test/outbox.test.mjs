import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binding, connectionHome, loadConnection, projectRoot } from '../src/config.mjs';
import { quietNow, validatePolicy } from '../src/policy.mjs';
import { drain, enqueue, MAX_HISTORY, MAX_PENDING, readJob, resolveJob, status, validateState } from '../src/outbox.mjs';
import { readState, writeState } from '../src/storage.mjs';
import { jobHash, parseStrings, validateJob } from '../src/values.mjs';

const NOW = Date.parse('2030-10-16T12:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION = { token: 'test-token', room: 'TESTROOM', apiUrl: 'https://example.invalid' };
const POLICY = { timeZone: 'America/New_York', quietStart: '22:00', quietEnd: '08:00', stateDirectory: '.outbox' };
const job = (id = 'report', overrides = {}) => ({ id, title: 'Report ready', message: 'Open the weekly report.', expiresAt: '2030-10-17T20:00:00.000Z', ...overrides });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'outbox-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { ...POLICY, stateDirectory: directory };
  let clock = NOW;
  const sent = [];
  const options = { now: () => clock, send: async (value) => { sent.push(value); return { notificationId: ID }; } };
  return { config, options, sent, now: (value) => { clock = value; },
    enqueue: (value) => enqueue(config, CONNECTION, value, options),
    drain: (extra = {}) => drain(config, CONNECTION, { ...options, ...extra }) };
}

test('quiet hours include their start and exclude their end for overnight and daytime windows', () => {
  const policy = { ...POLICY, timeZone: 'UTC' };
  for (const [time, quiet] of [['21:59', false], ['22:00', true], ['00:00', true], ['07:59', true], ['08:00', false]]) {
    assert.equal(quietNow(policy, Date.parse(`2030-10-16T${time}:00Z`)), quiet);
  }
  const daytime = { ...policy, quietStart: '09:00', quietEnd: '17:00' };
  for (const [time, quiet] of [['08:59', false], ['09:00', true], ['16:59', true], ['17:00', false], ['00:00', false]]) {
    assert.equal(quietNow(daytime, Date.parse(`2030-10-16T${time}:00Z`)), quiet);
  }
});

test('DST spring gaps and repeated fall hours use actual local wall time', () => {
  const gap = { ...POLICY, quietStart: '01:00', quietEnd: '03:00' };
  assert.equal(quietNow(gap, Date.parse('2026-03-08T06:59:00Z')), true);
  assert.equal(quietNow(gap, Date.parse('2026-03-08T07:00:00Z')), false);
  const repeated = { ...POLICY, quietStart: '01:00', quietEnd: '02:00' };
  assert.equal(quietNow(repeated, Date.parse('2026-11-01T05:30:00Z')), true);
  assert.equal(quietNow(repeated, Date.parse('2026-11-01T06:30:00Z')), true);
  assert.equal(quietNow(repeated, Date.parse('2026-11-01T07:00:00Z')), false);
});

test('invalid zones, equal endpoints, bad times and unknown policy fields are rejected', () => {
  for (const changes of [{ timeZone: 'Not/A_Zone' }, { timeZone: '+02:00' }, { quietStart: '24:00' }, { quietStart: '8:00' },
    { quietStart: '08:00' }, { quietEnd: '08:60' }, { stateDirectory: '' }, { unknown: 'x' }]) {
    assert.throws(() => validatePolicy({ ...POLICY, ...changes }));
  }
  assert.equal(validatePolicy({ ...POLICY, timeZone: 'america/new_york' }).timeZone, 'America/New_York');
});

test('job parsing rejects duplicate escaped keys, extra fields, malformed dates, controls and non-HTTP links', () => {
  const valid = job();
  assert.deepEqual(validateJob(parseStrings(Buffer.from(JSON.stringify(valid)))), valid);
  assert.throws(() => parseStrings(Buffer.from('{"id":"a","i\\u0064":"b"}')), /Duplicate/);
  assert.throws(() => parseStrings(Buffer.from('{"id":"a","nested":{}}')), /only strings/);
  assert.throws(() => parseStrings(Buffer.from([255])), /UTF-8/);
  for (const changes of [{ id: '../report' }, { title: ' ' }, { title: 'x'.repeat(41) }, { message: 'x'.repeat(121) }, { message: 'line\nline' },
    { title: '🚀'.repeat(21) }, { expiresAt: '2030-02-30T12:00:00.000Z' }, { expiresAt: '2030-10-17T20:00:00Z' },
    { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com' }, { extra: 'bad' }]) {
    assert.throws(() => validateJob({ ...valid, ...changes }));
  }
  const reordered = { expiresAt: valid.expiresAt, message: valid.message, id: valid.id, title: valid.title };
  assert.equal(jobHash(reordered), jobHash(valid));
});

test('flat string parsing preserves whitespace, key order and JSON escapes', () => {
  const source = String.raw`{
    "message": "quote: \"; path: C:\\temp; slash: \/; controls: \b\f\n\r\t; unicode: \u263a",
    "i\u0064": "report"
  }`;
  assert.deepEqual(parseStrings(Buffer.from(source)), {
    message: 'quote: "; path: C:\\temp; slash: /; controls: \b\f\n\r\t; unicode: ☺',
    id: 'report',
  });
});

test('flat string parsing rejects literals and non-string property values', () => {
  for (const source of ['null', '42', 'true', '"text"', '[]', '{"id":42}', '{"id":null}', '{"id":true}', '{"id":[]}', '{"id":{}}']) {
    assert.throws(() => parseStrings(Buffer.from(source)), /flat JSON object/);
  }
});

test('overwritten non-string values reject job files before enqueue or state changes', async (t) => {
  for (const firstValue of ['42', 'null', 'true', 'false', '[]', '{}', '{"nested":"value"}']) {
    await t.test(firstValue, async (t) => {
      const f = await fixture(t);
      await f.enqueue(job('existing'));
      const statePath = join(f.config.stateDirectory, 'state.json');
      const before = await readFile(statePath);
      const source = `{"id":${firstValue},${JSON.stringify(job('new-job')).slice(1)}`;
      const inputPath = join(f.config.stateDirectory, 'invalid-job.json');
      await writeFile(inputPath, source);
      await assert.rejects(async () => f.enqueue(await readJob(inputPath)), /flat JSON object|Duplicate JSON/);
      assert.equal(f.sent.length, 0);
      assert.deepEqual(await readFile(statePath), before);
    });
  }
});

test('input files are copied into the queue; later edits cannot alter an accepted job', async (t) => {
  const f = await fixture(t);
  const path = join(f.config.stateDirectory, 'input.json');
  await writeFile(path, JSON.stringify(job()));
  await f.enqueue(await readJob(path));
  await writeFile(path, JSON.stringify(job('report', { message: 'Changed after enqueue' })));
  await f.drain();
  assert.equal(f.sent[0].message, 'Open the weekly report.');
  await assert.rejects(f.enqueue(await readJob(path)), /different immutable/);
  await writeFile(path, Buffer.alloc(8193));
  await assert.rejects(readJob(path), /size limit/);
});

test('quiet queue survives restart, drains separately in order, and skips repeated enqueue/drain', async (t) => {
  const f = await fixture(t);
  f.now(Date.parse('2030-10-17T02:30:00Z'));
  await f.enqueue(job('first'));
  await f.enqueue(job('second'));
  assert.deepEqual(await f.drain(), { sent: 0, expired: 0, queued: 2, unresolved: [], quiet: true });
  assert.equal((await status(f.config, CONNECTION)).jobs.length, 2);
  f.now(Date.parse('2030-10-17T12:00:00Z'));
  assert.equal((await f.drain()).sent, 2);
  assert.deepEqual(f.sent.map((value) => value.id), ['first', 'second']);
  assert.deepEqual(await f.enqueue(job('first')), { id: 'first', status: 'sent', duplicate: true });
  assert.equal((await f.drain()).sent, 0);
  assert.equal((await readFile(join(f.config.stateDirectory, 'state.json'), 'utf8')).includes('test-token'), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.config.stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.config.stateDirectory, 'state.json'))).mode & 0o777, 0o600);
  }
});

test('queued work expires during quiet hours; repeated expired jobs retain their receipt', async (t) => {
  const f = await fixture(t);
  const expiring = job('short', { expiresAt: '2030-10-17T03:00:00.000Z' });
  await f.enqueue(expiring);
  f.now(Date.parse(expiring.expiresAt));
  const result = await f.drain();
  assert.equal(result.expired, 1); assert.equal(result.sent, 0); assert.equal(result.quiet, true);
  assert.equal((await f.enqueue(expiring)).status, 'expired');
  await assert.rejects(f.enqueue(job('new-stale', { expiresAt: expiring.expiresAt })), /already expired/);
});

test('expiry and quiet hours are checked between jobs', async (t) => {
  const f = await fixture(t);
  await f.enqueue(job('first'));
  await f.enqueue(job('expires-next', { expiresAt: '2030-10-16T12:01:00.000Z' }));
  const first = await f.drain({ send: async (value) => {
    f.sent.push(value); f.now(NOW + 60000); return { notificationId: ID };
  } });
  assert.equal(first.sent, 1); assert.equal(first.expired, 1);
  await f.enqueue(job('before-quiet'));
  await f.enqueue(job('held-for-tomorrow'));
  f.now(Date.parse('2030-10-17T01:59:00Z'));
  const second = await f.drain({ send: async (value) => {
    f.sent.push(value); f.now(Date.parse('2030-10-17T02:00:00Z')); return { notificationId: ID };
  } });
  assert.equal(second.sent, 1); assert.equal(second.queued, 1); assert.equal(second.quiet, true);
});

test('the durable write is followed by another expiry/quiet check before invoking the sender', async (t) => {
  for (const reason of ['quiet', 'expired']) {
    const f = await fixture(t);
    await f.enqueue(job());
    let calls = 0;
    const later = Date.parse(reason === 'quiet' ? '2030-10-17T02:00:00Z' : '2030-10-17T20:00:00Z');
    const result = await f.drain({ now: () => (++calls <= 2 ? NOW : later) });
    assert.equal(result.sent, 0);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(result.unresolved, []);
    assert.equal(result.expired, reason === 'expired' ? 1 : 0);
    assert.equal((await readState(f.config.stateDirectory)).jobs[0].status, reason === 'expired' ? 'expired' : 'queued');
  }
});

test('unknown delivery persists before invocation, never auto-expires, and does not block other jobs', async (t) => {
  const f = await fixture(t);
  await f.enqueue(job('uncertain'));
  await f.enqueue(job('next'));
  let calls = 0;
  const result = await f.drain({ send: async (value) => {
    calls++;
    const record = (await readState(f.config.stateDirectory)).jobs.find((item) => item.job.id === value.id);
    assert.equal(record.status, 'sending');
    if (value.id === 'uncertain') throw new Error('private transport details');
    return { notificationId: ID };
  } });
  assert.equal(calls, 2); assert.equal(result.sent, 1); assert.deepEqual(result.unresolved, ['uncertain']);
  f.now(Date.parse('2030-10-18T12:00:00Z'));
  assert.deepEqual((await f.drain()).unresolved, ['uncertain']);
  assert.equal(f.sent.length, 0);
  await resolveJob(f.config, CONNECTION, 'uncertain', 'confirmed', f.options);
  assert.deepEqual((await f.drain()).unresolved, []);
  assert.equal((await f.enqueue(job('uncertain'))).status, 'confirmed');
});

test('malformed send results stay unresolved; abandon resolves without another notification', async (t) => {
  const f = await fixture(t);
  await f.enqueue(job());
  assert.deepEqual((await f.drain({ send: async () => ({}) })).unresolved, ['report']);
  await resolveJob(f.config, CONNECTION, 'report', 'abandoned', f.options);
  assert.equal((await f.drain()).sent, 0);
  assert.equal(f.sent.length, 0);
  await assert.rejects(resolveJob(f.config, CONNECTION, 'report', 'confirmed', f.options), /Only unresolved/);
});

test('one drain attempts at most 20 jobs', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 21; i++) await f.enqueue(job(`job-${i}`));
  assert.equal((await f.drain()).sent, 20);
  assert.equal((await f.drain()).sent, 1);
  assert.equal(f.sent.length, 21);
});

test('enqueue, drain, status and resolution share one exclusive local lock', async (t) => {
  const f = await fixture(t);
  await f.enqueue(job());
  let arrived;
  let release;
  const started = new Promise((resolve) => { arrived = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const running = f.drain({ send: async () => { arrived(); await gate; return { notificationId: ID }; } });
  await started;
  try {
    await assert.rejects(f.enqueue(job('other')), /Another run/);
    await assert.rejects(f.drain(), /Another run/);
    await assert.rejects(status(f.config, CONNECTION), /Another run/);
    await assert.rejects(resolveJob(f.config, CONNECTION, 'report', 'abandoned'), /Another run/);
  } finally { release(); await running; }
});

test('quiet-policy or destination changes fail without sending', async (t) => {
  const f = await fixture(t);
  await f.enqueue(job());
  for (const changed of [{ ...f.config, quietStart: '21:00' }, { ...f.config, timeZone: 'UTC' }]) {
    await assert.rejects(drain(changed, CONNECTION, f.options), /connection changed/);
  }
  for (const changed of [{ ...CONNECTION, room: 'OTHER' }, { ...CONNECTION, token: 'rotated' }]) {
    await assert.rejects(drain(f.config, changed, f.options), /connection changed/);
  }
  assert.equal(f.sent.length, 0);
});

test('null, corrupt and conflicting state never initialize a fresh outbox', async (t) => {
  const f = await fixture(t);
  await f.enqueue(job());
  const state = await readState(f.config.stateDirectory);
  const conflicting = structuredClone(state);
  conflicting.jobs[0].job.message = 'tampered';
  const duplicate = structuredClone(state);
  duplicate.jobs.push(duplicate.jobs[0]);
  const falseSent = structuredClone(state);
  falseSent.jobs[0].status = 'sent';
  for (const value of ['null', '[]', '{broken', JSON.stringify(conflicting), JSON.stringify(duplicate), JSON.stringify(falseSent)]) {
    await writeFile(join(f.config.stateDirectory, 'state.json'), value);
    await assert.rejects(f.drain(), /State cannot be read|Invalid outbox state/);
  }
  assert.equal(f.sent.length, 0);
});

test('capacity limits stop enqueue without dropping jobs or receipts', async (t) => {
  const f = await fixture(t);
  const records = Array.from({ length: MAX_PENDING }, (_, i) => {
    const value = job(`queued-${i}`);
    return { job: value, payloadHash: jobHash(value), queuedAt: new Date(NOW).toISOString(), status: 'queued' };
  });
  const state = { version: 1, binding: binding(f.config, CONNECTION), jobs: records };
  await writeState(f.config.stateDirectory, state);
  await assert.rejects(f.enqueue(job('one-too-many')), /capacity reached/);
  assert.equal((await readState(f.config.stateDirectory)).jobs.length, MAX_PENDING);
  assert.throws(() => validateState({ ...state, jobs: Array(MAX_HISTORY + 1).fill(records[0]) }), /Invalid/);
  await assert.rejects(writeState(f.config.stateDirectory, { oversized: 'x'.repeat(8 * 1024 * 1024) }), /8 MiB/);
  assert.equal((await readState(f.config.stateDirectory)).jobs.length, MAX_PENDING);
});

test('credentials are local by default, never blended, uppercased by room, and production-only', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'outbox-connection-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'credentials.json'), JSON.stringify({ token: 'saved', room: { invite_code: 'room42' } }));
  assert.equal(connectionHome({}), join(projectRoot, '.pingroom'));
  assert.equal((await loadConnection({ PINGROOM_HOME: home })).room, 'ROOM42');
  for (const values of [{ PINGROOM_TOKEN: '' }, { PINGROOM_ROOM: '' }, { PINGROOM_TOKEN: '', PINGROOM_ROOM: '' }, { PINGROOM_TOKEN: 'only' }, { CI: 'true' }]) {
    await assert.rejects(loadConnection({ PINGROOM_HOME: home, ...values }), /Set both/);
  }
  const pair = await loadConnection({ PINGROOM_HOME: home, PINGROOM_TOKEN: 'env', PINGROOM_ROOM: ' env-room ', PINGROOM_API_URL: 'https://untrusted.invalid' });
  assert.equal(pair.room, 'ENV-ROOM'); assert.equal(pair.apiUrl, 'https://api.pingroom.io');
  await writeFile(join(home, 'credentials.json'), JSON.stringify({ token: 'saved', room: { invite_code: 'room' }, api_url: 'http://127.0.0.1:3000' }));
  await assert.rejects(loadConnection({ PINGROOM_HOME: home }), /production/);
});
