import axios, { AxiosInstance } from 'axios';
import cron from 'node-cron';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { IdentityService } from './IdentityService.js';
import { JobQueue } from './JobQueue.js';
import { DirectJobRequest } from '../types/DirectApi.js';
import { logger } from './Logger.js';
import { ENCODER_VERSION } from './GatewayClient.js';

/**
 * EmbedPollerService — Community encoder polling for the new 3Speak embed system.
 *
 * Polls POST {gateway_url}/api/v0/gateway/myJob with JWS auth every 60s.
 * When a job is received, feeds it directly into JobQueue.addDirectJob() —
 * the same pipeline used by DirectApiService (managed/push mode).
 */
export class EmbedPollerService {
  private config: EncoderConfig;
  private identity: IdentityService;
  private jobQueue: JobQueue;
  private client: AxiosInstance;
  private isRunning: boolean = false;
  private pollCronJob: any = null;
  private pollCount: number = 0;

  constructor(config: EncoderConfig, identity: IdentityService, jobQueue: JobQueue) {
    this.config = config;
    this.identity = identity;
    this.jobQueue = jobQueue;

    const gatewayUrl = config.embed_system?.gateway_url;
    if (!gatewayUrl) {
      throw new Error('EMBED_GATEWAY_URL is required for community mode');
    }

    this.client = axios.create({
      baseURL: gatewayUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `3Speak-Encoder/${ENCODER_VERSION}`,
      },
    });
  }

  async start(): Promise<void> {
    // Register with the embed gateway
    await this.registerNode();

    this.isRunning = true;

    // Poll every 60 seconds with random jitter (0-59s offset) to avoid thundering herd
    // node-cron 6-field format: second minute hour day month weekday
    const jitterSecond = Math.floor(Math.random() * 60);
    this.pollCronJob = cron.schedule(`${jitterSecond} * * * * *`, async () => {
      if (!this.isRunning) return;
      try {
        await this.sendHeartbeat();
        await this.pollForJob();
      } catch (error) {
        logger.warn('[Embed] Poll cycle error:', error instanceof Error ? error.message : error);
      }
    });

    // Fire the first poll immediately instead of waiting up to 60s
    this.sendHeartbeat().catch(() => {});
    this.pollForJob().catch(() => {});

    logger.info(`[Embed] Community poller started (polling every 60s, jitter=${jitterSecond}s)`);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollCronJob) {
      this.pollCronJob.stop();
      this.pollCronJob = null;
    }
    logger.info('[Embed] Community poller stopped');
  }

  /**
   * Register this encoder with the embed gateway.
   * POST /api/v0/gateway/updateNode
   */
  private async registerNode(): Promise<void> {
    const nodeInfo = {
      name: this.config.node.name,
      cryptoAccounts: this.config.node.cryptoAccounts || {},
      commit_hash: ENCODER_VERSION,
    };

    const jws = await this.identity.createJWS({ node_info: nodeInfo });

    try {
      const response = await this.client.post('/api/v0/gateway/updateNode', { jws });
      const data = response.data;

      if (data.success) {
        logger.info(`[Embed] Registered with gateway: ${data.encoder?.name || 'unknown'} (tier: ${data.encoder?.tier || 'unknown'})`);
      } else {
        logger.warn('[Embed] Registration response was not successful:', data);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error(`[Embed] Registration failed: ${error.response?.status} ${error.message}`);
      } else {
        logger.error('[Embed] Registration failed:', error);
      }
      throw error;
    }
  }

  /**
   * Send explicit heartbeat to keep encoder marked as online.
   * POST /api/v0/gateway/heartbeat
   */
  private async sendHeartbeat(): Promise<void> {
    const jws = await this.identity.createJWS({
      timestamp: new Date().toISOString(),
      version: ENCODER_VERSION,
    });

    try {
      await this.client.post('/api/v0/gateway/heartbeat', { jws });
      logger.debug('[Embed] Heartbeat sent');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.warn(`[Embed] Heartbeat failed: ${error.response?.status || error.message}`);
      } else {
        logger.warn('[Embed] Heartbeat failed:', error instanceof Error ? error.message : error);
      }
    }
  }

  /**
   * Poll for a job from the embed gateway.
   * POST /api/v0/gateway/myJob
   */
  private async pollForJob(): Promise<void> {
    this.pollCount++;

    const jws = await this.identity.createJWS({
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await this.client.post('/api/v0/gateway/myJob', { jws });
      const data = response.data;

      if (!data.success) {
        logger.warn('[Embed] Poll returned success=false:', data);
        return;
      }

      if (!data.job) {
        logger.info(`[Embed] Poll #${this.pollCount} — no jobs available`);
        return;
      }

      // The job payload matches DirectJobRequest exactly per the encoder contract
      const jobPayload = data.job as DirectJobRequest;

      logger.info(`[Embed] Job received: ${jobPayload.owner}/${jobPayload.permlink} (short: ${jobPayload.short}, premium: ${jobPayload.premium ?? false})`);

      // Feed directly into the same pipeline as DirectApiService
      const job = await this.jobQueue.addDirectJob(jobPayload);
      logger.info(`[Embed] Job queued: ${job.id}`);

    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status && status >= 500) {
          logger.warn(`[Embed] Gateway error (${status}): ${error.message}`);
        } else if (status === 401 || status === 403) {
          logger.error(`[Embed] Authentication failed (${status}) — check ENCODER_PRIVATE_KEY`);
        } else {
          logger.warn(`[Embed] Poll failed: ${error.message}`);
        }
      } else {
        logger.warn('[Embed] Poll error:', error instanceof Error ? error.message : error);
      }
    }
  }
}
