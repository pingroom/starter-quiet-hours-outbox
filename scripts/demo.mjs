import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drain, enqueue } from '../src/outbox.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quiet-hours-demo-'));
try {
  const config = { timeZone: 'America/New_York', quietStart: '22:00', quietEnd: '08:00', stateDirectory: directory };
  const connection = { apiUrl: 'https://example.invalid', token: 'offline-demo', room: 'OFFLINE' };
  const job = JSON.parse(await readFile(new URL('../examples/job.json', import.meta.url), 'utf8'));
  let clock = Date.parse('2030-10-17T02:30:00.000Z');
  let sends = 0;
  const options = { now: () => clock, send: async (value) => {
    sends++; console.log(`Simulated: ${value.title} — ${value.message}`);
    return { notificationId: '11111111-1111-4111-8111-111111111111' };
  } };
  await enqueue(config, connection, job, options);
  await enqueue(config, connection, { ...job, id: 'stale-report', expiresAt: '2030-10-17T03:00:00.000Z' }, options);
  const quiet = await drain(config, connection, options);
  console.log('22:30 local:', quiet);
  clock = Date.parse('2030-10-17T12:00:00.000Z');
  const morning = await drain(config, connection, options);
  console.log('08:00 local:', morning);
  console.log('Repeated enqueue:', await enqueue(config, connection, job, options));
  const repeated = await drain(config, connection, options);
  console.log('Repeated drain:', repeated);
  if (quiet.sent !== 0 || morning.sent !== 1 || morning.expired !== 1 || repeated.sent !== 0 || sends !== 1) throw new Error('Demo did not produce the expected delivery counts.');
  console.log('Demo passed: one simulated notification; no credentials or network used.');
} finally { await rm(directory, { recursive: true, force: true }); }
