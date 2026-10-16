import { loadEnvFile } from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBounded } from './storage.mjs';
import { hash, parseStrings } from './values.mjs';
import { validatePolicy } from './policy.mjs';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const connectionHome = (env = process.env) => env.PINGROOM_HOME || join(projectRoot, '.pingroom');

export function loadEnvironment() {
  try { loadEnvFile(join(projectRoot, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load .env.'); }
}

export async function loadConfig() {
  let buffer;
  try { ({ buffer } = await readBounded(join(projectRoot, 'config.json'), 4096)); }
  catch { throw new Error('Copy config.example.json to config.json and set your quiet hours.'); }
  const config = validatePolicy(parseStrings(buffer));
  return { ...config, stateDirectory: resolve(projectRoot, config.stateDirectory) };
}

export async function loadConnection(env = process.env) {
  const token = env.PINGROOM_TOKEN?.trim();
  const room = env.PINGROOM_ROOM?.trim();
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined || env.CI) {
    if (!token || !room) throw new Error('Set both PINGROOM_TOKEN and PINGROOM_ROOM; environment and saved credentials cannot be mixed.');
    return { token, room: room.toUpperCase(), apiUrl: 'https://api.pingroom.io' };
  }
  let saved;
  try { saved = JSON.parse((await readBounded(join(connectionHome(env), 'credentials.json'), 65536)).buffer.toString('utf8')); }
  catch { throw new Error('Run npm run connect, or set both PINGROOM_TOKEN and PINGROOM_ROOM.'); }
  if (typeof saved?.token !== 'string' || !saved.token.trim() || typeof saved.room?.invite_code !== 'string' || !saved.room.invite_code.trim()) {
    throw new Error('The saved connection needs a token and home room. Run npm run connect and choose a room.');
  }
  if (saved.api_url && saved.api_url !== 'https://api.pingroom.io') throw new Error('This starter requires a production PingRoom connection.');
  return { token: saved.token.trim(), room: saved.room.invite_code.trim().toUpperCase(), apiUrl: 'https://api.pingroom.io' };
}

export function binding(config, connection) {
  const policy = validatePolicy(config);
  return hash(JSON.stringify({ timeZone: policy.timeZone, start: policy.quietStart, end: policy.quietEnd,
    api: connection.apiUrl, room: connection.room, tokenHash: hash(connection.token) }));
}
