import { EncoderConfig } from '../config/ConfigLoader.js';
import { VideoJob, JobStatus, EncodingProgress, VideoProfile } from '../types/index.js';
import { logger } from './Logger.js';
import { GatewayClient } from './GatewayClient.js';
import { VideoProcessor } from './VideoProcessor.js';
import { IPFSService } from './IPFSService.js';
import { IdentityService } from './IdentityService.js';
import { DashboardService } from './DashboardService.js';
import { DirectApiService } from './DirectApiService.js';
import { JobQueue } from './JobQueue.js';
import { JobProcessor } from './JobProcessor.js';
import { PendingPinService } from './PendingPinService.js';
import { PinSyncService } from './PinSyncService.js';
import { MongoVerifier } from './MongoVerifier.js';
import { GatewayAidService } from './GatewayAidService.js';
import { GatewayMonitorService } from './GatewayMonitorService.js';
import cron from 'node-cron';
import { randomUUID } from 'crypto';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class ThreeSpeakEncoder {
  private config: EncoderConfig;
  private gateway: GatewayClient;
  private processor: VideoProcessor;
  private ipfs: IPFSService;
  private identity: IdentityService;
  private dashboard?: DashboardService;
  private directApi?: DirectApiService;
  private jobQueue: JobQueue;
  private pendingPinService: PendingPinService;
  private pinSyncService?: PinSyncService; // Background service for migrating local pins to supernode
  private mongoVerifier: MongoVerifier;
  private gatewayAid: GatewayAidService;
  private gatewayMonitor: GatewayMonitorService;
  private isRunning: boolean = false;
  private activeJobs: Map<string, any> = new Map();
  private defensiveTakeoverJobs: Set<string> = new Set(); // Track jobs we've taken via MongoDB fallback
  private gatewayFailureCount: number = 0;
  private readonly maxGatewayFailures: number = 3; // Mark offline after 3 consecutive failures
  private lastGatewaySuccess: Date = new Date();
  private startTime = new Date();
  
  // 🚁 Rescue Mode: Auto-claim abandoned jobs
  private rescuedJobsCount: number = 0;
  private lastRescueTime: Date | null = null;
  private readonly rescueCheckInterval: number = 60 * 1000; // Check every 60 seconds
  private readonly abandonedThreshold: number = 6.5 * 60 * 1000; // 6.5 minutes
  private readonly maxRescuesPerCycle: number = 2; // Max 2 jobs per rescue cycle
  
  // 🗑️ Automatic Garbage Collection
  private gcCronJob: any = null;
  private lastGcTime: Date | null = null;

  constructor(config: EncoderConfig, dashboard?: DashboardService) {
    this.config = config;
    if (dashboard) {
      this.dashboard = dashboard;
    }
    this.identity = new IdentityService(config);
    this.ipfs = new IPFSService(config);
    this.processor = new VideoProcessor(config, this.ipfs, dashboard);
    this.gateway = new GatewayClient(config);
    this.mongoVerifier = new MongoVerifier(config);
    this.gatewayAid = new GatewayAidService(config, this.identity);
    this.gatewayMonitor = new GatewayMonitorService(config);
    this.jobQueue = new JobQueue(
      config.encoder?.max_concurrent_jobs || 1,
      5, // maxRetries (increased for gateway server issues)
      3 * 60 * 1000 // 3 minutes (reduced for faster recovery)
    );
    // 🏠 Pass config and IPFS client for local fallback support
    this.pendingPinService = new PendingPinService('./data', config, this.ipfs.getClient());
    
    // Initialize DirectApiService if enabled
    if (config.direct_api?.enabled) {
      this.directApi = new DirectApiService(
        config.direct_api.port || 3002,
        config,
        this.jobQueue
      );
    }
  }

  async start(): Promise<void> {
    try {
      logger.info('🔧 Initializing services...');
      
      // Initialize all services
      await this.identity.initialize();
      logger.info('✅ Identity service ready');
      
      await this.ipfs.initialize();
      logger.info('✅ IPFS service ready');
      
      await this.processor.initialize();
      logger.info('✅ Video processor ready');
      
      await this.pendingPinService.initialize();
      logger.info('✅ Pending pin service ready');
      
      // Initialize PinSyncService if local fallback is enabled
      if (this.config.ipfs?.enable_local_fallback) {
        try {
          const pinDatabase = this.ipfs.getPinDatabase();
          if (pinDatabase) {
            this.pinSyncService = new PinSyncService(
              this.config,
              pinDatabase,
              this.ipfs.getClient()
            );
            await this.pinSyncService.start();
            logger.info('✅ Pin sync service started (automatic supernode migration)');
          } else {
            logger.warn('⚠️ Pin database not available - pin sync service disabled');
          }
        } catch (error) {
          logger.error('❌ Pin sync service failed to start:', error);
          logger.warn('🔄 Encoder will continue without automatic pin migration');
        }
      } else {
        logger.info('ℹ️ Pin sync service disabled (local fallback not enabled)');
      }
      
      // Set identity service for gateway client
      this.gateway.setIdentityService(this.identity);
      
      await this.gateway.initialize();
      logger.info('✅ Gateway client ready');

      // Initialize MongoDB verifier (optional - will skip if disabled)
      try {
        await this.mongoVerifier.initialize();
        if (this.mongoVerifier.isEnabled()) {
          logger.info('✅ MongoDB direct verification ready');
        } else {
          logger.info('ℹ️ MongoDB direct verification disabled');
        }
      } catch (error) {
        logger.warn('⚠️ MongoDB direct verification failed to initialize:', error);
        logger.warn('🔄 Encoder will continue without MongoDB fallback');
      }
      
      // Initialize Gateway Aid (optional - will skip if disabled)
      if (this.gatewayAid.isEnabled()) {
      if (this.config.gateway_aid?.primary) {
        logger.info('🚀 Gateway Aid PRIMARY MODE enabled - legacy gateway bypassed');
        logger.info('📡 Will poll Gateway Aid REST API every minute for jobs');
      } else {
        logger.info('✅ Gateway Aid fallback ready (approved community node)');
      }
        logger.info('ℹ️ Gateway Aid fallback disabled');
      }
      
      // Initialize Gateway Monitor (optional - will skip if disabled)
      if (this.gatewayMonitor.isEnabled()) {
        logger.info('✅ Gateway Monitor verification ready (community encoder mode)');
        logger.info('🌐 REST API job verification enabled for race condition prevention');
      } else {
        logger.info('ℹ️ Gateway Monitor verification disabled');
      }
      
      // Start DirectApiService if enabled
      if (this.directApi) {
        await this.directApi.start();
        logger.info(`✅ Direct API service started on port ${this.config.direct_api?.port || 3002}`);
      }
      
      // Handle gateway mode based on configuration
      if (this.config.remote_gateway?.enabled !== false) {
        // Gateway mode enabled - try to register and start polling
        try {
          await this.registerNode();
          logger.info('✅ Node registered with gateway');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('⚠️ Node registration failed, continuing without registration:', errorMessage);
          logger.info('🎯 Encoder will attempt to poll for jobs without registration');
        }
        
        // Start job polling for gateway jobs
        this.startJobPolling();
        logger.info('✅ Gateway job polling started');
      } else {
        // Gateway mode disabled - direct API only
        logger.info('🔌 Gateway mode disabled - running in Direct API only mode');
        logger.info('💡 This encoder will only process direct API requests');
        logger.info('📡 No connection to 3Speak gateway will be attempted');
      }
      
      this.isRunning = true;
      // Reset gateway failure tracking on successful start
      this.gatewayFailureCount = 0;
      this.lastGatewaySuccess = new Date();
      
      // Start background lazy pinning
      this.startLazyPinning();
      
      // Start automatic weekly garbage collection (if local fallback enabled)
      if (this.config.ipfs?.enable_local_fallback) {
        this.startAutomaticGarbageCollection();
        
        // Optional: Run GC on startup to clean up old unpinned items (in background)
        setTimeout(async () => {
          if (this.isRunning && this.activeJobs.size === 0) {
            try {
              logger.info('🗑️ STARTUP GC: Running initial garbage collection...');
              await this.ipfs.runGarbageCollection();
              this.lastGcTime = new Date();
              logger.info('✅ STARTUP GC: Completed successfully');
            } catch (error) {
              logger.debug('⚠️ STARTUP GC: Skipped or failed:', error);
            }
          }
        }, 60000); // Wait 1 minute after startup
      }
      
      await this.updateDashboard();
      logger.info('🎯 3Speak Encoder is fully operational!');
      
    } catch (error) {
      logger.error('❌ Failed to start encoder:', error);
      throw error;
    }
  }

  private async updateDashboard(): Promise<void> {
    if (this.dashboard) {
      // Get IPFS peer ID asynchronously
      let peerId = 'Not connected';
      try {
        peerId = await this.ipfs.getPeerId();
      } catch (error) {
        logger.debug('Failed to get IPFS peer ID for dashboard:', error);
      }

      // Determine gateway status based on failure count
      const isGatewayOnline = this.gatewayFailureCount < this.maxGatewayFailures;

      this.dashboard.updateNodeStatus({
        online: this.isRunning,
        registered: this.isRunning,
        didKey: this.identity?.getDIDKey() || 'Not initialized',
        ipfsPeerId: peerId,
        activeJobs: this.activeJobs.size,
        totalJobs: this.jobQueue.getTotalCount(),
        lastJobCheck: new Date().toISOString(),
        nodeName: this.config.node?.name || 'Unknown',
        gatewayStatus: {
          connected: isGatewayOnline,
          failureCount: this.gatewayFailureCount,
          maxFailures: this.maxGatewayFailures,
          lastSuccess: this.lastGatewaySuccess.toISOString(),
          timeSinceLastSuccess: Date.now() - this.lastGatewaySuccess.getTime()
        },
        rescueStats: {
          rescuedJobsCount: this.rescuedJobsCount,
          lastRescueTime: this.lastRescueTime?.toISOString() || null
        },
        gcStats: {
          lastGcTime: this.lastGcTime?.toISOString() || null
        }
      });
    }
  }

  async stop(): Promise<void> {
    logger.info('🛑 Stopping encoder...');
    this.isRunning = false;
    await this.updateDashboard();
    
    // Stop DirectApiService if running
    if (this.directApi) {
      await this.directApi.stop();
      logger.info('✅ Direct API service stopped');
    }
    
    // Stop PinSyncService if running
    if (this.pinSyncService) {
      await this.pinSyncService.stop();
      logger.info('✅ Pin sync service stopped');
    }
    
    // Stop automatic GC cron job
    if (this.gcCronJob) {
      this.gcCronJob.stop();
      logger.info('✅ Automatic GC stopped');
    }
    
    // Cancel all active jobs
    for (const [jobId, job] of this.activeJobs) {
      try {
        await this.gateway.rejectJob(jobId);
        logger.info(`📤 Rejected active job: ${jobId}`);
      } catch (error) {
        logger.warn(`Failed to reject job ${jobId}:`, error);
      }
    }
    
    this.activeJobs.clear();
    
    // Cleanup MongoDB verifier connection
    if (this.mongoVerifier) {
      try {
        await this.mongoVerifier.cleanup();
        logger.info('✅ MongoDB verifier cleanup completed');
      } catch (error) {
        logger.warn('⚠️ MongoDB verifier cleanup failed:', error);
      }
    }
    
    logger.info('✅ Encoder stopped');
  }



  private async registerNode(): Promise<void> {
    try {
      const peerId = await this.ipfs.getPeerId();
      const nodeInfo = {
        name: this.config.node.name,
        cryptoAccounts: this.config.node.cryptoAccounts || { hive: 'unknown' },
        peer_id: peerId,
        commit_hash: process.env.GIT_COMMIT || 'dev-build'
      };

      await this.gateway.updateNode(nodeInfo);
      logger.info('🆔 Node registered:', nodeInfo.name);
    } catch (error) {
      logger.error('❌ Failed to register node:', error);
      throw error;
    }
  }

  private startJobPolling(): void {
    // Poll for jobs every minute at random second to distribute load
    const randomSecond = Math.floor(Math.random() * 60);
    const cronPattern = `${randomSecond} * * * * *`;
    
    logger.info(`⏰ Scheduling job polling at second ${randomSecond} of every minute`);
    
    cron.schedule(cronPattern, async () => {
      if (!this.isRunning) return;
      
      try {
        await this.checkForNewJobs();
        
        // 💓 HEARTBEAT: Send heartbeat to maintain online status in round-robin
        // This keeps us visible for job assignment even when idle
        await this.gateway.sendHeartbeat();
      } catch (error) {
        logger.warn('⚠️ Job polling failed:', error);
      }
    });

    // Start unified job processor for both queue and gateway jobs
    this.startJobProcessor();
    
    // Start dashboard heartbeat to keep status fresh
    this.startDashboardHeartbeat();
    
    // 🚁 Start rescue mode if MongoDB is enabled
    this.startRescueMode();
  }

  private startJobProcessor(): void {
    // Process jobs from JobQueue every 5 seconds
    cron.schedule('*/5 * * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        // Process retries first
        this.jobQueue.processRetries();
        // Then process new jobs
        await this.processQueuedJobs();
      } catch (error) {
        logger.warn('⚠️ Job processing failed:', error);
      }
    });

    // Check for stuck jobs every 10 minutes
    cron.schedule('*/10 * * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        await this.detectAndHandleStuckJobs();
      } catch (error) {
        logger.warn('⚠️ Stuck job detection failed:', error);
      }
    });
  }

  private startDashboardHeartbeat(): void {
    // Update dashboard status every 30 seconds, or every 10 seconds if gateway has issues
    const updateInterval = this.gatewayFailureCount > 0 ? 10 : 30;
    const cronPattern = `*/${updateInterval} * * * * *`;
    
    // Cancel any existing heartbeat first
    if ((this as any)._heartbeatJob) {
      (this as any)._heartbeatJob.destroy();
    }
    
    (this as any)._heartbeatJob = cron.schedule(cronPattern, async () => {
      if (!this.isRunning) return;
      
      try {
        await this.updateDashboard();
        logger.debug('📊 Dashboard heartbeat sent');
      } catch (error) {
        logger.debug('⚠️ Dashboard heartbeat failed:', error);
      }
    });
    
    logger.info(`💓 Dashboard heartbeat started (${updateInterval}s interval)`);
    
    // 🚨 FIX: Start memory management timer
    this.startMemoryManagement();
  }

  private startMemoryManagement(): void {
    setInterval(() => {
      // Clean up old cached results
      this.jobQueue.cleanupOldCache();
      
      // Monitor memory usage
      const usage = process.memoryUsage();
      const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
      const totalMB = Math.round(usage.heapTotal / 1024 / 1024);
      
      logger.debug(`🧠 Memory: ${heapMB}MB heap / ${totalMB}MB total`);
      
      if (heapMB > 1500) { // Warn at 1.5GB
        logger.warn(`⚠️ HIGH MEMORY USAGE: ${heapMB}MB heap / ${totalMB}MB total - potential leak!`);
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
          const newUsage = process.memoryUsage();
          const newHeapMB = Math.round(newUsage.heapUsed / 1024 / 1024);
          logger.info(`🗑️ Forced GC: ${heapMB}MB → ${newHeapMB}MB (freed ${heapMB - newHeapMB}MB)`);
        }
      }
      
      // 🚨 EMERGENCY: Kill encoder if memory gets critically high
      if (heapMB > 10000) { // 10GB emergency limit
        logger.error(`🚨 CRITICAL MEMORY LEAK DETECTED: ${heapMB}MB heap usage!`);
        logger.error(`🚨 This indicates a serious memory leak - encoder will restart to prevent crash`);
        
        // Log active jobs for debugging
        logger.error(`🚨 Active jobs: ${Array.from(this.activeJobs.keys()).join(', ')}`);
        
        // Kill any active FFmpeg processes
        import('child_process').then(({ exec }) => {
          exec('pkill -9 ffmpeg', (error) => {
            if (error) {
              logger.warn('Could not kill FFmpeg processes:', error.message);
            } else {
              logger.info('🔪 Killed all FFmpeg processes');
            }
            
            // Exit with error code to trigger restart
            process.exit(1);
          });
        }).catch(() => {
          // If we can't kill FFmpeg processes, just exit
          process.exit(1);
        });
      }
    }, 5 * 60 * 1000); // Every 5 minutes
    
    logger.info(`🧠 Memory management started (5min intervals)`);
  }

  /**
   * � RESCUE MODE: Auto-claim abandoned jobs when gateway is completely down
   * 
   * This is the ultimate failsafe layer that runs every 60 seconds to check for
   * jobs that have been sitting unassigned for 6.5+ minutes. When the gateway is
   * completely dead and jobs are piling up, this system automatically rescues them.
   * 
   * Safety features:
   * - Only rescues jobs in "queued" status (never steals from other encoders)
   * - 6.5-minute abandon threshold (gateway reassigns at 5min, we wait longer)
   * - Rate limited to max 2 jobs per cycle
   * - Only runs if MongoDB is enabled
   * - Full defensive takeover tracking
   */
  private startRescueMode(): void {
    if (!this.mongoVerifier.isEnabled()) {
      logger.info('ℹ️ Rescue Mode disabled - MongoDB not enabled');
      return;
    }

    logger.info('🚁 RESCUE MODE: Starting abandoned job rescue system');
    logger.info(`🚁 Config: Check every ${this.rescueCheckInterval / 1000}s, abandon threshold ${this.abandonedThreshold / 1000 / 60}min, max ${this.maxRescuesPerCycle} jobs/cycle`);

    // Run rescue check every 60 seconds
    setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.checkForAbandonedJobs();
        
        // 💓 CRITICAL: Send heartbeat even when rescuing
        // Infrastructure encoders using rescue mode bypass normal gateway flows,
        // but still need to maintain online status for round-robin job distribution
        await this.gateway.sendHeartbeat();
      } catch (error) {
        logger.warn('⚠️ Rescue mode check failed:', error);
      }
    }, this.rescueCheckInterval);

    logger.info('✅ Rescue Mode active - will auto-claim abandoned jobs');
  }

  /**
   * Check for abandoned jobs and rescue them
   */
  private async checkForAbandonedJobs(): Promise<void> {
    try {
      // Get all available jobs from MongoDB
      const availableJobs = await this.mongoVerifier.getAvailableGatewayJobs();
      
      if (availableJobs.length === 0) {
        logger.debug('🚁 RESCUE: No jobs available for rescue check');
        return;
      }

      // Filter to only "queued" jobs (never steal "running" jobs)
      const queuedJobs = availableJobs.filter(job => job.status === 'queued');
      
      if (queuedJobs.length === 0) {
        logger.debug(`🚁 RESCUE: ${availableJobs.length} total jobs, but none in "queued" status`);
        return;
      }

      // Find jobs abandoned for 5+ minutes
      const now = Date.now();
      const abandonedJobs = queuedJobs.filter(job => {
        const createdAt = new Date(job.createdAt).getTime();
        const ageMs = now - createdAt;
        return ageMs >= this.abandonedThreshold;
      });

      if (abandonedJobs.length === 0) {
        logger.debug(`🚁 RESCUE: ${queuedJobs.length} queued jobs, but none abandoned 5+ minutes`);
        return;
      }

      logger.info(`🚁 RESCUE OPPORTUNITY: Found ${abandonedJobs.length} abandoned jobs (queued 5+ minutes)`);

      // Rate limit: max 2 jobs per rescue cycle
      const jobsToRescue = abandonedJobs.slice(0, this.maxRescuesPerCycle);
      
      if (jobsToRescue.length < abandonedJobs.length) {
        logger.info(`🚁 RATE LIMIT: Rescuing ${jobsToRescue.length} of ${abandonedJobs.length} abandoned jobs (max ${this.maxRescuesPerCycle} per cycle)`);
      }

      // Attempt to rescue each job
      for (const job of jobsToRescue) {
        try {
          await this.rescueAbandonedJob(job);
        } catch (error) {
          logger.warn(`⚠️ Failed to rescue job ${job.id}:`, error);
        }
      }

    } catch (error) {
      logger.error('❌ Abandoned job check failed:', error);
    }
  }

  /**
   * Rescue a single abandoned job
   */
  private async rescueAbandonedJob(job: any): Promise<void> {
    const jobId = job.id;
    const ageMinutes = Math.floor((Date.now() - new Date(job.createdAt).getTime()) / 1000 / 60);

    logger.info(`🚁 RESCUE ATTEMPT: Job ${jobId} (${job.owner}/${job.permlink})`);
    logger.info(`🚁 Job age: ${ageMinutes} minutes, size: ${job.sizeFormatted}`);

    try {
      // Use MongoDB defensive takeover to claim the job
      const myDID = this.identity.getDIDKey();
      
      logger.info(`🚁 CLAIMING: Attempting defensive takeover via MongoDB...`);
      await this.mongoVerifier.forceAssignJob(jobId, myDID);
      
      // Track as defensive takeover job
      this.defensiveTakeoverJobs.add(jobId);
      
      // Update rescue statistics
      this.rescuedJobsCount++;
      this.lastRescueTime = new Date();
      
      logger.info(`✅ RESCUED: Successfully claimed abandoned job ${jobId}`);
      logger.info(`📊 RESCUE STATS: Total rescued: ${this.rescuedJobsCount}`);
      
      // Fetch complete job details and process
      logger.info(`🎬 PROCESSING: Fetching complete job details for rescued job...`);
      
      try {
        // Get complete job from MongoDB
        const jobDocument = await this.mongoVerifier.getJobDetails(jobId);
        
        if (jobDocument) {
          logger.info(`✅ Fetched complete job details for ${jobId}`);
          
          // Process the job directly (it's already assigned to us via forceAssignJob)
          await this.processGatewayJob(jobDocument, true); // ownershipAlreadyConfirmed = true
          
          logger.info(`✅ Rescued job ${jobId} processing started`);
          
          // Update dashboard
          await this.updateDashboard();
          
        } else {
          logger.warn(`⚠️ Could not fetch complete job details for ${jobId} - skipping processing`);
        }
        
      } catch (fetchError) {
        logger.error(`❌ Failed to fetch/process rescued job ${jobId}:`, fetchError);
        // Don't throw - we successfully claimed it, just couldn't process it
      }
      
    } catch (error: any) {
      // Check if this is a "job already assigned" error (race condition with another encoder)
      if (error?.message?.includes('already assigned')) {
        logger.info(`ℹ️ RESCUE SKIP: Job ${jobId} was claimed by another encoder during rescue attempt`);
      } else {
        logger.error(`❌ RESCUE FAILED: Could not claim job ${jobId}:`, error);
        throw error;
      }
    }
  }

  /*
   * Convert MongoDB job document to VideoJob format
   * NOTE: Currently unused - rescued jobs use getJobDetails() and processGatewayJob() directly
   */
  /*
  private convertMongoJobToVideoJob(doc: any): VideoJob {
    return {
      id: doc.id,
      owner: doc.metadata?.video_owner || '',
      permlink: doc.metadata?.video_permlink || '',
      size: doc.input?.size || 0,
      created_at: doc.created_at ? new Date(doc.created_at).toISOString() : new Date().toISOString(),
      input: {
        uri: doc.input?.uri || '',
        size: doc.input?.size || 0
      },
      status: doc.status,
      assigned_to: doc.assigned_to,
      assigned_date: doc.assigned_date ? new Date(doc.assigned_date).toISOString() : null
    };
  }
  */

  /**
   * �🚨 MEMORY SAFE: Fire-and-forget ping job to prevent promise accumulation
   */
  private safePingJob(jobId: string, status: any): void {
    // Use setImmediate to ensure this runs asynchronously without creating
    // a promise that could accumulate in memory during network issues
    setImmediate(async () => {
      try {
        await this.gateway.pingJob(jobId, status);
      } catch (error: any) {
        // Log but don't propagate errors to prevent memory leaks
        const errorMsg = error?.message || error?.code || error?.toString() || 'Unknown error';
        logger.warn(`Failed to update gateway progress for ${jobId}: ${errorMsg}`);
      }
    });
  }

  private async detectAndHandleStuckJobs(): Promise<void> {
    const stuckJobs = this.jobQueue.detectStuckJobs(3600000); // 1 hour
    
    for (const jobId of stuckJobs) {
      const job = this.jobQueue.getJob(jobId);
      if (!job) continue;

      logger.warn(`🚨 Detected stuck job: ${jobId} (active for over 1 hour)`);
      
      // For gateway jobs, try to reject them to release them back to the queue
      if (job.type !== 'direct') {
        try {
          await this.gateway.rejectJob(jobId);
          logger.info(`✅ Released stuck gateway job back to queue: ${jobId}`);
        } catch (error) {
          logger.warn(`⚠️ Failed to reject stuck job ${jobId}:`, error);
        }
      }
      
      // Abandon the job locally
      this.jobQueue.abandonJob(jobId, 'Job stuck for over 1 hour');
      
      // Update dashboard
      if (this.dashboard) {
        this.dashboard.failJob(jobId, 'Job abandoned due to timeout');
      }
    }
  }

  private isRetryableError(error: any): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode = error?.status || error?.response?.status;
    
    // Network/communication errors are usually retryable
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED') || 
        errorMessage.includes('timeout') || errorMessage.includes('network')) {
      return true;
    }
    
    // HTTP 500 series errors are usually retryable (server issues)
    if (statusCode >= 500 && statusCode < 600) {
      return true;
    }
    
    // HTTP 429 (rate limiting) is retryable
    if (statusCode === 429) {
      return true;
    }
    
    // HTTP 4xx errors (except 408 timeout) are usually not retryable (client errors)
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 408) {
      return false;
    }
    
    // IPFS/FFmpeg processing errors are usually not retryable
    if (errorMessage.includes('ffmpeg') || errorMessage.includes('No such file')) {
      return false;
    }
    
    // Default to retryable for unknown errors
    return true;
  }

  private async processQueuedJobs(): Promise<void> {
    // Check if we can process more jobs
    if (this.activeJobs.size >= (this.config.encoder?.max_concurrent_jobs || 1)) {
      return;
    }

    // Get next job from unified queue
    const job = this.jobQueue.getNextJob();
    if (!job) {
      return; // No jobs available
    }

    try {
      if (job.type === 'direct') {
        // Process direct API job
        await this.processDirectJob(job);
      } else {
        // Process gateway job
        await this.processGatewayJob(job);
      }
    } catch (error) {
      logger.error(`❌ Job ${job.id} failed:`, cleanErrorForLogging(error));
      
      // Determine if this error is retryable
      const isRetryable = this.isRetryableError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Fail job with retry logic
      this.jobQueue.failJob(job.id, errorMessage, isRetryable);
      
      // Update dashboard with job failure
      if (this.dashboard) {
        const retryInfo = this.jobQueue.getRetryInfo(job.id);
        if (retryInfo && retryInfo.attempts < retryInfo.maxAttempts) {
          // Job will be retried
          this.dashboard.updateJobProgress(job.id, 0, 'retry-pending', {
            error: errorMessage,
            retryAttempt: retryInfo.attempts,
            maxAttempts: retryInfo.maxAttempts,
            nextRetry: retryInfo.nextRetry
          });
        } else {
          // Job permanently failed
          this.dashboard.failJob(job.id, errorMessage);
        }
      }
    }
  }

  private async processDirectJob(job: any): Promise<void> {
    this.activeJobs.set(job.id, job);
    const request = job.request;
    
    // 📱 Short video mode detection
    const isShortVideo = request.short === true;
    
    // Start job tracking in dashboard
    if (this.dashboard) {
      this.dashboard.startJob(job.id, {
        type: 'direct-api',
        video_id: `${request.owner}/${request.permlink}`,
        input_uri: `ipfs://${request.input_cid}`,
        profiles: isShortVideo ? ['480p'] : ['1080p', '720p', '480p'],
        webhook_url: request.webhook_url
      });
    }
    
    await this.updateDashboard();

    try {
      const startTime = Date.now();
      
      // 🧹 SANITIZE input_cid: Extract bare CID if a full URL was submitted
      let sanitizedCid = request.input_cid;
      const cidFromUrl = sanitizedCid.match(/\/ipfs\/([a-zA-Z0-9]+)/);
      if (cidFromUrl) {
        logger.warn(`⚠️ input_cid contains a full URL, extracting bare CID: ${cidFromUrl[1]}`);
        sanitizedCid = cidFromUrl[1];
      } else if (sanitizedCid.startsWith('ipfs://')) {
        sanitizedCid = sanitizedCid.replace('ipfs://', '');
      }
      // Strip any remaining protocol prefixes or whitespace
      sanitizedCid = sanitizedCid.replace(/^https?:\/\//, '').trim();
      
      // Convert DirectJob to VideoJob format for processing
      const videoJob: VideoJob = {
        id: job.id,
        type: 'gateway', // Use existing type
        status: JobStatus.QUEUED,
        created_at: new Date().toISOString(),
        input: {
          uri: `ipfs://${sanitizedCid}`, // Use sanitized CID with ipfs:// prefix
          size: 0 // Will be determined during download
        },
        metadata: {
          video_owner: request.owner, // NEW: Use owner
          video_permlink: request.permlink // NEW: Use permlink
        },
        storageMetadata: {
          app: request.frontend_app || 'direct-api',
          key: `${request.owner}/${request.permlink}`,
          type: 'direct'
        },
        profiles: this.getProfilesForJob(isShortVideo ? ['480p'] : ['1080p', '720p', '480p']),
        output: [],
        // 🎬 Pass short flag and webhook info to VideoProcessor
        short: request.short,
        webhook_url: request.webhook_url,
        api_key: request.api_key,
        ...(request.originalFilename && { originalFilename: request.originalFilename })
      };

      // Process video using existing VideoProcessor
      const result = await this.processor.processVideo(videoJob);
      
      const processingTimeSeconds = (Date.now() - startTime) / 1000;
      
      // Complete the job
      this.jobQueue.completeJob(job.id, result);
      
      // Complete job tracking in dashboard
      if (this.dashboard) {
        this.dashboard.completeJob(job.id, result);
      }
      
      logger.info(`✅ Direct job completed: ${job.id} (${request.owner}/${request.permlink})`);
      
      // 🔔 Send webhook notification if webhook_url provided
      if (request.webhook_url) {
        try {
          const manifestCid = result[0]?.ipfsHash || '';
          const qualitiesEncoded = result.map(r => r.profile).filter(p => p !== 'master');
          
          const webhookPayload: any = {
            owner: request.owner,
            permlink: request.permlink,
            input_cid: request.input_cid,
            status: 'complete',
            manifest_cid: manifestCid,
            video_url: `ipfs://${manifestCid}/manifest.m3u8`,
            job_id: job.id,
            processing_time_seconds: processingTimeSeconds,
            qualities_encoded: qualitiesEncoded,
            encoder_id: this.config.node?.name || 'unknown',
            timestamp: new Date().toISOString()
          };
          
          // Add optional fields only if defined
          if (request.frontend_app) webhookPayload.frontend_app = request.frontend_app;
          if (request.originalFilename) webhookPayload.originalFilename = request.originalFilename;
          
          // Import WebhookService at top of file if not already
          const { WebhookService } = await import('./WebhookService.js');
          const webhookService = new WebhookService();
          
          await webhookService.sendWebhook(request.webhook_url, webhookPayload, request.api_key);
          logger.info(`✅ Webhook delivered for ${request.owner}/${request.permlink}`);
        } catch (webhookError) {
          logger.warn(`⚠️ Webhook delivery failed for job ${job.id}:`, webhookError);
          // Don't fail the job for webhook failures
        }
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ Direct job ${job.id} failed:`, cleanErrorForLogging(error));
      
      this.jobQueue.failJob(job.id, errorMessage);
      
      // 🔔 Send failure webhook if URL provided
      if (request.webhook_url) {
        try {
          const { WebhookService } = await import('./WebhookService.js');
          const webhookService = new WebhookService();
          
          await webhookService.sendWebhook(request.webhook_url, {
            owner: request.owner,
            permlink: request.permlink,
            input_cid: request.input_cid,
            status: 'failed',
            job_id: job.id,
            processing_time_seconds: 0,
            qualities_encoded: [],
            encoder_id: this.config.node?.name || 'unknown',
            error: errorMessage,
            timestamp: new Date().toISOString()
          }, request.api_key);
        } catch (webhookError) {
          logger.warn(`⚠️ Failure webhook delivery failed for job ${job.id}:`, webhookError);
        }
      }
      
      throw error;
    } finally {
      this.activeJobs.delete(job.id);
      await this.updateDashboard();
    }
  }

  private async processGatewayJob(job: any, ownershipAlreadyConfirmed: boolean = false): Promise<void> {
    const jobId = job.id;
    const ourDID = this.identity.getDIDKey();
    let ownershipCheckInterval: NodeJS.Timeout | null = null;
    
    let isAutoAssignedFromMyJob = false;
    let isManualForceProcessing = ownershipAlreadyConfirmed;
    
    // � Check if job was queued with ownership already confirmed (from /myJob)
    if (job.ownershipAlreadyConfirmed === true && !ownershipAlreadyConfirmed) {
      ownershipAlreadyConfirmed = true;
      isAutoAssignedFromMyJob = true;
      isManualForceProcessing = false;
      logger.info(`✅ Job ${jobId} queued with ownership pre-confirmed (/myJob auto-assignment)`);
      logger.info(`📡 Will report progress and completion to gateway`);
    }
    
    // �🛡️ DEFENSIVE_CHECK: If this job was previously taken via MongoDB, force offline processing
    if (this.defensiveTakeoverJobs.has(jobId)) {
      logger.info(`🔒 DEFENSIVE_OVERRIDE: Job ${jobId} was previously taken via MongoDB - forcing offline mode`);
      ownershipAlreadyConfirmed = true;
      isManualForceProcessing = true;
      isAutoAssignedFromMyJob = false;
    }
    
    // 🛡️ Variables for MongoDB fallback (scope accessible from catch blocks)
    let completedResult: any = null;
    let masterCID: string | null = null;
    let usedMongoDBFallback: boolean = false; // Track if we used MongoDB to confirm ownership
    let usedGatewayAidFallback: boolean = (job as any).gatewayAidSource || false; // Track if job came from Gateway Aid
    let shouldReportToGateway: boolean = false; // Will be set after fallback detection
    
    this.activeJobs.set(jobId, job);
    
    // Check if this job has cached results from previous attempt
    const cachedResult = this.jobQueue.getCachedResult(jobId);
    
    // Start job tracking in dashboard
    if (this.dashboard) {
      this.dashboard.startJob(job.id, {
        type: 'gateway',
        video_id: job.metadata?.video_permlink || job.id,
        owner: job.metadata?.video_owner || 'unknown',
        permlink: job.metadata?.video_permlink || 'unknown',
        size: job.input?.size || 0,
        input_uri: job.input?.uri || 'unknown',
        profiles: job.profiles?.map((p: any) => p.name) || ['1080p', '720p', '480p']
      });
    }
    
    await this.updateDashboard();
    
    try {
      // 🔍 SMART CLAIMING: Skip ownership check if already confirmed
      let jobStatus: any;
      let ownershipVerified = false; // Declare at function scope for use in both branches
      
      if (ownershipAlreadyConfirmed) {
        logger.info(`✅ OWNERSHIP_PRECONFIRMED: Job ${jobId} ownership already verified - skipping all gateway checks`);
        // 🎯 FIX: Set ownershipVerified flag when pre-confirmed to prevent abort later
        ownershipVerified = true;
        logger.info(`✅ Setting ownershipVerified=true for pre-confirmed job ${jobId}`);
        
        // 🎯 CRITICAL: For /myJob jobs, call acceptJob() to activate progress tracking
        // Even though job is already assigned, gateway requires this acknowledgment
        if (isAutoAssignedFromMyJob) {
          try {
            logger.info(`📞 Calling acceptJob() for /myJob auto-assigned job ${jobId} to activate progress tracking...`);
            await this.gateway.acceptJob(jobId);
            logger.info(`✅ acceptJob() successful - progress tracking activated for job ${jobId}`);
          } catch (acceptError: any) {
            // Don't fail - job is already ours, this is just acknowledgment
            logger.warn(`⚠️ acceptJob() failed for job ${jobId}, but continuing (job already assigned):`, acceptError.message);
          }
        }
        // Skip all other gateway interactions and go straight to processing
      } else {
        // 🔍 Check if we need to claim the job first
        let needsToClaim = true;
        
        try {
          // 🛡️ PRE-CLAIM VERIFICATION: Check with Gateway Monitor first (if available) before trying gateway
          if (this.gatewayMonitor.isEnabled()) {
            logger.info(`🔍 PRE_CLAIM_CHECK: Verifying job availability via Gateway Monitor...`);
            const availability = await this.gatewayMonitor.isJobAvailableToClaim(jobId);
            
            if (!availability.available) {
              if (availability.currentOwner === ourDID) {
                logger.info(`✅ ALREADY_OWNED: Job ${jobId} is already assigned to us - no need to claim`);
                needsToClaim = false;
              } else if (availability.currentOwner) {
                logger.warn(`⚠️ PRE_CLAIM_CONFLICT: Job ${jobId} already claimed by ${availability.currentOwner}`);
                logger.info(`🏃‍♂️ GRACEFUL_SKIP: Reason - ${availability.reason}`);
                const skipError = new Error(`RACE_CONDITION_SKIP: ${availability.reason}`);
                (skipError as any).isRaceCondition = true;
                throw skipError;
              } else {
                logger.warn(`⚠️ JOB_NOT_CLAIMABLE: ${availability.reason} (status: ${availability.status})`);
                throw new Error(`Job not available to claim: ${availability.reason}`);
              }
            } else {
              logger.info(`✅ PRE_CLAIM_OK: Job ${jobId} is available to claim (status: ${availability.status})`);
              needsToClaim = true;
            }
          } 
          // Fall back to checking gateway status directly if monitor not available
          else {
            // Check current job status to see if we already own it
            jobStatus = await this.gateway.getJobStatus(jobId);
            if (jobStatus?.assigned_to === ourDID) {
              logger.info(`✅ ALREADY_OWNED: Job ${jobId} is already assigned to us - no need to claim`);
              needsToClaim = false;
            } else if (!jobStatus?.assigned_to) {
              logger.info(`🎯 NEEDS_CLAIMING: Job ${jobId} is unassigned - will claim it`);
              needsToClaim = true;
            } else {
              logger.warn(`⚠️ OWNERSHIP_CONFLICT: Job ${jobId} is assigned to ${jobStatus.assigned_to}, not us`);
              throw new Error(`Job ${jobId} is assigned to another encoder: ${jobStatus.assigned_to}`);
            }
          }
        } catch (statusError) {
          // If it's a race condition skip, rethrow it
          if ((statusError as any).isRaceCondition) {
            throw statusError;
          }
          logger.warn(`⚠️ Could not check job status, will attempt to claim anyway:`, statusError);
          needsToClaim = true; // Default to claiming if we can't check status
        }
        
        // Only call acceptJob if we need to claim the job
        if (needsToClaim) {
          logger.info(`📞 CLAIMING: Calling acceptJob() for ${jobId}`);
          
          try {
            // 🚀 TIMEOUT_FALLBACK: Set a reasonable timeout for acceptJob() to prevent long hangs
            const acceptJobPromise = this.gateway.acceptJob(jobId);
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('acceptJob timeout - gateway too slow')), 10000); // 10 second timeout
            });
            
            await Promise.race([acceptJobPromise, timeoutPromise]);
            logger.info(`✅ Successfully claimed gateway job: ${jobId}`);
            
            // Re-check status after claiming
            jobStatus = await this.gateway.getJobStatus(jobId);
            
          } catch (acceptError: any) {
            // 🛡️ DEFENSIVE CLAIMING: Gateway failed to assign job - investigate and take control
            const errorMessage = acceptError instanceof Error ? acceptError.message : String(acceptError);
            logger.error(`❌ GATEWAY_CLAIM_FAILED: acceptJob() failed for ${jobId}:`, errorMessage);
            
            // Try MongoDB fallback first (infrastructure nodes)
            if (this.mongoVerifier.isEnabled()) {
              logger.info(`🔍 DEFENSIVE_MODE: Investigating job status via MongoDB before giving up...`);
              
              try {
                const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
                
                if (mongoResult.jobExists) {
                  if (mongoResult.isOwned) {
                    // Job was actually assigned to us somehow
                    logger.info(`✅ MONGODB_SURPRISE: Job ${jobId} was assigned to us despite gateway failure!`);
                    logger.info(`🎯 PROCEEDING: Gateway lied, but MongoDB shows we own the job`);
                    usedMongoDBFallback = true; // 🎯 CRITICAL: Mark that we used MongoDB fallback
                    
                    // 🛡️ PERSISTENT_STATE: Mark this job as defensively taken over to prevent future gateway calls
                    this.defensiveTakeoverJobs.add(jobId);
                    logger.info(`🔒 DEFENSIVE_LOCK: Job ${jobId} permanently marked as MongoDB-controlled`)
                  } else if (!mongoResult.actualOwner) {
                    // Job is still unassigned - TAKE CONTROL
                    logger.warn(`🚨 GATEWAY_BROKEN: Job ${jobId} still unassigned after gateway failure`);
                    logger.info(`🛡️ DEFENSIVE_TAKEOVER: Force-assigning job to ourselves to prevent limbo`);
                    
                    try {
                      // Force assign the job to ourselves in MongoDB
                      await this.mongoVerifier.forceAssignJob(jobId, ourDID);
                      logger.info(`✅ FORCE_ASSIGNED: Job ${jobId} forcibly assigned to us in MongoDB`);
                      logger.info(`🎯 DEFENSIVE_SUCCESS: Proceeding with processing despite gateway failure`);
                      logger.info(`📊 TELEMETRY: Gateway broken, but MongoDB takeover successful`);
                      usedMongoDBFallback = true; // 🎯 CRITICAL: Mark that we used MongoDB fallback
                      
                      // 🛡️ PERSISTENT_STATE: Mark this job as defensively taken over to prevent future gateway calls
                      this.defensiveTakeoverJobs.add(jobId);
                      logger.info(`🔒 DEFENSIVE_LOCK: Job ${jobId} permanently marked as MongoDB-controlled`)
                      
                    } catch (forceAssignError) {
                      logger.error(`❌ FORCE_ASSIGN_FAILED: Could not force-assign job ${jobId}:`, forceAssignError);
                      throw new Error(`Both gateway and MongoDB assignment failed: ${errorMessage}`);
                    }
                  } else {
                    // Job was assigned to someone else - this is a GOOD thing, not a failure!
                    logger.info(`🏃‍♂️ RACE_CONDITION: Job ${jobId} was assigned to ${mongoResult.actualOwner} while we were trying`);
                    logger.info(`🎉 GOOD_NEWS: Another encoder is handling this job - no work needed from us!`);
                    logger.info(`🎯 GRACEFUL_SKIP: Moving on to next available job`);
                    
                    // This is NOT an error - it's a successful race condition resolution
                    // We'll return gracefully and let the calling code handle this as a skip
                    const raceConditionError = new Error(`RACE_CONDITION_SKIP: Job assigned to another encoder: ${mongoResult.actualOwner}`);
                    (raceConditionError as any).isRaceCondition = true; // Flag for special handling
                    throw raceConditionError;
                  }
                } else {
                  logger.error(`🤔 JOB_NOT_FOUND: Job ${jobId} doesn't exist in MongoDB`);
                  throw new Error(`Job not found in database: ${jobId}`);
                }
                
              } catch (mongoError) {
                logger.error(`❌ MONGODB_VERIFICATION_FAILED: Could not check job status in MongoDB:`, mongoError);
                throw acceptError; // Rethrow original error
              }
            } 
            // Try Gateway Aid fallback (approved community nodes)
            else if (this.gatewayAid.isEnabled()) {
              logger.info(`🆘 GATEWAY_AID: Attempting to claim job via REST API fallback...`);
              
              try {
                const claimed = await this.gatewayAid.claimJob(jobId);
                
                if (claimed) {
                  logger.info(`✅ GATEWAY_AID_SUCCESS: Job ${jobId} claimed via REST API`);
                  logger.info(`🎯 PROCEEDING: Using Gateway Aid for rest of this job`);
                  usedGatewayAidFallback = true; // 🎯 CRITICAL: Mark that we used Gateway Aid fallback
                } else {
                  logger.error(`❌ GATEWAY_AID_FAILED: Could not claim job ${jobId} via REST API`);
                  throw new Error(`Both gateway websocket and Gateway Aid failed: ${errorMessage}`);
                }
              } catch (aidError) {
                logger.error(`❌ GATEWAY_AID_ERROR: Exception while claiming job via REST:`, aidError);
                throw new Error(`Both gateway websocket and Gateway Aid failed: ${errorMessage}`);
              }
            } else {
              // No fallback available
              logger.error(`❌ NO_FALLBACK: No MongoDB or Gateway Aid fallback available`);
              throw acceptError; // Rethrow original error
            }
          }
        } else {
          logger.info(`⏩ SKIP_CLAIMING: Job ${jobId} already owned, proceeding directly to processing`);
        }
      }

      // 🔒 CRITICAL OWNERSHIP VALIDATION: Verify we own the job (skip if already confirmed)
      if (!ownershipAlreadyConfirmed) {
        try {
          // 🛡️ TRUST HIERARCHY: MongoDB (ground truth) → Gateway (unreliable WebSocket)
          // Note: Gateway Aid doesn't support job status queries, so we can't use it for verification
          // The gateway WebSocket has been observed lying and telling multiple encoders they own the same job
          // ownershipVerified already declared at function scope above
          
          // STEP 1: Try MongoDB first (most reliable - ground truth database)
          if (this.mongoVerifier.isEnabled()) {
            try {
              logger.info(`🔍 TIER_1_VERIFICATION: Checking MongoDB (ground truth database)...`);
              const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
              
              if (mongoResult.jobExists) {
                if (mongoResult.isOwned) {
                  logger.info(`✅ MONGODB_CONFIRMED: Job ${jobId} is assigned to us in database`);
                  logger.info(`📊 MongoDB ground truth: assigned_to=${ourDID}, status=${mongoResult.status}`);
                  ownershipVerified = true;
                  usedMongoDBFallback = true; // Using MongoDB as primary verification
                } else if (mongoResult.actualOwner) {
                  // Job is assigned to someone else - STOP IMMEDIATELY
                  logger.error(`🚨 MONGODB_THEFT_DETECTED: Job ${jobId} is assigned to ${mongoResult.actualOwner} in database!`);
                  logger.error(`🛑 ABORTING: Another encoder owns this job - stopping to prevent wasted work`);
                  logger.error(`📊 Ground truth from MongoDB: This is NOT our job`);
                  this.jobQueue.failJob(jobId, `Job stolen by another encoder: ${mongoResult.actualOwner}`, false);
                  return;
                } else {
                  // Job exists but not assigned to anyone
                  logger.warn(`⚠️ MONGODB_LIMBO: Job ${jobId} exists but assigned_to is null/empty`);
                  logger.info(`🔧 Will check gateway as secondary verification...`);
                }
              } else {
                logger.warn(`⚠️ MONGODB_NOT_FOUND: Job ${jobId} doesn't exist in database yet`);
                logger.info(`🔧 Will check gateway as secondary verification...`);
              }
            } catch (mongoError) {
              logger.error(`❌ MONGODB_CHECK_FAILED: Could not verify ownership via MongoDB:`, mongoError);
              logger.info(`🔧 Falling back to gateway verification (less reliable)...`);
            }
          } else {
            logger.info(`📊 MongoDB verification not available - checking next tier...`);
          }
          
          // STEP 2: Try Gateway Monitor API (community encoders without MongoDB)
          if (!ownershipVerified && this.gatewayMonitor.isEnabled()) {
            try {
              logger.info(`🔍 TIER_2_VERIFICATION: Checking Gateway Monitor API (community encoder mode)...`);
              const monitorResult = await this.gatewayMonitor.verifyJobOwnership(jobId, ourDID);
              
              if (monitorResult.jobExists) {
                if (monitorResult.isOwned && monitorResult.isSafeToProcess) {
                  logger.info(`✅ MONITOR_CONFIRMED: Job ${jobId} is assigned to us via REST API`);
                  logger.info(`📊 Gateway Monitor: assigned_to=${ourDID}, status=${monitorResult.status}`);
                  ownershipVerified = true;
                } else if (monitorResult.actualOwner) {
                  // Job is assigned to someone else - STOP IMMEDIATELY
                  logger.error(`🚨 MONITOR_THEFT_DETECTED: Job ${jobId} is assigned to ${monitorResult.actualOwner}!`);
                  logger.error(`🛑 ABORTING: Another encoder owns this job - stopping to prevent wasted work`);
                  logger.error(`📊 REST API verification: This is NOT our job`);
                  this.jobQueue.failJob(jobId, `Job stolen by another encoder: ${monitorResult.actualOwner}`, false);
                  return;
                } else {
                  // Job exists but not assigned to anyone
                  logger.warn(`⚠️ MONITOR_LIMBO: Job ${jobId} exists but assigned_to is null/empty`);
                  logger.info(`🔧 Will check gateway WebSocket as final verification...`);
                }
              } else {
                logger.warn(`⚠️ MONITOR_NOT_FOUND: Job ${jobId} doesn't exist in Gateway Monitor yet`);
                logger.info(`🔧 Will check gateway WebSocket as final verification...`);
              }
            } catch (monitorError) {
              logger.error(`❌ GATEWAY_MONITOR_CHECK_FAILED: Could not verify ownership via REST API:`, monitorError);
              logger.info(`🔧 Falling back to gateway WebSocket verification (less reliable)...`);
            }
          } else if (!ownershipVerified) {
            logger.info(`📊 Gateway Monitor verification not available - will use gateway WebSocket`);
            if (this.gatewayAid.isEnabled()) {
              logger.info(`ℹ️ Note: Gateway Aid available for job ops but doesn't support ownership verification`);
            }
          }
          
          // STEP 3: If neither MongoDB nor Monitor confirmed, check gateway WebSocket (unreliable, last resort)
          if (!ownershipVerified) {
            logger.info(`🔍 TIER_3_VERIFICATION: Checking Gateway WebSocket (least reliable - known to lie)...`);
            jobStatus = await this.gateway.getJobStatus(jobId);
            logger.info(`🔍 Job ${jobId} status: assigned_to=${jobStatus.assigned_to || 'null'}, status=${jobStatus.status || 'unknown'}`);
            logger.warn(`⚠️ WARNING: Gateway WebSocket has been known to lie and tell multiple encoders they own the same job`);
            if (!this.mongoVerifier.isEnabled() && !this.gatewayMonitor.isEnabled()) {
              logger.warn(`⚠️ Without MongoDB or Gateway Monitor verification, false assignments are possible - watch for conflicts!`);
            }
            
            // 🔍 DEBUG: Log DID format details for investigation
            logger.info(`🔍 DID_FORMAT_DEBUG: Our DID="${ourDID}"`);
            logger.info(`🔍 DID_FORMAT_DEBUG: Gateway assigned_to="${jobStatus.assigned_to || 'null'}"`);
            
            // 🛡️ DEFENSIVE: Handle DID format mismatches (did:key: prefix issues)
        const normalizeJobOwner = (owner: string | null): string => {
          if (!owner) return '';
          // Handle both "did:key:xyz" and "didxyz" formats
          if (owner.startsWith('did:key:')) {
            return owner; // Already has prefix
          } else if (owner.startsWith('did')) {
            return `did:key:${owner.substring(3)}`; // Convert "didxyz" to "did:key:xyz" 
          }
          return owner;
        };
        
        const normalizeOurDID = (ourDid: string): string => {
          if (!ourDid) return '';
          // Handle both "did:key:xyz" and "didxyz" formats
          if (ourDid.startsWith('did:key:')) {
            return ourDid; // Already has prefix
          } else if (ourDid.startsWith('did')) {
            return `did:key:${ourDid.substring(3)}`; // Convert "didxyz" to "did:key:xyz"
          }
          return ourDid;
        };
        
        const normalizedJobOwner = normalizeJobOwner(jobStatus.assigned_to);
        const normalizedOurDID = normalizeOurDID(ourDID);
        
        logger.info(`🔍 DID_NORMALIZED: Our DID="${normalizedOurDID}"`);
        logger.info(`🔍 DID_NORMALIZED: Gateway assigned_to="${normalizedJobOwner}"`);
        
        // After acceptJob(), the job MUST be assigned to us (with normalized comparison)
        if (normalizedJobOwner !== normalizedOurDID) {
          const actualOwner = jobStatus.assigned_to || 'unassigned/null';
          
          if (!jobStatus.assigned_to) {
            logger.error(`🚨 CLAIM FAILED: Job ${jobId} is still unassigned after acceptJob() - gateway may have rejected our claim`);
          } else {
            logger.error(`🚨 DID_MISMATCH: Job ${jobId} assigned_to="${actualOwner}" vs our DID="${ourDID}"`);
            logger.error(`🔍 NORMALIZED: Gateway="${normalizedJobOwner}" vs Ours="${normalizedOurDID}"`);
            
            // Check if it's just a format mismatch vs actual different owner
            const jobOwnerCore = (jobStatus.assigned_to || '').replace(/^did:key:/, '').replace(/^did/, '');
            const ourDIDCore = ourDID.replace(/^did:key:/, '').replace(/^did/, '');
            
            if (jobOwnerCore === ourDIDCore) {
              logger.warn(`⚠️ DID_FORMAT_MISMATCH: Same core DID but different format - this is a gateway API bug`);
              logger.warn(`🔧 PROCEEDING: Core DIDs match, treating as successful claim`);
              // Continue processing since it's the same DID with different format
            } else {
              logger.error(`🚨 RACE CONDITION: Job ${jobId} is assigned to different encoder: ${actualOwner}`);
              logger.error(`🚨 Another encoder won the race condition! This indicates high competition for jobs.`);
              // Gracefully handle the conflict without throwing
              this.jobQueue.failJob(jobId, `Failed to claim job: assigned_to=${actualOwner}, expected=${ourDID}`, false);
              return;
            }
          }
        }
            if (jobStatus.status !== 'assigned') {
              logger.warn(`⚠️ Unexpected job status after accept: ${jobStatus.status} (expected 'assigned')`);
            }
            
            logger.info(`✅ Gateway claims job ownership - proceeding with caution`);
            logger.warn(`⚠️ Remember: Gateway verification is unreliable - watch for conflicts during processing`);
            ownershipVerified = true;
          } // End of gateway verification
          
          if (!ownershipVerified) {
            logger.error(`🚨 OWNERSHIP_UNVERIFIED: Could not confirm ownership of job ${jobId} through any means`);
            logger.error(`🛑 ABORTING: Refusing to process job without ownership confirmation`);
            logger.info(`📊 RESCUE_MODE: If job is legitimately abandoned, rescue mode will reclaim it`);
            this.jobQueue.failJob(jobId, `Cannot verify job ownership`, false);
            return;
          }
          
        } catch (verificationError) {
          logger.error(`❌ OWNERSHIP_VERIFICATION_EXCEPTION: Unexpected error during verification:`, verificationError);
          logger.error(`🛑 ABORTING: Cannot safely proceed without ownership verification`);
          this.jobQueue.failJob(jobId, `Ownership verification exception: ${verificationError}`, false);
          return;
        }
      } // End of ownership validation check
      
      // If we reach here, ownership is confirmed (either pre-confirmed or verified above)
      logger.info(`✅ Job ${jobId} ownership confirmed - safe to proceed with processing`);
      
      // 🛡️ DEFENSIVE: Additional safety check - verify we're not processing someone else's job
      // This catches race conditions that might have occurred after our ownership check
      logger.info(`🔒 SAFETY_CHECK: Job ${jobId} processing started by encoder ${ourDID}`);
      logger.info(`⏱️ TIMESTAMP: ${new Date().toISOString()} - Starting processing phase`);
      
      // 🛡️ DEFENSIVE: Set up periodic ownership verification during processing (skip when offline)
      const startOwnershipMonitoring = () => {
        if (isManualForceProcessing || usedMongoDBFallback) {
          const reason = isManualForceProcessing ? "manual force processing" : "MongoDB fallback used";
          logger.info(`🎯 SKIP_MONITORING: Skipping periodic ownership checks - ${reason}`);
          return; // Skip monitoring when gateway is unreliable
        }
        
        ownershipCheckInterval = setInterval(async () => {
          try {
            const currentStatus = await this.gateway.getJobStatus(jobId);
            
            // 🛡️ DEFENSIVE: Use same DID normalization logic as initial check
            const normalizeOwner = (owner: string | null): string => {
              if (!owner) return '';
              if (owner.startsWith('did:key:')) return owner;
              if (owner.startsWith('did')) return `did:key:${owner.substring(3)}`;
              return owner;
            };
            
            const normalizedCurrentOwner = normalizeOwner(currentStatus.assigned_to);
            const normalizedOurDID = normalizeOwner(ourDID);
            
            if (normalizedCurrentOwner !== normalizedOurDID && currentStatus.assigned_to) {
              // Check if it's just format mismatch vs real ownership change
              const currentOwnerCore = (currentStatus.assigned_to || '').replace(/^did:key:/, '').replace(/^did/, '');
              const ourDIDCore = ourDID.replace(/^did:key:/, '').replace(/^did/, '');
              
              if (currentOwnerCore !== ourDIDCore) {
                logger.error(`🚨 OWNERSHIP_HIJACK_DETECTED: Job ${jobId} reassigned during processing!`);
                logger.error(`📊 CRITICAL_BUG: assigned_to changed from ${ourDID} to ${currentStatus.assigned_to}`);
                logger.error(`🛑 ABORTING: Stopping processing to prevent duplicate work`);
                
                // Clear the interval and abort processing
                if (ownershipCheckInterval) clearInterval(ownershipCheckInterval);
                throw new Error(`Job ownership hijacked: assigned_to=${currentStatus.assigned_to}, expected=${ourDID}`);
              } else {
                logger.debug(`🔍 DID format difference detected but same core DID - continuing safely`);
              }
            }
          } catch (error) {
            // 🛡️ AGGRESSIVE PROTECTION: Try MongoDB fallback before giving up
            logger.warn(`⚠️ Periodic ownership check via gateway failed for job ${jobId}:`, error);
            
            if (this.mongoVerifier.isEnabled()) {
              try {
                logger.info(`🔍 FALLBACK: Attempting MongoDB ownership verification for job ${jobId}`);
                const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
                
                if (mongoResult.jobExists && mongoResult.isOwned) {
                  logger.info(`✅ MONGODB_CONFIRMED: Job ${jobId} still belongs to us - continuing`);
                } else if (mongoResult.jobExists && !mongoResult.isOwned) {
                  logger.error(`🚨 MONGODB_THEFT_DETECTED: Job ${jobId} assigned to ${mongoResult.actualOwner}`);
                  logger.error(`🛑 ABORTING: Stopping processing to prevent wasted work`);
                  if (ownershipCheckInterval) clearInterval(ownershipCheckInterval);
                  throw new Error(`Job stolen by another encoder: ${mongoResult.actualOwner}`);
                } else {
                  logger.error(`🚨 VERIFICATION_IMPOSSIBLE: Cannot verify ownership of job ${jobId} via gateway OR MongoDB`);
                  logger.error(`🛑 ABORTING: Refusing to continue without ownership confirmation`);
                  logger.info(`📊 RESCUE_MODE: If job is legitimately abandoned, rescue mode will reclaim it`);
                  if (ownershipCheckInterval) clearInterval(ownershipCheckInterval);
                  throw new Error(`Cannot verify job ownership - both gateway and MongoDB verification failed`);
                }
              } catch (mongoError) {
                logger.error(`❌ MONGODB_VERIFICATION_FAILED: Could not verify job ${jobId} ownership:`, mongoError);
                logger.error(`🛑 ABORTING: Cannot verify ownership via gateway OR MongoDB - stopping to prevent wasted work`);
                logger.info(`📊 RESCUE_MODE: If job is legitimately abandoned, rescue mode will reclaim it`);
                if (ownershipCheckInterval) clearInterval(ownershipCheckInterval);
                throw mongoError;
              }
            } else {
              // No MongoDB fallback available - must abort since gateway verification failed
              logger.error(`🚨 NO_FALLBACK: MongoDB verification disabled and gateway verification failed`);
              logger.error(`🛑 ABORTING: Cannot verify job ${jobId} ownership - stopping to prevent wasted work`);
              logger.info(`📊 RESCUE_MODE: If job is legitimately abandoned, rescue mode will reclaim it`);
              if (ownershipCheckInterval) clearInterval(ownershipCheckInterval);
              throw error;
            }
          }
        }, 60000); // Check every minute during processing
      };
      
      // Start monitoring (will be cleared in finally block)
      startOwnershipMonitoring();

      // Update status to running using legacy-compatible format
      job.status = JobStatus.RUNNING;
      
      // 🎯 GATEWAY_REPORTING: Report to gateway unless in manual/offline mode
      // Skip reporting ONLY for: manual force processing, MongoDB fallback, or Gateway Aid fallback
      // DO report for: auto-assigned /myJob jobs (isAutoAssignedFromMyJob = true)
      shouldReportToGateway = !isManualForceProcessing && !usedMongoDBFallback && !usedGatewayAidFallback;
      
      if (shouldReportToGateway) {
        await this.gateway.pingJob(jobId, { 
          progressPct: 1.0,    // ⚠️ CRITICAL: Must be > 1 to trigger gateway status change
          download_pct: 100    // Download complete at this point
        });
        logger.info(`📡 Reported job start to gateway: ${jobId}`);
      } else {
        const reason = usedGatewayAidFallback ? "Gateway Aid fallback used" :
                       usedMongoDBFallback ? "MongoDB fallback used" : 
                       "manual force processing";
        logger.info(`🎯 SKIP_GATEWAY_PING: Skipping gateway ping - ${reason}, processing without gateway notifications`);
        
        // Send Gateway Aid progress update if using Gateway Aid
        if (usedGatewayAidFallback) {
          await this.gatewayAid.updateJobProgress(jobId, 1);
        }
      }

      let result: any;
      
      if (cachedResult) {
        logger.info(`🚀 SMART RETRY: Using cached result from previous attempt for ${jobId}`);
        logger.info(`💾 Skipping download/encode/upload - content already pinned and announced!`);
        result = cachedResult;
        
        // Update progress to show we're at completion phase
        if (this.dashboard) {
          this.dashboard.updateJobProgress(job.id, 95, 'notifying-gateway');
        }
      } else {
        // 🛡️ FINAL_STATUS_CHECK: Ensure MongoDB reflects we're about to process this job
        // This is the last checkpoint before encoding - ensures status=running and timestamps are set
        if (this.mongoVerifier.isEnabled()) {
          await this.mongoVerifier.ensureJobRunning(jobId, ourDID);
        }
        
        // Set current job ID for dashboard progress tracking
        this.processor.setCurrentJob(job.id);
        
        // Process the video using the unified processor
        result = await this.processor.processVideo(job, (progress: EncodingProgress) => {
          // Update progress in dashboard
          if (this.dashboard) {
            this.dashboard.updateJobProgress(job.id, progress.percent);
          }
          
          // 🎯 GATEWAY_REPORTING: Report progress unless in manual/offline mode
          if (shouldReportToGateway) {
            // Update progress with gateway (fire-and-forget to prevent memory leaks) - LEGACY FORMAT
            this.safePingJob(jobId, { 
              progress: progress.percent,        // Our internal format
              progressPct: progress.percent,     // Legacy gateway format
              download_pct: 100                  // Download always complete during encoding
            });
          } else if (usedGatewayAidFallback) {
            // Send Gateway Aid progress update
            this.gatewayAid.updateJobProgress(jobId, progress.percent).catch(err => {
              logger.warn(`⚠️ Gateway Aid progress update failed (non-critical):`, err);
            });
          }
        });
        
        // Cache the result before attempting gateway notification
        this.jobQueue.cacheResult(jobId, result);
        logger.info(`💾 Cached processing result for potential retry: ${jobId}`);
      }

      // Transform result to gateway-expected format
      const masterOutput = result[0];
      if (!masterOutput) {
        throw new Error('No master playlist output received from video processor');
      }
      
      // � DEBUG: Log the actual result structure to help diagnose format issues
      logger.info(`🔍 DEBUG: Video processing result structure:`);
      logger.info(`🔍 DEBUG: result.length = ${result.length}`);
      logger.info(`🔍 DEBUG: masterOutput keys = ${Object.keys(masterOutput || {}).join(', ')}`);
      logger.info(`🔍 DEBUG: masterOutput = ${JSON.stringify(masterOutput, null, 2)}`);
      
      // 🛡️ DEFENSIVE: Handle missing properties gracefully
      if (!masterOutput.ipfsHash) {
        throw new Error('Video processing result missing required ipfsHash property');
      }
      
      if (!masterOutput.uri) {
        logger.warn(`⚠️ Video processing result missing 'uri' property - using fallback`);
        // Try common alternative property names
        const fallbackOutput = masterOutput as any;
        masterOutput.uri = fallbackOutput.playlist || fallbackOutput.m3u8 || fallbackOutput.path || `${masterOutput.ipfsHash}/master.m3u8`;
        logger.info(`🔧 Using fallback URI: ${masterOutput.uri}`);
      }
      
      // �🛡️ Capture values for MongoDB fallback in outer scope
      completedResult = result;
      masterCID = masterOutput.ipfsHash;
      
      const gatewayResult = {
        ipfs_hash: masterOutput.ipfsHash,
        master_playlist: masterOutput.uri
      };
      
      // 🛡️ TANK MODE: Final verification before reporting to gateway
      logger.info(`🛡️ TANK MODE: Final persistence verification before gateway notification`);
      logger.info(`🔍 DEBUG: About to verify persistence for CID: ${masterOutput.ipfsHash}`);
      
      try {
        logger.info(`🔍 DEBUG: Starting verifyContentPersistence...`);
        const isContentPersisted = await this.ipfs.verifyContentPersistence(masterOutput.ipfsHash);
        logger.info(`🔍 DEBUG: Verification result: ${isContentPersisted}`);
        
        if (!isContentPersisted) {
          // 🛡️ FALLBACK: Try a simpler verification (just pin status)
          logger.warn(`⚠️ Detailed verification failed, trying simpler check...`);
          
          // Use the same endpoint where content was uploaded
          const uploadSource = this.ipfs.getLastUploadSource();
          const verificationEndpoint = uploadSource?.endpoint || 
                                       this.config.ipfs?.threespeak_endpoint || 
                                       'http://65.21.201.94:5002';
          
          logger.info(`🔍 Fallback verification against: ${uploadSource?.source || 'supernode'} (${verificationEndpoint})`);
          
          const axios = await import('axios');
          
          const pinResponse = await axios.default.post(
            `${verificationEndpoint}/api/v0/pin/ls?arg=${masterOutput.ipfsHash}&type=all`,
            null,
            { timeout: 15000 }
          );
          
          const pinData = typeof pinResponse.data === 'string' 
            ? (() => {
                const d = pinResponse.data.trim();
                if (d.startsWith('<')) throw new Error(`IPFS pin/ls returned HTML instead of JSON (likely proxy error): ${d.substring(0, 120)}`);
                return JSON.parse(d);
              })()
            : pinResponse.data;
          
          if (pinData?.Keys?.[masterOutput.ipfsHash]) {
            logger.info(`✅ Fallback verification: Content is pinned on ${uploadSource?.source || 'supernode'}, proceeding with gateway notification`);
          } else {
            throw new Error(`CRITICAL: Content ${masterOutput.ipfsHash} failed both detailed and fallback verification!`);
          }
        } else {
          logger.info(`✅ Content persistence verified - safe to report to gateway`);
        }
        
      } catch (verifyError: any) {
        // 🚨 Last resort: If verification completely fails, log but don't fail the job
        // (Content was uploaded successfully, verification might be having issues)
        logger.error(`❌ Verification failed: ${verifyError.message}`);
        logger.error(`🔍 DEBUG: Verification error details:`, verifyError);
        logger.warn(`🆘 PROCEEDING ANYWAY - Content was uploaded successfully, verification may have issues`);
        logger.warn(`🔍 Manual check recommended for hash: ${masterOutput.ipfsHash}`);
      }
      logger.info(`🔍 DEBUG: Verification phase complete, proceeding to gateway notification...`);
      logger.info(`📋 Sending result to gateway: ${JSON.stringify(gatewayResult)}`);
      
      // Complete the job with gateway (skip if offline or in manual mode or using fallback)
      let finishResponse: any = {};
      
      if (shouldReportToGateway) {
        logger.info(`🔍 DEBUG: About to call gateway.finishJob for ${jobId}...`);
        finishResponse = await this.gateway.finishJob(jobId, gatewayResult);
        logger.info(`🔍 DEBUG: Gateway finishJob response received:`, finishResponse);
        
        // � NEW: Check explicit status from February 2026 gateway update
        if (finishResponse.status === 'success') {
          logger.info(`✅ Gateway explicitly confirmed success for ${jobId}: ${finishResponse.message}`);
        } else if (finishResponse.status === 'error') {
          logger.error(`❌ Gateway reported error for ${jobId}: ${finishResponse.message || finishResponse.error}`);
          throw new Error(`Gateway completion failed: ${finishResponse.message || finishResponse.error}`);
        } else if (!finishResponse.status) {
          logger.debug(`⚠️ Gateway response missing 'status' field - backward compatible mode`);
        }
        
        // �🛡️ VERIFICATION: Did gateway actually update MongoDB?
        // Only verify if we have MongoDB access (infrastructure nodes)
        if (this.mongoVerifier?.isEnabled() && masterCID) {
          logger.info(`🔍 GATEWAY_VERIFICATION: Checking if gateway updated MongoDB for job ${jobId}...`);
          
          const gatewayUpdated = await this.verifyGatewayCompletedJob(jobId, masterCID, 3);
          
          if (!gatewayUpdated) {
            logger.error(`🚨 GATEWAY_VERIFICATION_FAILED: Gateway reported success but MongoDB was NOT updated!`);
            logger.error(`🔍 DIAGNOSIS: Gateway API bug - returned success but failed to persist to database`);
            logger.warn(`🏴‍☠️ EMERGENCY_TAKEOVER: Forcing MongoDB completion directly...`);
            
            try {
              await this.mongoVerifier.forceCompleteJob(jobId, { cid: gatewayResult.ipfs_hash });
              logger.info(`✅ TAKEOVER_SUCCESS: Job ${jobId} marked complete in MongoDB after gateway failure`);
              logger.info(`🎯 Video is now live despite gateway bug - users can watch immediately`);
            } catch (takeoverError) {
              logger.error(`❌ TAKEOVER_FAILED: Could not force complete ${jobId} in MongoDB:`, takeoverError);
              logger.error(`🚨 CRITICAL: Job may be stuck in 'processing' state - manual intervention required`);
            }
          } else {
            logger.info(`✅ GATEWAY_VERIFICATION_SUCCESS: MongoDB confirmed job ${jobId} is complete`);
          }
        }
      } else {
        const reason = usedGatewayAidFallback ? "Gateway Aid fallback (gateway unreliable)" :
                       usedMongoDBFallback ? "MongoDB fallback (gateway unreliable)" :
                       "manual force processing";
        logger.info(`🎯 SKIP_GATEWAY_FINISH: Skipping gateway.finishJob - ${reason}`);
        
        // Try Gateway Aid completion for community nodes
        if (usedGatewayAidFallback) {
          logger.info(`� GATEWAY_AID_COMPLETE: Completing job via REST API...`);
          
          try {
            const completed = await this.gatewayAid.completeJob(jobId, result);
            
            if (completed) {
              logger.info(`✅ GATEWAY_AID_SUCCESS: Job ${jobId} completed via REST API`);
              finishResponse = { success: true, duplicate: false };
            } else {
              logger.error(`❌ GATEWAY_AID_FAILED: Could not complete job ${jobId} via REST API`);
              logger.warn(`🆘 Job was processed successfully, but Gateway Aid completion failed`);
              finishResponse = { success: false, duplicate: false };
            }
          } catch (aidError) {
            logger.error(`❌ GATEWAY_AID_ERROR: Exception while completing job via REST:`, aidError);
            logger.warn(`🆘 Job was processed successfully, but Gateway Aid update failed`);
            finishResponse = { success: false, duplicate: false };
          }
        }
        // Use MongoDB completion for infrastructure nodes  
        else {
          // �🏴‍☠️ COMPLETE TAKEOVER: Update MongoDB directly when gateway is unreliable
          // 🏴‍☠️ AGGRESSIVE TAKEOVER: Use MongoDB for completion in these cases:
          // 1. Used MongoDB fallback during processing (usedMongoDBFallback)
          // 2. Job was defensively taken over (this.defensiveTakeoverJobs.has)
          // 3. Manual job processing (ownershipAlreadyConfirmed) - prefer MongoDB over unreliable gateway
          // 4. 🏠 LOCAL IPFS FALLBACK: Used local IPFS instead of supernode (check pin database)
          let usedLocalFallback = false;
          
          // 🏠 Check if this CID is in local pins database (indicates local fallback was used)
          // ✅ FIXED: Check local_fallback_enabled, not MongoDB (they're separate features!)
          const localFallbackEnabled = this.config.ipfs?.enable_local_fallback || false;
          if (localFallbackEnabled) {
            try {
              const LocalPinDatabase = (await import('./LocalPinDatabase.js')).LocalPinDatabase;
              const pinDb = new LocalPinDatabase();
              await pinDb.initialize();
              
              const localPin = await pinDb.getPin(gatewayResult.ipfs_hash);
              if (localPin) {
                usedLocalFallback = true;
                logger.info(`🏠 LOCAL_FALLBACK_DETECTED: CID ${gatewayResult.ipfs_hash} is in local pins database`);
                logger.info(`📊 Local pin created: ${localPin.created_at}, status: ${localPin.sync_status}`);
              }
            } catch (pinCheckError) {
              logger.warn(`⚠️ Could not check local pins database:`, pinCheckError);
              // Continue - this is just an optimization check
            }
          }
          
          const shouldUseMongoTakeover = (usedMongoDBFallback || 
                                         this.defensiveTakeoverJobs.has(jobId) || 
                                         isManualForceProcessing ||
                                         usedLocalFallback) && 
                                         this.mongoVerifier.isEnabled();
          
          if (shouldUseMongoTakeover) {
            const reason = usedMongoDBFallback ? "MongoDB fallback used" : 
                          this.defensiveTakeoverJobs.has(jobId) ? "defensive takeover active" : 
                          isManualForceProcessing ? "manual job processing" :
                          "local IPFS fallback used";
            logger.info(`🏴‍☠️ COMPLETE_TAKEOVER: Updating job completion directly in MongoDB (${reason})`);
            logger.info(`📊 MONGO_UPDATE: Setting job ${jobId} as complete with CID: ${gatewayResult.ipfs_hash}`);
            
            try {
              await this.mongoVerifier.forceCompleteJob(jobId, { cid: gatewayResult.ipfs_hash });
              logger.info(`✅ MONGO_SUCCESS: Job ${jobId} marked as complete in MongoDB`);
              logger.info(`🎯 TOTAL_INDEPENDENCE: Gateway bypassed completely - job done!`);
            } catch (mongoError) {
              logger.error(`❌ MONGO_COMPLETION_FAILED: Could not update MongoDB:`, mongoError);
              logger.warn(`🆘 Job was processed successfully, but MongoDB update failed`);
              // Continue anyway - the work is done, just the record update failed
            }
          }
          
          logger.info(`📋 Job ${jobId} completed successfully with result: ${JSON.stringify(gatewayResult)}`);
          finishResponse = { success: true, duplicate: false }; // Simulate successful response
        }
      }
      
      // 🚨 FIX: Always clear cached result to prevent memory leak
      this.jobQueue.clearCachedResult(jobId);
      
      // Check if this was a duplicate completion (job already done by another encoder)
      if (finishResponse.duplicate) {
        logger.info(`🎯 Job ${jobId} was already completed by another encoder - our work was successful but redundant`);
        logger.info(`💡 This is normal in distributed systems - another encoder got there first`);
        this.jobQueue.completeJob(jobId, result);
        if (this.dashboard) {
          this.dashboard.completeJob(jobId, result);
        }
        
        logger.info(`✅ Job ${jobId} marked as completed (duplicate completion handled)`);
        return; // Exit early - don't throw error
      }
      
      // Clear cached result on successful completion
      this.jobQueue.clearCachedResult(jobId);
      
      // Complete job tracking
      this.jobQueue.completeJob(jobId, result);
      if (this.dashboard) {
        this.dashboard.completeJob(jobId, result);
      }
      
      logger.info(`🎉 Gateway job completed: ${jobId}`);
      logger.info(`🛡️ TANK MODE: Content uploaded, pinned, and announced to DHT`);

    } catch (error) {
      // 🔍 CRITICAL: Don't log as "failed" yet - might be a race condition we need to skip
      logger.warn(`⚠️ Gateway job ${jobId} encountered error (investigating...):`, cleanErrorForLogging(error));
      
      // 🛡️ MONGODB FALLBACK: If we have the CID and MongoDB access, try to complete directly
      const gatewayErrorMessage = error instanceof Error ? error.message : String(error);
      const isRaceCondition = gatewayErrorMessage.includes('no longer available') || 
                             gatewayErrorMessage.includes('already assigned') ||
                             gatewayErrorMessage.includes('not assigned') ||
                             gatewayErrorMessage.includes('RACE_CONDITION_SKIP') ||
                             (error as any).isRaceCondition;
      
      // Only use MongoDB fallback if:
      // 1. We successfully processed the video (have CID)
      // 2. MongoDB verification is enabled  
      // 3. This is NOT a race condition (job stolen by another encoder)
      // 4. Gateway completion failed for infrastructure reasons
      if (masterCID && this.mongoVerifier?.isEnabled() && !isRaceCondition) {
        logger.warn(`🔄 GATEWAY_COMPLETION_FAILED: Attempting MongoDB fallback for job ${jobId}`);
        logger.info(`🎯 Video processing succeeded, CID: ${masterCID}`);
        logger.info(`🛡️ Content is safely uploaded and pinned - attempting direct database completion`);
        
        try {
          await this.mongoVerifier.forceCompleteJob(jobId, { cid: masterCID });
          
          // Mark as complete in local systems
          this.jobQueue.completeJob(jobId, completedResult);
          if (this.dashboard) {
            this.dashboard.completeJob(jobId, completedResult);
          }
          
          logger.info(`✅ MONGODB_FALLBACK_SUCCESS: Job ${jobId} completed via direct database update`);
          logger.info(`🎊 Video is now marked as complete despite gateway failure`);
          logger.info(`📊 FALLBACK_STATS: Gateway failed, MongoDB succeeded - video delivered to users`);
          
          return; // Success! Exit without failing the job
          
        } catch (mongoError) {
          logger.error(`❌ MONGODB_FALLBACK_FAILED: Could not complete job ${jobId} via database:`, mongoError);
          logger.warn(`💔 Both gateway AND MongoDB completion failed - job will be marked as failed`);
          // Continue to normal error handling
        }
      } 
      // 🆘 GATEWAY AID FALLBACK: Try Gateway Aid if MongoDB not available but we have the CID
      // ✅ FIX: Always try Gateway Aid for completion, even if job was claimed via legacy gateway
      // This is a crucial fallback when legacy gateway fails to respond after successful video processing
      // Gateway Aid may reject if it doesn't recognize the job, but it's worth attempting
      else if (masterCID && this.gatewayAid.isEnabled() && !isRaceCondition && completedResult) {
        const claimSource = usedGatewayAidFallback ? "Gateway Aid" : "legacy gateway";
        logger.warn(`🆘 GATEWAY_AID_RESCUE: Gateway failed, trying Gateway Aid fallback for job ${jobId} (claimed via ${claimSource})`);
        logger.info(`🎯 Video processing succeeded, CID: ${masterCID}`);
        logger.info(`🛡️ Content is safely uploaded and pinned - attempting Gateway Aid completion`);
        
        try {
          const completed = await this.gatewayAid.completeJob(jobId, completedResult);
          
          if (completed) {
            // Mark as complete in local systems
            this.jobQueue.completeJob(jobId, completedResult);
            if (this.dashboard) {
              this.dashboard.completeJob(jobId, completedResult);
            }
            
            logger.info(`✅ GATEWAY_AID_RESCUE_SUCCESS: Job ${jobId} completed via Gateway Aid REST API`);
            logger.info(`🎊 Video is now marked as complete despite gateway failure`);
            logger.info(`📊 FALLBACK_STATS: Gateway failed, Gateway Aid succeeded - video delivered to users`);
            
            return; // Success! Exit without failing the job
          } else {
            logger.error(`❌ GATEWAY_AID_RESCUE_FAILED: Gateway Aid returned false for job ${jobId}`);
            logger.warn(`💔 Both gateway AND Gateway Aid completion failed - job will be marked as failed`);
          }
        } catch (aidError) {
          const errorMsg = aidError instanceof Error ? aidError.message : String(aidError);
          
          // Check if Gateway Aid rejected because job wasn't claimed through it
          if (errorMsg.includes('400') || errorMsg.includes('Bad Request')) {
            logger.warn(`⚠️ GATEWAY_AID_REJECTED: Gateway Aid cannot complete job ${jobId} - likely claimed via legacy gateway`);
            logger.info(`💡 This is expected if job was claimed through legacy gateway, not Gateway Aid`);
            logger.warn(`💔 Gateway completion failed and Gateway Aid rejected - job will be marked as failed`);
          } else {
            logger.error(`❌ GATEWAY_AID_RESCUE_ERROR: Exception during Gateway Aid completion:`, aidError);
            logger.warn(`💔 Both gateway AND Gateway Aid completion failed - job will be marked as failed`);
          }
        }
      }
      else if (isRaceCondition) {
        logger.info(`🏃‍♂️ RACE_CONDITION: Skipping fallback - job ${jobId} belongs to another encoder`);
      } else if (!masterCID) {
        logger.warn(`🚨 NO_CID: Cannot use fallback - video processing did not complete successfully`);
      } else if (!this.mongoVerifier?.isEnabled() && !this.gatewayAid.isEnabled()) {
        logger.info(`🔒 NO_FALLBACK: Neither MongoDB nor Gateway Aid fallback available`);
      }
      
      // Determine if this is a retryable error and handle race conditions
      const errorMessage = error instanceof Error ? error.message : String(error);
      let isRetryable = this.isRetryableError(error);
      
      // 🛡️ DEFENSIVE: Enhanced gateway race condition detection and telemetry
      if (errorMessage.includes('no longer available') || errorMessage.includes('already assigned')) {
        logger.info(`🏃‍♂️ GATEWAY_RACE_CONDITION: Job ${jobId} was claimed by another encoder`);
        logger.info(`📊 TELEMETRY: Gateway race condition detected - evidence of gateway atomic operation bug`);
        logger.info(`🔍 DIAGNOSIS: This should return HTTP 409, not generic error message`);
        isRetryable = false; // Don't retry race conditions
        
      } else if (errorMessage.includes('status code 502')) {
        // 🚨 CRITICAL: HTTP 502 Bad Gateway - service is completely down
        logger.error(`💥 GATEWAY_COMPLETELY_DOWN: HTTP 502 for job ${jobId} - gateway service is offline`);
        logger.error(`🔍 DIAGNOSIS: nginx cannot connect to gateway backend service`);
        logger.error(`🛠️ REQUIRED_ACTION: Gateway admin must fix Docker/systemd service immediately`);
        logger.error(`⚠️ IMPACT: All encoders cannot get jobs until gateway is restored`);
        isRetryable = true; // Retry infrastructure failures
        
      } else if (errorMessage.includes('status code 504')) {
        // 🚨 HTTP 504 Gateway Timeout - upstream server didn't respond in time
        logger.warn(`⏰ GATEWAY_TIMEOUT_504: HTTP 504 for job ${jobId} - gateway upstream timeout`);
        logger.info(`🔍 DIAGNOSIS: Gateway didn't receive response from backend service within timeout window`);
        logger.info(`📊 CAUSE: High server load, slow database queries, or network congestion`);
        logger.info(`🔄 RESOLUTION: This is temporary - job will be retried automatically`);
        isRetryable = true; // Always retry 504 timeouts - they're temporary
        
      } else if (errorMessage.includes('status code 503')) {
        // 🚨 HTTP 503 Service Unavailable - temporary overload
        logger.warn(`🚨 GATEWAY_UNAVAILABLE_503: HTTP 503 for job ${jobId} - service temporarily unavailable`);
        logger.info(`🔍 DIAGNOSIS: Gateway service is overloaded or under maintenance`);
        logger.info(`🔄 RESOLUTION: This is temporary - job will be retried automatically`);
        isRetryable = true; // Always retry 503 - service will recover
        
      } else if (errorMessage.includes('status code 500')) {
        // 🛡️ DEFENSIVE: HTTP 500 during acceptJob likely indicates race condition disguised as server error
        logger.error(`🚨 GATEWAY_API_BUG: HTTP 500 for job ${jobId} during acceptJob - likely race condition disguised as server error`);
        logger.error(`📊 CRITICAL_EVIDENCE: Gateway fails to communicate job ownership information`);
        logger.error(`🔍 EXPECTED_BEHAVIOR: Should return HTTP 409 with message "Job already assigned to encoder_xyz"`);
        logger.error(`🔍 ACTUAL_BEHAVIOR: Returns HTTP 500 with generic error, hiding ownership details`);
        logger.error(`🔍 ROOT_CAUSE: Gateway acceptJob() API lacks proper conflict handling`);
        logger.error(`💡 IMPACT: Forces encoders to guess job state instead of receiving clear ownership info`);
        logger.error(`🛠️ REQUIRED_FIX: Gateway must return HTTP 409 + ownership details for assigned jobs`);
        
        // 🔍 FORENSIC: Try to get actual job status to prove this was a hidden race condition
        try {
          logger.info(`🔍 FORENSIC_INVESTIGATION: Checking actual job status after HTTP 500...`);
          const forensicStatus = await this.gateway.getJobStatus(jobId);
          if (forensicStatus.assigned_to && forensicStatus.assigned_to !== ourDID) {
            logger.error(`🎯 SMOKING_GUN: Job ${jobId} IS assigned to ${forensicStatus.assigned_to}!`);
            logger.error(`🚨 PROOF: HTTP 500 was hiding race condition - job belongs to another encoder`);
            logger.error(`� EVIDENCE: status=${forensicStatus.status}, assigned_to=${forensicStatus.assigned_to}`);
            logger.error(`⚖️ CONCLUSION: Gateway API bug confirmed - should have returned HTTP 409`);
            isRetryable = false; // Don't retry jobs that are clearly assigned to others
          } else if (!forensicStatus.assigned_to) {
            logger.warn(`🤔 Job ${jobId} shows unassigned after HTTP 500 - possible transient gateway error`);
            isRetryable = true;
          } else {
            logger.warn(`🧩 Job ${jobId} shows assigned to us after HTTP 500 - gateway inconsistency`);
            isRetryable = true;
          }
        } catch (forensicError) {
          logger.warn(`🔍 Could not perform forensic investigation on job ${jobId}:`, forensicError);
          logger.info(`�🔄 Will retry as potential temporary gateway instability (defensive approach)`);
          isRetryable = true; // Default to retrying if we can't investigate
        }
        
      } else if (errorMessage.includes('timeout')) {
        logger.warn(`⏰ GATEWAY_TIMEOUT: Job ${jobId} - gateway performance issue detected`);
        logger.info(`📊 TELEMETRY: Gateway response time exceeded configured timeout`);
        isRetryable = true; // Retry timeouts
        
      } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
        logger.error(`🔌 GATEWAY_UNREACHABLE: Job ${jobId} - network connectivity issue`);
        logger.info(`📊 TELEMETRY: Gateway network connectivity problem`);
        isRetryable = true; // Retry network issues
        
      } else {
        logger.error(`❌ UNKNOWN_GATEWAY_ERROR: Job ${jobId} failed with: ${errorMessage}`);
        logger.info(`📊 TELEMETRY: Unrecognized error pattern - may need investigation`);
        logger.info(`🔍 PLEASE_INVESTIGATE: New error type not in defensive handling logic`);
      }
      
      // 🔍 CRITICAL LOGIC FIX: Determine if we should report this as a failure
      let shouldReportFailure = true;
      let skipJobSilently = false;
      
      // Check if this was a job assignment uncertainty (not a real failure)
      if (errorMessage.includes('status code 500')) {
        // For HTTP 500 errors, check if we confirmed job ownership
        try {
          const forensicStatus = await this.gateway.getJobStatus(jobId);
          if (forensicStatus.assigned_to && forensicStatus.assigned_to !== ourDID) {
            // Job belongs to another encoder - this isn't our failure
            logger.info(`🎯 JOB_SKIP: Job ${jobId} belongs to another encoder, not reporting failure`);
            shouldReportFailure = false;
            skipJobSilently = true;
          } else if (!forensicStatus.assigned_to) {
            // Job is unassigned - we never owned it
            logger.info(`🎯 JOB_SKIP: Job ${jobId} was never assigned to us, not reporting failure`);
            shouldReportFailure = false;
            skipJobSilently = true;
          }
        } catch (forensicError) {
          // If we can't verify ownership and have MongoDB access, try that
          if (this.mongoVerifier.isEnabled()) {
            try {
              const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
              if (mongoResult.jobExists && !mongoResult.isOwned) {
                logger.info(`🎯 MONGODB_CONFIRM: Job ${jobId} belongs to another encoder, not reporting failure`);
                shouldReportFailure = false;
                skipJobSilently = true;
              } else if (!mongoResult.jobExists) {
                logger.info(`🎯 MONGODB_CONFIRM: Job ${jobId} doesn't exist, not reporting failure`);
                shouldReportFailure = false;
                skipJobSilently = true;
              }
            } catch (mongoError) {
              logger.warn(`⚠️ Could not verify job ownership via MongoDB: ${mongoError}`);
              // Default to not reporting if we can't confirm ownership
              shouldReportFailure = false;
              skipJobSilently = true;
            }
          } else {
            // No MongoDB access and can't confirm via gateway - don't report
            logger.info(`🎯 DEFENSIVE: Cannot confirm job ownership, not reporting failure`);
            shouldReportFailure = false;
            skipJobSilently = true;
          }
        }
      } else if (errorMessage.includes('Job already accepted by another encoder') || 
                 errorMessage.includes('already assigned') ||
                 errorMessage.includes('RACE_CONDITION_SKIP') ||
                 (error as any).isRaceCondition) {
        // Clear race condition - not our failure
        logger.info(`🎯 JOB_SKIP: Job ${jobId} was claimed by another encoder, not reporting failure`);
        shouldReportFailure = false;
        skipJobSilently = true;
      }
      
      // Only report failure if we confirmed we owned the job (and not offline/manual mode/fallback)
      if (shouldReportFailure && shouldReportToGateway) {
        try {
          await this.gateway.failJob(jobId, {
            error: errorMessage,
            timestamp: new Date().toISOString(),
            retryable: isRetryable,
            encoder_version: '2.0.0' // Help identify new encoder issues
          });
          logger.info(`📤 Reported job failure to gateway: ${jobId}`);
        } catch (reportError: any) {
          if (reportError.response?.status === 500) {
            logger.warn(`⚠️ Gateway server error (500) - may be due to DST/time change issues`);
            logger.warn(`🕐 Encoder time: ${new Date().toISOString()}`);
          } else {
            logger.warn(`⚠️ Failed to report job failure to gateway for ${jobId}:`, reportError.message);
          }
        }
      } else if (shouldReportFailure && !shouldReportToGateway) {
        const reason = isManualForceProcessing ? "manual processing" : 
                       usedMongoDBFallback ? "MongoDB fallback mode" :
                       "Gateway Aid fallback mode";
        logger.info(`🎯 FALLBACK_MODE: Job ${jobId} failed in ${reason} - handling via fallback`);
        logger.error(`❌ FALLBACK_PROCESSING_FAILED: ${errorMessage}`);
        
        // Report failure via Gateway Aid if applicable
        if (usedGatewayAidFallback) {
          try {
            await this.gatewayAid.failJob(jobId, errorMessage);
            logger.info(`📤 Reported job failure via Gateway Aid: ${jobId}`);
          } catch (aidError) {
            logger.warn(`⚠️ Failed to report job failure via Gateway Aid for ${jobId}:`, aidError);
          }
        }
        // Don't throw here - we still want to handle the original job failure with retry logic
      } else {
        logger.info(`✅ JOB_SKIP: Not reporting failure for ${jobId} - job assignment was uncertain`);
      }
      
      // If this was a job we never owned, don't treat it as a failure
      if (skipJobSilently) {
        logger.info(`🔄 JOB_SKIP: Silently moving to next job - ${jobId} was never ours`);
        
        // Clean up from active jobs since we're skipping
        this.activeJobs.delete(jobId);
        this.defensiveTakeoverJobs.delete(jobId); // Clean up defensive takeover tracking
        
        // Log as completed (skipped) for tracking purposes
        logger.info(`🏁 JOB_SKIPPED: Encoder ${ourDID} gracefully skipped job ${jobId} at ${new Date().toISOString()}`);
        
        return; // Exit gracefully without throwing error
      }
      
      // 🚨 CONFIRMED FAILURE: This is a real failure we owned
      logger.error(`❌ Gateway job ${jobId} FAILED (confirmed our job):`, cleanErrorForLogging(error));
      
      throw error; // Re-throw to be handled by the main job processor
    } finally {
      // 🛡️ DEFENSIVE: Cleanup monitoring interval
      if (ownershipCheckInterval) {
        clearInterval(ownershipCheckInterval);
        logger.info(`🧹 CLEANUP: Stopped ownership monitoring for job ${jobId}`);
      }
      
      this.activeJobs.delete(jobId);
      this.defensiveTakeoverJobs.delete(jobId); // Clean up defensive takeover tracking
      await this.updateDashboard();
      
      logger.info(`🏁 JOB_COMPLETE: Encoder ${ourDID} finished processing job ${jobId} at ${new Date().toISOString()}`);
    }
  }

  private getProfilesForJob(profiles: string[]) {
    const profileMap: { [key: string]: any } = {
      '1080p': { name: '1080p', size: '?x1080', width: 1920, height: 1080, bitrate: '4000k' },
      '720p': { name: '720p', size: '?x720', width: 1280, height: 720, bitrate: '2500k' },
      '480p': { name: '480p', size: '?x480', width: 854, height: 480, bitrate: '1000k' }
    };
    
    return profiles.map(p => profileMap[p] || profileMap['720p']);
  }

  private async checkForNewJobs(): Promise<void> {
    try {
      // First, update dashboard with available jobs and gateway stats
      await this.updateDashboardWithGatewayInfo();
      
      // Reset failure count on success
      const wasFailing = this.gatewayFailureCount > 0;
      this.gatewayFailureCount = 0;
      this.lastGatewaySuccess = new Date();
      
      // If we recovered from failures, restart heartbeat with normal interval
      if (wasFailing) {
        logger.info('🔄 Gateway connection recovered - switching to normal heartbeat interval');
        this.startDashboardHeartbeat();
      }
      
      // Then check if we can accept more jobs
      if (this.activeJobs.size >= (this.config.encoder?.max_concurrent_jobs || 1)) {
        logger.debug('🔄 Max concurrent jobs reached, skipping job acquisition');
        return;
      }

      // 🚀 PRIMARY METHOD: Poll /myJob for auto-assigned jobs
      let job: VideoJob | null = null;
      let jobSource: 'myJob' | 'gatewayAid' = 'myJob';
      let ownershipAlreadyConfirmed = false;

      try {
        job = await this.gateway.getMyJob();
        if (job) {
          jobSource = 'myJob';
          ownershipAlreadyConfirmed = true; // Gateway already assigned this to us
          
          if (process.env.NODE_ENV === 'development') {
            logger.info(`🎯 DEV: Job ${job.id} assigned to us via /myJob (auto-assignment)`);
          }
        }
      } catch (error) {
        // /myJob failed - fallback to Gateway Aid
        logger.warn('⚠️ /myJob polling failed, falling back to Gateway Aid');
        
        if (this.gatewayAid.isEnabled()) {
          await this.checkForGatewayAidJobs();
          return; // Gateway Aid handles its own job queueing
        } else {
          logger.warn('⚠️ Gateway Aid not enabled, cannot fallback');
          throw error;
        }
      }

      if (job) {
        // 🚨 DUPLICATE PREVENTION: Check if we're already processing this job
        if (this.activeJobs.has(job.id) || this.jobQueue.hasJob(job.id)) {
          logger.debug(`🔄 Job ${job.id} already in queue or active - skipping duplicate`);
          return;
        }
        
        logger.info(`📥 Received job ${job.id} from ${jobSource}`);
        
        // ✅ ROUND-ROBIN TRUST: /myJob uses round-robin assignment (one job → one encoder)
        // Gateway handles assignment logic and reassigns after 6 minutes of no activity
        // No validation needed - if returned by /myJob, it's definitively ours
        // Legacy race condition defenses removed (Feb 2026)
        
        // Add job to queue with ownership confirmation flag
        this.jobQueue.addGatewayJob(job, ownershipAlreadyConfirmed);
        logger.info(`📝 Job ${job.id} added to processing queue (ownership confirmed: ${ownershipAlreadyConfirmed})`);
      } else {
        logger.debug('🔍 No jobs assigned to us');
      }
    } catch (error) {
      // Increment failure count
      this.gatewayFailureCount++;
      const timeSinceLastSuccess = Date.now() - this.lastGatewaySuccess.getTime();
      
      // 🚨 Special handling for HTTP 502 (gateway completely down)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('status code 502')) {
        logger.error(`💥 GATEWAY_SERVICE_DOWN: HTTP 502 Bad Gateway - backend service is offline`);
        logger.error(`🔍 Root cause: nginx cannot connect to gateway Docker container/systemd service`);
        logger.error(`⚠️ This requires immediate sysadmin intervention to restore service`);
      }
      
      logger.warn(`⚠️ Gateway polling failed (${this.gatewayFailureCount}/${this.maxGatewayFailures}):`, error);
      
      // Only mark as offline after multiple consecutive failures
      if (this.gatewayFailureCount >= this.maxGatewayFailures) {
        logger.warn(`🚨 Gateway marked offline after ${this.gatewayFailureCount} consecutive failures`);
        if (this.dashboard) {
          this.dashboard.updateGatewayStatus(false);
        }
      } else if (this.gatewayFailureCount === 1) {
        // First failure - switch to faster heartbeat
        logger.info('🔄 First gateway failure - switching to faster heartbeat for monitoring');
        this.startDashboardHeartbeat();
      }
    }
  }

  /**
   * 🚀 GATEWAY AID PRIMARY MODE: Poll and claim jobs via REST API
   * Used when GATEWAY_AID_PRIMARY=true to bypass legacy gateway entirely
   * 
   * 🎯 FEBRUARY 2026 UPDATE: Gateway Aid now returns ALL jobs (assigned + unassigned)
   * We recognize jobs auto-assigned to us and start them immediately without claiming
   */
  private async checkForGatewayAidJobs(): Promise<void> {
    try {
      // 🔍 DEV MODE: Show we're in primary mode
      if (process.env.NODE_ENV === 'development') {
        logger.info(`🎯 DEV: GATEWAY AID PRIMARY MODE - polling REST API (legacy gateway bypassed)`);
      }

      // List ALL jobs from Gateway Aid (assigned + unassigned)
      const allJobs = await this.gatewayAid.listAvailableJobs();
      
      if (allJobs.length === 0) {
        logger.debug('🔍 No Gateway Aid jobs available');
        return;
      }

      // 🎯 PRIORITY FILTERING: Separate jobs by assignment status
      const ourDID = this.identity.getDIDKey();
      const jobsAssignedToUs: VideoJob[] = [];
      const unassignedJobs: VideoJob[] = [];
      const jobsForOthers: VideoJob[] = [];
      
      for (const job of allJobs) {
        if (job.assigned_to === ourDID) {
          jobsAssignedToUs.push(job);
        } else if (!job.assigned_to || job.assigned_to === null) {
          unassignedJobs.push(job);
        } else {
          jobsForOthers.push(job);
        }
      }
      
      // 📊 Log job distribution
      if (jobsForOthers.length > 0) {
        logger.debug(`🔍 Gateway Aid: ${jobsForOthers.length} jobs assigned to other encoders (skipped)`);
      }
      
      // 🎯 PRIORITY 1: Process jobs already assigned to us (no claiming needed)
      if (jobsAssignedToUs.length > 0) {
        logger.info(`✅ Found ${jobsAssignedToUs.length} Gateway Aid job(s) auto-assigned to us`);
        
        for (const job of jobsAssignedToUs) {
          // 🚨 DUPLICATE PREVENTION: Check if we're already processing this job
          if (this.activeJobs.has(job.id) || this.jobQueue.hasJob(job.id)) {
            logger.debug(`🔄 Job ${job.id} already in queue or active - skipping`);
            continue;
          }
          
          logger.info(`📥 Gateway Aid job ${job.id} auto-assigned to us - starting immediately`);
          
          // Add to queue with ownership pre-confirmed and Gateway Aid source flag
          this.jobQueue.addGatewayJob(job, true, true); // ownershipAlreadyConfirmed=true, gatewayAidSource=true
          logger.info(`📝 Job ${job.id} added to processing queue (auto-assigned via Gateway Aid)`);
          
          // Only process one job per cycle
          return;
        }
      }
      
      // 🎯 PRIORITY 2: Try to claim unassigned jobs (existing behavior)
      if (unassignedJobs.length > 0) {
        logger.info(`📋 Gateway Aid: ${unassignedJobs.length} unassigned job(s) available for claiming`);
        
        // 🎲 RANDOMIZE: Shuffle jobs to distribute load across encoders
        const shuffledJobs = unassignedJobs.sort(() => Math.random() - 0.5);
        
        if (process.env.NODE_ENV === 'development') {
          logger.info(`🎲 DEV: Trying ${shuffledJobs.length} unassigned jobs in randomized order`);
        }

        // 🔄 TRY MULTIPLE: Attempt to claim jobs until one succeeds
        for (const job of shuffledJobs) {
          // 🚨 DUPLICATE PREVENTION: Check if we're already processing this job
          if (this.activeJobs.has(job.id) || this.jobQueue.hasJob(job.id)) {
            logger.debug(`🔄 Job ${job.id} already in queue or active - skipping`);
            continue;
          }

          logger.info(`📥 Attempting to claim unassigned Gateway Aid job: ${job.id}`);

          // Claim the job via Gateway Aid
          const claimed = await this.gatewayAid.claimJob(job.id);
          
          if (claimed) {
            logger.info(`✅ Successfully claimed Gateway Aid job: ${job.id}`);
            
            // Add to queue for processing with Gateway Aid source flag
            this.jobQueue.addGatewayJob(job, false, true); // ownershipAlreadyConfirmed=false, gatewayAidSource=true
            logger.info(`📝 Gateway Aid job ${job.id} added to processing queue (claimed from available pool)`);
            return; // Success! Stop trying
          }
          
          // Failed to claim - another encoder got it
          logger.debug(`⚠️ Job ${job.id} already claimed by another encoder - trying next job`);
        }
        
        // Tried all available jobs, none were claimable
        logger.info(`🔄 All ${shuffledJobs.length} unassigned jobs already claimed - will retry next cycle`);
      } else {
        logger.debug('🔍 No unassigned jobs available for claiming');
      }
      
    } catch (error) {
      logger.error('❌ Gateway Aid job polling failed:', error);
    }
  }

  private async updateDashboardWithGatewayInfo(): Promise<void> {
    if (!this.dashboard) return;

    try {
      // Get available jobs and gateway stats
      const [availableJobs, gatewayStats] = await Promise.all([
        this.gateway.getAvailableJobs(),
        this.gateway.getGatewayStats()
      ]);

      // Update dashboard with available jobs
      this.dashboard.updateAvailableJobs(availableJobs);
      
      // Update gateway connection status
      this.dashboard.updateGatewayStatus(true, gatewayStats);
      
      logger.debug(`📊 Dashboard updated: ${availableJobs.length} available jobs`);
    } catch (error) {
      logger.debug('⚠️ Failed to update dashboard with gateway info:', error);
      // Don't immediately mark offline here - let checkForNewJobs handle the failure tracking
    }
  }

  private async processJob(job: VideoJob): Promise<void> {
    const jobId = job.id;
    
    // 🛡️ Variables for MongoDB fallback (scope accessible from catch blocks)  
    let completedResult: any = null;
    let masterCID: string | null = null;
    
    try {
      // 🛡️ DEFENSIVE_CHECK: Skip gateway calls if we've previously taken control via MongoDB
      if (this.defensiveTakeoverJobs.has(jobId)) {
        logger.info(`🔒 DEFENSIVE_SKIP: Job ${jobId} was previously taken via MongoDB - skipping acceptJob()`);
        this.activeJobs.set(jobId, job);
        logger.info(`✅ Job ownership confirmed via MongoDB: ${jobId}`);
      } else {
        // Accept the job normally
        await this.gateway.acceptJob(jobId);
        this.activeJobs.set(jobId, job);
        logger.info(`✅ Accepted job: ${jobId}`);
      }

      // 🔒 CRITICAL OWNERSHIP VALIDATION: Verify we actually own the job after accepting
      const ourDID = this.identity.getDIDKey();
      
      try {
        const jobStatus = await this.gateway.getJobStatus(jobId);
        logger.info(`🔍 Job ${jobId} status after accept: assigned_to=${jobStatus.assigned_to || 'null'}`);
        
        if (!jobStatus.assigned_to || jobStatus.assigned_to !== ourDID) {
          const actualOwner = jobStatus.assigned_to || 'unassigned';
          logger.error(`🚨 OWNERSHIP CONFLICT: Job ${jobId} is assigned to ${actualOwner}, but we are ${ourDID}`);
          logger.error(`🚨 Another encoder claimed this job! Aborting processing.`);
          throw new Error(`Ownership conflict: job assigned to ${actualOwner}, not us`);
        }
        
        logger.info(`✅ Confirmed ownership of job ${jobId}`);
        
      } catch (statusError: any) {
        if (statusError.message && statusError.message.includes('Ownership conflict')) {
          throw statusError; // Re-throw ownership conflicts
        }
        logger.warn(`⚠️ Failed to verify job ownership for ${jobId}, proceeding with caution:`, statusError);
      }

      // Update status to running using legacy-compatible format
      job.status = JobStatus.RUNNING;
      await this.gateway.pingJob(jobId, { 
        progressPct: 1.0,    // ⚠️ CRITICAL: Must be > 1 to trigger gateway status change
        download_pct: 100    // Download complete at this point
      });

      // Set current job ID for dashboard progress tracking
      this.processor.setCurrentJob(jobId);

      // 🛡️ FINAL_STATUS_CHECK: Ensure MongoDB reflects we're about to process this job
      if (this.mongoVerifier.isEnabled()) {
        await this.mongoVerifier.ensureJobRunning(jobId, this.identity.getDIDKey());
      }

      // Process the video
      const result = await this.processor.processVideo(job, (progress: EncodingProgress) => {
        // Update progress (fire-and-forget to prevent memory leaks) - LEGACY FORMAT
        this.safePingJob(jobId, { 
          progress: progress.percent,        // Our internal format
          progressPct: progress.percent,     // Legacy gateway format
          download_pct: 100                  // Download always complete during encoding
        });
      }, (hash: string, error: Error) => {
        // 🔄 LAZY PINNING: Queue failed pins for background retry
        this.pendingPinService.addPendingPin(hash, jobId, 0, 'directory').catch(err => {
          logger.warn(`⚠️ Failed to queue lazy pin for ${hash}:`, err.message);
        });
      });

      // Transform result to gateway-expected format
      const masterOutput = result[0];
      if (!masterOutput) {
        throw new Error('No master playlist output received from video processor');
      }
      
      // 🛡️ DEFENSIVE: Handle missing properties gracefully (legacy processJob method)
      if (!masterOutput.ipfsHash) {
        throw new Error('Video processing result missing required ipfsHash property');
      }
      
      if (!masterOutput.uri) {
        logger.warn(`⚠️ Video processing result missing 'uri' property - using fallback (legacy method)`);
        const fallbackOutput = masterOutput as any;
        masterOutput.uri = fallbackOutput.playlist || fallbackOutput.m3u8 || fallbackOutput.path || `${masterOutput.ipfsHash}/master.m3u8`;
        logger.info(`🔧 Using fallback URI: ${masterOutput.uri}`);
      }
      
      // 🛡️ Capture values for MongoDB fallback in outer scope
      completedResult = result;
      masterCID = masterOutput.ipfsHash || null;
      
      const gatewayResult = {
        ipfs_hash: masterOutput.ipfsHash,
        master_playlist: masterOutput.uri
      };
      
      logger.info(`📋 Sending result to gateway: ${JSON.stringify(gatewayResult)}`);
      
      // 🏴‍☠️ COMPLETE TAKEOVER: Skip gateway if this job was defensively taken over
      if (this.defensiveTakeoverJobs.has(jobId) && this.mongoVerifier.isEnabled()) {
        logger.info(`🏴‍☠️ COMPLETE_TAKEOVER: Job ${jobId} was defensively taken - updating MongoDB directly`);
        logger.info(`📊 MONGO_UPDATE: Setting job ${jobId} as complete with CID: ${gatewayResult.ipfs_hash}`);
        
        try {
          await this.mongoVerifier.forceCompleteJob(jobId, { cid: gatewayResult.ipfs_hash });
          logger.info(`✅ MONGO_SUCCESS: Job ${jobId} marked as complete in MongoDB`);
          logger.info(`🎯 TOTAL_INDEPENDENCE: Gateway bypassed completely - job done!`);
        } catch (mongoError) {
          logger.error(`❌ MONGO_COMPLETION_FAILED: Could not update MongoDB:`, mongoError);
          logger.warn(`🆘 Job was processed successfully, but MongoDB update failed`);
          // Don't throw - the video is processed and uploaded successfully
        }
      } else {
        // Upload results and complete job via gateway (normal flow)
        const finishResponse = await this.gateway.finishJob(jobId, gatewayResult);
        
        // 🚀 NEW: Check explicit status from February 2026 gateway update
        if (finishResponse.status === 'success') {
          logger.info(`✅ Gateway explicitly confirmed success for ${jobId}: ${finishResponse.message}`);
        } else if (finishResponse.status === 'error') {
          logger.error(`❌ Gateway reported error for ${jobId}: ${finishResponse.message || finishResponse.error}`);
          throw new Error(`Gateway completion failed: ${finishResponse.message || finishResponse.error}`);
        }
        
        logger.info(`🎉 Gateway completion successful for job: ${jobId}`);
      }
      
      logger.info(`🎉 Completed job: ${jobId}`);
      logger.info(`🛡️ TANK MODE: Content uploaded, pinned, and announced to DHT`);

    } catch (error) {
      logger.error(`❌ Job ${jobId} failed:`, cleanErrorForLogging(error));
      
      // 🛡️ MONGODB FALLBACK: If we have the CID and MongoDB access, try to complete directly
      const gatewayErrorMessage = error instanceof Error ? error.message : String(error);
      const isRaceCondition = gatewayErrorMessage.includes('no longer available') || 
                             gatewayErrorMessage.includes('already assigned') ||
                             gatewayErrorMessage.includes('not assigned') ||
                             gatewayErrorMessage.includes('RACE_CONDITION_SKIP') ||
                             (error as any).isRaceCondition;
      
      // Only use MongoDB fallback if:
      // 1. We successfully processed the video (have CID)
      // 2. MongoDB verification is enabled  
      // 3. This is NOT a race condition (job stolen by another encoder)
      // 4. Gateway completion failed for infrastructure reasons
      if (masterCID && this.mongoVerifier?.isEnabled() && !isRaceCondition) {
        logger.warn(`🔄 GATEWAY_COMPLETION_FAILED: Attempting MongoDB fallback for job ${jobId}`);
        logger.info(`🎯 Video processing succeeded, CID: ${masterCID}`);
        logger.info(`🛡️ Content is safely uploaded and pinned - attempting direct database completion`);
        
        try {
          await this.mongoVerifier.forceCompleteJob(jobId, { cid: masterCID });
          
          logger.info(`✅ MONGODB_FALLBACK_SUCCESS: Job ${jobId} completed via direct database update`);
          logger.info(`🎊 Video is now marked as complete despite gateway failure`);
          logger.info(`📊 FALLBACK_STATS: Gateway failed, MongoDB succeeded - video delivered to users`);
          
          return; // Success! Exit without failing the job
          
        } catch (mongoError) {
          logger.error(`❌ MONGODB_FALLBACK_FAILED: Could not complete job ${jobId} via database:`, mongoError);
          logger.warn(`💔 Both gateway AND MongoDB completion failed - job will be marked as failed`);
          // Continue to normal error handling
        }
      } else if (isRaceCondition) {
        logger.info(`🏃‍♂️ RACE_CONDITION: Skipping fallback - job ${jobId} belongs to another encoder`);
      } else if (!masterCID) {
        logger.warn(`🚨 NO_CID: Cannot use fallback - video processing did not complete successfully`);
      } else if (!this.mongoVerifier?.isEnabled()) {
        logger.info(`🔒 NO_FALLBACK: MongoDB fallback not available - job will be retried`);
      }
      
      try {
        await this.gateway.failJob(jobId, {
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      } catch (reportError) {
        logger.error(`Failed to report job failure for ${jobId}:`, reportError);
      }
    } finally {
      this.activeJobs.delete(jobId);
      this.defensiveTakeoverJobs.delete(jobId); // Clean up defensive takeover tracking
    }
  }

  /**
   * Manually release a stuck job
   */
  async releaseStuckJob(jobId: string): Promise<void> {
    logger.info(`🔧 Attempting to release stuck job: ${jobId}`);
    
    try {
      // Try to reject the job in the gateway to release it
      await this.gateway.rejectJob(jobId);
      logger.info(`✅ Successfully released job ${jobId} in gateway`);
    } catch (error) {
      logger.warn(`⚠️ Failed to reject job ${jobId} in gateway:`, error);
    }

    // Remove from our local tracking
    this.activeJobs.delete(jobId);
    this.defensiveTakeoverJobs.delete(jobId); // Clean up defensive takeover tracking
    this.jobQueue.abandonJob(jobId, 'Manual release of stuck job');
    
    // Update dashboard
    if (this.dashboard) {
      this.dashboard.failJob(jobId, 'Manually released stuck job');
    }
    
    logger.info(`🧹 Cleaned up local references for job: ${jobId}`);
  }

  /**
   * Manually process a specific job by job ID
   */
  async processManualJob(jobId: string): Promise<void> {
    logger.info(`🎯 Attempting to manually process job: ${jobId}`);
    
    try {
      // 🛡️ DEFENSIVE_CHECK: Skip all gateway calls if we've previously taken control via MongoDB
      if (this.defensiveTakeoverJobs.has(jobId)) {
        logger.info(`🔒 DEFENSIVE_SKIP: Job ${jobId} was previously taken via MongoDB - skipping all gateway calls`);
        logger.info(`🎯 PROCEEDING: Processing job offline without gateway communication`);
        
        // Get job details from MongoDB and process directly
        const jobDetails = await this.mongoVerifier.getJobDetails(jobId);
        if (!jobDetails) {
          throw new Error(`Job ${jobId} not found in MongoDB despite defensive takeover`);
        }
        
        return await this.processGatewayJob(jobDetails, true); // ownershipAlreadyConfirmed = true
      }
      
      // 🛡️ ENHANCED: Check MongoDB first if available (more reliable than gateway)
      let jobOwnershipConfirmed = false;
      const ourDID = this.identity.getDIDKey();
      
      if (this.mongoVerifier.isEnabled()) {
        try {
          logger.info(`🔍 Checking MongoDB for job ${jobId} ownership...`);
          const mongoResult = await this.mongoVerifier.verifyJobOwnership(jobId, ourDID);
          
          if (mongoResult.jobExists) {
            if (mongoResult.isOwned) {
              logger.info(`✅ MONGODB_CONFIRMED: Job ${jobId} is assigned to us in database`);
              logger.info(`🎯 SKIP_GATEWAY: No need to call acceptJob() - we already own this job`);
              jobOwnershipConfirmed = true;
              
              // 🏴‍☠️ MARK FOR COMPLETE TAKEOVER: Since we're using MongoDB as source of truth, mark for complete takeover
              this.defensiveTakeoverJobs.add(jobId);
              logger.info(`🔒 DEFENSIVE_MARK: Job ${jobId} marked for complete MongoDB control (manual processing)`)
            } else {
              logger.warn(`⚠️ MONGODB_CONFLICT: Job ${jobId} is assigned to another encoder: ${mongoResult.actualOwner}`);
              throw new Error(`Job ${jobId} is already assigned to another encoder: ${mongoResult.actualOwner}`);
            }
          } else {
            logger.warn(`⚠️ Job ${jobId} not found in MongoDB - may be completed or cancelled`);
          }
        } catch (mongoError) {
          logger.warn(`⚠️ MongoDB verification failed, falling back to gateway check:`, mongoError);
        }
      }
      
      // Only try gateway if MongoDB didn't confirm ownership
      if (!jobOwnershipConfirmed) {
        logger.info(`🔍 Checking gateway for job ${jobId} status...`);
        const jobStatus = await this.gateway.getJobStatus(jobId);
        
        if (!jobStatus) {
          throw new Error(`Job ${jobId} not found in gateway`);
        }
        
        logger.info(`📋 Job ${jobId} gateway status: ${jobStatus.status || 'unknown'}`);
        
        // Check if job is already assigned to us via gateway
        if (jobStatus.assigned_to === ourDID) {
          logger.info(`✅ GATEWAY_CONFIRMED: Job ${jobId} is already assigned to us`);
          logger.info(`🎯 SKIP_ACCEPT: No need to call acceptJob() - we already own this job`);
          jobOwnershipConfirmed = true;
        } else if (!jobStatus.assigned_to) {
          // Job is unassigned - need to claim it
          logger.info(`🎯 CLAIMING: Job ${jobId} is unassigned, attempting to claim via acceptJob()`);
          await this.gateway.acceptJob(jobId);
          logger.info(`✅ Successfully claimed job via gateway: ${jobId}`);
          jobOwnershipConfirmed = true;
        } else {
          // Job is assigned to someone else
          throw new Error(`Job ${jobId} is assigned to another encoder: ${jobStatus.assigned_to}`);
        }
      }
      
      if (jobOwnershipConfirmed) {
        // Check if job is already in our active jobs to prevent duplicates
        if (this.activeJobs.has(jobId)) {
          logger.warn(`⚠️ Job ${jobId} is already being processed - skipping duplicate`);
          return;
        }
        
        // 🔧 FIX: Get complete job details before processing
        let jobDetails = null;
        
        // Try MongoDB first for complete job details
        if (this.mongoVerifier.isEnabled()) {
          try {
            jobDetails = await this.mongoVerifier.getJobDetails(jobId);
            logger.info(`📋 Got complete job details from MongoDB for ${jobId}`);
          } catch (mongoError) {
            logger.warn(`⚠️ Failed to get job details from MongoDB, trying gateway:`, mongoError);
          }
        }
        
        // Fallback to gateway if MongoDB fails
        if (!jobDetails) {
          try {
            jobDetails = await this.gateway.getJobStatus(jobId);
            logger.info(`📋 Got job details from gateway for ${jobId}`);
          } catch (gatewayError) {
            logger.error(`❌ Failed to get job details from gateway:`, gatewayError);
          }
        }
        
        // Create job object with complete details or minimal fallback
        const job = jobDetails ? {
          id: jobId,
          type: 'gateway',
          status: 'accepted',
          input: jobDetails.input || { uri: 'unknown', size: 0 },
          metadata: jobDetails.metadata || {},
          profiles: jobDetails.profiles || ['1080p', '720p', '480p']
        } : {
          id: jobId,
          type: 'gateway', 
          status: 'accepted',
          input: { uri: 'unknown', size: 0 },
          metadata: { video_permlink: jobId },
          profiles: ['1080p', '720p', '480p']
        };
        
        logger.info(`🚀 Starting manual processing for job: ${jobId}`);
        this.activeJobs.set(jobId, job);
        
        // Process the job directly with ownership already confirmed
        await this.processGatewayJob(job, true); // true = ownership already confirmed
      }
      
    } catch (error) {
      logger.error(`❌ Failed to manually process job ${jobId}:`, error);
      
      // Update dashboard with failure
      if (this.dashboard) {
        this.dashboard.failJob(jobId, `Manual processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      
      throw error;
    }
  }

  /**
   * 🚀 FORCE PROCESSING: Bypass gateway completely and process job directly
   * 
   * This is the nuclear option for 3Speak infrastructure nodes:
   * 1. Query MongoDB directly for job details
   * 2. Download and process video completely
   * 3. Upload results to IPFS
   * 4. Update MongoDB directly with completion status
   * 
   * ⚠️ REQUIRES MONGODB ACCESS - Only works for 3Speak infrastructure nodes
   */
  async forceProcessJob(jobId: string): Promise<void> {
    if (!this.mongoVerifier.isEnabled()) {
      throw new Error('Force processing requires MongoDB access - only available for 3Speak infrastructure nodes');
    }

    logger.info(`🚀 FORCE_PROCESSING: Starting bypass processing for job ${jobId}`);
    logger.warn(`⚠️ TANK_MODE: Bypassing gateway completely - direct MongoDB control`);
    
    try {
      // Step 1: Get job details directly from MongoDB
      logger.info(`📊 Step 1: Querying MongoDB for job details...`);
      const jobDoc = await this.mongoVerifier.getJobDetails(jobId);
      
      if (!jobDoc) {
        throw new Error(`Job ${jobId} not found in MongoDB database`);
      }

      logger.info(`✅ Found job in MongoDB:`);
      logger.info(`   📄 Job ID: ${jobDoc.id}`);
      logger.info(`   📺 Video: ${jobDoc.metadata?.video_owner}/${jobDoc.metadata?.video_permlink}`);
      logger.info(`   📊 Status: ${jobDoc.status}`);
      logger.info(`   📥 Input: ${jobDoc.input.uri}`);
      logger.info(`   💾 Size: ${(jobDoc.input.size / 1024 / 1024).toFixed(2)} MB`);

      // Step 2: 🔒 SECURITY CHECK - Prevent processing completed jobs
      if (jobDoc.status === 'complete') {
        logger.warn(`🚨 SECURITY: Rejecting force processing request - job ${jobId} is already complete`);
        logger.info(`📊 Job status: ${jobDoc.status}`);
        if (jobDoc.result?.cid) {
          logger.info(`📹 Video CID: ${jobDoc.result.cid}`);
          logger.info(`✅ Video is already published and available`);
        }
        if (jobDoc.completed_at) {
          logger.info(`⏰ Completed at: ${jobDoc.completed_at}`);
        }
        logger.info(`🛡️ This prevents spam/abuse of the force processing feature`);
        throw new Error(`Job ${jobId} is already complete - cannot reprocess completed jobs`);
      }
      
      // Additional security checks
      if (jobDoc.status === 'deleted') {
        logger.warn(`🚨 SECURITY: Job ${jobId} is marked as deleted - cannot force process`);
        throw new Error(`Job ${jobId} has been deleted - cannot process deleted jobs`);
      }

      // 🚨 JUGGERNAUT MODE: Skip ownership checks entirely
      // Force processing bypasses ALL ownership validation - this is the nuclear option
      const ourDID = this.identity.getDIDKey();
      logger.warn(`⚠️ JUGGERNAUT_MODE: Bypassing ownership checks - forcefully claiming job regardless of current owner`);
      logger.info(`🔓 Step 2: Force claiming job (no ownership validation)...`);
      
      // Directly claim the job without checking who owns it
      await this.mongoVerifier.updateJob(jobId, {
        assigned_to: ourDID,
        assigned_date: new Date(),
        status: 'assigned',
        last_pinged: new Date()
      });
      logger.info(`✅ Force claimed job ${jobId} - ownership stolen if necessary`);

      // Step 3: Convert MongoDB job to VideoJob format for processing
      logger.info(`🔄 Step 3: Converting to internal job format...`);
      
      const videoJob: VideoJob = {
        id: jobDoc.id,
        type: 'gateway',
        status: JobStatus.RUNNING,
        created_at: jobDoc.created_at.toISOString(),
        input: {
          uri: jobDoc.input.uri,
          size: jobDoc.input.size
        },
        metadata: {
          video_owner: jobDoc.metadata?.video_owner || 'unknown',
          video_permlink: jobDoc.metadata?.video_permlink || 'unknown'
        },
        storageMetadata: jobDoc.storageMetadata || {
          app: '3speak',
          key: `${jobDoc.metadata?.video_owner}/${jobDoc.metadata?.video_permlink}/video`,
          type: 'video'
        },
        profiles: this.getProfilesForJob(['1080p', '720p', '480p']),
        output: []
      };

      // Step 5: Mark as running in MongoDB
      await this.mongoVerifier.updateJob(jobId, {
        status: 'running',
        last_pinged: new Date(),
        'progress.download_pct': 0,
        'progress.pct': 0
      });

      // Step 6: Start dashboard tracking
      if (this.dashboard) {
        this.dashboard.startJob(jobId, {
          type: 'force-processing',
          video_id: jobDoc.metadata?.video_permlink || jobId,
          input_uri: jobDoc.input.uri,
          profiles: ['1080p', '720p', '480p']
        });
      }

      // Step 7: Process the video using existing pipeline
      logger.info(`🎬 Step 4: Processing video (download → encode → upload)...`);
      
      this.processor.setCurrentJob(jobId);
      
      const result = await this.processor.processVideo(videoJob, (progress) => {
        // Update progress in MongoDB instead of gateway
        this.mongoVerifier.updateJob(jobId, {
          'progress.pct': progress.percent,
          'progress.download_pct': 100, // Download always complete during encoding
          last_pinged: new Date()
        }).catch(err => {
          logger.warn(`⚠️ Failed to update progress in MongoDB:`, err);
        });

        // Update dashboard
        if (this.dashboard) {
          this.dashboard.updateJobProgress(jobId, progress.percent, 'force-processing');
        }
      });

      // Step 8: Get master playlist CID
      const masterOutput = result[0];
      if (!masterOutput || !masterOutput.ipfsHash) {
        throw new Error('No master playlist CID received from video processor');
      }

      logger.info(`✅ Step 5: Video processing complete!`);
      logger.info(`📋 Master playlist CID: ${masterOutput.ipfsHash}`);

      // Step 9: Force complete job in MongoDB (the magic happens here!)
      logger.info(`🚀 Step 6: Force completing job in MongoDB...`);
      await this.mongoVerifier.forceCompleteJob(jobId, { cid: masterOutput.ipfsHash });

      // Step 10: Complete dashboard tracking
      if (this.dashboard) {
        this.dashboard.completeJob(jobId, result);
      }

      logger.info(`🎉 FORCE_PROCESSING_COMPLETE: Job ${jobId} processed and marked complete!`);
      logger.info(`🌟 Video should now be published automatically by 3Speak system`);
      logger.info(`🛡️ TANK_MODE: Bypassed all gateway issues - direct database control succeeded`);

    } catch (error) {
      logger.error(`❌ Force processing failed for job ${jobId}:`, error);
      
      // Try to mark as failed in MongoDB
      try {
        await this.mongoVerifier.updateJob(jobId, {
          status: 'failed',
          last_pinged: new Date(),
          error: error instanceof Error ? error.message : 'Force processing failed'
        });
      } catch (updateError) {
        logger.warn(`⚠️ Failed to update job failure in MongoDB:`, updateError);
      }

      // Update dashboard with failure
      if (this.dashboard) {
        this.dashboard.failJob(jobId, `Force processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      
      throw error;
    }
  }

  /**
   * Manually reset gateway failure tracking (useful for dashboard)
   */
  resetGatewayStatus(): void {
    this.gatewayFailureCount = 0;
    this.lastGatewaySuccess = new Date();
    logger.info('🔄 Gateway failure tracking reset manually');
    
    // Update dashboard immediately
    this.updateDashboard();
    
    // Restart heartbeat with normal interval
    this.startDashboardHeartbeat();
  }

  /**
   * Get current gateway health status
   */
  getGatewayHealth(): { 
    failureCount: number; 
    maxFailures: number; 
    isOnline: boolean; 
    lastSuccess: Date; 
    timeSinceLastSuccess: number 
  } {
    return {
      failureCount: this.gatewayFailureCount,
      maxFailures: this.maxGatewayFailures,
      isOnline: this.gatewayFailureCount < this.maxGatewayFailures,
      lastSuccess: this.lastGatewaySuccess,
      timeSinceLastSuccess: Date.now() - this.lastGatewaySuccess.getTime()
    };
  }

  /**
   * 🔄 LAZY PINNING: Start background pinning of queued content during idle time
   */
  private startLazyPinning(): void {
    // Process pending pins every 2 minutes during idle time
    const lazyPinInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(lazyPinInterval);
        return;
      }

      // Only process during idle time (no active jobs)
      if (this.activeJobs.size === 0) {
        try {
          const stats = await this.pendingPinService.getStats();
          if (stats.totalPending > 0) {
            logger.info(`🔄 LAZY PINNING: Processing ${stats.totalPending} pending pins during idle time`);
            
            // Process one pending pin
            const success = await this.processSinglePendingPin();
            if (success) {
              logger.info(`✅ LAZY PINNING: Successfully processed 1 pending pin`);
            }
          }
        } catch (error) {
          logger.debug(`⚠️ LAZY PINNING: Background processing error:`, error);
        }
      } else {
        logger.debug(`🔄 LAZY PINNING: Skipping (${this.activeJobs.size} active jobs)`);
      }
    }, 2 * 60 * 1000); // Every 2 minutes

    logger.info(`🔄 LAZY PINNING: Background processing started (2min intervals)`);
  }

  /**
   * 🗑️ AUTOMATIC GC: Schedule weekly garbage collection
   */
  private startAutomaticGarbageCollection(): void {
    // Run every Sunday at 3 AM (low-traffic time)
    // Cron format: second minute hour day-of-month month day-of-week
    this.gcCronJob = cron.schedule('0 3 * * 0', async () => {
      if (!this.isRunning) {
        logger.debug('🗑️ AUTOMATIC GC: Skipped - encoder not running');
        return;
      }

      // Wait for active jobs to complete (up to 5 minutes)
      if (this.activeJobs.size > 0) {
        logger.info(`🗑️ AUTOMATIC GC: Waiting for ${this.activeJobs.size} active jobs to complete...`);
        
        for (let i = 0; i < 10; i++) { // Check every 30s for 5 minutes
          await new Promise(resolve => setTimeout(resolve, 30000));
          if (this.activeJobs.size === 0) break;
          logger.debug(`🗑️ AUTOMATIC GC: Still waiting... ${this.activeJobs.size} jobs active`);
        }
        
        if (this.activeJobs.size > 0) {
          logger.warn(`⚠️ AUTOMATIC GC: Skipped - ${this.activeJobs.size} jobs still active after 5 minutes`);
          return;
        }
      }

      try {
        logger.info(`🗑️ AUTOMATIC GC: Starting weekly garbage collection...`);
        const startTime = Date.now();
        
        const result = await this.ipfs.runGarbageCollection();
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        this.lastGcTime = new Date();
        logger.info(`✅ AUTOMATIC GC: Completed in ${duration}s - ${result.itemsRemoved || 0} items removed`);
        
      } catch (error) {
        logger.error(`❌ AUTOMATIC GC: Failed:`, error);
        logger.error(`❌ AUTOMATIC GC: Error details:`, error instanceof Error ? error.message : String(error));
      }
    });

    logger.info(`🗑️ AUTOMATIC GC: Scheduled weekly (Sundays at 3 AM)`);
  }

  /**
   * Process a single pending pin from the queue
   */
  private async processSinglePendingPin(): Promise<boolean> {
    const pendingPin = await this.pendingPinService.getNextPendingPin();
    if (!pendingPin) {
      return false;
    }

    try {
      logger.info(`🔄 LAZY PINNING: Attempting to pin ${pendingPin.hash}`);
      
      // Use IPFS service to pin the content
      await this.ipfs.pinHash(pendingPin.hash);
      
      // Mark as successful
      await this.pendingPinService.markPinSuccessful(pendingPin.hash);
      logger.info(`✅ LAZY PINNING: Successfully pinned ${pendingPin.hash} for job ${pendingPin.job_id}`);
      
      return true;
    } catch (error) {
      logger.warn(`⚠️ LAZY PINNING: Failed to pin ${pendingPin.hash}:`, error);
      
      // The PendingPinService will handle retry logic automatically
      return false;
    }
  }

  /**
   * 🔍 VERIFY: Check if gateway actually updated MongoDB after finishJob
   * This catches cases where gateway returns success but fails to update database
   */
  private async verifyGatewayCompletedJob(jobId: string, expectedCID: string, maxRetries: number = 3): Promise<boolean> {
    // Only available for infrastructure nodes with MongoDB access
    if (!this.mongoVerifier?.isEnabled()) {
      logger.debug(`🔍 Gateway verification skipped - MongoDB not available`);
      return true; // Assume success if we can't verify
    }

    logger.info(`🔍 VERIFY: Checking if gateway updated MongoDB for job ${jobId}...`);
    logger.info(`🔍 VERIFY: Gateway consistently takes ~45s to update MongoDB after returning 200 OK`);
    logger.info(`🔍 VERIFY: Check schedule: 45s, 50s, 60s (total 60 second verification window)`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Gateway consistently takes ~45 seconds to update MongoDB after returning 200 OK
        // Check schedule: 45s, 50s, 60s (no point checking earlier)
        if (attempt > 1) {
          const waitTime = 5000; // 5s between checks (45s, 50s, 60s)
          logger.info(`🔍 VERIFY: Waiting ${waitTime/1000}s before retry ${attempt}/${maxRetries}...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          // First check - wait 45 seconds (gateway consistently takes ~45s to process)
          logger.info(`🔍 VERIFY: Waiting 45 seconds for gateway to complete internal processing...`);
          await new Promise(resolve => setTimeout(resolve, 45000));
        }

        // Query MongoDB directly for job status
        const jobDoc = await this.mongoVerifier.getJobDetails(jobId);

        if (!jobDoc) {
          logger.warn(`🔍 VERIFY: Job ${jobId} not found in MongoDB (attempt ${attempt}/${maxRetries})`);
          continue;
        }

        // Check if job is marked as complete
        if (jobDoc.status === 'complete' || jobDoc.status === 'completed') {
          // Verify the CID matches
          const jobCID = jobDoc.result?.ipfs_hash;
          
          if (jobCID === expectedCID) {
            logger.info(`✅ VERIFY: Gateway successfully updated MongoDB for job ${jobId}`);
            logger.info(`✅ VERIFY: Status = ${jobDoc.status}, CID = ${jobCID}`);
            return true;
          } else {
            logger.warn(`⚠️ VERIFY: Job ${jobId} marked complete but CID mismatch!`);
            logger.warn(`⚠️ VERIFY: Expected: ${expectedCID}, Got: ${jobCID}`);
            // Still consider this a success - gateway updated something
            return true;
          }
        }

        logger.warn(`🔍 VERIFY: Job ${jobId} status is "${jobDoc.status}" (not complete) - attempt ${attempt}/${maxRetries}`);

        if (attempt === maxRetries) {
          logger.error(`❌ VERIFY: Gateway failed to update MongoDB after ${maxRetries} attempts`);
          logger.error(`❌ VERIFY: Job ${jobId} stuck in status "${jobDoc.status}"`);
          return false;
        }

      } catch (error) {
        logger.error(`❌ VERIFY: Error checking MongoDB for job ${jobId}:`, error);
        
        if (attempt === maxRetries) {
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Check MongoDB for real-time job status updates
   */
  async checkJobStatusUpdate(jobId: string): Promise<any> {
    if (!this.mongoVerifier.isEnabled()) {
      throw new Error('Job status updates require MongoDB access - only available for 3Speak infrastructure nodes');
    }

    logger.info(`🔍 CHECKING_UPDATES: Getting real-time status for job ${jobId} from MongoDB...`);
    
    try {
      const statusUpdate = await this.mongoVerifier.getJobStatusUpdate(jobId);
      
      if (!statusUpdate.exists) {
        logger.warn(`❌ Job ${jobId} not found in MongoDB - may have been deleted`);
        return {
          found: false,
          status: 'not_found',
          message: 'Job not found in database - may have been deleted',
          timestamp: new Date().toISOString()
        };
      }

      // Analyze the status and provide helpful context
      let analysis = '';
      let recommendation = '';
      
      switch (statusUpdate.status) {
        case 'complete':
          analysis = '✅ Job completed successfully';
          recommendation = statusUpdate.result?.cid 
            ? `Video is published with CID: ${statusUpdate.result.cid}` 
            : 'Job marked complete but no CID found - may need investigation';
          break;
          
        case 'running':
        case 'assigned':
          const assignedTo = statusUpdate.assigned_to || 'unknown encoder';
          analysis = `🔄 Job is currently being processed by: ${assignedTo}`;
          recommendation = 'Wait for completion or check if encoder is stuck';
          break;
          
        case 'failed':
          analysis = '❌ Job failed in database';
          recommendation = 'Safe to retry or force process if needed';
          break;
          
        case 'pending':
        case 'queued':
          analysis = '⏳ Job is waiting to be processed';
          recommendation = 'Job should be picked up automatically by available encoders';
          break;
          
        default:
          analysis = `❓ Unknown status: ${statusUpdate.status}`;
          recommendation = 'Manual investigation may be required';
      }

      // Check if job has been recently active
      const lastPing = statusUpdate.last_pinged ? new Date(statusUpdate.last_pinged) : null;
      const now = new Date();
      const timeSinceLastPing = lastPing ? Math.floor((now.getTime() - lastPing.getTime()) / 60000) : null;
      
      let activityStatus = '';
      if (lastPing && timeSinceLastPing !== null) {
        if (timeSinceLastPing < 5) {
          activityStatus = '🟢 Recently active (last ping < 5 min ago)';
        } else if (timeSinceLastPing < 30) {
          activityStatus = '🟡 Moderately active (last ping < 30 min ago)';
        } else {
          activityStatus = `🔴 Stale (last ping ${timeSinceLastPing} minutes ago)`;
        }
      } else {
        activityStatus = '⚫ No recent activity recorded';
      }

      const result = {
        found: true,
        status: statusUpdate.status,
        assigned_to: statusUpdate.assigned_to,
        analysis,
        recommendation,
        activity_status: activityStatus,
        last_pinged: statusUpdate.last_pinged,
        completed_at: statusUpdate.completed_at,
        progress: statusUpdate.progress,
        result: statusUpdate.result,
        error_message: statusUpdate.error_message,
        metadata: statusUpdate.metadata,
        timestamp: new Date().toISOString()
      };

      logger.info(`📋 STATUS_UPDATE: ${analysis}`);
      logger.info(`💡 RECOMMENDATION: ${recommendation}`);
      logger.info(`📊 ACTIVITY: ${activityStatus}`);
      
      return result;

    } catch (error) {
      logger.error(`❌ Failed to check job status update for ${jobId}:`, error);
      throw error;
    }
  }

  // ===========================================
  // IPFS STORAGE ADMINISTRATION METHODS
  // ===========================================

  /**
   * Get all pinned items with metadata
   */
  async getPinnedItems(): Promise<any[]> {
    try {
      logger.info(`🔍 STORAGE_ADMIN: Listing all pinned items...`);

      // Use the public IPFS service method
      return await this.ipfs.getPinnedItems();

    } catch (error) {
      logger.error(`❌ STORAGE_ADMIN: Failed to list pinned items:`, error);
      throw new Error(`Failed to list pinned items: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get detailed information about a specific pin
   */
  async getPinDetails(cid: string): Promise<any> {
    try {
      logger.info(`🔍 STORAGE_ADMIN: Getting details for pin ${cid}...`);

      // Use the public IPFS service method
      return await this.ipfs.getPinDetails(cid);

    } catch (error) {
      logger.error(`❌ STORAGE_ADMIN: Failed to get pin details for ${cid}:`, error);
      throw new Error(`Failed to get pin details: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Migrate pins to supernode
   */
  async migratePinsToSupernode(cids: string[]): Promise<any> {
    try {
      logger.info(`🚀 STORAGE_ADMIN: Migrating ${cids.length} pins to supernode...`);

      // Use the public IPFS service method
      return await this.ipfs.migratePinsToSupernode(cids);

    } catch (error) {
      logger.error(`❌ STORAGE_ADMIN: Migration failed:`, error);
      throw new Error(`Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Unpin items locally
   */
  async unpinItemsLocally(cids: string[]): Promise<any> {
    try {
      logger.info(`🗑️ STORAGE_ADMIN: Unpinning ${cids.length} items locally...`);

      // Use the public IPFS service method
      return await this.ipfs.unpinItemsLocally(cids);

    } catch (error) {
      logger.error(`❌ STORAGE_ADMIN: Unpinning failed:`, error);
      throw new Error(`Unpinning failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Run garbage collection
   */
  async runGarbageCollection(): Promise<any> {
    try {
      logger.info(`🗑️ STORAGE_ADMIN: Running IPFS garbage collection...`);

      // Use the public IPFS service method
      return await this.ipfs.runGarbageCollection();

    } catch (error) {
      logger.error(`❌ STORAGE_ADMIN: Garbage collection failed:`, error);
      throw new Error(`Garbage collection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<any> {
    try {
      logger.info(`📊 STORAGE_ADMIN: Getting storage statistics...`);

      // Use the public IPFS service method
      return await this.ipfs.getStorageStats();

    } catch (error) {
      logger.error(`❌ STORAGE_ADMIN: Failed to get storage stats:`, error);
      throw new Error(`Failed to get storage stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}