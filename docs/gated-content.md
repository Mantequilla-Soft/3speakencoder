# Gated (paid) content

Encoder-side support for Patreon-style paid videos. Gated jobs produce AES-128
encrypted HLS renditions plus one unencrypted preview. The content key comes
from `3speak-gate` and never persists past the job.

## Why encrypt at all

3Speak video lives on public IPFS gateways. Content addressing means the CID
*is* the credential: anyone holding it can fetch the bytes, forever, and there
is no way to un-publish. Hiding a URL therefore protects nothing durably.

Encryption is what turns that public storage into private content. Segments stay
on IPFS exactly as before, harmless without the key, and only the gate decides
who gets one.

Be honest about the ceiling: this is not DRM. The key reaches the viewer's
browser in the clear, and `yt-dlp` decrypts AES-128 HLS automatically. What it
buys is that a leaked CDN URL or CID is worthless, and that a cancelled
subscription stops working immediately.

## ⚠️ Only run gated jobs on nodes you operate

This is the constraint that matters most, and it is not about key handling.

An encoder cannot transcode what it cannot read, so it holds the plaintext
source of every video it touches. No key scheme changes that. Separately, a node
with a gate API key can mint content keys for *any* video id, not just the ones
it was sent.

So gated jobs must be dispatched only to first-party encoders, which is a
routing decision in the embedvideos dispatcher, not something this encoder can
enforce for itself. What this encoder does enforce is the other direction: a node
with no gate configured **fails** a gated job rather than encoding it in the
clear.

## Configuration

```bash
GATE_URL=https://gate.3speak.tv
GATE_INTERNAL_API_KEY=<key issued to this node>
```

Both unset is a valid, safe configuration: the node handles ordinary public jobs
and refuses gated ones.

Issue a separate API key per node so a single node can be revoked without
disturbing the others.

## Job fields

| Field | Meaning |
| --- | --- |
| `gated` | `true` turns on encryption and preview generation |
| `gate_video_id` | id the gate knows this asset by; falls back to the job id |
| `preview_seconds` | preview length, default 45 |

## What a gated job produces

```
outputs/
  manifest.m3u8      master playlist, quality variants only
  1080p/index.m3u8   AES-128 encrypted
  720p/index.m3u8    AES-128 encrypted
  480p/index.m3u8    AES-128 encrypted
  preview/index.m3u8 UNENCRYPTED trailer
```

The preview is deliberately excluded from the master playlist, so a paying
viewer's player never treats it as a quality variant. It exists so the paywall
has something to show, and so other Hive frontends render a working trailer
rather than a player that cannot decrypt anything.

## How it works

1. `VideoProcessor.processVideo` sees `job.gated` and calls `GateClient.fetchKeyMaterial`
   **before any encoding starts**. If the gate is unreachable the job fails here,
   having done no work.
2. The key is written to a `0600` file in a `0700` temp directory, alongside a
   three-line FFmpeg key info file. This is staged **outside** the job work
   directory on purpose: the work directory is what gets uploaded and pinned, so
   a key file inside it would be published next to the video it protects.
3. Each rendition is encoded with `-hls_key_info_file`. There is no IV line, so
   FFmpeg derives the IV from the segment sequence number, which is what the
   gate's playback path expects.
4. Every rendition is verified encrypted before upload (see below).
5. The unencrypted preview is encoded from the source, which is why it happens
   before the source file is deleted.
6. `dispose()` shreds the key material in a `finally` block, so it runs on the
   failure path too.

## The verification step

`verifyEncryptedOutput` runs on every rendition of a gated job and fails the job
if anything looks unencrypted. Two independent checks, because either alone can
be fooled: the playlist must declare `#EXT-X-KEY:METHOD=AES-128`, and the first
segment must not look like plaintext MPEG-TS.

It exists because the failure it catches is unrecoverable. If FFmpeg silently
ignored the key info file, the plaintext video would be pinned to public IPFS
and could never be withdrawn. Failing the job is always cheaper.

## Testing

```bash
npm run build                          # WorkerManager needs dist/
npx tsx scripts/test-gated-encode.ts   # 12 checks
```

The test starts a real gate, drives a real encode through the real
`WorkerManager`, and confirms the gate's key decrypts the resulting segment back
to valid MPEG-TS. It also asserts the negative cases: an unconfigured node
refuses gated work, and the verification guard rejects a plaintext encode.

It expects `3speak-gate` built at `../3speak-gate`.
