# Verification Bug Fix - January 23, 2026

## Problem Identified

The encoder was experiencing **false verification failures** after successful uploads to Hotnode.

### The Bug Flow:

```
1. Upload to Hotnode → ✅ SUCCESS (QmZvYBA8Yh6WxnHKpEvz1Tu6M8Tc2HXF27qtPDp9MV2PkK)
2. Verify on Supernode → ❌ TIMEOUT (wrong node!)
3. Verify on Local IPFS → ❌ NOT FOUND (wrong node!)
4. Job fails despite successful upload
```

### Root Cause:

The verification logic **always checked Supernode and Local IPFS**, regardless of where the content was actually uploaded. When using Hotnode uploads (which is the fast path), the content exists on Hotnode but verification was looking at completely different IPFS nodes.

### Evidence from Logs:

```
[11:02:30 AM] INFO: ✅ Hotnode upload successful: QmZvYBA8Yh6WxnHKpEvz1Tu6M8Tc2HXF27qtPDp9MV2PkK
[11:02:30 AM] INFO: 🔐 TANK MODE: Final persistence check for QmZvYBA8Yh6WxnHKpEvz1Tu6M8Tc2HXF27qtPDp9MV2PkK
[11:03:00 AM] WARN: ⚠️ Pin verification attempt 1 failed:  (checking supernode)
[11:03:32 AM] WARN: ⚠️ Pin verification attempt 2 failed:  (checking supernode)
[11:04:04 AM] WARN: ⚠️ Pin verification attempt 3 failed:  (checking supernode)
[11:04:04 AM] INFO: 🏠 Supernode verification failed, checking local IPFS...
[11:05:50 AM] ERROR: 🚨 CRITICAL: Content is NOT pinned on either supernode or local IPFS!
```

The content was on **Hotnode**, but we never checked there!

---

## Solution Implemented

### 1. Upload Source Tracking

Added tracking of which IPFS node was used for upload:

```typescript
private lastUploadSource: { 
  cid: string; 
  source: 'hotnode' | 'supernode' | 'local'; 
  endpoint: string 
} | null = null;
```

### 2. Track on Every Upload Path

**Hotnode Path:**
```typescript
this.lastUploadSource = { 
  cid, 
  source: 'hotnode', 
  endpoint: hotnodeEndpoint 
};
```

**Supernode Path:**
```typescript
const supernodeEndpoint = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
this.lastUploadSource = { 
  cid: result, 
  source: 'supernode', 
  endpoint: supernodeEndpoint 
};
```

**Local IPFS Path:**
```typescript
const apiAddr = this.config.ipfs?.apiAddr || '/ip4/127.0.0.1/tcp/5001';
const localEndpoint = this.multiaddrToUrl(apiAddr);
this.lastUploadSource = { 
  cid: result, 
  source: 'local', 
  endpoint: localEndpoint 
};
```

### 3. Smart Verification

Updated `verifyContentPersistence()` to check the **actual upload target**:

```typescript
async verifyContentPersistence(hash: string): Promise<boolean> {
  // Use the node we uploaded to, not a random node
  if (this.lastUploadSource && this.lastUploadSource.cid === hash) {
    verificationEndpoint = this.lastUploadSource.endpoint;
    verificationSource = this.lastUploadSource.source;
    logger.info(`🎯 Verifying on upload target: ${verificationSource}`);
  } else {
    // Fallback to supernode (legacy behavior)
    verificationEndpoint = this.config.ipfs?.threespeak_endpoint || '...';
    logger.warn(`⚠️ Upload source unknown, defaulting to supernode check`);
  }
  
  // Check the correct node based on upload source
  if (this.lastUploadSource?.source === 'local') {
    isPinned = await this.verifyLocalPinStatus(hash);
  } else {
    isPinned = await this.verifyPinStatus(hash, verificationEndpoint, 3);
  }
}
```

### 4. Fallback Verification Fix

Also updated the fallback verification in `ThreeSpeakEncoder.ts` to use the correct endpoint:

```typescript
const uploadSource = this.ipfs.getLastUploadSource();
const verificationEndpoint = uploadSource?.endpoint || 
                             this.config.ipfs?.threespeak_endpoint || 
                             'http://65.21.201.94:5002';
```

---

## Files Modified

1. **`src/services/IPFSService.ts`**
   - Added `lastUploadSource` tracking field
   - Updated `uploadDirectory()` to track hotnode uploads
   - Updated `uploadDirectory()` to track supernode uploads  
   - Updated `uploadDirectory()` to track local uploads
   - Updated `verifyContentPersistence()` to use upload source
   - Added `getLastUploadSource()` method for external access

2. **`src/services/ThreeSpeakEncoder.ts`**
   - Updated fallback verification to use correct endpoint
   - Added logging for which node is being verified

3. **`tests/test-verification-fix.js`**
   - Created test to verify upload source tracking mechanism

---

## Expected Behavior After Fix

### Hotnode Upload → Hotnode Verification ✅

```
[11:02:30 AM] INFO: ✅ Hotnode upload successful: QmZv...
[11:02:30 AM] INFO: 🛡️ TRACK UPLOAD SOURCE: hotnode
[11:02:30 AM] INFO: 🔐 TANK MODE: Final persistence check
[11:02:30 AM] INFO: 🎯 Verifying on upload target: hotnode (https://hotnode-abc.3speak.tv)
[11:02:32 AM] INFO: ✅ Content verified on hotnode
```

### Supernode Upload → Supernode Verification ✅

```
[11:02:30 AM] INFO: ✅ Supernode upload successful: QmZv...
[11:02:30 AM] INFO: 🛡️ TRACK UPLOAD SOURCE: supernode
[11:02:30 AM] INFO: 🔐 TANK MODE: Final persistence check
[11:02:30 AM] INFO: 🎯 Verifying on upload target: supernode
[11:02:32 AM] INFO: ✅ Content verified on supernode
```

### Local Upload → Local Verification ✅

```
[11:02:30 AM] INFO: ✅ LOCAL FALLBACK SUCCESS: QmZv...
[11:02:30 AM] INFO: 🛡️ TRACK UPLOAD SOURCE: local
[11:02:30 AM] INFO: 🔐 TANK MODE: Final persistence check
[11:02:30 AM] INFO: 🎯 Verifying on upload target: local
[11:02:32 AM] INFO: ✅ Content verified on local
```

---

## Impact

### Before Fix:
- ❌ Hotnode uploads appeared to fail verification
- ❌ Jobs failed despite successful uploads
- ❌ 90+ seconds wasted checking wrong nodes (3x 30s timeouts)
- ❌ False "CRITICAL" errors in logs
- ❌ Manual intervention required to complete jobs

### After Fix:
- ✅ Verification checks the correct node
- ✅ Jobs complete successfully when upload succeeds
- ✅ Fast verification (2-5 seconds instead of 90+ seconds)
- ✅ Accurate status reporting
- ✅ No manual intervention needed

---

## Testing

Run the test:
```bash
npm run build
node tests/test-verification-fix.js
```

Or monitor a live encoding job and verify logs show:
```
🎯 Verifying on upload target: hotnode (https://...)
✅ Content verified on hotnode
```

---

## Related Issues

This fix ensures the encoder's "Tank Mode" verification works correctly with the multi-path upload strategy (Hotnode → Supernode → Local fallback).

Previously, the verification was a single-path assumption (always check supernode), which broke when Hotnode uploads were introduced.
