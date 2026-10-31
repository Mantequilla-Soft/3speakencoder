// CI: wait until an encoder started by the installer (start on boot) logs that it has
// found and used FFmpeg. The encoder writes encoder.log in its own folder.
//   node tests/installer/wait-for-log.mjs <install dir>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const log = join(process.argv[2], 'encoder.log');
const READY = 'Video processor ready';
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  if (existsSync(log) && readFileSync(log, 'utf8').includes(READY)) {
    console.log(`OK: the autostarted encoder reached "${READY}"`);
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 3000));
}
console.log(`FAILED: no "${READY}" in ${log} within 4 minutes`);
if (existsSync(log)) console.log(readFileSync(log, 'utf8').split('\n').slice(-30).join('\n'));
process.exit(1);
