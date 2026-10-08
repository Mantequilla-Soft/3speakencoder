import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { logger } from './Logger.js';
import type { EncoderConfig } from '../config/ConfigLoader.js';

export interface PendingPin {
  hash: string;
  job_id: string;
  added_at: string;
  attempts: number;
  last_attempt: string | null;
  size_mb: number;
  type: 'file' | 'directory';
}

export interface PendingPinData {
  pending_pins: PendingPin[];
  last_cleanup: string;
}

/**
 * 🔄 Lazy Pinning Service
 * Manages a queue of content that needs to be pinned when the encoder is idle
 */
export class PendingPinService {
  private filePath: string;
  private lockPath: string;
  private maxEntries: number = 1000; // Prevent file from growing too large
  private maxAttempts: number = 3;
  private retryDelayMs: number = 5 * 60 * 1000; // 5 minutes between retries
  private config: EncoderConfig;
  private ipfsClient: any; // We'll inject this if needed

  constructor(dataDir: string = './data', config?: EncoderConfig, ipfsClient?: any) {
    this.filePath = join(dataDir, 'pending_pins.json');
    this.lockPath = join(dataDir, 'pending_pins.lock');
    this.config = config!;
    this.ipfsClient = ipfsClient;
  }

  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      const dataDir = dirname(this.filePath);
      await fs.mkdir(dataDir, { recursive: true });

      // Create empty file if it doesn't exist
      try {
        await fs.access(this.filePath);
      } catch {
        await this.writeData({ pending_pins: [], last_cleanup: new Date().toISOString() });
        logger.info('📋 Initialized pending pins file');
      }

      // Clean up any stale lock file on startup
      try {
        await fs.unlink(this.lockPath);
        logger.info('🔓 Removed stale lock file');
      } catch {
        // Lock file doesn't exist, that's fine
      }

      logger.info('🔄 PendingPinService initialized');
    } catch (error) {
      logger.error('❌ Failed to initialize PendingPinService:', error);
      throw error;
    }
  }

  /**
   * Add a hash to the pending pin queue
   */
  async addPendingPin(hash: string, jobId: string, sizeMB: number, type: 'file' | 'directory'): Promise<void> {
    await this.withLock(async () => {
      const data = await this.readData();
      
      // Check if hash already exists
      const existing = data.pending_pins.find(p => p.hash === hash);
      if (existing) {
        logger.debug(`📋 Hash ${hash} already in pending pins queue`);
        return;
      }

      // Add new pending pin
      const pendingPin: PendingPin = {
        hash,
        job_id: jobId,
        added_at: new Date().toISOString(),
        attempts: 0,
        last_attempt: null,
        size_mb: sizeMB,
        type
      };

      data.pending_pins.push(pendingPin);

      // Limit file size by removing oldest entries if needed
      if (data.pending_pins.length > this.maxEntries) {
        const removed = data.pending_pins.splice(0, data.pending_pins.length - this.maxEntries);
        logger.warn(`📋 Removed ${removed.length} old pending pins to limit file size`);
      }

      await this.writeData(data);
      logger.info(`📋 Added ${type} to pending pins: ${hash} (${sizeMB.toFixed(1)}MB)`);
    });
  }

  /**
   * Get the next hash to pin (oldest first, but skip recently failed ones)
   */
  async getNextPendingPin(): Promise<PendingPin | null> {
    return await this.withLock(async () => {
      const data = await this.readData();
      const now = new Date();

      // Find oldest entry that hasn't exceeded max attempts and isn't in retry delay
      for (const pin of data.pending_pins) {
        // Skip if max attempts reached
        if (pin.attempts >= this.maxAttempts) {
          continue;
        }

        // Skip if recently attempted (within retry delay)
        if (pin.last_attempt) {
          const lastAttempt = new Date(pin.last_attempt);
          const timeSinceAttempt = now.getTime() - lastAttempt.getTime();
          if (timeSinceAttempt < this.retryDelayMs) {
            continue;
          }
        }

        return pin;
      }

      return null;
    });
  }

  /**
   * Mark a pin attempt as successful and remove from queue
   */
  async markPinSuccessful(hash: string): Promise<void> {
    await this.withLock(async () => {
      const data = await this.readData();
      const index = data.pending_pins.findIndex(p => p.hash === hash);
      
      if (index !== -1) {
        const pin = data.pending_pins[index];
        data.pending_pins.splice(index, 1);
        await this.writeData(data);
        logger.info(`✅ Lazy pin successful, removed from queue: ${hash} (${pin?.size_mb?.toFixed(1) || 'unknown'}MB)`);
      } else {
        logger.debug(`📋 Hash ${hash} not found in pending pins queue (already processed?)`);
      }
    });
  }

  /**
   * Mark a pin attempt as failed and update retry info
   */
  async markPinFailed(hash: string, error: string): Promise<void> {
    await this.withLock(async () => {
      const data = await this.readData();
      const pin = data.pending_pins.find(p => p.hash === hash);
      
      if (pin) {
        pin.attempts++;
        pin.last_attempt = new Date().toISOString();

        if (pin.attempts >= this.maxAttempts) {
          // Remove permanently failed pins
          const index = data.pending_pins.indexOf(pin);
          data.pending_pins.splice(index, 1);
          logger.warn(`❌ Lazy pin failed permanently after ${this.maxAttempts} attempts: ${hash} - ${error}`);
          
          // 🏠 Try local fallback if enabled - THIS IS THE KEY ENHANCEMENT!
          if (this.config?.ipfs?.enable_local_fallback && this.ipfsClient) {
            await this.tryLocalFallbackForFailedLazyPin(hash, pin);
          } else {
            logger.info(`💾 Content ${hash} lost - no local fallback enabled. Enable ENABLE_LOCAL_FALLBACK=true for database archival.`);
          }
        } else {
          logger.warn(`⚠️ Lazy pin attempt ${pin.attempts}/${this.maxAttempts} failed: ${hash} - ${error}`);
        }

        await this.writeData(data);
      }
    });
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{ total: number, byType: Record<string, number>, totalSizeMB: number }> {
    const data = await this.readData();
    const stats = {
      total: data.pending_pins.length,
      byType: {} as Record<string, number>,
      totalSizeMB: 0
    };

    for (const pin of data.pending_pins) {
      stats.byType[pin.type] = (stats.byType[pin.type] || 0) + 1;
      stats.totalSizeMB += pin.size_mb;
    }

    return stats;
  }

  /**
   * Clean up old entries periodically
   */
  async cleanup(): Promise<void> {
    await this.withLock(async () => {
      const data = await this.readData();
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      const originalCount = data.pending_pins.length;
      data.pending_pins = data.pending_pins.filter(pin => {
        const addedAt = new Date(pin.added_at);
        return addedAt > oneWeekAgo; // Keep entries newer than 1 week
      });

      const removedCount = originalCount - data.pending_pins.length;
      if (removedCount > 0) {
        data.last_cleanup = new Date().toISOString();
        await this.writeData(data);
        logger.info(`🧹 Cleaned up ${removedCount} old pending pins (older than 1 week)`);
      }
    });
  }

  /**
   * Thread-safe file operations using lock file
   */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const maxWaitMs = 30000; // 30 second timeout
    const checkIntervalMs = 100;
    const startTime = Date.now();

    // Wait for lock to be available
    while (Date.now() - startTime < maxWaitMs) {
      try {
        // Try to create lock file (atomic operation)
        await fs.writeFile(this.lockPath, process.pid.toString(), { flag: 'wx' });
        break;
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // Lock exists, check if the process is still running
          try {
            const lockPid = await fs.readFile(this.lockPath, 'utf8');
            const pid = parseInt(lockPid.trim());
            
            // Check if process still exists
            try {
              process.kill(pid, 0); // Signal 0 just checks if process exists
              // Process exists, wait a bit
              await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
              continue;
            } catch {
              // Process doesn't exist, remove stale lock
              await fs.unlink(this.lockPath);
              logger.warn('🔓 Removed stale lock file from dead process');
            }
          } catch {
            // Can't read lock file, try to remove it
            try {
              await fs.unlink(this.lockPath);
            } catch {
              // Ignore errors removing lock file
            }
          }
        } else {
          throw error;
        }
      }
    }

    // Check if we got the lock
    try {
      await fs.access(this.lockPath);
    } catch {
      throw new Error('Failed to acquire lock for pending pins file');
    }

    try {
      // Execute the operation
      return await operation();
    } finally {
      // Always release the lock
      try {
        await fs.unlink(this.lockPath);
      } catch {
        // Ignore errors releasing lock
      }
    }
  }

  /**
   * Get statistics about pending pins
   */
  async getStats(): Promise<{ totalPending: number; totalSize: number; oldestDate: Date | null }> {
    return this.withLock(async () => {
      const data = await this.readData();
      
      if (data.pending_pins.length === 0) {
        return { totalPending: 0, totalSize: 0, oldestDate: null };
      }
      
      const totalSize = data.pending_pins.reduce((sum, pin) => sum + pin.size_mb, 0);
      const oldestPin = data.pending_pins.reduce((oldest, pin) => 
        new Date(pin.added_at) < new Date(oldest.added_at) ? pin : oldest
      );
      
      return {
        totalPending: data.pending_pins.length,
        totalSize: totalSize,
        oldestDate: new Date(oldestPin.added_at)
      };
    });
  }

  private async readData(): Promise<PendingPinData> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      // Return empty data if file doesn't exist or is corrupted
      logger.warn('⚠️ Could not read pending pins file, creating new one');
      const emptyData: PendingPinData = {
        pending_pins: [],
        last_cleanup: new Date().toISOString()
      };
      await this.writeData(emptyData);
      return emptyData;
    }
  }

  private async writeData(data: PendingPinData): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await fs.writeFile(this.filePath, content, 'utf8');
  }

  /**
   * 🏠 LOCAL FALLBACK: Try to pin locally when lazy pinning fails permanently
   * This creates a database of locally pinned content for batch processing later
   */
  private async tryLocalFallbackForFailedLazyPin(hash: string, pin: PendingPin): Promise<void> {
    try {
      logger.info(`🏠 LAZY PIN FALLBACK: Trying local pin for permanently failed lazy pin: ${hash}`);
      
      // Pin to local IPFS daemon
      await this.ipfsClient.pin.add(hash);
      
      // Log to database for batch processing later
      await this.logLocalFallbackPin(hash, pin);
      
      logger.info(`✅ LAZY PIN FALLBACK: Successfully pinned ${hash} locally (${pin.size_mb.toFixed(1)}MB)`);
      logger.info(`💾 DATABASE: Content archived locally for batch processing on permanent server`);
      
    } catch (localError: any) {
      logger.error(`❌ LAZY PIN FALLBACK: Local pin also failed for ${hash}: ${localError.message}`);
      logger.error(`💔 CONTENT LOST: ${hash} (${pin.size_mb.toFixed(1)}MB) - no remaining fallback options`);
    }
  }

  /**
   * 📝 Log locally pinned content to database file for batch processing
   */
  private async logLocalFallbackPin(hash: string, pin: PendingPin): Promise<void> {
    try {
      const logDir = dirname(this.filePath);
      const logFile = join(logDir, 'local-fallback-pins.jsonl');
      
      const logEntry = {
        hash,
        job_id: pin.job_id,
        size_mb: pin.size_mb,
        type: pin.type,
        failed_lazy_attempts: pin.attempts,
        local_pin_timestamp: new Date().toISOString(),
        source: 'failed_lazy_pin_fallback',
        node_id: process.env.NODE_NAME || 'unknown'
      };
      
      const logLine = JSON.stringify(logEntry) + '\n';
      await fs.appendFile(logFile, logLine, 'utf8');
      
      logger.info(`📝 BATCH DATABASE: Logged ${hash} to local-fallback-pins.jsonl for batch processing`);
      
    } catch (error: any) {
      logger.error(`❌ Failed to log local fallback pin: ${error.message}`);
    }
  }
}