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
- **On success:** the pin is marked `synced`, and the local copy is unpinned unless `REMOVE_LOCAL_AFTER_SYNC=false`. Synced rows are cleaned out of the database after 7 days.
- **After a crash:** rows left at `syncing` by a crash or restart go back to `pending` when the service starts.

Adding the same files to two Kubo nodes with default settings gives the same CID, which is what makes this work. This was verified with two Kubo 0.43.1 nodes: a folder pinned locally, then migrated, arrived on the "hotnode" under the original CID.

## Dashboard
With local fallback on, the **Local IPFS storage** tile (unlocked with `STORAGE_ADMIN_PASSWORD`) lists local pins and can **Send to hotnode** right away, unpin, and run garbage collection. `GET /api/storage-admin/pins/:cid` includes the pin's `migrationStatus` from the database.

## Settings
```bash
ENABLE_LOCAL_FALLBACK=false   # pin locally when the hotnode upload fails
REMOVE_LOCAL_AFTER_SYNC=true  # unpin locally once the video is confirmed on a hotnode
STORAGE_ADMIN_PASSWORD=       # unlocks the dashboard's storage tools
```
Local fallback needs disk space for the pinned videos and an IPFS daemon that stays reachable until they've been moved.
