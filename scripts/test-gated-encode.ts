/**
 * 🔐 Integration test for gated (paid) content encryption.
 *
 * Drives a REAL encode through the real WorkerManager, against a REAL running
 * 3speak-gate, and proves the encrypted output is genuinely encrypted and
 * genuinely decryptable with the key the gate hands out.
 *
 * This is deliberately not a unit test. The failure that matters here is
 * "FFmpeg quietly ignored the key info file and we pinned plaintext to public
 * IPFS", and only running the actual pipeline can rule that out.
 *
 * Usage:
 *   npm run build            # emits dist/, which WorkerManager needs
 *   npx tsx scripts/test-gated-encode.ts
 *
 * Requires the gate to be built at ../3speak-gate/dist (adjust GATE_DIR).
 */

import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { GateClient, GateNotConfiguredError, verifyEncryptedOutput } from '../src/services/GateClient.js';
import { WorkerManager } from '../src/workers/WorkerManager.js';
import { VideoProcessor } from '../src/services/VideoProcessor.js';
import type { EncoderConfig } from '../src/config/ConfigLoader.js';
import type { IPFSService } from '../src/services/IPFSService.js';

const GATE_DIR = resolve(process.cwd(), '..', '3speak-gate');
const GATE_PORT = 37991;
const GATE_BASE = `http://127.0.0.1:${GATE_PORT}`;
const INTERNAL_KEY = crypto.randomBytes(16).toString('hex');
const VIDEO_ID = 'encoder-smoke-1';

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function startGate() {
  const entry = join(GATE_DIR, 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`Gate not built at ${entry}. Run "npm run build" in ${GATE_DIR}.`);
  }
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      GATE_PORT: String(GATE_PORT),
      GATE_PUBLIC_BASE_URL: GATE_BASE,
      GATE_MASTER_SECRET: crypto.randomBytes(32).toString('hex'),
      GATE_INTERNAL_API_KEYS: INTERNAL_KEY,
      GATE_UPSTREAM_HOSTS: '127.0.0.1',
      GATE_STORE: 'memory',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`[gate:err] ${d}`));
  return child;
}

async function waitForHealth(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${GATE_BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function makeConfig(gate?: { url: string; internal_api_key: string }): EncoderConfig {
  return {
    node: { name: 'test-node', cryptoAccounts: { hive: 'test' } },
    ipfs_gateway_url: 'https://ipfs.3speak.tv',
    ...(gate ? { gate } : {}),
  } as EncoderConfig;
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'encoder-gated-test-'));
  const gate = startGate();

  try {
    if (!(await waitForHealth())) throw new Error('gate did not become healthy');

    section('Refusing to encode without a gate');
    const unconfigured = new GateClient(makeConfig());
    ok('an unconfigured node reports it cannot encrypt', unconfigured.isConfigured === false);
    let refused = false;
    try {
      await unconfigured.fetchKeyMaterial(VIDEO_ID);
    } catch (error) {
      refused = error instanceof GateNotConfiguredError;
    }
    ok('a gated job on an unconfigured node throws rather than encoding in the clear', refused);

    section('Key staging');
    const client = new GateClient(makeConfig({ url: GATE_BASE, internal_api_key: INTERNAL_KEY }));
    const keyMaterial = await client.fetchKeyMaterial(VIDEO_ID);

    const keyInfo = await fs.readFile(keyMaterial.keyInfoPath, 'utf8');
    const [uriLine, keyPathLine] = keyInfo.split('\n');
    ok('key info file names the gate key endpoint', Boolean(uriLine?.includes(`/v1/key/${VIDEO_ID}`)), uriLine);

    const keyBytes = await fs.readFile(keyPathLine!.trim());
    ok('staged key is 16 bytes (AES-128)', keyBytes.length === 16);

    // The work directory is what gets uploaded and pinned, so key material must
    // never be staged inside it.
    ok('key material is staged outside any job work directory', !keyMaterial.keyInfoPath.includes('/3speak-encoder/'), keyMaterial.keyInfoPath);

    section('Real encode through WorkerManager');
    const sourceFile = join(tmp, 'source.mp4');
    const encodeSource = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=15:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      '-shortest', sourceFile,
    ]);
    if (encodeSource.status !== 0) throw new Error('could not build a test source video');

    const profileDir = join(tmp, '480p');
    await fs.mkdir(profileDir, { recursive: true });
    const outputPath = join(profileDir, 'index.m3u8');

    const workerManager = new WorkerManager(1);
    await workerManager.initialize();

    try {
      await workerManager.submitTask({
        taskId: 'gated-test-480p',
        sourceFile,
        profile: { name: '480p', height: 480 },
        profileDir,
        outputPath,
        codec: { name: 'libx264', type: 'software' },
        timeoutMs: 300_000,
        profileSettings: {
          profile: 'main', level: '3.1', bitrate: '1400k',
          maxrate: '1498k', bufsize: '2100k', audioBitrate: '96k',
        },
        segmentDuration: 2,
        // 🔐 the field under test
        keyInfoPath: keyMaterial.keyInfoPath,
      });

      const playlist = await fs.readFile(outputPath, 'utf8');
      ok('playlist declares AES-128 encryption', /#EXT-X-KEY:METHOD=AES-128/.test(playlist));
      ok('playlist key URI points at the gate', playlist.includes(`${GATE_BASE}/v1/key/${VIDEO_ID}`));

      const segmentName = playlist.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      const cipher = await fs.readFile(join(profileDir, segmentName!));
      ok('segment on disk is ciphertext, not plaintext MPEG-TS', cipher[0] !== 0x47, `first byte 0x${cipher[0]!.toString(16)}`);

      // The real proof: the key the gate would hand a viewer decrypts this.
      const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, Buffer.alloc(16, 0));
      const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
      ok('the gate key decrypts the segment back to valid MPEG-TS', plain[0] === 0x47, `first byte 0x${plain[0]!.toString(16)}, expected 0x47`);

      section('Post-encode verification guard');
      let verified = true;
      try {
        await verifyEncryptedOutput(outputPath);
      } catch {
        verified = false;
      }
      ok('verifyEncryptedOutput accepts a correctly encrypted rendition', verified);

      // Negative case: the guard must actually catch a plaintext encode, which
      // is the scenario that would otherwise pin an unprotected video to IPFS.
      const plainDir = join(tmp, 'plain');
      await fs.mkdir(plainDir, { recursive: true });
      const plainPlaylist = join(plainDir, 'index.m3u8');
      spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', sourceFile,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', join(plainDir, 'p_%d.ts'), plainPlaylist,
      ]);

      let caught = false;
      try {
        await verifyEncryptedOutput(plainPlaylist);
      } catch {
        caught = true;
      }
      ok('verifyEncryptedOutput REJECTS an unencrypted rendition', caught);
    } finally {
      await workerManager.shutdown();
    }

    section('Passthrough path (gated)');
    // Regression guard: createPassthroughHLS used to resolve `playlist` to the
    // top-level master manifest instead of the quality-level playlist. A master
    // manifest never carries #EXT-X-KEY (that tag lives on the media playlist),
    // so verifyEncryptedOutput() failed every gated job that took the
    // passthrough shortcut, encrypted or not.
    const passthroughOutputs = join(tmp, 'passthrough-outputs');
    const videoProcessor = new VideoProcessor(
      makeConfig({ url: GATE_BASE, internal_api_key: INTERNAL_KEY }),
      {} as IPFSService,
    );
    const passthroughResult = await (videoProcessor as unknown as {
      createPassthroughHLS: (
        sourceFile: string,
        outputsDir: string,
        progressCallback: (progress: { percent?: number }) => void,
        isShortVideo?: boolean,
        hasAudio?: boolean,
        keyInfoPath?: string,
      ) => Promise<{ path: string; playlist: string }>;
    }).createPassthroughHLS(
      sourceFile,
      passthroughOutputs,
      () => {},
      false,
      true,
      keyMaterial.keyInfoPath,
    );

    const masterManifestPath = join(passthroughOutputs, 'manifest.m3u8');
    ok(
      'passthrough resolves playlist to the quality playlist, not the master manifest',
      passthroughResult.playlist !== masterManifestPath,
      passthroughResult.playlist,
    );

    const passthroughPlaylist = await fs.readFile(passthroughResult.playlist, 'utf8');
    ok('passthrough playlist declares AES-128 encryption', /#EXT-X-KEY:METHOD=AES-128/.test(passthroughPlaylist));

    let passthroughVerified = true;
    let passthroughVerifyError = '';
    try {
      await verifyEncryptedOutput(passthroughResult.playlist);
    } catch (error) {
      passthroughVerified = false;
      passthroughVerifyError = error instanceof Error ? error.message : String(error);
    }
    ok('verifyEncryptedOutput accepts the passthrough rendition', passthroughVerified, passthroughVerifyError);

    section('Key shredding');
    const keyDir = join(keyMaterial.keyInfoPath, '..');
    await keyMaterial.dispose();
    ok('dispose() removes all key material from disk', !existsSync(keyDir), keyDir);
  } finally {
    gate.kill('SIGTERM');
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\ntest crashed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
