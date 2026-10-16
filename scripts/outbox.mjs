import { loadConfig, loadConnection, loadEnvironment } from '../src/config.mjs';
import { drain, enqueue, readJob, resolveJob, status } from '../src/outbox.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  if (!['drain', 'enqueue', 'resolve', 'status'].includes(command)
    || args.length !== (command === 'enqueue' ? 1 : command === 'resolve' ? 2 : 0)) {
    throw new Error('Use npm start, npm run enqueue -- <job.json>, npm run status, or npm run resolve -- <job-id> confirmed|abandoned.');
  }
  loadEnvironment();
  const config = await loadConfig();
  const connection = await loadConnection();
  const result = command === 'enqueue' ? await enqueue(config, connection, await readJob(args[0]))
    : command === 'resolve' ? await resolveJob(config, connection, ...args)
      : command === 'status' ? await status(config, connection) : await drain(config, connection);
  console.log(JSON.stringify(result, null, 2));
  if (result.unresolved?.length) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
