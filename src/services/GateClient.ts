/**
 * 🔐 Client for 3speak-gate, the entitlement and content-key service.
 *
 * Gated (paid) videos are encrypted at encode time with AES-128 HLS. The key
 * comes from the gate, is written to disk only for as long as FFmpeg needs it,
 * and is shredded immediately afterwards. Segments then sit on public IPFS as
 * ciphertext, and only the gate can hand a viewer the key.
 *
 * ⚠️ Only run gated jobs on encoders you operate. An encoder cannot transcode
 * what it cannot read, so it necessarily holds the plaintext source of every
 * video it touches. Key hygiene does not change that. An encoder holding a gate
 * API key can also mint keys for any video id, so a community node must never
 * be given one.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { logger } from './Logger.js';

const KEY_HEX_RE = /^[0-9a-f]{32}$/;      // AES-128 = 16 bytes
const REQUEST_TIMEOUT_MS = 10_000;
const TS_SYNC_BYTE = 0x47;
const TS_PACKET_SIZE = 188;

export interface GateKeyMaterial {
  videoId: string;
  keyVersion: number;
  /** URI written into the playlist; the gate rewrites it per viewer at serve time */
  keyUri: string;
  /** the 3-line file FFmpeg reads via -hls_key_info_file */
  keyInfoPath: string;
  /** Removes all key material from disk. ALWAYS call this in a finally block. */
  dispose(): Promise<void>;
}

/** Thrown when a gated job arrives on an encoder that cannot encrypt it. */
export class GateNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateNotConfiguredError';
  }
}

/** Thrown when encoded output fails the post-encode encryption check. */
export class UnencryptedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnencryptedOutputError';
  }
}

export class GateClient {
  private readonly url: string | undefined;
  private readonly apiKey: string | undefined;

  constructor(config: EncoderConfig) {
    this.url = config.gate?.url;
    this.apiKey = config.gate?.internal_api_key;
  }

  /** True when this node is configured to encode gated content. */
  get isConfigured(): boolean {
    return Boolean(this.url && this.apiKey);
  }

  /**
   * Fetches the content key and stages it for FFmpeg.
   *
   * Key material is written outside the job's work directory on purpose: the
   * work directory is what gets uploaded and pinned to IPFS, so a key file
   * inside it would be published alongside the video it protects.
   */
  async fetchKeyMaterial(videoId: string, keyVersion?: number): Promise<GateKeyMaterial> {
    if (!this.isConfigured) {
      throw new GateNotConfiguredError(
        'Gated job received but gate.url / gate.internal_api_key are not configured. ' +
          'Refusing to encode: an unencrypted gated video would be published in the clear and ' +
          'cannot be un-published from IPFS.',
      );
    }

    const body: Record<string, unknown> = { videoId };
    if (keyVersion !== undefined) body.keyVersion = keyVersion;

    let response: Response;
    try {
      response = await fetch(`${this.url!.replace(/\/+$/, '')}/internal/keyinfo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey! },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Gate unreachable while fetching content key: ${msg}`);
    }

    if (!response.ok) {
      throw new Error(`Gate refused to issue a content key: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      keyHex?: string;
      keyUri?: string;
      keyVersion?: number;
    };

    if (!payload.keyHex || !KEY_HEX_RE.test(payload.keyHex)) {
      throw new Error('Gate returned a malformed content key (expected 32 hex characters)');
    }
    if (!payload.keyUri) {
      throw new Error('Gate returned no key URI');
    }

    // Staged outside the job work directory so it is never uploaded or pinned.
    const keyDir = await fs.mkdtemp(join(tmpdir(), '3speak-gate-key-'));
    await fs.chmod(keyDir, 0o700);

    const keyPath = join(keyDir, 'content.key');
    const keyInfoPath = join(keyDir, 'content.keyinfo');

    await fs.writeFile(keyPath, Buffer.from(payload.keyHex, 'hex'), { mode: 0o600 });

    // FFmpeg's key info file: line 1 is the URI written into the playlist,
    // line 2 is where FFmpeg reads the raw key bytes from, line 3 is an
    // optional IV. Omitting the IV makes FFmpeg derive it from the segment
    // sequence number, which is what the gate's decryption path expects.
    await fs.writeFile(keyInfoPath, `${payload.keyUri}\n${keyPath}\n`, { mode: 0o600 });

    logger.info(`🔐 Content key staged for ${videoId} (key version ${payload.keyVersion ?? 1})`);

    return {
      videoId,
      keyVersion: payload.keyVersion ?? 1,
      keyUri: payload.keyUri,
      keyInfoPath,
      dispose: async () => {
        try {
          await fs.rm(keyDir, { recursive: true, force: true });
          logger.info(`🔐 Content key material shredded for ${videoId}`);
        } catch (error) {
          // Loud, because leaving a key on disk is the failure that matters.
          logger.error(`🚨 FAILED to remove key material at ${keyDir}:`, error);
        }
      },
    };
  }

  /** Registers the finished video with the gate so it can serve it. */
  async registerVideo(params: {
    videoId: string;
    creator: string;
    upstreamBaseUrl: string;
    manifestPath?: string;
    previewUrl?: string;
    keyVersion?: number;
  }): Promise<void> {
    if (!this.isConfigured) {
      throw new GateNotConfiguredError('Cannot register a gated video: gate is not configured');
    }

    const response = await fetch(`${this.url!.replace(/\/+$/, '')}/internal/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey! },
      body: JSON.stringify({ gated: true, ...params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Gate rejected video registration: HTTP ${response.status}`);
    }

    logger.info(`🔐 Registered gated video ${params.videoId} with the gate`);
  }
}

/**
 * Post-encode safety check: proves the output really is encrypted.
 *
 * This exists because the failure it catches is unrecoverable. If FFmpeg
 * silently ignored the key info file, the plaintext video would be uploaded and
 * pinned to public IPFS, and IPFS content cannot be un-published. Failing the
 * job here is always cheaper than discovering it later.
 *
 * Two independent checks, because either one alone can be fooled: the playlist
 * must declare AES-128, and the first segment must not look like plaintext
 * MPEG-TS. Plaintext TS has a 0x47 sync byte every 188 bytes; ciphertext hitting
 * that pattern three times running is a ~1-in-16-million accident.
 */
export async function verifyEncryptedOutput(playlistPath: string): Promise<void> {
  let playlist: string;
  try {
    playlist = await fs.readFile(playlistPath, 'utf8');
  } catch (error) {
    throw new UnencryptedOutputError(`Could not read playlist for verification: ${playlistPath}`);
  }

  if (!/#EXT-X-KEY:METHOD=AES-128/.test(playlist)) {
    throw new UnencryptedOutputError(
      `Gated output is NOT encrypted: ${playlistPath} has no #EXT-X-KEY:METHOD=AES-128 line. ` +
        'Refusing to upload, because plaintext published to IPFS cannot be withdrawn.',
    );
  }

  const segmentName = playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));

  if (!segmentName) {
    throw new UnencryptedOutputError(`Gated output has no segments to verify: ${playlistPath}`);
  }

  const segmentPath = join(playlistPath, '..', segmentName);
  let head: Buffer;
  try {
    const handle = await fs.open(segmentPath, 'r');
    try {
      head = Buffer.alloc(TS_PACKET_SIZE * 2 + 1);
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new UnencryptedOutputError(`Could not read segment for verification: ${segmentPath}`);
  }

  const looksLikePlaintextTs =
    head[0] === TS_SYNC_BYTE &&
    head[TS_PACKET_SIZE] === TS_SYNC_BYTE &&
    head[TS_PACKET_SIZE * 2] === TS_SYNC_BYTE;

  if (looksLikePlaintextTs) {
    throw new UnencryptedOutputError(
      `Gated output is NOT encrypted: ${segmentPath} is plaintext MPEG-TS despite the playlist ` +
        'declaring AES-128. Refusing to upload.',
    );
  }

  logger.info(`🔐 Verified encrypted output: ${playlistPath}`);
}
