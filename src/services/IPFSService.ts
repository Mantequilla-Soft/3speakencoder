import { create } from 'ipfs-http-client';
import { Readable } from 'stream';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { logger } from './Logger.js';
import { LocalPinDatabase } from './LocalPinDatabase.js';
import { multiaddrToUrl } from '../common/IpfsUtils.js';

/**
 * Where encoded videos go:
 *
 *   1. A hotnode, assigned by the traffic director.
 *   2. If that fails and ENABLE_LOCAL_FALLBACK=true: the local IPFS daemon, recorded in the
 *      pin database. PinSyncService later re-uploads it to a hotnode (again via the traffic
 *      director), keeping the CID that was already reported.
 *   3. Otherwise the upload throws, so the job fails and the dispatcher is told.
 *
 * There is no supernode path: the 3Speak supernode is no longer used for uploads or pins.
 */

/**
 * The video couldn't be stored anywhere. Not retried by the encoder: the job fails and the
 * dispatcher is told, so it can decide what to do (e.g. hand the job to another encoder).
 */
export class UploadFailedError extends Error {
  override name = 'UploadFailedError';
}

export interface UploadContext {
  jobId?: string;
}

export type MigrationResult =
  | { success: true; cid: string; endpoint: string }
  | { success: false; cid: string; error: string };

export class IPFSService {
  private config: EncoderConfig;
  private client: any;
  private peerId: string = '';
  private pinDatabase: LocalPinDatabase | null = null;

  constructor(config: EncoderConfig) {
    this.config = config;

    // Local fallback pins are tracked so they can be moved to a hotnode later
    if (this.config.ipfs?.enable_local_fallback) {
      this.pinDatabase = new LocalPinDatabase();
    }
  }

  async initialize(): Promise<void> {
    try {
      const url = multiaddrToUrl(this.config.ipfs?.apiAddr || '/ip4/127.0.0.1/tcp/5001');
      this.client = create({ url });

      // Direct HTTP call: avoids multiaddr parsing issues in the client
      const axios = await import('axios');
      const response = await axios.default.post(`${url}/api/v0/id`, null, { timeout: 10000 });
      this.peerId = response.data.ID || response.data.id;
      logger.info(`📂 IPFS connected: ${this.peerId}`);

      if (this.pinDatabase) {
        await this.pinDatabase.initialize();
      }
    } catch (error) {
      logger.error('❌ Failed to connect to IPFS:', error);
      throw error;
    }
  }

  getClient(): any {
    return this.client;
  }

  getPinDatabase(): LocalPinDatabase | null {
    return this.pinDatabase;
  }

  async getPeerId(): Promise<string> {
    if (!this.peerId) {
      const url = multiaddrToUrl(this.config.ipfs?.apiAddr || '/ip4/127.0.0.1/tcp/5001');
      const axios = await import('axios');
      const response = await axios.default.post(`${url}/api/v0/id`, null, { timeout: 10000 });
      this.peerId = response.data.ID || response.data.id;
    }
    return this.peerId;
  }

  // ===========================================
  // UPLOAD
  // ===========================================

  /**
   * Upload an encoded output directory and return its CID.
   * Throws if the hotnode upload fails and local fallback is disabled.
   */
  async uploadDirectory(dirPath: string, context: UploadContext = {}): Promise<string> {
    let hotnodeError: string;

    const hotnodeEndpoint = await this.getHotnodeEndpoint();
    if (hotnodeEndpoint) {
      try {
        const cid = await this.uploadDirectoryToHotnode(dirPath, hotnodeEndpoint);
        logger.info(`✅ Uploaded to hotnode: ${cid}`);
        return cid;
      } catch (error: any) {
        hotnodeError = error.message;
        logger.warn(`⚠️ Hotnode upload failed: ${hotnodeError}`);
      }
    } else {
      hotnodeError = 'no hotnode available from the traffic director';
      logger.warn(`⚠️ Upload failed: ${hotnodeError}`);
    }

    if (!this.config.ipfs?.enable_local_fallback) {
      throw new UploadFailedError(`Upload to hotnode failed (${hotnodeError}) and local fallback is disabled (ENABLE_LOCAL_FALLBACK=false)`);
    }

    logger.info('🏠 Local fallback: pinning on this node; it will be moved to a hotnode later');
    let cid: string;
    try {
      cid = await this.uploadDirectoryToLocalIPFS(dirPath);
    } catch (error: any) {
      throw new UploadFailedError(`Upload to hotnode failed (${hotnodeError}) and local fallback failed too (${error.message})`);
    }
    await this.recordLocalPin(cid, context.jobId);
    return cid;
  }

  /** Ask the traffic director for a hotnode upload endpoint (".../api/v0/add"). */
  private async getHotnodeEndpoint(): Promise<string | null> {
    try {
      const axios = await import('axios');
      const trafficDirectorUrl = this.config.ipfs?.traffic_director_url || 'https://cdn.3speak.tv/api/hotnode';
      const response = await axios.default.get(trafficDirectorUrl, { timeout: 5000 });
      const endpoint = response.data?.success ? response.data?.data?.uploadEndpoint : null;
      if (endpoint) {
        logger.info(`🎯 Hotnode assigned: ${endpoint}`);
        return endpoint;
      }
      logger.warn('⚠️ Traffic director returned an unexpected response');
      return null;
    } catch (error: any) {
      logger.warn(`⚠️ Traffic director unavailable: ${error.message}`);
      return null;
    }
  }

  /** Hotnodes are fast, but large uploads still need time. */
  private calculateHotnodeUploadTimeout(sizeBytes: number): number {
    const sizeMB = sizeBytes / (1024 * 1024);
    if (sizeMB < 500) return 5 * 60 * 1000;
    if (sizeMB < 2000) return 15 * 60 * 1000;
    if (sizeMB < 5000) return 30 * 60 * 1000;
    return 60 * 60 * 1000;
  }

  private async uploadDirectoryToHotnode(dirPath: string, hotnodeEndpoint: string): Promise<string> {
    const FormData = await import('form-data');
    const nodeFs = await import('fs');
    const fs = await import('fs/promises');
    const path = await import('path');

    const form = new FormData.default();
    const streams: import('fs').ReadStream[] = [];
    let totalSize = 0;

    for (const filePath of await this.getAllFiles(dirPath)) {
      const relativePath = path.relative(dirPath, filePath).split(path.sep).join('/');
      totalSize += (await fs.stat(filePath)).size;
      const stream = nodeFs.createReadStream(filePath);
      streams.push(stream);
      form.append('file', stream, { filename: relativePath, filepath: relativePath });
    }

    logger.info(`🚀 Uploading ${(totalSize / 1024 / 1024).toFixed(1)}MB in ${streams.length} files to ${hotnodeEndpoint}`);
    try {
      return await this.postToHotnode(form, totalSize, hotnodeEndpoint);
    } finally {
      for (const stream of streams) {
        if (!stream.destroyed) stream.destroy();
      }
    }
  }

  /** POST a multipart form of files to a hotnode's /api/v0/add and return the wrapping directory's CID. */
  private async postToHotnode(form: any, totalSize: number, hotnodeEndpoint: string): Promise<string> {
    const axios = await import('axios');
    const timeoutMs = this.calculateHotnodeUploadTimeout(totalSize);
    const startTime = Date.now();

    // wrap-with-directory: the CID returned is the folder holding manifest.m3u8 and the renditions
    const response = await axios.default.post(`${hotnodeEndpoint}?wrap-with-directory=true`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: timeoutMs,
      responseType: 'text',
      validateStatus: (status) => status < 400,
    });

    logger.info(`🚀 Hotnode upload took ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return IPFSService.directoryCidFromAddResponse(String(response.data));
  }

  /** `ipfs add` answers with one JSON line per entry; the wrapping directory has an empty Name. */
  static directoryCidFromAddResponse(body: string): string {
    const entries = body.trim().split('\n').flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const root = entries.find(e => e.Hash && !e.Name) ?? entries.reverse().find(e => e.Hash);
    if (!root) {
      const preview = body.trim().slice(0, 120).replace(/\n/g, ' ');
      throw new Error(`Could not find the directory CID in the upload response: ${preview}`);
    }
    return root.Hash;
  }

  private async uploadDirectoryToLocalIPFS(dirPath: string): Promise<string> {
    const { globSource } = await import('ipfs-http-client');
    const startTime = Date.now();
    let directoryHash = '';

    for await (const result of this.client.addAll(globSource(dirPath, '**/*'), { wrapWithDirectory: true, pin: true })) {
      if (!result.path) directoryHash = result.cid.toString();
    }
    if (!directoryHash) throw new Error('Local IPFS returned no directory CID');

    logger.info(`🏠 Pinned locally in ${((Date.now() - startTime) / 1000).toFixed(1)}s: ${directoryHash}`);
    return directoryHash;
  }

  private async recordLocalPin(cid: string, jobId?: string): Promise<void> {
    if (!this.pinDatabase) return;
    try {
      await this.pinDatabase.addLocalPin({ hash: cid, sync_status: 'pending', ...(jobId ? { job_id: jobId } : {}) });
      logger.info(`📊 Local pin queued for migration to a hotnode: ${cid}`);
    } catch (error: any) {
      // The content is pinned and the job can complete; only the migration bookkeeping is missing
      logger.error(`❌ Could not record local pin ${cid} for migration: ${error.message}`);
    }
  }

  private async getAllFiles(dirPath: string): Promise<string[]> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const files: string[] = [];
    for (const item of await fs.readdir(dirPath)) {
      const fullPath = path.join(dirPath, item);
      if ((await fs.stat(fullPath)).isDirectory()) {
        files.push(...await this.getAllFiles(fullPath));
      } else {
        files.push(fullPath);
      }
    }
    return files;
  }

  // ===========================================
  // MIGRATION OF LOCAL FALLBACK PINS TO A HOTNODE
  // ===========================================

  /**
   * Re-upload a locally pinned directory to a hotnode, file by file from the local daemon.
   * Succeeds only if the hotnode returns the same CID, since that CID was already reported
   * for the job. On a mismatch the local pin is kept.
   */
  async migrateToHotnode(cid: string): Promise<MigrationResult> {
    const endpoint = await this.getHotnodeEndpoint();
    if (!endpoint) return { success: false, cid, error: 'No hotnode available from the traffic director' };

    try {
      const FormData = await import('form-data');
      const form = new FormData.default();
      let totalSize = 0;
      let fileCount = 0;

      const addDirectory = async (dirCid: string, prefix: string): Promise<void> => {
        for await (const entry of this.client.ls(dirCid)) {
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.type === 'dir') {
            await addDirectory(entry.cid.toString(), relativePath);
          } else {
            const size = Number(entry.size) || 0;
            totalSize += size;
            fileCount++;
            form.append('file', Readable.from(this.client.cat(entry.cid)), {
              filename: relativePath,
              filepath: relativePath,
              knownLength: size,
            });
          }
        }
      };
      await addDirectory(cid, '');
      if (fileCount === 0) return { success: false, cid, error: 'Local pin is empty or not a directory' };

      logger.info(`🔄 Migrating ${cid} to ${endpoint} (${(totalSize / 1024 / 1024).toFixed(1)}MB, ${fileCount} files)`);
      const uploadedCid = await this.postToHotnode(form, totalSize, endpoint);
      if (uploadedCid !== cid) {
        return { success: false, cid, error: `Hotnode returned a different CID (${uploadedCid}); keeping the local pin` };
      }
      return { success: true, cid, endpoint };
    } catch (error: any) {
      return { success: false, cid, error: error.message || String(error) };
    }
  }

  // ===========================================
  // STORAGE ADMIN (dashboard)
  // ===========================================

  async getPinnedItems(): Promise<any[]> {
    try {
      const pins: any[] = [];
      for await (const pin of this.client.pin.ls({ type: 'recursive' })) {
        try {
          const stat = await this.client.files.stat(`/ipfs/${pin.cid}`);
          let contents = null;
          try {
            contents = (await this.client.ls(pin.cid)).map((item: any) => ({
              name: item.name, type: item.type, size: item.size, cid: item.cid.toString()
            }));
          } catch {
            contents = null;
          }
          pins.push({
            cid: pin.cid.toString(),
            type: 'recursive',
            size: stat.cumulativeSize || stat.size || 0,
            blockSize: stat.size || 0,
            blocks: stat.blocks || 0,
            isDirectory: contents !== null,
            contents,
            timestamp: new Date().toISOString()
          });
        } catch {
          pins.push({ cid: pin.cid.toString(), type: 'recursive', size: 0, error: 'Failed to get details', timestamp: new Date().toISOString() });
        }
      }
      return pins;
    } catch (error) {
      logger.error('Failed to list pinned items:', error);
      throw new Error(`Failed to list pinned items: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPinDetails(cid: string): Promise<any> {
    try {
      let pinned = false;
      try {
        for await (const _ of this.client.pin.ls({ paths: [cid] })) {
          pinned = true;
          break;
        }
      } catch {
        pinned = false;
      }
      if (!pinned) return { cid, pinned: false, message: 'CID is not pinned locally' };

      const stat = await this.client.files.stat(`/ipfs/${cid}`);
      let contents = null;
      try {
        contents = (await this.client.ls(cid)).map((item: any) => ({
          name: item.name, type: item.type, size: item.size, cid: item.cid.toString()
        }));
      } catch {
        contents = null;
      }
      const migration = this.pinDatabase ? await this.pinDatabase.getPin(cid) : null;

      return {
        cid,
        pinned: true,
        isDirectory: contents !== null,
        contents,
        size: stat.cumulativeSize || stat.size || 0,
        blockSize: stat.size || 0,
        blocks: stat.blocks || 0,
        migrationStatus: migration?.sync_status ?? null,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error(`Failed to get pin details for ${cid}:`, error);
      throw new Error(`Failed to get pin details: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Storage admin "Send to hotnode": migrate the selected local pins now. */
  async migratePinsToHotnode(cids: string[]): Promise<any> {
    const results = { total: cids.length, successful: 0, failed: 0, details: [] as any[] };
    for (const cid of cids) {
      const result = await this.migrateToHotnode(cid);
      if (result.success) {
        results.successful++;
        results.details.push({ cid, status: 'success', endpoint: result.endpoint });
        if (this.pinDatabase && await this.pinDatabase.getPin(cid)) await this.pinDatabase.markSynced(cid);
        logger.info(`✅ Migrated to hotnode: ${cid}`);
      } else {
        results.failed++;
        results.details.push({ cid, status: 'failed', error: result.error });
        logger.error(`❌ Migration to hotnode failed for ${cid}: ${result.error}`);
      }
    }
    return results;
  }

  async unpinItemsLocally(cids: string[]): Promise<any> {
    const results = { total: cids.length, successful: 0, failed: 0, details: [] as any[] };
    for (const cid of cids) {
      try {
        await this.client.pin.rm(cid);
        results.successful++;
        results.details.push({ cid, status: 'unpinned' });
        logger.info(`🗑️ Unpinned locally: ${cid}`);
      } catch (error) {
        results.failed++;
        results.details.push({ cid, status: 'error', error: error instanceof Error ? error.message : 'Unknown error' });
        logger.error(`❌ Unpin failed for ${cid}: ${error}`);
      }
    }
    return results;
  }

  async runGarbageCollection(): Promise<any> {
    try {
      const removedItems: string[] = [];
      for await (const item of this.client.repo.gc()) {
        if (item.err) logger.warn(`⚠️ GC warning: ${item.cid} - ${item.err}`);
        else removedItems.push(item.cid.toString());
      }
      logger.info(`🗑️ Garbage collection removed ${removedItems.length} items`);
      return {
        success: true,
        removedItems: removedItems.length,
        items: removedItems,
        message: `Garbage collection completed - ${removedItems.length} items removed`
      };
    } catch (error) {
      logger.error('Garbage collection failed:', error);
      throw new Error(`Garbage collection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getStorageStats(): Promise<any> {
    try {
      const repoStat = await this.client.repo.stat();
      const count = async (type: string) => {
        let n = 0;
        for await (const _ of this.client.pin.ls({ type })) n++;
        return n;
      };
      const [recursive, direct, indirect] = [await count('recursive'), await count('direct'), await count('indirect')];
      // IPFS returns BigInt for large numbers, which JSON.stringify can't handle
      const big = (value: any) => (typeof value === 'bigint' ? value.toString() : value);

      return {
        repository: {
          size: big(repoStat.repoSize),
          numObjects: big(repoStat.numObjects),
          storageMax: big(repoStat.storageMax),
          version: repoStat.version,
          path: repoStat.repoPath
        },
        pins: { recursive, direct, indirect, total: recursive + direct + indirect },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to get storage stats:', error);
      throw new Error(`Failed to get storage stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
