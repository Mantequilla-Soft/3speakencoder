# 3Speak Encoder v2: notes for AI assistants

Node/TypeScript service that encodes videos for 3Speak into HLS (1080p/720p/480p) and uploads them to IPFS. Node only orchestrates: ffmpeg encodes (in worker threads), aria2c downloads, the IPFS daemon stores. The legacy `encoder.3speak.tv` gateway, MongoDB fallback and "rescue mode" are gone; ignore old docs that mention them (see `docs/README.md`).

## How jobs flow
- **Sources:** `EmbedPollerService` polls `embed.3speak.tv` every 60s with JWS auth (community mode). `DirectApiService` accepts `POST /encode` on port 3002 (managed mode). Both feed `JobQueue`.
- **Processing:** `ThreeSpeakEncoder` takes jobs from the queue. `VideoProcessor` downloads, probes and encodes through `WorkerManager` / `workers/VideoEncodingWorker` (loaded from `dist/`, so it must be built). `IPFSService` uploads: a hotnode from the traffic director first, then the supernode, then local fallback pinning (`PendingPinService`, `PinSyncService`, `LocalPinDatabase`). `WebhookService` reports progress and completion. Gated (paid) content is encrypted via `GateClient`.
- **Operator side:**
  - `DashboardService` serves the dashboard on port 3001 (`src/dashboard/index.html`), pushes status over WebSocket, sends a 5s pulse and pings clients.
  - `HealthMonitor` measures event-loop lag.
  - `VersionService` resolves the running commit and checks GitHub for "behind main".
  - `SelfUpdateService` runs the opt-in update from the dashboard; `scripts/run-encoder.sh` / `.ps1` restart the encoder on exit code 75.

## Conventions
- ESM TypeScript, strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Relative imports end in `.js`.
- Config comes from env vars in `src/config/ConfigLoader.ts` (zod). Every setting is documented in `.env.example`; keep both in sync. A typo in an optional setting must never stop the encoder from starting.
- Read `package.json` with `createRequire`, not a JSON import (breaks `node dist/index.js`).
- Tests: vitest in `tests/unit/`. Mock `../../src/services/Logger.js` (it writes log files on import). `npm run typecheck` also checks the tests. Other files in `tests/` are manual scripts.
- CI (`.github/workflows/ci.yml`): `npm ci`, typecheck, unit tests and build on Ubuntu and Windows.

## Gotchas
- Import `src/common/ffmpegCompat.js` wherever fluent-ffmpeg is used: it fixes fluent-ffmpeg's `-formats` parsing, which breaks `-f lavfi` on FFmpeg 8+.
- Dashboard page: build DOM with `textContent` (helper `el()`), never `innerHTML` with server data. State-changing endpoints need `X-Dashboard-Request: 1`. Every request passes the Host/Origin check in `src/common/hostCheck.ts` (DNS-rebinding defense).
- Pending pins live in `data/pending-pins.json` (gitignored). `data/pending_pins.json` is a legacy tracked file: never write it.
- Self-update must never interrupt a job: drain (`JobQueue.pauseIntake`, `EmbedPollerService.isPolling`) before touching the working tree, and always resume intake on failure.
- Embed payloads (`updateNode`, `heartbeat`) must stay backward compatible: only add fields, never change `commit_hash` / `version`.
