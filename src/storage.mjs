import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readBounded(path, limit) {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error('File exceeds its size limit or is not a regular file.');
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error('File grew beyond its size limit.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('File changed during reading; close producer files before enqueueing.');
    return { buffer: Buffer.concat(chunks), mtimeMs: after.mtimeMs };
  } finally { await handle.close(); }
}

export async function readState(directory) {
  try {
    const value = JSON.parse((await readBounded(join(directory, 'state.json'), 8 * 1024 * 1024)).buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('State must be an object.');
    return value;
  }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('State cannot be read. Preserve it and restore a trusted backup.');
  }
}

export async function writeState(directory, state) {
  const path = join(directory, 'state.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const data = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('State reached its 8 MiB limit; no new delivery will be attempted.');
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    let directoryHandle;
    try { directoryHandle = await open(dirname(path), 'r'); await directoryHandle.sync(); }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) throw error; }
    finally { await directoryHandle?.close(); }
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

export async function withLock(directory, operation) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = join(directory, 'run.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another run holds .outbox/run.lock. If it crashed, verify it has stopped before removing only that lock directory.'); throw error; }
  try {
    const owner = await open(join(lock, 'owner.json'), 'wx', 0o600);
    try { await owner.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
    finally { await owner.close(); }
    return await operation();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
