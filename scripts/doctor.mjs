#!/usr/bin/env node
// Checks what the encoder needs, the same way the encoder finds it.
//   npm run doctor
// Exit code 1 when something required is missing. The installers run this last.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import ffmpeg from 'fluent-ffmpeg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(root, '.env'), quiet: true });

let failed = false;
const ok = (msg) => console.log(`✅ ${msg}`);
const warn = (msg) => console.log(`⚠️  ${msg}`);
const fail = (msg) => { console.log(`❌ ${msg}`); failed = true; };

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node} is too old: install Node.js 20 or newer (https://nodejs.org)`);

// .env
if (existsSync(join(root, '.env'))) ok('.env found');
else warn('No .env file: run the installer, or copy .env.example to .env');

// FFmpeg, found exactly like the encoder finds it (fluent-ffmpeg: FFMPEG_PATH, then PATH)
const where = (fn) => new Promise((resolve) => ffmpeg()[fn]((err, path) => resolve(err ? '' : path || '')));
if (process.env.FFMPEG_PATH && !existsSync(process.env.FFMPEG_PATH)) {
  fail(`FFMPEG_PATH in .env points to ${process.env.FFMPEG_PATH}, which doesn't exist`);
}
const ffmpegPath = await where('_getFfmpegPath');
const ffprobePath = await where('_getFfprobePath');
if (!ffmpegPath) {
  fail('FFmpeg not found. Install it (see README), or set FFMPEG_PATH in .env to the full path of ffmpeg'
    + (process.platform === 'win32' ? '.exe, e.g. FFMPEG_PATH=C:\\ffmpeg\\bin\\ffmpeg.exe' : ''));
} else {
  try {
    const version = execFileSync(ffmpegPath, ['-version'], { encoding: 'utf8' }).split('\n')[0];
    ok(`FFmpeg: ${ffmpegPath} (${version})`);
    const encoders = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (/\blibx264\b/.test(encoders)) ok('FFmpeg has libx264 (software H.264)');
    else warn('This FFmpeg build has no libx264: only hardware encoding will work. Install a full FFmpeg build.');
  } catch (error) {
    fail(`FFmpeg at ${ffmpegPath} doesn't run: ${error.message}`);
  }
}
if (ffmpegPath && !ffprobePath) fail('ffprobe not found: it ships with FFmpeg; put it next to ffmpeg or set FFPROBE_PATH in .env');
else if (ffprobePath) ok(`ffprobe: ${ffprobePath}`);

// IPFS daemon API: the encoder refuses to start without it
const addr = process.env.IPFS_API_ADDR || '/ip4/127.0.0.1/tcp/5001';
const m = addr.match(/^\/(?:ip4|dns4?|ip6)\/([^/]+)\/tcp\/(\d+)/);
const apiUrl = m ? `http://${m[1].includes(':') ? `[${m[1]}]` : m[1]}:${m[2]}/api/v0/id` : null;
try {
  if (!apiUrl) throw new Error(`can't read IPFS_API_ADDR=${addr}`);
  const res = await fetch(apiUrl, { method: 'POST', signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  ok(`IPFS daemon answering at ${addr}`);
} catch (error) {
  fail(`IPFS daemon not reachable at ${addr} (${error.message}). The encoder needs it running: start it with "ipfs daemon"`);
}

console.log(failed ? '\n❌ Fix the problems above, then run npm run doctor again.' : '\n✅ Ready to encode.');
process.exit(failed ? 1 : 0);
