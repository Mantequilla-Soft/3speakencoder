import sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';
import { logger } from './Logger.js';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface LocalPin {
  id?: number;
  hash: string;
  job_id?: string;
  content_type?: string;
  size_bytes?: number;
  pin_timestamp?: string;
  last_sync_attempt?: string;
  sync_attempts?: number;
  sync_status?: 'pending' | 'syncing' | 'synced' | 'failed';
  supernode_verified?: boolean;
  local_path?: string;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
}

export class LocalPinDatabase {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'local-pins.db');
  }

  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.dbPath);
      await fs.mkdir(dataDir, { recursive: true });

      // Open database
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // Create tables
      await this.createTables();
      
      logger.info(`📊 Local pin database initialized: ${this.dbPath}`);
    } catch (error) {
      logger.error('❌ Failed to initialize local pin database:', error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS local_pins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT UNIQUE NOT NULL,
        job_id TEXT,
        content_type TEXT,
        size_bytes INTEGER,
        pin_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_sync_attempt DATETIME,
        sync_attempts INTEGER DEFAULT 0,
        sync_status TEXT DEFAULT 'pending',
        supernode_verified BOOLEAN DEFAULT FALSE,
        local_path TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;

    const createIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_sync_status ON local_pins(sync_status);',
      'CREATE INDEX IF NOT EXISTS idx_hash ON local_pins(hash);',
      'CREATE INDEX IF NOT EXISTS idx_pin_timestamp ON local_pins(pin_timestamp);',
      'CREATE INDEX IF NOT EXISTS idx_job_id ON local_pins(job_id);'
    ];

    await this.db.exec(createTableSQL);
    
    for (const indexSQL of createIndexes) {
      await this.db.exec(indexSQL);
    }
  }

  async addLocalPin(pin: LocalPin): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.run(`
        INSERT OR REPLACE INTO local_pins (
          hash, job_id, content_type, size_bytes, local_path, metadata
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        pin.hash,
        pin.job_id || null,
        pin.content_type || 'unknown',
        pin.size_bytes || null,
        pin.local_path || null,
        pin.metadata || null
      ]);

      logger.info(`📝 Added local pin to database: ${pin.hash} (ID: ${result.lastID})`);
      return result.lastID as number;
    } catch (error) {
      logger.error(`❌ Failed to add local pin ${pin.hash}:`, error);
      throw error;
    }
  }

  async getPendingPins(limit: number = 100): Promise<LocalPin[]> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      // Get pins that are:
      // 1. Status = 'pending' (never tried)
      // 2. Status = 'failed' but with exponential backoff:
      //    - 1st failure: retry after 5 minutes
      //    - 2nd failure: retry after 1 hour  
      //    - 3rd failure: retry after 6 hours
      //    - 4th+ failure: retry after 24 hours
      const pins = await this.db.all(`
        SELECT * FROM local_pins 
        WHERE sync_status = 'pending'
           OR (sync_status = 'failed' AND (
             (sync_attempts = 1 AND datetime(last_sync_attempt, '+5 minutes') <= datetime('now')) OR
             (sync_attempts = 2 AND datetime(last_sync_attempt, '+1 hour') <= datetime('now')) OR
             (sync_attempts = 3 AND datetime(last_sync_attempt, '+6 hours') <= datetime('now')) OR
             (sync_attempts >= 4 AND datetime(last_sync_attempt, '+24 hours') <= datetime('now'))
           ))
        ORDER BY pin_timestamp ASC 
        LIMIT ?
      `, [limit]);

      return pins;
    } catch (error) {
      logger.error('❌ Failed to get pending pins:', error);
      throw error;
    }
  }

  async getPin(hash: string): Promise<LocalPin | null> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const pin = await this.db.get(`
        SELECT * FROM local_pins 
        WHERE hash = ?
      `, [hash]);

      return pin || null;
    } catch (error) {
      logger.error(`❌ Failed to get pin ${hash}:`, error);
      throw error;
    }
  }

  async updateSyncStatus(hash: string, status: LocalPin['sync_status'], error?: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const metadata = error ? JSON.stringify({ last_error: error }) : null;
      
      await this.db.run(`
        UPDATE local_pins 
        SET sync_status = ?, 
            last_sync_attempt = CURRENT_TIMESTAMP,
            sync_attempts = sync_attempts + 1,
            metadata = COALESCE(?, metadata),
            updated_at = CURRENT_TIMESTAMP
        WHERE hash = ?
      `, [status, metadata, hash]);

      logger.info(`📊 Updated sync status for ${hash}: ${status}`);
    } catch (error) {
      logger.error(`❌ Failed to update sync status for ${hash}:`, error);
      throw error;
    }
  }

  async markSynced(hash: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      await this.db.run(`
        UPDATE local_pins 
        SET sync_status = 'synced',
            supernode_verified = TRUE,
            updated_at = CURRENT_TIMESTAMP
        WHERE hash = ?
      `, [hash]);

      logger.info(`✅ Marked ${hash} as synced to supernode`);
    } catch (error) {
      logger.error(`❌ Failed to mark ${hash} as synced:`, error);
      throw error;
    }
  }

  async getStats(): Promise<{ total: number; pending: number; synced: number; failed: number }> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const stats = await this.db.get(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN sync_status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN sync_status = 'synced' THEN 1 ELSE 0 END) as synced,
          SUM(CASE WHEN sync_status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM local_pins
      `);

      return stats || { total: 0, pending: 0, synced: 0, failed: 0 };
    } catch (error) {
      logger.error('❌ Failed to get pin stats:', error);
      throw error;
    }
  }

  async cleanupSynced(olderThanDays: number = 7): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.run(`
        DELETE FROM local_pins 
        WHERE sync_status = 'synced' 
        AND supernode_verified = TRUE
        AND updated_at < datetime('now', '-${olderThanDays} days')
      `);

      const deletedCount = result.changes || 0;
      if (deletedCount > 0) {
        logger.info(`🧹 Cleaned up ${deletedCount} old synced pins`);
      }

      return deletedCount;
    } catch (error) {
      logger.error('❌ Failed to cleanup synced pins:', error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      logger.info('📊 Local pin database closed');
    }
  }
}