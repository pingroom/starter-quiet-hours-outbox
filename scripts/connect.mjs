import { spawn } from 'node:child_process';
import { cliPath } from '../src/cli.mjs';
import { connectionHome, loadEnvironment } from '../src/config.mjs';

try {
  loadEnvironment();
  const child = spawn(process.execPath, [cliPath, 'pair', '--agent-label', 'Quiet-hours-outbox-starter', '--api', 'https://api.pingroom.io'], {
    stdio: 'inherit', env: { ...process.env, PINGROOM_HOME: connectionHome() },
  });
  child.once('error', () => { console.error('Could not start the CLI. Run npm ci first.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
} catch (error) { console.error(error.message); process.exitCode = 1; }
