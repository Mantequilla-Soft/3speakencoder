import axios, { AxiosInstance } from 'axios';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { VideoJob, NodeInfo, GatewayJobResponse } from '../types/index.js';
import { IdentityService } from './IdentityService.js';
import { logger } from './Logger.js';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class GatewayClient {
  private config: EncoderConfig;
  private apiUrl: string;
  private client: AxiosInstance;
  private identity?: IdentityService;

  constructor(config: EncoderConfig) {
    this.config = config;
    this.apiUrl = config.remote_gateway.api;
  const rg = (config.remote_gateway as any) || {};
  const defaultTimeout = rg.timeoutMs || 120000; // default 120s
  const maxContent = rg.maxContentLength || 50 * 1024 * 1024;

    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: defaultTimeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': '3Speak-Encoder-Modern/1.0.0'
      },
      // 🚨 MEMORY SAFE: Additional config to prevent memory leaks
      maxRedirects: 3,
      maxContentLength: 50 * 1024 * 1024, // 50MB max response size
      maxBodyLength: 50 * 1024 * 1024,    // 50MB max request size
    });

    // 🚨 MEMORY SAFE: Add interceptors to clean up failed requests
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        // Clean up any large response data on error to prevent memory leaks
        if (error.response && error.response.data) {
          // Don't hold onto large error response bodies
          if (typeof error.response.data === 'object' && 
              JSON.stringify(error.response.data).length > 1000) {
            error.response.data = '[Large response data removed to prevent memory leak]';
          }
        }
        throw error;
      }
    );
  }

  /**
   * Simple GET wrapper with retries and exponential backoff for transient network/gateway issues.
   */
  private async getWithRetries<T = any>(path: string, opts: any = {}, context: string = ''): Promise<T> {
  const rg = (this.config.remote_gateway as any) || {};
  const maxRetries = rg.retries || 3;
  const baseDelay = rg.retryBaseDelayMs || 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.get<T>(path, opts);
        return response.data;
      } catch (err: any) {
        const isLast = attempt === maxRetries;
        const shouldRetry = !err.response || (err.response && err.response.status >= 500) || err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED';
        if (!shouldRetry || isLast) throw err;

        const delay = baseDelay * Math.pow(2, attempt - 1);
        const contextStr = context ? ` [${context}]` : '';
        logger.warn(`⚠️ GET ${path}${contextStr} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms:`, err.message || err.code);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Simple POST wrapper with retries and exponential backoff for transient network/gateway issues.
   */
  private async postWithRetries<T = any>(path: string, payload: any, opts: any = {}, context: string = ''): Promise<T> {
  const rg = (this.config.remote_gateway as any) || {};
  const maxRetries = rg.retries || 3;
  const baseDelay = rg.retryBaseDelayMs || 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.post<T>(path, payload, opts);
        return response.data;
      } catch (err: any) {
        const isLast = attempt === maxRetries;
        const shouldRetry = !err.response || (err.response && err.response.status >= 500) || err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED';
        if (!shouldRetry || isLast) throw err;

        const delay = baseDelay * Math.pow(2, attempt - 1);
        const contextStr = context ? ` [${context}]` : '';
        logger.warn(`⚠️ POST ${path}${contextStr} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms:`, err.message || err.code);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('Unreachable');
  }

  async initialize(): Promise<void> {
    // Test gateway connectivity with retry logic
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`🔍 Testing gateway connection (attempt ${attempt}/${maxRetries})...`);
        await this.getWithRetries('/api/v0/gateway/stats', { timeout: 10000 });
        logger.info('🌐 Gateway connection verified');
        return;
      } catch (error) {
        lastError = error;
        logger.warn(`⚠️ Gateway connection attempt ${attempt} failed:`, cleanErrorForLogging(error));

        if (attempt < maxRetries) {
          const delay = 2000 * attempt; // 2s, 4s, 6s
          logger.info(`⏱️ Retrying gateway connection in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    logger.error('❌ Gateway connection failed after all retries:', cleanErrorForLogging(lastError));
    // Don't fail initialization completely, encoder should still work for direct API
    logger.warn('⚠️ Gateway features will be disabled, but direct API will still work');
  }

  setIdentityService(identity: IdentityService): void {
    this.identity = identity;
  }

  async updateNode(nodeInfo: NodeInfo): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    try {
      const jws = await this.identity.createJWS({ node_info: nodeInfo });
      
      await this.postWithRetries('/api/v0/gateway/updateNode', { jws });
      logger.info('📡 Node registered successfully');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        logger.error(`❌ Gateway registration failed [${status}]: ${message}`);
        throw new Error(`Gateway registration failed: ${message}`);
      }
      throw error;
    }
  }

  async getJob(): Promise<VideoJob | null> {
    try {
      const response = await this.client.get<VideoJob>('/api/v0/gateway/getJob', { timeout: 30000 }); // Increased to 30s for gateway issues

      if (response.data) {
        logger.debug('📋 Gateway job retrieved successfully');
        return response.data;
      }

      return null;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          // No jobs available - this is normal
          return null;
        } else if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') {
          logger.warn('🔌 Gateway unreachable, will retry on next poll');
          return null;
        } else if (error.code === 'ENOTFOUND') {
          logger.warn('🌐 DNS resolution failed for gateway, will retry on next poll');
          return null;
        } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          logger.warn('⏰ Gateway request timeout - service may be overloaded, will retry on next poll');
          return null;
        }
      }
      
      logger.error('❌ Gateway job polling error:', cleanErrorForLogging(error));
      throw error;
    }
  }

  async acceptJob(jobId: string): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    const jws = await this.identity.createJWS({ job_id: jobId });

    try {
      await this.postWithRetries('/api/v0/gateway/acceptJob', { jws }, {}, `job:${jobId}`);
      logger.debug(`✅ Successfully accepted job: ${jobId}`);
    } catch (error) {
      // Handle "job already accepted by another encoder" scenario
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorMessage = error.response?.data?.message || error.message;

        const isAlreadyAccepted = status === 400 || status === 409 || (
          errorMessage.toLowerCase().includes('already') ||
          errorMessage.toLowerCase().includes('accepted') ||
          errorMessage.toLowerCase().includes('not assigned') ||
          errorMessage.toLowerCase().includes('invalid state')
        );

        if (isAlreadyAccepted) {
          logger.warn(`⚠️ Job ${jobId} was already accepted by another encoder: ${errorMessage}`);
          throw new Error(`Job already accepted by another encoder: ${errorMessage}`);
        }
      }

      // Re-throw other errors
      throw error;
    }
  }

  async rejectJob(jobId: string): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    const jws = await this.identity.createJWS({ job_id: jobId });
    
    await this.postWithRetries('/api/v0/gateway/rejectJob', { jws }, {}, `job:${jobId}`);
  }

  async failJob(jobId: string, errorDetails: any): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    try {
      // 🕐 DST FIX: Add current timestamp to help with time change issues
      const payload = { 
        job_id: jobId,
        error: errorDetails,
        timestamp: new Date().toISOString(),
        encoder_time: Date.now() // Unix timestamp for precise timing
      };
      
      const jws = await this.identity.createJWS(payload);

      await this.postWithRetries('/api/v0/gateway/failJob', { jws }, {}, `job:${jobId}`);
      
    } catch (error: any) {
      // 🚨 DST/Gateway Fix: Don't fail the encoder if gateway reporting fails
      if (error.response?.status === 500) {
        logger.warn(`⚠️ Gateway server error (500) - this may be due to time change/DST issues: ${error.message}`);
        logger.warn(`🕐 Current encoder time: ${new Date().toISOString()}`);
        // Don't throw - let the job retry logic handle this
        return;
      }
      throw error;
    }
  }

  async finishJob(jobId: string, result: any): Promise<any> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    // Extract the IPFS hash/CID from the result
    const cid = result.ipfs_hash || result.cid;
    if (!cid) {
      throw new Error('No IPFS CID found in result');
    }

    // 🎯 LEGACY-COMPATIBLE: Use exact payload format from legacy encoder
    const payload = {
      job_id: jobId,
      output: {
        cid: cid
      }
    };

    const jws = await this.identity.createJWS(payload);

    try {
      return await this.postWithRetries('/api/v0/gateway/finishJob', { jws }, {}, `job:${jobId}`);
    } catch (error) {
      // Handle "job already completed by another encoder" scenario
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorMessage = error.response?.data?.message || error.message;

        // Check for duplicate completion indicators
        const isDuplicateCompletion = status === 500 && (
          errorMessage.toLowerCase().includes('already') ||
          errorMessage.toLowerCase().includes('completed') ||
          errorMessage.toLowerCase().includes('duplicate') ||
          errorMessage.toLowerCase().includes('not assigned') ||
          errorMessage.toLowerCase().includes('invalid state')
        );

        if (isDuplicateCompletion) {
          logger.warn(`⚠️ Job ${jobId} was already completed by another encoder - treating as success`);
          logger.warn(`📋 Duplicate completion details: ${errorMessage}`);

          // Return synthetic success response
          return {
            success: true,
            message: 'Job already completed by another encoder',
            duplicate: true,
            originalError: errorMessage
          };
        }

        // Check for other gateway state errors that indicate the job is in an unexpected state
        const isStateError = status === 400 || status === 409;
        if (isStateError) {
          logger.warn(`⚠️ Job ${jobId} state conflict: ${errorMessage}`);
          throw new Error(`Job state conflict: ${errorMessage}`);
        }
      }

      // Re-throw other errors
      throw error;
    }
  }



  async pingJob(jobId: string, status: any): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    // 🚨 LEGACY-COMPATIBLE: Use exact format expected by gateway
    const payload: any = { 
      job_id: jobId
    };
    
    // Add progress fields in legacy format
    if (status.progress !== undefined) {
      payload.progressPct = Math.max(1.0, status.progress); // ⚠️ Must be > 1 to trigger "running" status
    }
    
    if (status.download_pct !== undefined) {
      payload.download_pct = status.download_pct;
    }
    
    // Legacy expects progressPct + download_pct, NOT generic status
    const jws = await this.identity.createJWS(payload);

    await this.postWithRetries('/api/v0/gateway/pingJob', { jws }, {}, `job:${jobId}`);
  }

  async cancelJob(jobId: string): Promise<void> {
    if (!this.identity) {
      throw new Error('Identity service not set');
    }

    const jws = await this.identity.createJWS({ job_id: jobId });

    await this.postWithRetries('/api/v0/gateway/cancelJob', { jws });
  }

  async getNodeStats(nodeId: string): Promise<any> {
    return await this.getWithRetries(`/api/v0/gateway/nodestats/${nodeId}`);
  }

  async getJobStatus(jobId: string): Promise<any> {
    return await this.getWithRetries(`/api/v0/gateway/jobstatus/${jobId}`, {}, `job:${jobId}`);
  }

  /**
   * Validate that a job is assigned to this encoder before processing
   */
  async validateJobOwnership(jobId: string): Promise<boolean> {
    try {
      const jobStatus = await this.getJobStatus(jobId);

      if (!jobStatus) {
        logger.warn(`⚠️ Job ${jobId} not found in gateway`);
        return false;
      }

      // Check if job is in a valid state for this encoder
      const validStates = ['assigned', 'accepted', 'running'];
      if (!validStates.includes(jobStatus.status)) {
        logger.warn(`⚠️ Job ${jobId} is in invalid state: ${jobStatus.status}`);
        return false;
      }

      // If the gateway tracks assigned encoder, we could check it here
      // For now, we assume if we got the job via getJob(), it's ours

      return true;
    } catch (error) {
      logger.warn(`⚠️ Failed to validate job ownership for ${jobId}:`, error);
      return false;
    }
  }

  async getAvailableJobs(): Promise<VideoJob[]> {
    // Note: The 3Speak gateway doesn't provide a public available jobs endpoint
    // We can only poll for jobs assigned to us via getJob()
    // For now, return empty array - we'd need gateway API changes to show available jobs
    logger.debug('📋 Available jobs endpoint not supported by gateway');
    return [];
  }

  async getGatewayStats(): Promise<any> {
    try {
      return await this.getWithRetries('/api/v0/gateway/stats', { timeout: 10000 });
    } catch (error) {
      logger.debug('❌ Failed to get gateway stats:', error);
      return null;
    }
  }

  /**
   * Send heartbeat to gateway to maintain online status
   * Called every ~60 seconds to prevent being marked offline by round-robin
   * 
   * This keeps the encoder's last_seen timestamp fresh so it stays visible
   * in the round-robin job distribution system.
   */
  async sendHeartbeat(): Promise<boolean> {
    if (!this.identity) {
      logger.warn('⚠️ Cannot send heartbeat: Identity service not set');
      return false;
    }

    try {
      // Create minimal payload with timestamp
      const payload = {
        timestamp: new Date().toISOString()
      };
      
      // Sign with our DID
      const jws = await this.identity.createJWS(payload);
      
      // Send to gateway (10 second timeout for quick failure)
      const response = await this.postWithRetries(
        '/api/v0/gateway/heartbeat',
        { jws },
        { timeout: 10000 },
        'heartbeat'
      );
      
      if (response?.status === 'success') {
        logger.debug('💓 Heartbeat acknowledged by gateway');
        return true;
      } else {
        logger.warn(`⚠️ Heartbeat failed: ${response?.message || 'Unknown response'}`);
        return false;
      }
    } catch (error) {
      // Don't throw - heartbeat failures shouldn't crash the encoder
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          logger.warn('⚠️ Heartbeat endpoint not found - gateway may need update');
        } else if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') {
          logger.debug('💓 Heartbeat failed: Gateway unreachable');
        } else {
          logger.error(`❌ Heartbeat request failed [${status}]:`, error.message);
        }
      } else {
        logger.error('❌ Heartbeat request failed:', error);
      }
      return false;
    }
  }
}