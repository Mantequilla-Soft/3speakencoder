// CI: start an installed encoder and wait until it has found and used FFmpeg.
//   node tests/installer/smoke-start.mjs <install dir>
// Job sources are switched off (env beats .env), so it never registers with 3Speak.
import { spawn, execSync } from 'node:child_process';

const dir = process.argv[2];
const READY = 'Video processor ready';
const child = spawn('npm', ['start'], {
  cwd: dir,
  shell: process.platform === 'win32',
  env: { ...process.env, EMBED_SYSTEM_ENABLED: 'false', DIRECT_API_ENABLED: 'false', VERSION_CHECK_ENABLED: 'false' },
});

let output = '';
const stop = (code) => {
  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
  } else {
    child.kill('SIGTERM');
  }
  console.log(code === 0 ? `\nOK: encoder reached "${READY}"` : `\nFAILED: no "${READY}" within the time limit`);
  process.exit(code);
};
const onData = (data) => {
  process.stdout.write(data);
  output += data;
  if (output.includes(READY)) stop(0);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (code) => { console.log(`\nencoder exited early with code ${code}`); process.exit(1); });
setTimeout(() => stop(1), 240_000);
