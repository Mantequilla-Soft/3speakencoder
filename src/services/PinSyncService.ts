import { LocalPinDatabase, LocalPin } from './LocalPinDatabase.js';
import { logger } from './Logger.js';
import { EncoderConfig } from '../config/ConfigLoader.js';
import type { IPFSService } from './IPFSService.js';

/**
 * Lazy migration of local fallback pins: every few minutes, re-upload pending ones to a
 * hotnode (via the traffic director), one at a time. Failed attempts back off (see
 * LocalPinDatabase.getPendingPins). Only runs when ENABLE_LOCAL_FALLBACK=true.
 */
export class PinSyncService {
  private database: LocalPinDatabase;
  private config: EncoderConfig;
  private ipfs: IPFSService;
  private isRunning: boolean = false;
  private isSyncing: boolean = false;
  private syncInterval: NodeJS.Timeout | null = null;
  private readonly SYNC_INTERVAL_MS = 5 * 60 * 1000;

  constructor(config: EncoderConfig, database: LocalPinDatabase, ipfs: IPFSService) {
    this.config = config;
    this.database = database;
    this.ipfs = ipfs;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // A crash or restart mid-upload leaves rows at "syncing"; retry them
    const interrupted = await this.database.resetInterrupted();
    if (interrupted > 0) logger.info(`🔄 ${interrupted} interrupted migration(s) queued again`);

    void this.performSync();
    this.syncInterval = setInterval(() => void this.performSync(), this.SYNC_INTERVAL_MS);
    logger.info(`✅ Local pin migration to hotnodes started (every ${this.SYNC_INTERVAL_MS / 60000} min)`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = null;
    logger.info('⏹️ Local pin migration stopped');
  }

  /** One pass: migrate due pins one at a time. Never overlaps with itself. */
  async performSync(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;
    try {
      const due = await this.database.getPendingPins(10);
      if (due.length === 0) return;
      logger.info(`🔄 Migrating ${due.length} local pin(s) to hotnodes`);
      for (const pin of due) {
        if (!this.isRunning) break;
        await this.migrate(pin);
      }
      await this.database.cleanupSynced(7);
    } catch (error) {
      logger.error('❌ Local pin migration pass failed:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  private async migrate(pin: LocalPin): Promise<void> {
    await this.database.markSyncing(pin.hash);
    const result = await this.ipfs.migrateToHotnode(pin.hash);

    if (!result.success) {
      logger.warn(`⚠️ Migration of ${pin.hash} failed, will retry later: ${result.error}`);
      await this.database.updateSyncStatus(pin.hash, 'failed', result.error);
      return;
    }

    await this.database.markSynced(pin.hash);
    logger.info(`✅ Migrated ${pin.hash} to ${result.endpoint}`);

    if (this.config.ipfs?.remove_local_after_sync) {
      try {
        await this.ipfs.getClient().pin.rm(pin.hash);
        logger.info(`🗑️ Removed local pin ${pin.hash} (REMOVE_LOCAL_AFTER_SYNC=true)`);
      } catch (error: any) {
        logger.warn(`⚠️ Could not remove local pin ${pin.hash}: ${error.message}`);
      }
    }
  }

  async getStats(): Promise<any> {
    return await this.database.getStats();
  }
}
