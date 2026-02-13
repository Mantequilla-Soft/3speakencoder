# 🚁 Rescue Mode - Auto-Recovery System

## Overview

Rescue Mode is the **ultimate failsafe layer** for the 3Speak encoder that automatically claims and processes abandoned jobs when the gateway is completely down. This ensures continuous video processing even during complete gateway outages.

## Problem It Solves

When the 3Speak gateway experiences a complete failure, jobs can sit in the "queued" status indefinitely. Encoders continue polling but cannot accept jobs through the gateway API. This creates a backlog that requires manual intervention.

**Rescue Mode automatically detects and claims these abandoned jobs**, bypassing the gateway entirely through MongoDB direct access.

## How It Works

### 1. Continuous Monitoring
- Runs every **60 seconds** as a background timer
- Queries MongoDB directly for available jobs
- No impact on normal gateway polling operations

### 2. Abandoned Job Detection
Jobs are considered "abandoned" when:
- Status is **"queued"** (never assigned to any encoder)
- Created **6.5+ minutes ago** (abandon threshold)
- No assignment from gateway API

**Note**: Gateway reassigns jobs at 5 minutes, so we wait 6.5 minutes to avoid conflicts.

**Safety**: Never touches jobs in "running" status - only rescues unassigned jobs

### 3. Auto-Claiming Process
When abandoned jobs are detected:
1. **Rate Limited**: Max 2 jobs per rescue cycle (prevents overload)
2. **MongoDB Takeover**: Uses `forceAssignJob()` to claim directly in database
3. **Race Detection**: Gracefully skips if another encoder claims simultaneously
4. **Defensive Tracking**: Marks job for complete MongoDB control (no gateway calls)

### 4. Processing
Rescued jobs are processed identically to normal jobs:
- Fetches complete job details from MongoDB
- Processes through standard video pipeline
- Updates completion status directly in MongoDB
- No gateway communication required

## Configuration

### Required
```json
{
  "mongodb": {
    "enabled": true,
    "uri": "mongodb://...",
    "database_name": "encoder_gateway"
  }
}
```

**Note**: Rescue Mode only activates if MongoDB is enabled. Standard encoders without MongoDB access will not run rescue operations.

### Tunable Parameters

Located in `ThreeSpeakEncoder.ts`:

```typescript
private readonly rescueCheckInterval: number = 60 * 1000;      // 60 seconds
private readonly abandonedThreshold: number = 5 * 60 * 1000;   // 5 minutes
private readonly maxRescuesPerCycle: number = 2;               // 2 jobs/cycle
```

#### Recommended Settings:

**Conservative (Default)**
- Check interval: 60 seconds
- Abandon threshold: 5 minutes
- Max per cycle: 2 jobs

**Aggressive (High Throughput)**
- Check interval: 30 seconds
- Abandon threshold: 3 minutes
- Max per cycle: 3 jobs

**Ultra-Conservative (Low Risk)**
- Check interval: 120 seconds (2 minutes)
- Abandon threshold: 10 minutes
- Max per cycle: 1 job

## Safety Features

### 1. Status Filtering
- **ONLY** rescues jobs with status = "queued"
- **NEVER** steals jobs in "running" status
- Prevents job theft from other encoders

### 2. Race Condition Protection
- MongoDB's `forceAssignJob()` includes security check
- Verifies job is unassigned before claiming
- Gracefully handles concurrent claims from multiple encoders

### 3. Rate Limiting
- Maximum 2 jobs per rescue cycle (configurable)
- Prevents overwhelming the encoder during mass failures
- Allows controlled recovery pace

### 4. Defensive Takeover Tracking
- All rescued jobs marked in `defensiveTakeoverJobs` Set
- Skips ALL gateway communication for rescued jobs
- Prevents confusion when gateway comes back online

### 5. Age Threshold
- Jobs must be abandoned for 5+ minutes
- Avoids false positives from normal gateway delays
- Prevents unnecessary rescues during temporary slowdowns

## Dashboard Integration

Rescue Mode includes live statistics in the dashboard:

### Display Behavior
- **Hidden by default** until first rescue occurs
- **Automatically appears** when `rescuedJobsCount > 0`
- **Persists** after first activation for session visibility

### Statistics Shown
```
🚁 Rescue Mode
├── Status: Active (green when running)
├── Jobs Rescued: 42
└── Last Rescue: 2025-11-02 14:35:22
```

### WebSocket Updates
Rescue statistics are included in the standard `node-status` messages:
```json
{
  "type": "node-status",
  "data": {
    "rescueStats": {
      "rescuedJobsCount": 42,
      "lastRescueTime": "2025-11-02T14:35:22.000Z"
    }
  }
}
```

## Logging

Rescue Mode provides comprehensive logging for monitoring and debugging:

### Normal Operation
```
🚁 RESCUE MODE: Starting abandoned job rescue system
🚁 Config: Check every 60s, abandon threshold 5min, max 2 jobs/cycle
✅ Rescue Mode active - will auto-claim abandoned jobs
```

### Job Detection
```
🚁 RESCUE OPPORTUNITY: Found 15 abandoned jobs (queued 5+ minutes)
🚁 RATE LIMIT: Rescuing 2 of 15 abandoned jobs (max 2 per cycle)
```

### Claiming Process
```
🚁 RESCUE ATTEMPT: Job 9d37524a-f041-4cc5-902f-a702b0259ce3 (user/video)
🚁 Job age: 8 minutes, size: 250.5 MB
🚁 CLAIMING: Attempting defensive takeover via MongoDB...
✅ RESCUED: Successfully claimed abandoned job 9d37524a-...
📊 RESCUE STATS: Total rescued: 42
🎬 PROCESSING: Fetching complete job details for rescued job...
✅ Rescued job 9d37524a-... processing started
```

### Race Conditions
```
ℹ️ RESCUE SKIP: Job 9d37524a-... was claimed by another encoder during rescue attempt
```

### No Jobs Found
```
🚁 RESCUE: No jobs available for rescue check
🚁 RESCUE: 5 total jobs, but none in "queued" status
🚁 RESCUE: 3 queued jobs, but none abandoned 5+ minutes
```

## Performance Impact

### Resource Usage
- **CPU**: Negligible (single MongoDB query per minute)
- **Memory**: Minimal (no caching, immediate processing)
- **Network**: One MongoDB query every 60 seconds

### Gateway Impact
- **Zero impact** on gateway APIs
- All operations bypass gateway completely
- No additional load on gateway infrastructure

### Encoder Throughput
- Rate limiting prevents overload
- Normal jobs continue processing unaffected
- Rescued jobs enter standard processing pipeline

## Use Cases

### Scenario 1: Complete Gateway Failure
```
Gateway: DOWN (500 errors)
Jobs: 50 queued, aging
Rescue Mode: Auto-claims 2 jobs/minute
Result: Continuous processing despite gateway failure
```

### Scenario 2: Partial Gateway Outage
```
Gateway: Intermittent (slow responses)
Jobs: Mix of assigned and queued
Rescue Mode: Claims abandoned queued jobs only
Result: Accelerates processing of stuck jobs
```

### Scenario 3: Database-Only Operation
```
Gateway: Completely offline for maintenance
MongoDB: Accessible and healthy
Rescue Mode: Full autonomous operation
Result: Zero-downtime video processing
```

## Monitoring

### Key Metrics to Watch

**Rescue Rate**
- High rescue rate = gateway issues
- Zero rescues = healthy gateway operation
- Monitor `rescuedJobsCount` over time

**Rescue Timing**
- `lastRescueTime` frequency indicates gateway health
- Frequent rescues = persistent gateway problems
- Sporadic rescues = intermittent issues

**Job Age at Rescue**
- Jobs rescued at exactly 5 minutes = normal operation
- Jobs rescued at 10+ minutes = detection delays (investigate)

### Alerts to Configure

**High Rescue Rate**
```
IF rescuedJobsCount increases by 10+ in 5 minutes
THEN alert "Gateway may be down - Rescue Mode handling backlog"
```

**Extended Rescue Activity**
```
IF lastRescueTime updates every minute for 30+ minutes
THEN alert "Prolonged gateway outage - Rescue Mode active"
```

## Architecture Integration

### Component Interaction

```
┌─────────────────────────────────────────────────┐
│ ThreeSpeakEncoder (Main)                        │
│                                                  │
│  ┌────────────────────────────────────────┐    │
│  │ Normal Polling (60s)                    │    │
│  │ - Gateway API calls                     │    │
│  │ - Job acceptance                        │    │
│  └────────────────────────────────────────┘    │
│                                                  │
│  ┌────────────────────────────────────────┐    │
│  │ Rescue Mode (60s, independent)          │    │
│  │ - MongoDB direct query                  │    │
│  │ - Abandoned job detection               │    │
│  │ - Auto-claim + process                  │    │
│  └────────────────────────────────────────┘    │
│                                                  │
│  Both feed into:                                │
│  └──> processGatewayJob()                       │
│  └──> MongoDB direct completion                 │
└─────────────────────────────────────────────────┘
```

### Integration with Existing Systems

**MongoDB Verifier**
- `getAvailableGatewayJobs()`: Query unassigned jobs
- `forceAssignJob()`: Claim job with security checks
- `getJobDetails()`: Fetch complete job document

**Job Processing**
- `processGatewayJob()`: Standard processing pipeline
- `defensiveTakeoverJobs`: Skip gateway communication
- MongoDB direct completion for results

**Dashboard**
- `rescueStats` included in node status updates
- Dynamic display (hidden until first rescue)
- Real-time statistics via WebSocket

## Backwards Compatibility

**100% backwards compatible** with regular encoders:

✅ **Without MongoDB**: Rescue Mode never activates, zero impact
✅ **With MongoDB disabled**: Same as above
✅ **Standard encoders**: Continue normal operation
✅ **No config changes required**: Works with existing setups

Only encoders with MongoDB enabled benefit from auto-rescue capabilities.

## Future Enhancements

### Potential Improvements

**Adaptive Rate Limiting**
- Increase rescue rate during sustained gateway outages
- Decrease during recovery to avoid overwhelming gateway

**Smart Prioritization**
- Rescue smaller files first (faster completions)
- Prioritize jobs from specific users/communities
- Age-weighted rescue (older jobs first)

**Health Integration**
- Coordinate with gateway health checks
- Automatically enable/disable based on gateway status
- Cross-encoder coordination to avoid conflicts

**Analytics**
- Track rescue success rates
- Measure time-to-rescue for jobs
- Identify patterns in gateway failures

## Conclusion

Rescue Mode transforms the 3Speak encoder from dependent on gateway availability to **completely autonomous** during outages. Combined with MongoDB direct completion, it creates a resilient system that continues processing videos regardless of gateway status.

**Key Benefits:**
- ✅ Zero manual intervention during gateway failures
- ✅ Continuous video processing even when gateway is down
- ✅ Rate-limited to prevent encoder overload
- ✅ Safe from race conditions and job theft
- ✅ Full backwards compatibility
- ✅ Comprehensive logging and monitoring

This is the **final resilience layer** in the encoder's multi-layered fallback system.
