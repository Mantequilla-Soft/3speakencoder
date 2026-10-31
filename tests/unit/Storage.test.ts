import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { IPFSService, UploadFailedError } = await import('../../src/services/IPFSService.js');
const { PinSyncService } = await import('../../src/services/PinSyncService.js');
const { LocalPinDatabase } = await import('../../src/services/LocalPinDatabase.js');

const CID = 'QmVdF5WJgwWcrHtGhKBYC637mfCPesxffe1wv3HyrbZrYV';
const config = (fallback: boolean): any => ({ ipfs: { enable_local_fallback: fallback, remove_local_after_sync: true } });

function service(fallback: boolean) {
  const svc: any = new IPFSService(config(fallback));
  svc.recordLocalPin = vi.fn(async () => {});
  return svc;
}

describe('uploadDirectory', () => {
  it('uses the hotnode when it works', async () => {
    const svc = service(true);
    svc.getHotnodeEndpoint = vi.fn(async () => 'http://hot/api/v0/add');
    svc.uploadDirectoryToHotnode = vi.fn(async () => CID);
    svc.uploadDirectoryToLocalIPFS = vi.fn();
    expect(await svc.uploadDirectory('/out', { jobId: 'j1' })).toBe(CID);
    expect(svc.uploadDirectoryToLocalIPFS).not.toHaveBeenCalled();
  });

  it.each([
    ['no hotnode available', async () => null, undefined],
    ['the hotnode upload fails', async () => 'http://hot/api/v0/add', async () => { throw new Error('socket hang up'); }],
  ])('fallback off and %s: throws UploadFailedError, nothing pinned locally', async (_c, endpoint, upload) => {
    const svc = service(false);
    svc.getHotnodeEndpoint = vi.fn(endpoint);
    if (upload) svc.uploadDirectoryToHotnode = vi.fn(upload);
    svc.uploadDirectoryToLocalIPFS = vi.fn();
    const error = await svc.uploadDirectory('/out').catch((e: Error) => e);
    expect(error).toBeInstanceOf(UploadFailedError);
    expect(error.message).toMatch(/local fallback is disabled/);
    expect(svc.uploadDirectoryToLocalIPFS).not.toHaveBeenCalled();
  });

  it('fallback on: pins locally and queues it for migration with the job id', async () => {
    const svc = service(true);
    svc.getHotnodeEndpoint = vi.fn(async () => null);
    svc.uploadDirectoryToLocalIPFS = vi.fn(async () => CID);
    const context = { jobId: 'j3', owner: 'alice', permlink: 'my-video' };
    expect(await svc.uploadDirectory('/out', context)).toBe(CID);
    expect(svc.recordLocalPin).toHaveBeenCalledWith(CID, context);
  });

  it('fallback on but local pinning fails too: UploadFailedError', async () => {
    const svc = service(true);
    svc.getHotnodeEndpoint = vi.fn(async () => null);
    svc.uploadDirectoryToLocalIPFS = vi.fn(async () => { throw new Error('daemon down'); });
    await expect(svc.uploadDirectory('/out')).rejects.toBeInstanceOf(UploadFailedError);
  });
});

describe('directoryCidFromAddResponse', () => {
  it('returns the wrapping directory (empty Name)', () => {
    const body = [
      { Name: 'manifest.m3u8', Hash: 'QmFile' },
      { Name: '480p', Hash: 'QmDir' },
      { Name: '', Hash: CID },
    ].map(o => JSON.stringify(o)).join('\n');
    expect(IPFSService.directoryCidFromAddResponse(body)).toBe(CID);
  });

  it('falls back to the last hash, and rejects responses without one', () => {
    expect(IPFSService.directoryCidFromAddResponse('{"Name":"x","Hash":"QmA"}\n{"Name":"y","Hash":"QmB"}')).toBe('QmB');
    expect(() => IPFSService.directoryCidFromAddResponse('<html>502 Bad Gateway</html>')).toThrow(/directory CID/);
  });
});

describe('migrateToHotnode', () => {
  function withLocalTree(svc: any) {
    async function* ls(cid: string) {
      if (cid === CID) {
        yield { name: 'manifest.m3u8', type: 'file', size: 10, cid: 'QmM' };
        yield { name: '480p', type: 'dir', size: 0, cid: 'QmSub' };
      } else {
        yield { name: 'index.m3u8', type: 'file', size: 5, cid: 'QmI' };
      }
    }
    async function* cat() { yield new Uint8Array([1]); }
    svc.client = { ls, cat };
  }

  it('succeeds only when the hotnode returns the same CID', async () => {
    const svc = service(true);
    withLocalTree(svc);
    svc.getHotnodeEndpoint = vi.fn(async () => 'http://hot/api/v0/add');
    svc.postToHotnode = vi.fn(async () => CID);
    expect(await svc.migrateToHotnode(CID)).toEqual({ success: true, cid: CID, endpoint: 'http://hot/api/v0/add' });
    expect(svc.postToHotnode.mock.calls[0][1]).toBe(15); // total size of both files
  });

  it('keeps the local pin when the hotnode returns a different CID', async () => {
    const svc = service(true);
    withLocalTree(svc);
    svc.getHotnodeEndpoint = vi.fn(async () => 'http://hot/api/v0/add');
    svc.postToHotnode = vi.fn(async () => 'QmSomethingElse');
    const result = await svc.migrateToHotnode(CID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/different CID/);
  });

  it('fails without a hotnode', async () => {
    const svc = service(true);
    svc.getHotnodeEndpoint = vi.fn(async () => null);
    expect(await svc.migrateToHotnode(CID)).toMatchObject({ success: false, error: expect.stringMatching(/No hotnode/) });
  });
});

describe('LocalPinDatabase + PinSyncService', () => {
  let dir: string;
  let db: InstanceType<typeof LocalPinDatabase>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pins-'));
    db = new LocalPinDatabase(join(dir, 'local-pins.db'));
    await db.initialize();
  });
  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function sync(result: any) {
    const pinRm = vi.fn(async () => {});
    const ipfs: any = { migrateToHotnode: vi.fn(async () => result), getClient: () => ({ pin: { rm: pinRm } }) };
    const svc: any = new PinSyncService(config(true), db, ipfs);
    svc.isRunning = true;
    return { svc, ipfs, pinRm };
  }

  it('migrates pending pins, marks them migrated and removes the local copy', async () => {
    await db.addLocalPin({ hash: CID, sync_status: 'pending', job_id: 'j1' });
    const { svc, pinRm } = sync({ success: true, cid: CID, endpoint: 'http://hot' });
    await svc.performSync();
    expect((await db.getPin(CID))?.sync_status).toBe('synced');
    expect(pinRm).toHaveBeenCalledWith(CID);
  });

  it('a failed migration counts one attempt and keeps the local pin', async () => {
    await db.addLocalPin({ hash: CID, sync_status: 'pending' });
    const { svc, pinRm } = sync({ success: false, cid: CID, error: 'No hotnode available' });
    await svc.performSync();
    const pin = await db.getPin(CID);
    expect(pin).toMatchObject({ sync_status: 'failed', sync_attempts: 1 });
    expect(pinRm).not.toHaveBeenCalled();
  });

  it('pins left at "syncing" by a crash are queued again', async () => {
    await db.addLocalPin({ hash: CID, sync_status: 'pending' });
    await db.markSyncing(CID);
    expect(await db.resetInterrupted()).toBe(1);
    expect((await db.getPin(CID))?.sync_status).toBe('pending');
  });
});

describe('review fixes (#62)', () => {
  it('fails the job if the local pin cannot be recorded, and removes the untracked pin', async () => {
    const svc: any = new IPFSService(config(true));
    svc.getHotnodeEndpoint = vi.fn(async () => null);
    svc.uploadDirectoryToLocalIPFS = vi.fn(async () => CID);
    svc.recordLocalPin = vi.fn(async () => { throw new Error('SQLITE_FULL: database or disk is full'); });
    const pinRm = vi.fn(async () => {});
    svc.client = { pin: { rm: pinRm } };
    const error = await svc.uploadDirectory('/out', { jobId: 'j' }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(UploadFailedError);
    expect(error.message).toMatch(/could not be recorded/);
    expect(pinRm).toHaveBeenCalledWith(CID);
  });

  it('migration states the import settings explicitly; local adds use the same ones', async () => {
    const svc: any = service(true);
    async function* ls() { yield { name: 'manifest.m3u8', type: 'file', size: 3, cid: 'QmM' }; }
    async function* cat() { yield new Uint8Array([1]); }
    const addAll = vi.fn(async function* () { yield { path: '', cid: { toString: () => CID } }; });
    svc.client = { ls, cat, addAll };
    svc.getHotnodeEndpoint = vi.fn(async () => 'http://hot/api/v0/add');
    svc.postToHotnode = vi.fn(async () => CID);
    await svc.migrateToHotnode(CID);
    expect(svc.postToHotnode.mock.calls[0][3]).toBe('cid-version=0&raw-leaves=false&chunker=size-262144');

    await svc.uploadDirectoryToLocalIPFS('/tmp');
    expect((addAll.mock.calls[0] as unknown[])[1]).toMatchObject({ wrapWithDirectory: true, pin: true, cidVersion: 0, rawLeaves: false, chunker: 'size-262144' });
  });

  it('an UploadFailedError is not retryable, and failJob then ends the job', async () => {
    const { ThreeSpeakEncoder } = await import('../../src/services/ThreeSpeakEncoder.js');
    const isRetryable = (ThreeSpeakEncoder.prototype as any).isRetryableError;
    expect(isRetryable.call({}, new UploadFailedError('Upload to hotnode failed (timeout of 300000ms exceeded)'))).toBe(false);
    expect(isRetryable.call({}, new Error('connect ECONNREFUSED'))).toBe(true);

    const { JobQueue } = await import('../../src/services/JobQueue.js');
    const queue = new JobQueue(1, 5, 1000);
    const job = await queue.addDirectJob({ owner: 'a', permlink: 'b', input_cid: 'Qm', webhook_url: 'http://x', api_key: 'k', short: false } as any);
    queue.getNextJob();
    queue.failJob(job.id, 'upload failed', false);
    expect(queue.getJob(job.id)?.status).toBe('failed');
    expect(queue.getRetryInfo(job.id)).toBeNull();
  });
});

describe('pin status (lifecycle)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pinstatus-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('upgrades a database created by an older version, keeping its rows', async () => {
    const sqlite3 = (await import('sqlite3')).default;
    const { open } = await import('sqlite');
    const file = join(dir, 'old.db');
    const old = await open({ filename: file, driver: sqlite3.Database });
    await old.exec(`CREATE TABLE local_pins (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT UNIQUE NOT NULL, job_id TEXT,
      content_type TEXT, size_bytes INTEGER, pin_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, last_sync_attempt DATETIME,
      sync_attempts INTEGER DEFAULT 0, sync_status TEXT DEFAULT 'pending', supernode_verified BOOLEAN DEFAULT FALSE,
      local_path TEXT, metadata TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await old.run(`INSERT INTO local_pins (hash, job_id) VALUES (?, ?)`, [CID, 'old-job']);
    await old.close();

    const db = new LocalPinDatabase(file);
    await db.initialize();
    const row = await db.getPin(CID);
    expect(row).toMatchObject({ hash: CID, job_id: 'old-job', owner: null, migrated_at: null, deleted_at: null });
    await db.close();
  });

  it('walks pending -> migrated -> unpinned -> deleted with dates', async () => {
    const { pinLifecycle } = await import('../../src/services/LocalPinDatabase.js');
    const db = new LocalPinDatabase(join(dir, 'p.db'));
    await db.initialize();
    await db.addLocalPin({ hash: CID, owner: 'alice', permlink: 'my-video', job_id: 'j1' });
    expect(pinLifecycle((await db.getPin(CID))!)).toBe('pending');

    await db.markSynced(CID, 'https://hotipfs-2.3speak.tv/api/v0/add');
    let row = (await db.getPin(CID))!;
    expect(pinLifecycle(row)).toBe('migrated');
    expect(row.migrated_to).toBe('https://hotipfs-2.3speak.tv/api/v0/add');
    expect(row.migrated_at).toBeTruthy();

    await db.markUnpinned(CID);
    expect(pinLifecycle((await db.getPin(CID))!)).toBe('unpinned');
    expect(await db.markGarbageCollected()).toBe(1);
    row = (await db.getPin(CID))!;
    expect(pinLifecycle(row)).toBe('deleted');
    expect(row.deleted_at).toBeTruthy();
    expect(await db.markGarbageCollected()).toBe(0); // only once
    expect((await db.listPins()).map(p => p.hash)).toEqual([CID]); // history is kept
    await db.close();
  });
});

describe('listLocalPins (dashboard view)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pinview-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function setup(pinnedNow: string[]) {
    const db = new LocalPinDatabase(join(dir, 'v.db'));
    await db.initialize();
    const svc: any = new IPFSService({ ipfs_gateway_url: 'https://gw.example/', ipfs: { enable_local_fallback: true } } as any);
    svc.pinDatabase = db;
    svc.client = { pin: { ls: async function* () { for (const c of pinnedNow) yield { cid: { toString: () => c } }; } } };
    return { db, svc };
  }

  it('builds links, retry info and flags pins unpinned before migration', async () => {
    const OTHER = 'QmOtherOtherOtherOtherOtherOtherOtherOtherOther';
    const { db, svc } = await setup([CID]);   // OTHER is no longer pinned on the daemon
    await db.addLocalPin({ hash: CID, owner: 'alice', permlink: 'my video' });
    await db.updateSyncStatus(CID, 'failed', 'No hotnode available from the traffic director');
    await db.addLocalPin({ hash: OTHER });

    const views = await svc.listLocalPins();
    const a = views.find((v: any) => v.cid === CID);
    expect(a).toMatchObject({
      status: 'pending', owner: 'alice', permlink: 'my video', attempts: 1,
      lastError: 'No hotnode available from the traffic director',
      gatewayUrl: `https://gw.example/ipfs/${CID}/manifest.m3u8`,
      playerUrl: 'https://play.3speak.tv/embed?v=alice/my%20video',
      unpinnedBeforeMigration: false,
    });
    // 5 minutes after the first failure
    expect(new Date(a.nextAttemptAt).getTime() - new Date(a.pinnedAt).getTime()).toBeGreaterThan(4 * 60e3);

    const b = views.find((v: any) => v.cid === OTHER);
    expect(b).toMatchObject({ status: 'unpinned', unpinnedBeforeMigration: true, playerUrl: null });
    expect((await db.getPin(OTHER))?.unpinned_at).toBeTruthy(); // reconciliation was saved
    await db.close();
  });
});

describe('checkGateway', () => {
  it('reports reachable / not reachable from the gateway response', async () => {
    const http = await import('http');
    const server = http.createServer((req, res) => {
      res.statusCode = req.url?.includes(CID) ? 200 : 504;
      res.end('#EXTM3U');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const svc = new IPFSService({ ipfs_gateway_url: `http://127.0.0.1:${port}` } as any);
    expect(await svc.checkGateway(CID)).toMatchObject({ reachable: true, status: 200 });
    expect(await svc.checkGateway('QmMissingMissingMissingMissingMissingMissing00')).toMatchObject({ reachable: false, status: 504 });
    server.close();
  });
});
