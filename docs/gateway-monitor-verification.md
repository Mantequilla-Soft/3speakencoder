# Gateway Monitor Verification Service

## Overview

The Gateway Monitor service provides REST API-based job ownership verification for **community encoders** who don't have direct MongoDB database access. This prevents race conditions and ensures jobs aren't claimed by multiple encoders simultaneously.

## The Problem

Community encoders previously had only the legacy gateway WebSocket to check job ownership, which:
- Has been observed lying about job assignments
- Can tell multiple encoders they own the same job
- Causes wasted processing resources and conflicts
- No reliable way to verify ownership before claiming

## The Solution

The Gateway Monitor API (`https://gateway-monitor.3speak.tv/api`) provides:
- ✅ **Pre-claim verification** - Check if job is already taken before claiming
- ✅ **Ownership verification** - Confirm we actually own a job before processing
- ✅ **Job availability checks** - Verify job status and assignment
- ✅ **Race condition prevention** - Same reliability as MongoDB, but for community nodes

## Verification Hierarchy

The encoder now uses a 3-tier verification system:

### Tier 1: MongoDB Direct (Best - Ground Truth)
- **Who**: 3Speak infrastructure nodes only
- **Access**: Direct database connection required
- **Reliability**: ⭐⭐⭐⭐⭐ (Ground truth)
- **Use case**: Infrastructure nodes with `MONGODB_URI` configured

### Tier 2: Gateway Monitor API (Better - REST API)
- **Who**: Community encoders without database access
- **Access**: Public REST API at `gateway-monitor.3speak.tv`
- **Reliability**: ⭐⭐⭐⭐ (Very reliable)
- **Use case**: Community encoders with `GATEWAY_MONITOR_ENABLED=true`

### Tier 3: Legacy Gateway WebSocket (Fallback)
- **Who**: All encoders (last resort)
- **Access**: WebSocket connection to gateway
- **Reliability**: ⭐⭐ (Known to be unreliable)
- **Use case**: When Tier 1 and Tier 2 are unavailable

## Configuration

### For Community Encoders

Add to your `.env` file:

```bash
# Enable Gateway Monitor verification
GATEWAY_MONITOR_ENABLED=true
GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api
```

### For Infrastructure Nodes

Infrastructure nodes should continue using MongoDB verification as their primary method:

```bash
# MongoDB is still the best option for infra nodes
MONGODB_VERIFICATION_ENABLED=true
MONGODB_URI=mongodb://...
DATABASE_NAME=encoder_jobs

# Gateway Monitor as secondary verification (optional)
GATEWAY_MONITOR_ENABLED=true
GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api
```

## How It Works

### 1. Pre-Claim Verification

Before attempting to claim a job, the encoder checks if it's available:

```typescript
const availability = await gatewayMonitor.isJobAvailableToClaim(jobId);

if (!availability.available) {
  if (availability.currentOwner) {
    // Job already claimed by another encoder - skip it gracefully
    logger.info(`Job already claimed by ${availability.currentOwner}`);
    return;
  }
}
```

### 2. Ownership Verification

After claiming (or before processing), verify we actually own it:

```typescript
const verification = await gatewayMonitor.verifyJobOwnership(jobId, ourDID);

if (!verification.isOwned) {
  // Someone else owns this job - abort!
  logger.error(`Job owned by ${verification.actualOwner}`);
  return;
}

if (verification.isSafeToProcess) {
  // Safe to proceed with encoding
  await processVideo();
}
```

### 3. Integration with Job Claiming

The encoder automatically uses the verification hierarchy:

```javascript
// Pre-claim check (prevents wasted gateway calls)
if (gatewayMonitor.isEnabled()) {
  const availability = await gatewayMonitor.isJobAvailableToClaim(jobId);
  if (!availability.available && availability.currentOwner !== ourDID) {
    // Skip - already claimed by someone else
    return;
  }
}

// Attempt to claim via gateway
await gateway.acceptJob(jobId);

// Verify ownership before processing
if (mongoVerifier.isEnabled()) {
  // Tier 1: MongoDB verification (infrastructure nodes)
  const mongoResult = await mongoVerifier.verifyJobOwnership(jobId, ourDID);
  if (!mongoResult.isOwned) {
    throw new Error('Job ownership conflict detected');
  }
} else if (gatewayMonitor.isEnabled()) {
  // Tier 2: Gateway Monitor verification (community encoders)
  const monitorResult = await gatewayMonitor.verifyJobOwnership(jobId, ourDID);
  if (!monitorResult.isOwned) {
    throw new Error('Job ownership conflict detected');
  }
} else {
  // Tier 3: Legacy gateway verification (fallback)
  const gatewayStatus = await gateway.getJobStatus(jobId);
  if (gatewayStatus.assigned_to !== ourDID) {
    throw new Error('Job ownership conflict detected');
  }
}
```

## API Reference

### `GatewayMonitorService`

#### `isEnabled(): boolean`
Returns whether the service is enabled and configured.

#### `getJobDetails(jobId: string): Promise<GatewayMonitorJob | null>`
Fetches complete job information from the Gateway Monitor API.

#### `verifyJobOwnership(jobId: string, expectedOwnerDID: string): Promise<OwnershipResult>`
Verifies if the job is owned by the expected DID.

**Returns:**
```typescript
{
  isOwned: boolean;          // True if job is assigned to expectedOwnerDID
  jobExists: boolean;        // True if job exists in system
  actualOwner: string | null; // Current owner DID (null if unassigned)
  status: string | null;     // Job status (pending, assigned, running, complete, etc.)
  isSafeToProcess: boolean;  // True if owned and in processable state
}
```

#### `isJobAvailableToClaim(jobId: string): Promise<AvailabilityResult>`
Checks if a job can be safely claimed without conflicts.

**Returns:**
```typescript
{
  available: boolean;        // True if job can be claimed
  reason: string;           // Human-readable reason
  currentOwner: string | null; // Current owner if already claimed
  status: string | null;    // Job status
}
```

## Testing

Run the test suite:

```bash
npx tsx tests/test-gateway-monitor.ts
```

Expected output:
```
🧪 Gateway Monitor Service Test
================================

1️⃣ Service Status:
   Enabled: ✅ Yes
   Base URL: https://gateway-monitor.3speak.tv/api

2️⃣ Testing Job Details Fetch:
   Job ID: 2f42577d-9c93-4a62-9ae2-d1270b5bc4f3
   ✅ Job found!
   📊 Status: complete
   👤 Assigned to: did:key:z6Mkq65oNPyW3Gq187UHrvzWVZTmLhYk4wgFsBGD9HQpXSGp

3️⃣ Testing Ownership Verification:
   Job exists: ✅ Yes
   Is owned by us: ✅ Yes
   Safe to process: ❌ No (already complete)

4️⃣ Testing Job Availability Check:
   Available to claim: ❌ No
   Reason: Already assigned

✅ All tests completed successfully!
💡 This prevents race conditions for community encoders!
```

## Benefits

### For Community Encoders
- ✅ **No database access required** - Works with public REST API
- ✅ **Prevents race conditions** - Check before claiming
- ✅ **Saves resources** - Don't process jobs we don't own
- ✅ **Graceful handling** - Skip conflicts without errors
- ✅ **Same reliability as infra nodes** - Just via different method

### For the Network
- ✅ **Fewer conflicts** - Multiple encoders don't fight over same jobs
- ✅ **Better efficiency** - No wasted encoding work
- ✅ **Clearer logs** - Understand why jobs are skipped
- ✅ **Scalability** - More community encoders can participate safely

## Real-World Example

### Before Gateway Monitor
```
[Encoder A] Gateway says job XYZ is unassigned, claiming...
[Encoder B] Gateway says job XYZ is unassigned, claiming...
[Gateway] Assigned XYZ to Encoder A
[Gateway] Assigned XYZ to Encoder B (bug! gateway lied)
[Encoder A] Processing video...
[Encoder B] Processing video...
[System] Two encoders wasted resources on same job!
```

### After Gateway Monitor
```
[Encoder A] Checking Gateway Monitor API...
[Monitor] Job XYZ is unassigned
[Encoder A] Safe to claim, attempting...
[Gateway] Assigned XYZ to Encoder A
[Encoder B] Checking Gateway Monitor API...
[Monitor] Job XYZ is assigned to Encoder A
[Encoder B] Skipping - already claimed by another encoder
[System] No wasted work! Race condition prevented ✅
```

## Comparison with Other Methods

| Method | Access Required | Reliability | Latency | Community Friendly |
|--------|----------------|-------------|---------|-------------------|
| **MongoDB Direct** | Database connection | ⭐⭐⭐⭐⭐ | ~5ms | ❌ No (infra only) |
| **Gateway Monitor** | None (public API) | ⭐⭐⭐⭐ | ~200ms | ✅ Yes |
| **Legacy Gateway** | WebSocket connection | ⭐⭐ | ~50ms | ✅ Yes |
| **Gateway Aid** | Approved access | ⭐⭐⭐ | ~150ms | ⚠️ Approval needed |

## Logging Examples

### Successful Verification
```
info: 🔍 TIER_2_VERIFICATION: Checking Gateway Monitor API (community encoder mode)...
info: ✅ MONITOR_CONFIRMED: Job abc-123 is assigned to us via REST API
info: 📊 Gateway Monitor: assigned_to=did:key:z6Mk..., status=assigned
```

### Race Condition Detected
```
info: 🔍 PRE_CLAIM_CHECK: Verifying job availability via Gateway Monitor...
warn: ⚠️ PRE_CLAIM_CONFLICT: Job abc-123 already claimed by did:key:z6Mk...
info: 🏃‍♂️ GRACEFUL_SKIP: Reason - Already assigned to another encoder
```

### Ownership Conflict
```
info: 🔍 TIER_2_VERIFICATION: Checking Gateway Monitor API...
error: 🚨 MONITOR_THEFT_DETECTED: Job abc-123 is assigned to did:key:z6Mk...!
error: 🛑 ABORTING: Another encoder owns this job - stopping to prevent wasted work
```

## Future Enhancements

- [ ] Caching of job status to reduce API calls
- [ ] Batch job status queries for efficiency
- [ ] WebSocket notifications for real-time updates
- [ ] Automatic retry with exponential backoff
- [ ] Metrics dashboard for verification success rates

## Conclusion

The Gateway Monitor service bridges the gap between infrastructure nodes (with MongoDB) and community encoders (without database access), providing reliable job ownership verification through a public REST API. This enables safe, conflict-free video encoding across the entire 3Speak encoder network.
