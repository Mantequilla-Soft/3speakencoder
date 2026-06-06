import { VideoJob, VideoProfile } from '../types/index.js';
import { DirectJob, DirectJobRequest } from '../types/DirectApi.js';
import { VideoProcessor } from './VideoProcessor.js';
import { GatewayClient } from './GatewayClient.js';
import { WebhookService } from './WebhookService.js';
import { JobQueue, QueuedJob } from './JobQueue.js';
import { JobStatus } from '../types/index.js';
import { logger } from './Logger.js';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class JobProcessor {
  private videoProcessor: VideoProcessor;
  private gatewayClient: GatewayClient;
  private webhookService: WebhookService;
  private jobQueue: JobQueue;

  constructor(
    videoProcessor: VideoProcessor,
    gatewayClient: GatewayClient,
    jobQueue: JobQueue
  ) {
    this.videoProcessor = videoProcessor;
    this.gatewayClient = gatewayClient;
    this.webhookService = new WebhookService();
    this.jobQueue = jobQueue;
  }

  async processJob(job: QueuedJob): Promise<void> {
    if (job.type === 'direct') {
      await this.processDirectJob(job as DirectJob);
    } else {
      await this.processGatewayJob(job as VideoJob);
    }
  }

  /**
   * 🚨 MEMORY SAFE: Fire-and-forget ping job to prevent promise accumulation
   */
  private safePingJob(jobId: string, status: any): void {
    // Use setImmediate to ensure this runs asynchronously without creating
    // a promise that could accumulate in memory during network issues
    setImmediate(async () => {
      try {
        await this.gatewayClient.pingJob(jobId, status);
      } catch (error: any) {
        // Log but don't propagate errors to prevent memory leaks
        const errorMsg = error?.message || error?.code || error?.toString() || 'Unknown error';
        logger.warn(`Failed to update gateway progress for ${jobId}: ${errorMsg}`);
      }
    });
  }

  private async processGatewayJob(job: VideoJob): Promise<void> {
    const jobId = job.id;
    
    try {
      logger.info(`🚀 Processing gateway job: ${jobId}`);

      // Accept the job with gateway
      await this.gatewayClient.acceptJob(jobId);
      
      // Update status to running
      await this.gatewayClient.pingJob(jobId, { status: JobStatus.RUNNING });

      // Process the video with progress callback
      const result = await this.videoProcessor.processVideo(job, (progress) => {
        this.jobQueue.updateProgress(jobId, progress.percent);
        
        // Update gateway with progress (fire-and-forget to prevent memory leaks)
        this.safePingJob(jobId, { 
          status: JobStatus.RUNNING,
          progress: progress.percent 
        });
      });

      // Upload results and complete job
      await this.gatewayClient.finishJob(jobId, result);
      this.jobQueue.completeJob(jobId, result);
      
      logger.info(`✅ Gateway job completed: ${jobId}`);
      logger.info(`🛡️ TANK MODE: Content uploaded, pinned, and announced to DHT`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`❌ Gateway job ${jobId} failed:`, cleanErrorForLogging(error));
      
      try {
        await this.gatewayClient.failJob(jobId, {
          error: errorMessage,
          timestamp: new Date().toISOString()
        });
      } catch (reportError) {
        logger.error(`Failed to report gateway job failure for ${jobId}:`, reportError);
      }
      
      this.jobQueue.failJob(jobId, errorMessage);
    }
  }

  private async processDirectJob(job: DirectJob): Promise<void> {
    const jobId = job.id;
    const request = job.request;
    
    try {
      logger.info(`🚀 Processing direct job: ${jobId} (${request.owner}/${request.permlink}, short: ${request.short})`);

      // Convert DirectJob to VideoJob format for processing
      // NOTE: type must NOT be 'gateway' — VideoProcessor uses type !== 'gateway' to
      // identify direct jobs and apply the correct profile set (480p for non-premium).
      const videoJob: VideoJob = {
        id: jobId,
        status: JobStatus.RUNNING,
        created_at: job.created_at,
        input: {
          uri: `ipfs://${request.input_cid}`, // Use input_cid with ipfs:// prefix
          size: 0 // Unknown for direct jobs
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
        profiles: this.generateProfilesFromRequest(request),
        output: [],
        progress: 0,
        // 🎬 Pass short flag through to VideoProcessor
        short: request.short,
        // 📋 Store webhook info for completion callback
        webhook_url: request.webhook_url,
        api_key: request.api_key,
        ...(request.originalFilename && { originalFilename: request.originalFilename })
      };

      // 📊 Progress pinging setup (only if webhook_url provided)
      let lastPingTime = 0;
      let lastPingProgress = 0;
      const PING_INTERVAL_MS = 10000; // 10 seconds
      const PING_PROGRESS_THRESHOLD = 5; // Only ping if progress changed by 5%+

      const progressCallback = (progress: any) => {
        // Always update local queue
        this.jobQueue.updateProgress(jobId, progress.percent);

        // Send progress ping if webhook_url exists
        if (request.webhook_url) {
          const now = Date.now();
          const timeSinceLastPing = now - lastPingTime;
          const progressDelta = Math.abs(progress.percent - lastPingProgress);

          // Send ping if: 10s elapsed OR progress jumped by 5%+
          if (timeSinceLastPing >= PING_INTERVAL_MS || progressDelta >= PING_PROGRESS_THRESHOLD) {
            lastPingTime = now;
            lastPingProgress = progress.percent;

            // Fire-and-forget ping (no await)
            this.webhookService.sendProgressPing(
              request.webhook_url,
              request.owner,
              request.permlink,
              progress.percent,
              progress.profile, // Use encoding profile as stage
              request.api_key
            ).catch(err => {
              // Already logged in sendProgressPing, just prevent unhandled rejection
            });
          }
        }
      };

      // Process the video with progress callback
      const startTime = Date.now();
      const result = await this.videoProcessor.processVideo(videoJob, progressCallback);
      const processingTimeSeconds = (Date.now() - startTime) / 1000;

      // Complete the job
      this.jobQueue.completeJob(jobId, result);
      
      // 🔔 Send webhook notification if URL provided
      if (request.webhook_url) {
        try {
          // Extract manifest CID from result
          const manifestCid = result[0]?.ipfsHash || '';
          const qualitiesEncoded = result.map(r => r.profile).filter(p => p !== 'master');
          
          const webhookPayload: any = {
            owner: request.owner,
            permlink: request.permlink,
            input_cid: request.input_cid,
            status: 'complete',
            progress: 100, // ✅ Explicit completion progress
            manifest_cid: manifestCid,
            video_url: `ipfs://${manifestCid}/manifest.m3u8`,
            job_id: jobId,
            processing_time_seconds: processingTimeSeconds,
            qualities_encoded: qualitiesEncoded,
            encoder_id: process.env.ENCODER_NAME || 'unknown',
            timestamp: new Date().toISOString()
          };
          
          // Add optional fields only if defined
          if (request.frontend_app) webhookPayload.frontend_app = request.frontend_app;
          if (request.originalFilename) webhookPayload.originalFilename = request.originalFilename;
          
          await this.webhookService.sendWebhook(request.webhook_url, webhookPayload, request.api_key);
          
          logger.info(`✅ Webhook delivered for ${request.owner}/${request.permlink}`);
        } catch (webhookError) {
          logger.warn(`⚠️ Webhook delivery failed for job ${jobId}:`, webhookError);
          // Don't fail the job for webhook failures
        }
      }
      
      logger.info(`✅ Direct job completed: ${jobId} (${request.owner}/${request.permlink})`);
      logger.info(`🛡️ TANK MODE: Content uploaded, pinned, and announced to DHT`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`❌ Direct job ${jobId} failed:`, cleanErrorForLogging(error));
      
      this.jobQueue.failJob(jobId, errorMessage);
      
      // 🔔 Send failure webhook if URL provided
      if (request.webhook_url) {
        try {
          await this.webhookService.sendWebhook(request.webhook_url, {
            owner: request.owner,
            permlink: request.permlink,
            input_cid: request.input_cid,
            status: 'failed',
            progress: 0, // ❌ Explicit failure progress
            job_id: jobId,
            processing_time_seconds: 0,
            qualities_encoded: [],
            encoder_id: process.env.ENCODER_NAME || 'unknown',
            error: errorMessage,
            timestamp: new Date().toISOString()
          }, request.api_key);
        } catch (webhookError) {
          logger.warn(`⚠️ Failure webhook delivery failed for job ${jobId}:`, webhookError);
        }
      }
    }
  }

  private generateProfilesFromRequest(request: DirectJobRequest): VideoProfile[] {
    if (request.short) {
      return [{ name: '480p', size: '?x480', width: 854, height: 480 }];
    }
    if (request.premium) {
      return [
        { name: '1080p', size: '?x1080', width: 1920, height: 1080 },
        { name: '720p', size: '?x720', width: 1280, height: 720 },
        { name: '480p', size: '?x480', width: 854, height: 480 }
      ];
    }
    return [{ name: '480p', size: '?x480', width: 854, height: 480 }];
  }
}