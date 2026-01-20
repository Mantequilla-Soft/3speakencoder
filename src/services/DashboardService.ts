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
    gatewayStats: null
  };
  private activeJobs: Map<string, any> = new Map();
  private jobHistory: any[] = [];
  private failedJobs: any[] = [];
  private availableJobs: any[] = [];
  private gatewayConnected: boolean = false;
  
  // 🔒 SECURITY: Rate limiting for force processing
  private forceProcessAttempts: Map<string, number[]> = new Map();

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
        gatewayStatus: {
          connected: this.gatewayConnected,
          stats: this.nodeStatus.gatewayStats
        },
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
        recent: this.jobHistory.slice(-20),
        available: this.availableJobs,
        gateway: {
          connected: this.gatewayConnected,
          stats: this.nodeStatus.gatewayStats
        }
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

    // Manual job processing endpoint
    this.app.post('/api/manual-job', express.json(), async (req, res) => {
      const { jobId } = req.body;
      if (!jobId) {
        return res.status(400).json({ error: 'Job ID is required' });
      }
      try {
        if (this.encoder) {
          await this.encoder.processManualJob(jobId);
          return res.json({ success: true, message: `Manual processing of job ${jobId} initiated` });
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to process manual job:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Force processing endpoint - bypasses gateway completely
    this.app.post('/api/force-process-job', express.json(), async (req, res) => {
      const { jobId } = req.body;
      
      // 🔒 SECURITY: Validate job ID format
      if (!jobId) {
        return res.status(400).json({ error: 'Job ID is required' });
      }
      
      if (typeof jobId !== 'string' || jobId.length < 10 || jobId.length > 100) {
        return res.status(400).json({ error: 'Invalid job ID format' });
      }
      
      // 🔒 SECURITY: Basic sanitization - prevent injection attacks
      const sanitizedJobId = jobId.replace(/[^a-zA-Z0-9\-_]/g, '');
      if (sanitizedJobId !== jobId) {
        return res.status(400).json({ error: 'Job ID contains invalid characters' });
      }
      
      // 🔒 SECURITY: Rate limiting - max 3 force processing attempts per hour per IP
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const now = Date.now();
      const hourAgo = now - (60 * 60 * 1000);
      
      // Clean old attempts and get current attempts for this IP
      if (this.forceProcessAttempts.has(clientIP)) {
        const attempts = this.forceProcessAttempts.get(clientIP)!.filter(time => time > hourAgo);
        this.forceProcessAttempts.set(clientIP, attempts);
        
        if (attempts.length >= 3) {
          logger.warn(`🚨 RATE_LIMIT: IP ${clientIP} exceeded force processing limit (3/hour)`);
          return res.status(429).json({ 
            error: 'Rate limit exceeded. Maximum 3 force processing attempts per hour.' 
          });
        }
      }
      
      // Record this attempt
      const attempts = this.forceProcessAttempts.get(clientIP) || [];
      attempts.push(now);
      this.forceProcessAttempts.set(clientIP, attempts);
      
      try {
        if (this.encoder) {
          await this.encoder.forceProcessJob(jobId);
          return res.json({ 
            success: true, 
            message: `Force processing of job ${jobId} completed successfully! Video should now be published.` 
          });
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to force process job:', error);
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        
        // Check if it's a MongoDB access error
        if (errorMsg.includes('MongoDB access') || errorMsg.includes('not enabled')) {
          return res.status(403).json({ 
            error: 'Force processing requires MongoDB access - only available for 3Speak infrastructure nodes' 
          });
        }
        
        return res.status(500).json({ error: errorMsg });
      }
    });

    // MongoDB status endpoint - for checking force processing availability
    this.app.get('/api/mongodb-status', (req, res) => {
      try {
        if (this.encoder) {
          const mongoStatus = (this.encoder as any).mongoVerifier.getStatus();
          return res.json({
            enabled: mongoStatus.enabled,
            connected: mongoStatus.connected,
            databaseName: mongoStatus.databaseName
          });
        } else {
          return res.json({ enabled: false, connected: false });
        }
      } catch (error) {
        logger.error('Failed to get MongoDB status:', error);
        return res.json({ enabled: false, connected: false });
      }
    });

    // Job status update endpoint - check MongoDB for real job status
    this.app.get('/api/check-job-status/:jobId', async (req, res) => {
      const { jobId } = req.params;
      
      // 🔒 SECURITY: Validate job ID format (same as force processing)
      if (!jobId) {
        return res.status(400).json({ error: 'Job ID is required' });
      }
      
      if (typeof jobId !== 'string' || jobId.length < 10 || jobId.length > 100) {
        return res.status(400).json({ error: 'Invalid job ID format' });
      }
      
      // 🔒 SECURITY: Basic sanitization - prevent injection attacks
      const sanitizedJobId = jobId.replace(/[^a-zA-Z0-9\-_]/g, '');
      if (sanitizedJobId !== jobId) {
        return res.status(400).json({ error: 'Job ID contains invalid characters' });
      }
      
      try {
        if (this.encoder) {
          const statusUpdate = await this.encoder.checkJobStatusUpdate(jobId);
          return res.json(statusUpdate);
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to check job status:', error);
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        
        // Check if it's a MongoDB access error
        if (errorMsg.includes('MongoDB access') || errorMsg.includes('not enabled')) {
          return res.status(403).json({ 
            error: 'Job status updates require MongoDB access - only available for 3Speak infrastructure nodes' 
          });
        }
        
        return res.status(500).json({ error: errorMsg });
      }
    });

    // Manual job completion endpoint - for jobs that are processed but failed to report
    this.app.post('/api/manual-complete', express.json(), async (req, res) => {
      const { jobId, result } = req.body;
      if (!jobId || !result) {
        return res.status(400).json({ error: 'Job ID and result are required' });
      }
      try {
        if (this.encoder) {
          await this.encoder.manualCompleteJob(jobId, result);
          return res.json({ success: true, message: `Job ${jobId} manually completed` });
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to manually complete job:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Available gateway jobs endpoint - shows unassigned and running jobs
    this.app.get('/api/available-gateway-jobs', async (req, res) => {
      try {
        if (this.encoder) {
          const mongoVerifier = (this.encoder as any).mongoVerifier;
          if (!mongoVerifier || !mongoVerifier.isEnabled()) {
            return res.status(403).json({ 
              error: 'Available gateway jobs require MongoDB access - only available for 3Speak infrastructure nodes' 
            });
          }
          
          const availableJobs = await mongoVerifier.getAvailableGatewayJobs();
          return res.json({ jobs: availableJobs, count: availableJobs.length });
        } else {
          return res.status(503).json({ error: 'Encoder not available' });
        }
      } catch (error) {
        logger.error('Failed to fetch available gateway jobs:', error);
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
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

  updateAvailableJobs(jobs: any[]): void {
    this.availableJobs = jobs.map(job => ({
      id: job.id,
      video_id: job.metadata?.video_permlink || job.id,
      input_uri: job.input?.uri || 'unknown',
      profiles: job.profiles?.map((p: any) => p.name) || ['unknown'],
      created_at: job.created_at,
      status: job.status || 'available',
      size: job.input?.size || 0
    }));

    this.broadcast({
      type: 'job',
      data: {
        action: 'available_jobs_updated',
        availableJobs: this.availableJobs
      },
      timestamp: new Date().toISOString()
    });
  }

  updateGatewayStatus(connected: boolean, stats?: any): void {
    this.gatewayConnected = connected;
    if (stats) {
      this.nodeStatus.gatewayStats = stats;
    }

    this.broadcast({
      type: 'status',
      data: {
        action: 'gateway_status_updated',
        connected: this.gatewayConnected,
        stats: this.nodeStatus.gatewayStats
      },
      timestamp: new Date().toISOString()
    });
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