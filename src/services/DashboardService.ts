import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { logger } from './Logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DashboardEvent {
  type: 'status' | 'job' | 'log' | 'config';
  data: any;
  timestamp: string;
}

export class DashboardService {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer;
  private port: number;
  private clients: Set<any> = new Set();
  private encoder: any; // Reference to encoder for maintenance operations
  private nodeStatus: any = {
    online: false,
    registered: false,
    didKey: '',
    ipfsPeerId: '',
    activeJobs: 0,
    totalJobs: 0,
    lastJobCheck: null,
    versionInfo: {
      current: 'unknown'
    }
  };
  private activeJobs: Map<string, any> = new Map();
  private jobHistory: any[] = [];
  private failedJobs: any[] = [];

  constructor(port: number = 3001) {
    this.port = port;
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    
    this.setupExpress();
    this.setupWebSocket();
  }

  private setupExpress(): void {
    // Serve static files
    this.app.use(express.static(path.join(__dirname, '../dashboard')));
    
    // API endpoints
    this.app.get('/api/status', (req, res) => {
      const config = this.encoder ? (this.encoder as any).config : null;
      res.json({
        ...this.nodeStatus,
        activeJobDetails: Array.from(this.activeJobs.values()),
        recentJobs: this.jobHistory.slice(-10),
        config: config ? {
          ipfs: {
            enable_local_fallback: config.ipfs?.enable_local_fallback || false
          }
        } : null
      });
    });

    this.app.get('/api/jobs', (req, res) => {
      res.json({
        active: Array.from(this.activeJobs.values()),
        recent: this.jobHistory.slice(-20)
      });
    });

    this.app.get('/api/failed-jobs', (req, res) => {
      res.json({
        failed: this.failedJobs
      });
    });

    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Maintenance endpoint to release stuck jobs
    this.app.post('/api/maintenance/release-job/:jobId', express.json(), async (req, res) => {
      const jobId = req.params.jobId;
      try {
        if (this.encoder) {
          await this.encoder.releaseStuckJob(jobId);
          res.json({ success: true, message: `Job ${jobId} release initiated` });
        } else {
          res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to release stuck job:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Retry failed job endpoint
    this.app.post('/api/retry-job/:jobId', express.json(), async (req, res) => {
      const jobId = req.params.jobId;
      try {
        if (this.encoder) {
          await this.encoder.releaseStuckJob(jobId);
          // Remove from failed jobs list
          this.failedJobs = this.failedJobs.filter(job => job.id !== jobId);
          res.json({ success: true, message: `Job ${jobId} retry initiated` });
        } else {
          res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to retry job:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../dashboard/index.html'));
    });

    // ===========================================
    // IPFS STORAGE ADMINISTRATION ENDPOINTS
    // ===========================================

    // Check if storage admin is enabled and authenticate password
    this.app.post('/api/storage-admin/auth', express.json(), (req, res) => {
      const { password } = req.body;

      try {
        if (this.encoder) {
          const config = (this.encoder as any).config;

          // ✅ FIXED: Check if local fallback is enabled (not MongoDB)
          // Storage management should work for any node with local IPFS
          if (!config.ipfs?.enable_local_fallback) {
            return res.status(403).json({
              error: 'Storage administration requires local IPFS enabled (set ENABLE_LOCAL_FALLBACK=true)'
            });
          }

          // Check if storage admin password is configured
          if (!config.storage_admin?.password) {
            return res.status(403).json({
              error: 'Storage administration not configured - contact 3Speak team'
            });
          }

          // Authenticate password
          if (password !== config.storage_admin.password) {
            return res.status(401).json({
              error: 'Invalid password'
            });
          }

          return res.json({
            success: true,
            message: 'Authentication successful',
            features: ['pins', 'migrate', 'unpin', 'gc', 'stats']
          });
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Storage admin auth error:', error);
        return res.status(500).json({ error: 'Authentication failed' });
      }
    });

    // List all pinned items with metadata
    this.app.get('/api/storage-admin/pins', async (req, res) => {
      const authPassword = req.headers['x-storage-password'] as string;

      try {
        if (this.encoder) {
          const config = (this.encoder as any).config;

          // Verify authentication
          if (!config.storage_admin?.password || authPassword !== config.storage_admin.password) {
            return res.status(401).json({ error: 'Authentication required' });
          }

          const pins = await this.encoder.getPinnedItems();
          return res.json({ pins, count: pins.length });
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to list pinned items:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Get details about a specific pin
    this.app.get('/api/storage-admin/pins/:cid', async (req, res) => {
      const { cid } = req.params;
      const authPassword = req.headers['x-storage-password'] as string;

      try {
        if (this.encoder) {
          const config = (this.encoder as any).config;

          // Verify authentication
          if (!config.storage_admin?.password || authPassword !== config.storage_admin.password) {
            return res.status(401).json({ error: 'Authentication required' });
          }

          const pinDetails = await this.encoder.getPinDetails(cid);
          return res.json(pinDetails);
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to get pin details:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Migrate pins to supernode
    this.app.post('/api/storage-admin/migrate', express.json(), async (req, res) => {
      const { cids } = req.body;
      const authPassword = req.headers['x-storage-password'] as string;

      if (!Array.isArray(cids) || cids.length === 0) {
        return res.status(400).json({ error: 'CID array is required' });
      }

      try {
        if (this.encoder) {
          const config = (this.encoder as any).config;

          // Verify authentication
          if (!config.storage_admin?.password || authPassword !== config.storage_admin.password) {
            return res.status(401).json({ error: 'Authentication required' });
          }

          const result = await this.encoder.migratePinsToSupernode(cids);
          return res.json(result);
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to migrate pins:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Unpin items locally
    this.app.post('/api/storage-admin/unpin', express.json(), async (req, res) => {
      const { cids } = req.body;
      const authPassword = req.headers['x-storage-password'] as string;

      if (!Array.isArray(cids) || cids.length === 0) {
        return res.status(400).json({ error: 'CID array is required' });
      }

      try {
        if (this.encoder) {
          const config = (this.encoder as any).config;

          // Verify authentication
          if (!config.storage_admin?.password || authPassword !== config.storage_admin.password) {
            return res.status(401).json({ error: 'Authentication required' });
          }

          const result = await this.encoder.unpinItemsLocally(cids);
          return res.json(result);
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to unpin items:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Run garbage collection
    this.app.post('/api/storage-admin/gc', async (req, res) => {
      const authPassword = req.headers['x-storage-password'] as string;

      try {
        if (this.encoder) {
          const config = (this.encoder as any).config;

          // Verify authentication
          if (!config.storage_admin?.password || authPassword !== config.storage_admin.password) {
            return res.status(401).json({ error: 'Authentication required' });
          }

          const result = await this.encoder.runGarbageCollection();
          return res.json(result);
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to run garbage collection:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Get storage statistics
    this.app.get('/api/storage-admin/stats', async (req, res) => {
      const authPassword = req.headers['x-storage-password'] as string;

      try {
        if (this.encoder) {
          const config = (this.encoder as any).config;

          // Verify authentication
          if (!config.storage_admin?.password || authPassword !== config.storage_admin.password) {
            return res.status(401).json({ error: 'Authentication required' });
          }

          const stats = await this.encoder.getStorageStats();
          return res.json(stats);
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to get storage stats:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logger.info('📱 Dashboard client connected');
      
      // Send current status to new client
      this.sendToClient(ws, {
        type: 'status',
        data: this.nodeStatus,
        timestamp: new Date().toISOString()
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('📱 Dashboard client disconnected');
      });

      ws.on('error', (error) => {
        logger.warn('📱 Dashboard WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }

  private sendToClient(client: any, event: DashboardEvent): void {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(JSON.stringify(event));
      } catch (error) {
        logger.warn('📱 Failed to send to dashboard client:', error);
        this.clients.delete(client);
      }
    }
  }

  private broadcast(event: DashboardEvent): void {
    this.clients.forEach(client => {
      this.sendToClient(client, event);
    });
  }

  // Public methods for encoder to call
  updateNodeStatus(status: Partial<typeof this.nodeStatus>): void {
    this.nodeStatus = { ...this.nodeStatus, ...status };
    this.broadcast({
      type: 'status',
      data: this.nodeStatus,
      timestamp: new Date().toISOString()
    });
  }

  updateJobStatus(jobData: any): void {
    this.broadcast({
      type: 'job',
      data: jobData,
      timestamp: new Date().toISOString()
    });
  }

  sendLog(level: string, message: string, meta?: any): void {
    this.broadcast({
      type: 'log',
      data: { level, message, meta },
      timestamp: new Date().toISOString()
    });
  }

  // Job tracking methods
  startJob(jobId: string, jobData: any): void {
    const job = {
      id: jobId,
      ...jobData,
      status: 'processing',
      startTime: new Date().toISOString(),
      progress: 0
    };
    
    this.activeJobs.set(jobId, job);
    this.updateJobStatus(job);
    
    // Update active jobs count
    this.updateNodeStatus({ activeJobs: this.activeJobs.size });
  }

  updateJobProgress(jobId: string, progress: number, status?: string, details?: any): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.progress = progress;
      if (status) job.status = status;
      if (details) job.details = { ...job.details, ...details };
      job.lastUpdate = new Date().toISOString();
      
      this.activeJobs.set(jobId, job);
      this.updateJobStatus(job);
    }
  }

  completeJob(jobId: string, result?: any): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.status = 'completed';
      job.endTime = new Date().toISOString();
      job.progress = 100;
      if (result) job.result = result;
      
      // Move to history
      this.jobHistory.unshift(job);
      if (this.jobHistory.length > 50) {
        this.jobHistory = this.jobHistory.slice(0, 50);
      }
      
      this.activeJobs.delete(jobId);
      this.updateJobStatus(job);
      
      // Update active jobs count
      this.updateNodeStatus({ activeJobs: this.activeJobs.size });
    }
  }

  failJob(jobId: string, error: string): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = error;
      job.endTime = new Date().toISOString();
      job.retryable = this.isRetryableError(error);
      job.retryCount = job.retryCount || 0;
      
      // 🏃‍♂️ Check if this is a race condition (job claimed by another encoder)
      const isRaceCondition = error.includes('RACE_CONDITION_SKIP') ||
                             error.includes('no longer available') ||
                             error.includes('already assigned') ||
                             error.includes('Job assigned to another encoder') ||
                             error.includes('assigned to another encoder');
      
      // Only add to failed jobs list if it's NOT a race condition
      if (!isRaceCondition) {
        // Add to failed jobs list (keep last 20)
        this.failedJobs.unshift({
          id: jobId,
          videoId: job.video_id || job.id,
          error: error,
          timestamp: job.endTime,
          retryable: job.retryable,
          retryCount: job.retryCount
        });
        if (this.failedJobs.length > 20) {
          this.failedJobs = this.failedJobs.slice(0, 20);
        }
        
        // Broadcast failed jobs update only for real failures
        this.broadcast({
          type: 'job',
          data: {
            action: 'failed_jobs_updated',
            failedJobs: this.failedJobs
          },
          timestamp: new Date().toISOString()
        });
      } else {
        // Race condition - log but don't add to failed jobs
        console.log(`🏃‍♂️ RACE_CONDITION_SKIP: Job ${jobId} claimed by another encoder - not adding to failed jobs list`);
      }
      
      // Move to history regardless of race condition status
      this.jobHistory.unshift(job);
      if (this.jobHistory.length > 50) {
        this.jobHistory = this.jobHistory.slice(0, 50);
      }
      
      this.activeJobs.delete(jobId);
      this.updateJobStatus(job);
      
      // Update active jobs count
      this.updateNodeStatus({ activeJobs: this.activeJobs.size });
    }
  }

  private isRetryableError(error: string): boolean {
    const retryablePatterns = [
      '500', '502', '503', '504',           // Server errors
      'network', 'timeout', 'connection',   // Network issues
      'ECONNREFUSED', 'ENOTFOUND',          // Connection errors
    ];
    const errorLower = error.toLowerCase();
    return retryablePatterns.some(pattern => errorLower.includes(pattern));
  }

  private getErrorStatusMessage(error: string, retryAttempt?: number, maxRetries?: number): string {
    const is500Error = error.includes('500') || error.includes('Internal Server Error');
    const isGatewayError = error.includes('502') || error.includes('503') || error.includes('504');
    
    if (is500Error || isGatewayError) {
      const retryText = retryAttempt && maxRetries ? ` (retry ${retryAttempt}/${maxRetries})` : '';
      return `Gateway Issue${retryText} - Usually resolves automatically`;
    }
    
    return error;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        logger.info(`📊 Dashboard server running at http://localhost:${this.port}`);
        resolve();
      }).on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close();
      this.server.close(() => {
        logger.info('📊 Dashboard server stopped');
        resolve();
      });
    });
  }

  setEncoder(encoder: any): void {
    this.encoder = encoder;
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }
}