# HotIPFS CDN Pullzone CORS Fix - January 29, 2026

## Problem Summary

Videos uploaded to the hotipfs node (hotipfs-1.3speak.tv) were failing to play through the CDN Bunny pullzone (hotipfs-3speak-1.b-cdn.net) with CORS errors, forcing fallback to the legacy supernode pullzone.

### Critical Error
```
Access to XMLHttpRequest has been blocked by CORS policy: 
The 'Access-Control-Allow-Origin' header contains multiple values '*, *', 
but only one is allowed.
```

### Business Impact
- **Primary Issue**: Hotnode CDN pullzone was unusable for video playback
- **Infrastructure Risk**: When supernode goes down, videos become inaccessible
- **Purpose of Hotnode**: Designed to provide redundancy when supernode is offline or restarting
- **User Experience**: Videos were playing, but only through fallback (legacy supernode pullzone)

---

## Root Cause Analysis

### Investigation Timeline

1. **Initial Symptoms** (2026-01-29 ~13:00 UTC)
   - Videos playing through fallback pullzone (`ipfs-3speak.b-cdn.net`)
   - Primary hotipfs pullzone failing with CORS errors
   - Browser console showing `*, *` duplicate header error

2. **Direct Testing** (2026-01-29 ~18:30 UTC)
   ```bash
   curl -I "https://hotipfs-1.3speak.tv/ipfs/CID/manifest.m3u8"
   ```
   **Result**: Showed duplicate `access-control-allow-origin: *` headers

3. **CDN Testing** (2026-01-29 ~19:13 UTC)
   ```bash
   curl -I "https://hotipfs-3speak-1.b-cdn.net/ipfs/CID/manifest.m3u8"
   ```
   **Result**: 
   ```
   access-control-allow-origin: *
   access-control-allow-origin: *
   ```
   Two identical headers = Browser CORS rejection

### Technical Root Cause

**Duplicate CORS Headers from Multiple Sources:**

1. **IPFS Gateway (Port 8080)** - Sending default CORS headers
   - Built-in IPFS Kubo defaults include CORS headers
   - Even without explicit HTTPHeaders config in `~/.ipfs/config`
   - Headers: `access-control-allow-origin: *`

2. **nginx (Port 443)** - Adding its own CORS headers
   - nginx config explicitly adds CORS headers for HLS streaming
   - Multiple location blocks (`.m3u8`, `.ts`, `/`)
   - Headers: `add_header Access-Control-Allow-Origin "*" always;`

3. **CDN Bunny** - "Add CORS headers" feature was APPENDING not REPLACING
   - When enabled, CDN adds another `*` instead of overriding
   - Result: `*, *` (invalid per CORS spec)

---

## Attempted Solutions (Chronological)

### Attempt 1: Disable CDN Bunny CORS
- **Action**: Turned OFF "Add CORS headers" in CDN Bunny pullzone settings
- **Result**: ❌ Failed - Origin's duplicate headers passed through unchanged
- **Why It Failed**: Origin (hotipfs node) was still sending duplicates

### Attempt 2: Add proxy_hide_header Directives (Server-Level)
- **Action**: Added to nginx server block:
  ```nginx
  proxy_hide_header Access-Control-Allow-Origin;
  proxy_hide_header Access-Control-Allow-Methods;
  proxy_hide_header Access-Control-Allow-Headers;
  proxy_hide_header Access-Control-Expose-Headers;
  ```
- **Result**: ❌ Failed - Directives only worked in specific location blocks
- **Why It Failed**: HLS files (`.m3u8`, `.ts`) were in separate location blocks

### Attempt 3: Add proxy_hide_header in Location Blocks
- **Action**: Added `proxy_hide_header` inside `.m3u8` and `.ts` location blocks
- **Action**: Used conditional CORS (echo back Origin header) like supernode
- **Result**: ❌ Failed - Empty CORS value when no Origin header in request
- **Why It Failed**: curl tests have no Origin header, conditional returned empty value

### Attempt 4: Simplified nginx Config with Wildcard CORS
- **Action**: Kept `proxy_hide_header` but used `*` instead of conditional
- **Result**: ❌ Partially worked - Direct origin working, CDN still broken
- **Why It Failed**: CDN Bunny cache + "Add CORS" was APPENDING not REPLACING

### Attempt 5: Re-enable CDN Bunny CORS + Cache Purge
- **Action**: Re-enabled "Add CORS headers" feature in CDN Bunny
- **Action**: Purged CDN cache multiple times
- **Result**: ❌ Failed - Still showing duplicate headers even on cache MISS
- **Why It Failed**: CDN Bunny was appending to origin headers, not replacing them

---

## Final Solution ✅

### CDN Bunny Edge Rule

**Configuration:**
- **Tool**: CDN Bunny Edge Rules (response header manipulation)
- **Action**: Set Response Header
- **Header Name**: `Access-Control-Allow-Origin`
- **Header Value**: `*`
- **Condition**: Request URL → Match any → `*`

**How It Works:**
1. CDN Bunny intercepts ALL responses from origin
2. **Strips/removes** any existing `access-control-allow-origin` headers from origin
3. **Replaces** with a single, clean `Access-Control-Allow-Origin: *`
4. Serves modified response to browser

**Why This Works:**
- Edge Rules operate at the CDN edge, AFTER pulling from origin
- Edge Rules have REPLACE semantics, not APPEND
- Applies to ALL content (manifests, segments, everything)
- No origin configuration changes needed
- Works regardless of what origin sends

---

## Verification

### Before Fix
```bash
curl -I "https://hotipfs-3speak-1.b-cdn.net/ipfs/CID/manifest.m3u8"

access-control-allow-origin: *
access-control-allow-origin: *  # ❌ DUPLICATE
```

### After Fix
```bash
curl -I "https://hotipfs-3speak-1.b-cdn.net/ipfs/CID/manifest.m3u8"

access-control-allow-origin: *  # ✅ SINGLE VALUE ONLY
```

### Browser Console - Before
```
Access to XMLHttpRequest has been blocked by CORS policy: 
The 'Access-Control-Allow-Origin' header contains multiple values '*, *'
[3Speak Player] Loaded successfully - Source: https://ipfs-3speak.b-cdn.net/...
                                            ^^^^^^^^^ FALLBACK
```

### Browser Console - After
```
[3Speak Player] Loaded successfully - Source: https://hotipfs-3speak-1.b-cdn.net/...
                                            ^^^^^^^^^^^^^^^^^ PRIMARY!
```

---

## Configuration Files Changed

### 1. HotIPFS Node nginx Config
**File**: `/etc/nginx/sites-available/hotipfs-1`

**Key Changes:**
- Added `proxy_hide_header` directives to strip IPFS gateway headers
- Uses conditional CORS (echoes Origin header) for `.m3u8` and `.ts` files
- Wildcard `*` CORS for other content

**Note**: These changes helped but were not sufficient alone. The CDN Edge Rule was the critical fix.

### 2. CDN Bunny Pullzone Settings
**Pullzone**: `hotipfs-3speak-1` (ID: 5235838)

**Settings:**
- ✅ "Add CORS headers" - **ENABLED**
- ✅ Edge Rule created (as documented above)

**Note**: The "Add CORS headers" feature ALONE was insufficient. The Edge Rule is what actually fixed it.

---

## Why Legacy Pullzone Worked

The legacy supernode pullzone (`ipfs-3speak.b-cdn.net`) worked because:

1. **Different Origin Server**: Points to `ipfs.3speak.tv` (supernode)
2. **Different nginx Config**: Supernode nginx doesn't have the same CORS duplication
3. **CDN CORS Enabled**: Has "Add CORS headers" enabled
4. **No Conflicting Headers**: Origin sends clean headers, CDN adds without conflict

---

## Lessons Learned

1. **CDN "Add CORS" Does NOT Override by Default**
   - CDN Bunny's "Add CORS headers" feature APPENDS to origin headers
   - Does not replace/override conflicting headers from origin
   - Edge Rules are needed for true override behavior

2. **nginx proxy_hide_header Has Location Scope**
   - Directives at server level don't automatically apply to location blocks
   - Must be repeated in each location block or use includes

3. **IPFS Gateway Has Built-in CORS Defaults**
   - Even with empty HTTPHeaders config, IPFS sends default CORS
   - Cannot be disabled without patching IPFS source code
   - Must be handled at nginx or CDN layer

4. **CDN Cache Purge Is Not Instantaneous**
   - Global edge propagation takes 5-30 minutes
   - Cache MISS doesn't mean all edges are fresh
   - Edge Rules apply immediately on next request

5. **Browser CORS Is Strict on Duplicates**
   - Single duplicate header = complete rejection
   - No fallback to "first valid value"
   - Must be exactly one header value

6. **Fallback Architecture Saved Us**
   - Video player's 4-tier fallback system worked perfectly
   - Users never saw broken videos (just used fallback)
   - Gave us time to debug without pressure

---

## Infrastructure Architecture

### Current Video Delivery Chain

```
User Browser
    ↓
Video Player (play.3speak.tv)
    ↓
Primary: hotipfs-3speak-1.b-cdn.net → hotipfs-1.3speak.tv (Hot Node)
    ↓ (on failure)
Fallback1: ipfs-3speak.b-cdn.net → ipfs.3speak.tv (Supernode)
    ↓ (on failure)
Fallback2: ipfs.3speak.tv (Direct Supernode)
    ↓ (on failure)
Fallback3: ipfs-audio.3speak.tv (Audio Gateway)
```

### Redundancy Benefits
- **Hot Node Purpose**: Fast IPFS node for new uploads
- **Supernode Purpose**: Long-term storage and reliability
- **Why Both**: Supernode restarts/maintenance don't cause outages
- **CDN Benefits**: Global edge caching, reduced origin load

---

## Testing Checklist

When making similar changes in future:

- [ ] Test direct origin access: `curl -I https://origin.example.com/path`
- [ ] Test CDN pullzone access: `curl -I https://cdn.example.com/path`
- [ ] Count CORS headers in response (should be exactly 1)
- [ ] Test in browser console (check Network tab)
- [ ] Test with browser from different geographic location
- [ ] Verify `cdn-cache: MISS` shows fresh content
- [ ] Test `.m3u8` manifest files specifically
- [ ] Test `.ts` segment files specifically
- [ ] Test with `Origin: https://play.3speak.tv` header in curl
- [ ] Wait 30 minutes after changes for full CDN propagation

---

## Future Improvements

### Potential Optimizations

1. **Simplify nginx Config**
   - Remove CORS headers from nginx entirely
   - Let CDN Bunny Edge Rule handle ALL CORS
   - Reduces origin complexity

2. **Monitor CDN Edge Rule Performance**
   - Check if edge rules add latency
   - Monitor CDN costs (edge rules may incur charges)

3. **Apply Same Fix to Other Hotnodes**
   - If additional hotnodes are deployed
   - Use same Edge Rule pattern

4. **Document in CDN Bunny**
   - Add comments in pullzone description
   - Note why Edge Rule exists

5. **Standardize CORS Handling**
   - Create standard config snippet for all IPFS nodes
   - Document in deployment playbooks

---

## Related Documentation

- IPFS Kubo Gateway Configuration: https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-config
- CDN Bunny Edge Rules: https://docs.bunny.net/docs/edge-rules
- CORS Specification: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
- nginx Headers Module: http://nginx.org/en/docs/http/ngx_http_headers_module.html

---

## Summary

**Problem**: Duplicate CORS headers (`*, *`) from IPFS gateway + nginx caused video playback failures through hotipfs CDN pullzone.

**Solution**: CDN Bunny Edge Rule to override/replace all `Access-Control-Allow-Origin` headers with single `*` value.

**Result**: ✅ Hotipfs CDN pullzone now primary video source, providing redundancy when supernode is offline.

**Status**: **RESOLVED** - January 29, 2026 19:40 UTC

---

**Document Created**: January 29, 2026  
**Last Updated**: January 29, 2026  
**Author**: Internal Team (with AI assistance)  
**Severity**: High (impacted video delivery redundancy)  
**Resolution Time**: ~6 hours (investigation + fixes)
