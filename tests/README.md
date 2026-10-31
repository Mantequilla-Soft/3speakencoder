# 🧪 Tests

## Unit tests (automated)

`tests/unit/` holds the real test suite. CI runs it on Ubuntu and Windows for every push and PR.

```bash
npm run test:unit    # vitest run
npm run typecheck    # tsc on src/ and the tests
npm test             # vitest in watch mode while developing
```

| File | Covers |
|------|--------|
| `HealthMonitor.test.ts` | event-loop lag window, percentiles, warnings, hourly summary |
| `DashboardService.test.ts` | `/api/status` fields, WebSocket pulse and ping/pong, shutdown |
| `DashboardAuth.test.ts` | dashboard password, CSRF header, DNS-rebinding/Origin checks, bind address, self-update endpoints |
| `VersionService.test.ts` | commit resolution from `.git` (refs, packed-refs, worktrees), GitHub compare mapping |
| `SelfUpdateService.test.ts` | update eligibility, drain, rollback, restart marker, concurrency |
| `EmbedPolling.test.ts`, `EmbedVersionFields.test.ts` | in-flight poll tracking, embed payload version fields |
| `PendingPinMigration.test.ts` | move from the tracked `pending_pins.json` to `pending-pins.json` |
| `ffmpegCompat.test.ts` | `ffmpeg -formats` parsing for FFmpeg 8+ |
| `errorUtils.test.ts` | error cleaning and formatting helpers |

New tests go in `tests/unit/*.test.ts`. Mock `../../src/services/Logger.js` (it creates log files when imported) and avoid real network, IPFS or ffmpeg so the suite stays fast and runs in CI.

## Manual scripts

The other files in `tests/` are scripts run by hand against real services. They are not part of CI and several are out of date:

| Script | Status |
|--------|--------|
| `test-hardware-acceleration.ts` (`npm run test:hardware`) | works: checks GPU encoders with your local ffmpeg |
| `test-cluster-pins.js`, `test-hotnode-integration.js` | need real IPFS endpoints from `.env` |
| `test-cluster-config.js`, `test-local-fallback.js`, `test-lazy-pin-fallback.js` | **broken**: import `./dist/…`, which resolves to `tests/dist/` (doesn't exist) |
| `test-mongo-verifier.ts`, `test-force-processing.js` | **broken**: import `src/services/MongoVerifier.js`, which no longer exists |
| `test-mongodb-connection.js`, `test-mongo-force.ts`, `test-mongo-result-fix.ts`, `test-force-processing-security.ts`, `test-gateway-monitor.ts`, `test-finishJob-response.ts`, `test-verification-fix.js`, `verify-gateway-safety.js`, `verify-code-paths.js` | target the legacy gateway / MongoDB features removed in v2 |
| `test-services.ts` | **broken**: imports `./services/…` relative to `tests/`, which doesn't exist (it was moved here from `src/`) |

Run TypeScript scripts with `npx tsx tests/<file>.ts` and JavaScript ones with `node tests/<file>.js`.
