# Supernode Pin Verification System

## Overview

This document details how the 3Speak Modern Encoder verifies whether IPFS content has been successfully migrated and pinned to the supernode infrastructure. The verification system ensures reliable content availability through multi-layered checks and automated synchronization.

## Architecture

The verification system consists of three main components:

1. **LocalPinDatabase** - SQLite database tracking pin states
2. **PinSyncService** - Automated sync and verification orchestration  
3. **IPFS Supernode API** - Direct verification via HTTP API calls

## Database Tracking

### Schema

Each pin is tracked with the following key fields:

```sql
CREATE TABLE local_pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,
  job_id TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  pin_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_sync_attempt DATETIME,
  sync_attempts INTEGER DEFAULT 0,
  sync_status TEXT DEFAULT 'pending',
  supernode_verified BOOLEAN DEFAULT FALSE,
  local_path TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Key Fields

- **`supernode_verified`**: Boolean flag indicating confirmed presence on supernode
- **`sync_status`**: Current state (`pending`, `syncing`, `synced`, `failed`)
- **`sync_attempts`**: Number of verification attempts
- **`last_sync_attempt`**: Timestamp of most recent verification

### Database Operations

**Mark as Verified:**
```typescript
await this.db.run(`
  UPDATE local_pins 
  SET sync_status = 'synced',
      supernode_verified = TRUE,
      updated_at = CURRENT_TIMESTAMP
  WHERE hash = ?
`, [hash]);
```

**Query Pending Pins:**
```typescript
SELECT * FROM local_pins 
WHERE sync_status = 'pending' 
ORDER BY pin_timestamp ASC 
LIMIT ?
```

## Direct IPFS API Verification

### Verification Method

The core verification uses the IPFS HTTP API `pin/ls` endpoint on the supernode:

**Location:** [src/services/PinSyncService.ts](../src/services/PinSyncService.ts#L119)

```typescript
private async checkSupernodePin(hash: string): Promise<boolean> {
  const axios = await import('axios');
  const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint 
    || 'http://65.21.201.94:5002';
  
  const response = await axios.default.post(
    `${threeSpeakIPFS}/api/v0/pin/ls?arg=${hash}`,
    null,
    { timeout: 10000 }
  );

  // Pin exists if response is successful and doesn't contain "not pinned"
  return response.status === 200 && !response.data.includes('not pinned');
}
```

### Verification Logic

| Response | Interpretation | Action |
|----------|---------------|--------|
| HTTP 200 + no "not pinned" text | ✅ Pin exists on supernode | Mark as verified |
| HTTP 404 | ❌ Pin not found | Return false, attempt pin |
| Error contains "not pinned" | ❌ Pin not present | Return false, attempt pin |
| Other HTTP errors | 🔥 Connection/API issue | Propagate error, retry later |

### Endpoint Details

- **Default Supernode:** `http://65.21.201.94:5002`
- **API Path:** `/api/v0/pin/ls?arg={CID}`
- **Method:** POST
- **Timeout:** 10 seconds
- **Response:** JSON containing pin status

## Sync Workflow

### Three-Phase Verification Process

**Location:** [src/services/PinSyncService.ts](../src/services/PinSyncService.ts#L83-L111)

#### Phase 1: Pre-Check
Before attempting to pin, verify if content already exists:

```typescript
const alreadyPinned = await this.checkSupernodePin(pin.hash);
if (alreadyPinned) {
  logger.info(`✅ Pin ${pin.hash} already exists on supernode`);
  await this.database.markSynced(pin.hash);
  return; // Skip pinning
}
```

#### Phase 2: Pinning
If not present, initiate pinning to supernode:

```typescript
await this.pinToSupernode(pin.hash);
```

**Pinning Implementation:**
```typescript
private async pinToSupernode(hash: string): Promise<void> {
  const axios = await import('axios');
  const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint 
    || 'http://65.21.201.94:5002';
  
  await axios.default.post(
    `${threeSpeakIPFS}/api/v0/pin/add?arg=${hash}&recursive=true`,
    null,
    { 
      timeout: 120000, // 2 minutes for large content
      maxContentLength: 10 * 1024 * 1024
    }
  );
}
```

#### Phase 3: Post-Pin Verification
After pinning, verify it was successful:

```typescript
const verified = await this.checkSupernodePin(pin.hash);
if (verified) {
  logger.info(`✅ Successfully synced pin ${pin.hash} to supernode`);
  await this.database.markSynced(pin.hash);
  
  // Optionally remove local pin to save space
  if (this.config.ipfs?.remove_local_after_sync) {
    await this.removeLocalPin(pin.hash);
  }
} else {
  throw new Error('Pin verification failed after sync');
}
```

## Pin Status States

### State Machine

```
pending → syncing → synced
    ↓                  ↑
  failed ──────────────┘
         (retry)
```

### State Definitions

| State | Description | Next Actions |
|-------|-------------|--------------|
| **pending** | Pin needs to be synced to supernode | Will be picked up in next sync cycle |
| **syncing** | Currently being synced | Awaiting verification |
| **synced** | Successfully verified on supernode | Complete - will be cleaned up after retention period |
| **failed** | Sync attempt failed | Will retry in next cycle |

### Status Updates

**Update to Syncing:**
```typescript
await this.database.updateSyncStatus(pin.hash, 'syncing');
```

**Mark as Failed:**
```typescript
await this.database.updateSyncStatus(pin.hash, 'failed', error.message);
```

**Mark as Synced:**
```typescript
await this.database.markSynced(pin.hash);
```

## Continuous Monitoring

### Automatic Sync Service

**Location:** [src/services/PinSyncService.ts](../src/services/PinSyncService.ts#L17-L48)

The service runs continuous verification cycles:

```typescript
private readonly SYNC_INTERVAL_MS = 30 * 1000; // 30 seconds
private readonly MAX_CONCURRENT_SYNCS = 3;

async start(): Promise<void> {
  // Initial sync
  await this.performSync();

  // Schedule regular syncs every 30 seconds
  this.syncInterval = setInterval(() => {
    this.performSync().catch(error => {
      logger.error('❌ Sync service error:', error);
    });
  }, this.SYNC_INTERVAL_MS);
}
```

### Sync Cycle Details

**Each cycle:**
1. Query database for up to 3 pending pins
2. Process pins concurrently (max 3 at once)
3. Each pin goes through the 3-phase verification workflow
4. Update database with results
5. Log statistics (synced/pending/failed counts)
6. Clean up old synced pins (7+ days old)

**Concurrent Processing:**
```typescript
const syncPromises = pendingPins.map(pin => this.syncSinglePin(pin));
await Promise.allSettled(syncPromises);
```

### Automatic Cleanup

Old verified pins are periodically removed:

```typescript
await this.database.cleanupSynced(7); // Keep for 7 days
```

**Cleanup Query:**
```sql
DELETE FROM local_pins 
WHERE sync_status = 'synced' 
AND supernode_verified = TRUE
AND updated_at < datetime('now', '-7 days')
```

## Statistics and Monitoring

### Database Stats

Query current sync statistics:

```typescript
const stats = await this.database.getStats();
// Returns: { total, pending, synced, failed }
```

**SQL Implementation:**
```sql
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN sync_status = 'pending' THEN 1 ELSE 0 END) as pending,
  SUM(CASE WHEN sync_status = 'synced' THEN 1 ELSE 0 END) as synced,
  SUM(CASE WHEN sync_status = 'failed' THEN 1 ELSE 0 END) as failed
FROM local_pins
```

### Manual Operations

**Force Sync Specific Pin:**
```typescript
await pinSyncService.forceSyncPin(hash);
```

**Check Individual Pin Status:**
```typescript
const pin = await database.getPin(hash);
console.log(pin.sync_status, pin.supernode_verified);
```

## Configuration

### Required Settings

```json
{
  "ipfs": {
    "threespeak_endpoint": "http://65.21.201.94:5002",
    "enable_local_fallback": true,
    "remove_local_after_sync": false
  }
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `threespeak_endpoint` | `http://65.21.201.94:5002` | Supernode IPFS API URL |
| `enable_local_fallback` | `true` | Enable local pin database tracking |
| `remove_local_after_sync` | `false` | Remove local pins after supernode verification |

## Error Handling

### Retry Logic

- **Automatic Retries:** Every 30 seconds via sync service
- **Max Retries:** No hard limit, continues until synced or manually stopped
- **Exponential Backoff:** Not currently implemented, uses fixed 30s interval
- **Error Storage:** Last error message stored in `metadata` field

### Common Error Scenarios

| Error | Cause | Resolution |
|-------|-------|-----------|
| Connection timeout | Supernode unreachable | Will retry automatically |
| "not pinned" response | Content not on supernode | Attempts pinning |
| HTTP 404 | Content doesn't exist | Attempts pinning |
| Pin add failure | Supernode can't fetch content | Marks as failed, retries |

## Integration Points

### Used By

1. **JobProcessor** - Marks pins for sync after successful encoding
2. **ThreeSpeakEncoder** - Initiates pin tracking during video processing
3. **DashboardService** - Displays sync statistics and allows manual operations

### Database Files

- **Location:** `data/local-pins.db`
- **Type:** SQLite3
- **Auto-created:** Yes, on first run
- **Backup Recommended:** Yes

## Monitoring and Debugging

### Log Messages

**Successful Verification:**
```
✅ Pin {hash} already exists on supernode
✅ Successfully synced pin {hash} to supernode
✅ Marked {hash} as synced to supernode
```

**Active Syncing:**
```
🔄 Syncing {n} pending pins to supernode
📌 Syncing pin to supernode: {hash}
```

**Failures:**
```
❌ Failed to sync pin {hash}: {error}
❌ Failed to pin {hash} to supernode: {error}
```

**Statistics:**
```
📊 Pin sync stats: {synced}/{total} synced, {pending} pending
🧹 Cleaned up {count} old synced pins
```

### Debugging Commands

**Check database directly:**
```bash
sqlite3 data/local-pins.db "SELECT sync_status, COUNT(*) FROM local_pins GROUP BY sync_status;"
```

**View recent pins:**
```bash
sqlite3 data/local-pins.db "SELECT hash, sync_status, supernode_verified, updated_at FROM local_pins ORDER BY updated_at DESC LIMIT 10;"
```

**Find failed pins:**
```bash
sqlite3 data/local-pins.db "SELECT hash, sync_attempts, metadata FROM local_pins WHERE sync_status='failed';"
```

## Performance Characteristics

### Timing

- **Verification Check:** ~10 seconds (per pin)
- **Pin Operation:** Up to 2 minutes (for large content)
- **Sync Cycle:** 30 seconds
- **Concurrent Pins:** 3 simultaneous operations

### Resource Usage

- **Database Size:** ~1KB per 1000 pins
- **Memory:** Minimal (~1MB for service)
- **Network:** 1 API call per verification
- **CPU:** Negligible

## Security Considerations

### Network

- Direct HTTP communication with supernode
- No authentication currently required for pin/ls and pin/add
- Communication over internal network (port 5002)

### Database

- SQLite database stored locally
- No sensitive data stored
- File permissions should be restricted (600)

## Future Enhancements

Potential improvements to consider:

1. **Exponential Backoff:** Reduce retry frequency for persistent failures
2. **Pin Priority:** Priority queue for critical content
3. **Batch Verification:** Check multiple pins in single API call
4. **Health Monitoring:** Track supernode availability metrics
5. **Multi-Supernode:** Verify across multiple nodes for redundancy
6. **Webhook Notifications:** Alert on sync failures
7. **Migration Dashboard:** UI for monitoring migration progress

## Related Documentation

- [Cluster Pinning Strategy](./cluster-pinning.md)
- [Gateway Pinning Optimization](./gateway-pinning-optimization.md)
- [Local Fallback Pinning](./local-fallback-pinning.md)
- [IPFS Supernode Crisis Analysis](./ipfs-supernode-crisis-analysis.md)

## References

### Source Files

- [PinSyncService.ts](../src/services/PinSyncService.ts) - Main sync orchestration
- [LocalPinDatabase.ts](../src/services/LocalPinDatabase.ts) - Database operations
- [IPFSService.ts](../src/services/IPFSService.ts) - IPFS client wrapper

### Configuration

- [ConfigLoader.ts](../src/config/ConfigLoader.ts) - Configuration schema
- [encoder.json](../encoder.json) - Default configuration

---

**Last Updated:** January 17, 2026  
**Version:** 1.0  
**Status:** Production
