# Local fallback pinning

What the encoder does when it can't upload a finished video to a hotnode.

## Normal path
`IPFSService.uploadDirectory` asks the traffic director (`TRAFFIC_DIRECTOR_URL`) for a hotnode and uploads the output folder there (`/api/v0/add?wrap-with-directory=true`). The returned folder CID is what the job reports. There is no supernode path.

## When the hotnode upload fails
"Fails" covers: the traffic director doesn't answer or returns no endpoint, or the upload errors or times out.

| `ENABLE_LOCAL_FALLBACK` | What happens |
|---|---|
| `false` (default) | `uploadDirectory` throws `UploadFailedError`. The job fails without a retry (`ThreeSpeakEncoder.isRetryableError`), and the dispatcher gets a failure webhook. |
| `true` | The folder is added and pinned on the local IPFS daemon (`uploadDirectoryToLocalIPFS`, `wrapWithDirectory`). It's recorded in the local pin database (`data/local-pins.db`) as `pending`, with the job id. The job completes with the local CID. |

If local pinning also fails, the job fails as in the first row.

## Migrating local pins to a hotnode
`PinSyncService` runs only with `ENABLE_LOCAL_FALLBACK=true`:

- **Schedule:** every 5 minutes it takes pins that are due from `LocalPinDatabase.getPendingPins`. These are pins never tried, or failed ones past their backoff: 5 min, 1 h, 6 h, then every 24 h.
- **One at a time,** for each pin, `IPFSService.migrateToHotnode` does the following:
  1. Asks the traffic director for a hotnode.
  2. Rebuilds the folder from the local daemon (`ls` / `cat`, same relative paths) and uploads it the same way as a normal upload.
  3. Accepts the result **only if the hotnode returns the same CID**. That CID was already reported for the job, so a different one would point viewers at content that isn't there. On a mismatch the local pin is kept and the attempt counts as failed.
- **On success:** the pin is marked `synced` with the time and the hotnode, and the local copy is unpinned unless `REMOVE_LOCAL_AFTER_SYNC=false`. Rows are kept as history.
- **After a crash:** rows left at `syncing` by a crash or restart go back to `pending` when the service starts.

Adding the same files to two Kubo nodes with default settings gives the same CID, which is what makes this work. This was verified with two Kubo 0.43.1 nodes: a folder pinned locally, then migrated, arrived on the "hotnode" under the original CID.

## Pin status
Each local fallback pin goes through these states, recorded with dates in `data/local-pins.db`:

| Status | Meaning |
|---|---|
| **Pending migration** | Pinned here, waiting for a hotnode. Shows the attempts, the last error and the next try. |
| **Migrated** | Confirmed on a hotnode under the same CID. Shows when, and the hotnode. |
| **Unpinned** | No longer pinned here: after migration (`REMOVE_LOCAL_AFTER_SYNC`), from the dashboard, or removed outside the encoder. |
| **Deleted** | Unpinned, then removed from disk by garbage collection. |

Every listing reconciles with the IPFS daemon, so a pin removed with the IPFS CLI shows as unpinned. Pins **unpinned before they reached a hotnode** get a red warning: this node may have held the only copy.

Each pin also records the video's owner and permlink. Older database files get the new columns automatically on startup; their existing rows show as "Unknown video".

## Dashboard
With local fallback on, the **Local IPFS storage** tile (unlocked with `STORAGE_ADMIN_PASSWORD`) lists every local fallback pin, with filters by status. Each row has:
- the video, linking to the 3Speak player (`https://play.3speak.tv/embed?v=owner/permlink`)
- the CID, linking to its `manifest.m3u8` on `IPFS_GATEWAY_URL`
- **Check**, which asks the gateway whether the manifest is reachable right now
- **Send to hotnode** while it's pending
- **Unpin**, with a stronger warning if it hasn't been migrated

Below that are the node's repository numbers, the raw list of every IPFS pin, and garbage collection.

API, all with the `x-storage-password` header:
- `GET /api/storage-admin/local-pins`
- `GET /api/storage-admin/pins/:cid/check`
- `GET /api/storage-admin/pins/:cid` (includes `migrationStatus`)

## Settings
```bash
ENABLE_LOCAL_FALLBACK=false   # pin locally when the hotnode upload fails
REMOVE_LOCAL_AFTER_SYNC=true  # unpin locally once the video is confirmed on a hotnode
STORAGE_ADMIN_PASSWORD=       # unlocks the dashboard's storage tools
```
Local fallback needs disk space for the pinned videos and an IPFS daemon that stays reachable until they've been moved.
