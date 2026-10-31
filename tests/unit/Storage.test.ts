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
    expect(await svc.uploadDirectory('/out', { jobId: 'j3' })).toBe(CID);
    expect(svc.recordLocalPin).toHaveBeenCalledWith(CID, 'j3');
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
