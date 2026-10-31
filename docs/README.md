# docs/

Notes written while building and operating the encoder. **The main [README](../README.md) and [`.env.example`](../.env.example) describe how the encoder works today;** when a note here disagrees with them, they win.

## Feature notes
Design notes for features in the current encoder. Details may have drifted since they were written.

- [gated-content.md](gated-content.md): encrypting paid videos via 3speak-gate
- [local-fallback-pinning.md](local-fallback-pinning.md): what happens when a hotnode upload fails, and how local pins move to a hotnode later (current)
- [smart-cache-system.md](smart-cache-system.md): reusing finished work on retries
- [hardware-acceleration-enhanced.md](hardware-acceleration-enhanced.md), [GPU_FIXES.md](GPU_FIXES.md): GPU encoder detection and fixes

## Incident write-ups
Dated records of specific problems and how they were handled.

- [memory-leak-fixes.md](memory-leak-fixes.md)
- [dst-fix-summary.md](dst-fix-summary.md)
- [verification-fix-jan-23.md](verification-fix-jan-23.md)
- [ipfs-supernode-crisis-analysis.md](ipfs-supernode-crisis-analysis.md)
- [eddie-recovery-plan.md](eddie-recovery-plan.md)

## Removed features
Kept for history; none of this exists in the encoder any more.

- Legacy `encoder.3speak.tv` gateway: [RESCUE_MODE.md](RESCUE_MODE.md), [gateway-monitor-verification.md](gateway-monitor-verification.md), [finishJob-response-integration.md](finishJob-response-integration.md)
- Supernode uploads and pinning (the supernode is no longer used): [pinning-strategy.md](pinning-strategy.md), [supernode-pin-verification.md](supernode-pin-verification.md), [cluster-pinning.md](cluster-pinning.md), [lazy-pin-fallback-enhancement.md](lazy-pin-fallback-enhancement.md)
