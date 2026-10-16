import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { notificationId, validateJob } from './values.mjs';

const exec = promisify(execFile);
export const cliPath = createRequire(import.meta.url).resolve('@pingroom/cli/bin/pingroom.js');

export async function sendJob(input, connection, { timeoutMs = 15000 } = {}) {
  const job = validateJob(input);
  const home = await mkdtemp(join(tmpdir(), 'pingroom-outbox-'));
  try {
    const args = [cliPath, 'ping', '--json', '--title', job.title, '--message', job.message,
      '--data', JSON.stringify({ outbox_job_id: job.id, expires_at: job.expiresAt })];
    if (job.url) args.push('--url', job.url, '--button-label', 'Open');
    const { stdout } = await exec(process.execPath, args, {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: 'true', PINGROOM_NO_UPDATE_CHECK: '1',
        PINGROOM_HOME: home, PINGROOM_TOKEN: connection.token, PINGROOM_ROOM: connection.room, PINGROOM_API_URL: connection.apiUrl },
      timeout: timeoutMs, maxBuffer: 65536,
    });
    const response = JSON.parse(stdout);
    const id = response?.notification_id ?? response?.id;
    if (!notificationId(id) || (response.notification_id !== undefined && response.id !== undefined && response.notification_id !== response.id)) throw new Error('Missing or ambiguous notification ID.');
    return { notificationId: id };
  } catch { throw new Error('CLI delivery did not produce a confirmed success; its remote outcome may be unknown.'); }
  finally { await rm(home, { recursive: true, force: true }); }
}
