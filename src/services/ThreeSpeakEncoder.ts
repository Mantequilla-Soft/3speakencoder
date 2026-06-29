import { EncoderConfig } from '../config/ConfigLoader.js';
import { VideoJob, JobStatus, EncodingProgress } from '../types/index.js';
import { logger } from './Logger.js';
import { VideoProcessor } from './VideoProcessor.js';
import { IPFSService } from './IPFSService.js';
import { IdentityService } from './IdentityService.js';
import { DashboardService } from './DashboardService.js';
import { DirectApiService } from './DirectApiService.js';
import { DirectJob } from '../types/DirectApi.js';
import { JobQueue } from './JobQueue.js';
import { PendingPinService } from './PendingPinService.js';
import { PinSyncService } from './PinSyncService.js';
import { EmbedPollerService } from './EmbedPollerService.js';
import cron from 'node-cron';
import { cleanErrorForLogging } from '../common/errorUtils.js';
import pkg from '../../package.json';

const ENCODER_VERSION = pkg.version;

export class ThreeSpeakEncoder {
  private config: EncoderConfig;
  private processor: VideoProcessor;
  private ipfs: IPFSService;
  private identity: IdentityService;
  private dashboard?: DashboardService;
  private directApi?: DirectApiService;
  private jobQueue: JobQueue;
  private pendingPinService: PendingPinService;
  private pinSyncService?: PinSyncService;
  private embedPoller?: EmbedPollerService;
  private isRunning: boolean = false;
  private activeJobs: Map<string, any> = new Map();
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
    this.jobQueue = new JobQueue(
      config.encoder?.max_concurrent_jobs || 1,
      5,
      3 * 60 * 1000
    );
    this.pendingPinService = new PendingPinService('./data', config, this.ipfs.getClient());

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

      await this.identity.initialize();
      logger.info('✅ Identity service ready');

      logger.info(`📦 Encoder version: ${ENCODER_VERSION}`);

      await this.ipfs.initialize();
      logger.info('✅ IPFS service ready');

      await this.processor.initialize();
      logger.info('✅ Video processor ready');

      await this.pendingPinService.initialize();
      logger.info('✅ Pending pin service ready');

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

      if (this.directApi) {
        await this.directApi.start();
        logger.info(`✅ Direct API service started on port ${this.config.direct_api?.port || 3002}`);
      }

      if (this.config.embed_system?.enabled) {
        const embedMode = this.config.embed_system.mode || 'community';

        if (embedMode === 'community') {
          try {
            this.embedPoller = new EmbedPollerService(this.config, this.identity, this.jobQueue);
            await this.embedPoller.start();
            logger.info('✅ Embed system community poller started');
          } catch (error) {
            logger.error('❌ Embed system community poller failed to start:', error);
            logger.warn('🔄 Encoder will continue without embed system polling');
          }
        } else if (embedMode === 'managed') {
          if (!this.directApi) {
            logger.error('❌ Embed system managed mode requires DIRECT_API_ENABLED=true');
          } else {
            logger.info(`✅ Embed system managed mode active (via Direct API on port ${this.config.direct_api?.port || 3002})`);
          }
        }
      }

      this.isRunning = true;

      this.startJobProcessor();
      this.startDashboardHeartbeat();
      this.startLazyPinning();

      if (this.config.ipfs?.enable_local_fallback) {
        this.startAutomaticGarbageCollection();

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
        }, 60000);
      }

      await this.updateDashboard();
      logger.info('🎯 3Speak Encoder is fully operational!');

    } catch (error) {
      logger.error('❌ Failed to start encoder:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info('🛑 Stopping encoder...');
    this.isRunning = false;
    await this.updateDashboard();

    if (this.embedPoller) {
      await this.embedPoller.stop();
      logger.info('✅ Embed system poller stopped');
    }

    if (this.directApi) {
      await this.directApi.stop();
      logger.info('✅ Direct API service stopped');
    }

    if (this.pinSyncService) {
      await this.pinSyncService.stop();
      logger.info('✅ Pin sync service stopped');
    }

    if (this.gcCronJob) {
      this.gcCronJob.stop();
      logger.info('✅ Automatic GC stopped');
    }

    this.activeJobs.clear();
    logger.info('✅ Encoder stopped');
  }

  private async updateDashboard(): Promise<void> {
    if (this.dashboard) {
      let peerId = 'Not connected';
      try {
        peerId = await this.ipfs.getPeerId();
      } catch (error) {
        logger.debug('Failed to get IPFS peer ID for dashboard:', error);
      }

      this.dashboard.updateNodeStatus({
        online: this.isRunning,
        registered: this.isRunning,
        didKey: this.identity?.getDIDKey() || 'Not initialized',
        ipfsPeerId: peerId,
        activeJobs: this.activeJobs.size,
        totalJobs: this.jobQueue.getTotalCount(),
        lastJobCheck: new Date().toISOString(),
        nodeName: this.config.node?.name || 'Unknown',
        gcStats: {
          lastGcTime: this.lastGcTime?.toISOString() || null
        },
        versionInfo: {
          current: ENCODER_VERSION
        }
      });
    }
  }

  private startJobProcessor(): void {
    cron.schedule('*/5 * * * * *', async () => {
      if (!this.isRunning) return;
      try {
        this.jobQueue.processRetries();
        await this.processQueuedJobs();
      } catch (error) {
        logger.warn('⚠️ Job processing failed:', error);
      }
    });

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
    cron.schedule('*/30 * * * * *', async () => {
      if (!this.isRunning) return;
      try {
        await this.updateDashboard();
        logger.debug('📊 Dashboard heartbeat sent');
      } catch (error) {
        logger.debug('⚠️ Dashboard heartbeat failed:', error);
      }
    });

    logger.info('💓 Dashboard heartbeat started (30s interval)');
    this.startMemoryManagement();
  }

  private startMemoryManagement(): void {
    setInterval(() => {
      this.jobQueue.cleanupOldCache();

      const usage = process.memoryUsage();
      const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
      const totalMB = Math.round(usage.heapTotal / 1024 / 1024);

      logger.debug(`🧠 Memory: ${heapMB}MB heap / ${totalMB}MB total`);

      if (heapMB > 1500) {
        logger.warn(`⚠️ HIGH MEMORY USAGE: ${heapMB}MB heap / ${totalMB}MB total - potential leak!`);
        if (global.gc) {
          global.gc();
          const newUsage = process.memoryUsage();
          const newHeapMB = Math.round(newUsage.heapUsed / 1024 / 1024);
          logger.info(`🗑️ Forced GC: ${heapMB}MB → ${newHeapMB}MB (freed ${heapMB - newHeapMB}MB)`);
        }
      }

      if (heapMB > 10000) {
        logger.error(`🚨 CRITICAL MEMORY LEAK DETECTED: ${heapMB}MB heap usage!`);
        logger.error(`🚨 Active jobs: ${Array.from(this.activeJobs.keys()).join(', ')}`);
        import('child_process').then(({ exec }) => {
          exec('pkill -9 ffmpeg', (error) => {
            if (error) logger.warn('Could not kill FFmpeg processes:', error.message);
            else logger.info('🔪 Killed all FFmpeg processes');
            process.exit(1);
          });
        }).catch(() => process.exit(1));
      }
    }, 5 * 60 * 1000);

    logger.info('🧠 Memory management started (5min intervals)');
  }

  private async detectAndHandleStuckJobs(): Promise<void> {
    const stuckJobs = this.jobQueue.detectStuckJobs(3600000, 14400000);

    for (const jobId of stuckJobs) {
      const job = this.jobQueue.getJob(jobId);
      if (!job) continue;

      logger.warn(`🚨 Detected stuck job: ${jobId} (no progress for 1h or running >4h)`);

      try {
        this.processor.cancelJob(jobId);
      } catch (cancelError) {
        logger.warn(`⚠️ Failed to cancel processes for stuck job ${jobId}:`, cancelError);
      }

      this.jobQueue.abandonJob(jobId, 'Job stuck for over 1 hour');

      const directJob = job as DirectJob;
      if (directJob.request?.webhook_url) {
        try {
          const { WebhookService } = await import('./WebhookService.js');
          const ws = new WebhookService();
          await ws.sendWebhook(directJob.request.webhook_url, {
            owner: directJob.request.owner,
            permlink: directJob.request.permlink,
            input_cid: directJob.request.input_cid,
            status: 'failed',
            progress: 0,
            job_id: jobId,
            processing_time_seconds: 0,
            qualities_encoded: [],
            encoder_id: this.config.node?.name || 'unknown',
            error: 'Job timed out — no progress for 1 hour or running longer than 4 hours',
            timestamp: new Date().toISOString()
          }, directJob.request.api_key);
          logger.info(`🔔 Sent timeout failure webhook for job ${jobId}`);
        } catch (err) {
          logger.warn(`⚠️ Failed to send timeout webhook for job ${jobId}:`, err);
        }
      }

      if (this.dashboard) {
        this.dashboard.failJob(jobId, 'Job abandoned due to timeout');
      }
    }
  }

  private isRetryableError(error: any): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode = error?.status || error?.response?.status;

    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('timeout') || errorMessage.includes('network')) {
      return true;
    }
    if (statusCode >= 500 && statusCode < 600) return true;
    if (statusCode === 429) return true;
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 408) return false;
    if (errorMessage.includes('ffmpeg') || errorMessage.includes('No such file')) return false;
    return true;
  }

  private async processQueuedJobs(): Promise<void> {
    if (this.activeJobs.size >= (this.config.encoder?.max_concurrent_jobs || 1)) return;

    const job = this.jobQueue.getNextJob();
    if (!job) return;

    try {
      await this.processDirectJob(job as DirectJob);
    } catch (error) {
      logger.error(`❌ Job ${job.id} failed:`, cleanErrorForLogging(error));
      const isRetryable = this.isRetryableError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.jobQueue.failJob(job.id, errorMessage, isRetryable);

      if (this.dashboard) {
        const retryInfo = this.jobQueue.getRetryInfo(job.id);
        if (retryInfo && retryInfo.attempts < retryInfo.maxAttempts) {
          this.dashboard.updateJobProgress(job.id, 0, 'retry-pending', {
            error: errorMessage,
            retryAttempt: retryInfo.attempts,
            maxAttempts: retryInfo.maxAttempts,
            nextRetry: retryInfo.nextRetry
          });
        } else {
          this.dashboard.failJob(job.id, errorMessage);
        }
      }
    }
  }

  private async processDirectJob(job: DirectJob): Promise<void> {
    this.activeJobs.set(job.id, job);
    const request = job.request;

    const isShortVideo = request.short === true;
    const isPremium = request.premium === true;

    if (this.dashboard) {
      this.dashboard.startJob(job.id, {
        type: 'direct-api',
        video_id: `${request.owner}/${request.permlink}`,
        input_uri: `ipfs://${request.input_cid}`,
        profiles: isShortVideo ? ['480p'] : (isPremium ? ['1080p', '720p', '480p'] : ['480p']),
        webhook_url: request.webhook_url
      });
    }

    await this.updateDashboard();

    try {
      const startTime = Date.now();

      let sanitizedCid = request.input_cid;
      const cidFromUrl = sanitizedCid.match(/\/ipfs\/([a-zA-Z0-9]+)/);
      if (cidFromUrl) {
        logger.warn(`⚠️ input_cid contains a full URL, extracting bare CID: ${cidFromUrl[1]}`);
        sanitizedCid = cidFromUrl[1] ?? sanitizedCid;
      } else if (sanitizedCid.startsWith('ipfs://')) {
        sanitizedCid = sanitizedCid.replace('ipfs://', '');
      }
      sanitizedCid = sanitizedCid.replace(/^https?:\/\//, '').trim();

      const videoJob: VideoJob = {
        id: job.id,
        status: JobStatus.QUEUED,
        created_at: new Date().toISOString(),
        input: {
          uri: `ipfs://${sanitizedCid}`,
          size: 0
        },
        metadata: {
          video_owner: request.owner,
          video_permlink: request.permlink
        },
        storageMetadata: {
          app: request.frontend_app || 'direct-api',
          key: `${request.owner}/${request.permlink}`,
          type: 'direct'
        },
        profiles: this.getProfilesForJob(isShortVideo ? ['480p'] : (isPremium ? ['1080p', '720p', '480p'] : ['480p'])),
        output: [],
        short: request.short,
        ...(request.premium !== undefined ? { premium: request.premium } : {}),
        webhook_url: request.webhook_url,
        api_key: request.api_key,
        ...(request.originalFilename !== undefined ? { originalFilename: request.originalFilename } : {})
      };

      let lastPingTime = 0;
      let lastPingProgress = 0;
      const PING_INTERVAL_MS = 10000;
      const PING_PROGRESS_THRESHOLD = 5;

      const progressCallback = (progress: EncodingProgress) => {
        this.jobQueue.updateProgress(job.id, progress.percent);

        if (this.dashboard) {
          this.dashboard.updateJobProgress(job.id, progress.percent);
        }

        if (request.webhook_url) {
          const now = Date.now();
          const timeSinceLastPing = now - lastPingTime;
          const progressDelta = Math.abs(progress.percent - lastPingProgress);

          if (timeSinceLastPing >= PING_INTERVAL_MS || progressDelta >= PING_PROGRESS_THRESHOLD) {
            lastPingTime = now;
            lastPingProgress = progress.percent;

            import('./WebhookService.js').then(({ WebhookService }) => {
              const webhookService = new WebhookService();
              webhookService.sendProgressPing(
                request.webhook_url!,
                request.owner,
                request.permlink,
                progress.percent,
                progress.profile,
                request.api_key
              ).catch(() => {});
            });
          }
        }
      };

      this.processor.setCurrentJob(job.id);
      const result = await this.processor.processVideo(videoJob, progressCallback);
      const processingTimeSeconds = (Date.now() - startTime) / 1000;

      this.jobQueue.completeJob(job.id, result);

      if (this.dashboard) {
        this.dashboard.completeJob(job.id, result);
      }

      logger.info(`✅ Direct job completed: ${job.id} (${request.owner}/${request.permlink})`);

      if (request.webhook_url) {
        try {
          const manifestCid = result[0]?.ipfsHash || '';
          const qualitiesEncoded = result.map(r => r.profile).filter(p => p !== 'master');

          const webhookPayload: any = {
            owner: request.owner,
            permlink: request.permlink,
            input_cid: request.input_cid,
            status: 'complete',
            progress: 100,
            manifest_cid: manifestCid,
            video_url: `ipfs://${manifestCid}/manifest.m3u8`,
            job_id: job.id,
            processing_time_seconds: processingTimeSeconds,
            qualities_encoded: qualitiesEncoded,
            encoder_id: this.config.node?.name || 'unknown',
            timestamp: new Date().toISOString()
          };

          if (request.frontend_app) webhookPayload.frontend_app = request.frontend_app;
          if (request.originalFilename) webhookPayload.originalFilename = request.originalFilename;

          const { WebhookService } = await import('./WebhookService.js');
          const webhookService = new WebhookService();
          await webhookService.sendWebhook(request.webhook_url, webhookPayload, request.api_key);
          logger.info(`✅ Webhook delivered for ${request.owner}/${request.permlink}`);
        } catch (webhookError) {
          logger.warn(`⚠️ Webhook delivery failed for job ${job.id}:`, webhookError);
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ Direct job ${job.id} failed:`, cleanErrorForLogging(error));

      this.jobQueue.failJob(job.id, errorMessage);

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

  private getProfilesForJob(profiles: string[]) {
    const profileMap: { [key: string]: any } = {
      '1080p': { name: '1080p', size: '?x1080', width: 1920, height: 1080, bitrate: '4000k' },
      '720p':  { name: '720p',  size: '?x720',  width: 1280, height: 720,  bitrate: '2500k' },
      '480p':  { name: '480p',  size: '?x480',  width: 854,  height: 480,  bitrate: '1000k' }
    };
    return profiles.map(p => profileMap[p] || profileMap['720p']);
  }

  /**
   * Release a stuck job — abandon it locally and cancel any running process.
   * Called by DashboardService via /api/maintenance/release-job.
   */
  async releaseStuckJob(jobId: string): Promise<void> {
    logger.info(`🔧 Releasing stuck job: ${jobId}`);

    try {
      this.processor.cancelJob(jobId);
    } catch (error) {
      logger.warn(`⚠️ Failed to cancel processor for job ${jobId}:`, error);
    }

    this.activeJobs.delete(jobId);
    this.jobQueue.abandonJob(jobId, 'Manual release of stuck job');

    if (this.dashboard) {
      this.dashboard.failJob(jobId, 'Manually released stuck job');
    }

    logger.info(`🧹 Cleaned up local references for job: ${jobId}`);
  }

  // ===========================================
  // LAZY PINNING
  // ===========================================

  private startLazyPinning(): void {
    const lazyPinInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(lazyPinInterval);
        return;
      }

      if (this.activeJobs.size === 0) {
        try {
          const stats = await this.pendingPinService.getStats();
          if (stats.totalPending > 0) {
            logger.info(`🔄 LAZY PINNING: Processing ${stats.totalPending} pending pins during idle time`);
            const success = await this.processSinglePendingPin();
            if (success) logger.info('✅ LAZY PINNING: Successfully processed 1 pending pin');
          }
        } catch (error) {
          logger.debug('⚠️ LAZY PINNING: Background processing error:', error);
        }
      } else {
        logger.debug(`🔄 LAZY PINNING: Skipping (${this.activeJobs.size} active jobs)`);
      }
    }, 2 * 60 * 1000);

    logger.info('🔄 LAZY PINNING: Background processing started (2min intervals)');
  }

  private async processSinglePendingPin(): Promise<boolean> {
    const pendingPin = await this.pendingPinService.getNextPendingPin();
    if (!pendingPin) return false;

    try {
      logger.info(`🔄 LAZY PINNING: Attempting to pin ${pendingPin.hash}`);
      await this.ipfs.pinHash(pendingPin.hash);
      await this.pendingPinService.markPinSuccessful(pendingPin.hash);
      logger.info(`✅ LAZY PINNING: Successfully pinned ${pendingPin.hash} for job ${pendingPin.job_id}`);
      return true;
    } catch (error) {
      logger.warn(`⚠️ LAZY PINNING: Failed to pin ${pendingPin.hash}:`, error);
      return false;
    }
  }

  // ===========================================
  // AUTOMATIC GARBAGE COLLECTION
  // ===========================================

  private startAutomaticGarbageCollection(): void {
    this.gcCronJob = cron.schedule('0 3 * * 0', async () => {
      if (!this.isRunning) return;

      if (this.activeJobs.size > 0) {
        logger.info(`🗑️ AUTOMATIC GC: Waiting for ${this.activeJobs.size} active jobs to complete...`);
        for (let i = 0; i < 10; i++) {
          await new Promise(resolve => setTimeout(resolve, 30000));
          if (this.activeJobs.size === 0) break;
        }
        if (this.activeJobs.size > 0) {
          logger.warn(`⚠️ AUTOMATIC GC: Skipped - jobs still active`);
          return;
        }
      }

      try {
        logger.info('🗑️ AUTOMATIC GC: Starting weekly garbage collection...');
        const startTime = Date.now();
        const result = await this.ipfs.runGarbageCollection();
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        this.lastGcTime = new Date();
        logger.info(`✅ AUTOMATIC GC: Completed in ${duration}s - ${(result as any)?.itemsRemoved || 0} items removed`);
      } catch (error) {
        logger.error('❌ AUTOMATIC GC: Failed:', error);
      }
    });

    logger.info('🗑️ AUTOMATIC GC: Scheduled weekly (Sundays at 3 AM)');
  }

  // ===========================================
  // IPFS STORAGE ADMINISTRATION
  // ===========================================

  async getPinnedItems(): Promise<any[]> {
    return await this.ipfs.getPinnedItems();
  }

  async getPinDetails(cid: string): Promise<any> {
    return await this.ipfs.getPinDetails(cid);
  }

  async migratePinsToSupernode(cids: string[]): Promise<any> {
    return await this.ipfs.migratePinsToSupernode(cids);
  }

  async unpinItemsLocally(cids: string[]): Promise<any> {
    return await this.ipfs.unpinItemsLocally(cids);
  }

  async runGarbageCollection(): Promise<any> {
    return await this.ipfs.runGarbageCollection();
  }

  async getStorageStats(): Promise<any> {
    return await this.ipfs.getStorageStats();
  }
}
