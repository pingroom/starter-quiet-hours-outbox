import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendJob } from '../src/cli.mjs';
import { drain, enqueue } from '../src/outbox.mjs';
import { readState } from '../src/storage.mjs';

const ID = '12345678-1234-4123-8123-123456789abc';
const NOW = Date.parse('2030-10-16T12:00:00.000Z');
const job = (id) => ({ id, title: 'Report ready', message: 'Open your report.', expiresAt: '2030-10-17T20:00:00.000Z', url: 'https://example.com/report' });

async function setup(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const directory = await mkdtemp(join(tmpdir(), 'outbox-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    config: { timeZone: 'UTC', quietStart: '22:00', quietEnd: '08:00', stateDirectory: directory },
    connection: { apiUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture-token-only', room: 'ROOM42' },
  };
}

test('real CLI 0.12 sends a linked notification once and ignores an ambient webhook', { timeout: 15000 }, async (t) => {
  const requests = [];
  const { config, connection } = await setup(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notification_id: ID, success: true }));
  });
  const previous = process.env.PINGROOM_WEBHOOK_URL;
  process.env.PINGROOM_WEBHOOK_URL = `${connection.apiUrl}/must-not-use-ambient-webhook`;
  t.after(() => { if (previous === undefined) delete process.env.PINGROOM_WEBHOOK_URL; else process.env.PINGROOM_WEBHOOK_URL = previous; });
  const options = { now: () => NOW, send: (value, target) => sendJob(value, target, { timeoutMs: 5000 }) };
  await enqueue(config, connection, job('report'), options);
  assert.equal((await drain(config, connection, options)).sent, 1);
  assert.equal((await enqueue(config, connection, job('report'), options)).duplicate, true);
  assert.equal((await drain(config, connection, options)).sent, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/api/agent/rooms/ROOM42/notifications');
  assert.equal(requests[0].auth, 'Bearer fixture-token-only');
  assert.deepEqual(requests[0].body, {
    title: 'Report ready', message: 'Open your report.',
    data: { outbox_job_id: 'report', expires_at: '2030-10-17T20:00:00.000Z', url: 'https://example.com/report', button_label: 'Open' },
  });
  const state = await readState(config.stateDirectory);
  assert.equal(state.jobs[0].notificationId, ID);
  assert.equal(JSON.stringify(state).includes('fixture-token-only'), false);
});

test('real CLI rejection, malformed success and a three-second timeout become durable unknown outcomes', { timeout: 25000 }, async (t) => {
  let mode = 'error';
  let hits = 0;
  let arrived;
  const requestArrived = new Promise((resolve) => { arrived = resolve; });
  const { config, connection } = await setup(t, (req, res) => {
    hits++;
    req.resume();
    if (mode === 'hang') { arrived(); return; }
    res.writeHead(mode === 'error' ? 403 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mode === 'error' ? { error: 'fixture-token-private-details' } : { success: true }));
  });
  const options = { now: () => NOW, send: (value, target) => sendJob(value, target, { timeoutMs: mode === 'hang' ? 3000 : 5000 }) };
  for (const name of ['error', 'malformed']) {
    mode = name;
    await enqueue(config, connection, job(name), options);
    const result = await drain(config, connection, options);
    assert.equal(result.sent, 0);
    assert.ok(result.unresolved.includes(name));
    assert.equal(JSON.stringify(result).includes('fixture-token'), false);
  }
  assert.equal(hits, 2);
  mode = 'hang';
  await enqueue(config, connection, job('hang'), options);
  const start = Date.now();
  const [result] = await Promise.all([drain(config, connection, options), requestArrived]);
  assert.deepEqual(result.unresolved, ['error', 'malformed', 'hang']);
  assert.equal(hits, 3);
  assert.ok(Date.now() - start >= 2800, 'The request reached the server and was stopped at the configured deadline.');
  assert.equal((await drain(config, connection, options)).sent, 0);
  assert.equal(hits, 3, 'Unknown sends never repeat automatically.');
});
