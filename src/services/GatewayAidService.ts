/**
 * Gateway Aid Service - REST API Fallback for Community Nodes
 * 
 * Provides REST API fallback when websocket/gateway APIs fail
 * Requires DID approval from 3Speak team
 * 
 * Used by approved community nodes without MongoDB access
 * Infrastructure nodes should use MongoDB fallback instead
 */

import axios, { AxiosInstance } from 'axios';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { VideoJob, EncodedOutput } from '../types/index.js';
import { IdentityService } from './IdentityService.js';
import { logger } from './Logger.js';

const log = logger.child({ service: 'GatewayAidService' });

export interface GatewayAidJobResponse {
  success: boolean;
  job?: VideoJob;
  message?: string;
  error?: string; // Error message when success = false
  data?: {
    code?: string; // Error code like "ENCODER_NOT_AUTHORIZED"
  };
}

export interface GatewayAidListResponse {
  success: boolean;
  jobs: VideoJob[];
  total?: number;
  error?: string;
  data?: {
    code?: string;
  };
}

export interface GatewayAidUpdateResponse {
  success: boolean;
  message?: string;
  error?: string;
  data?: {
    code?: string;
  };
}

export class GatewayAidService {
  private client: AxiosInstance;
  private enabled: boolean;
  private baseUrl: string;
  private identityService: IdentityService;
  private lastHeartbeat: Map<string, number> = new Map(); // Track heartbeat timestamps

  constructor(config: EncoderConfig, identityService: IdentityService) {
    this.enabled = config.gateway_aid?.enabled || false;
    this.baseUrl = config.gateway_aid?.base_url || '';
    this.identityService = identityService;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add X-Encoder-DID header to all authenticated requests
    this.client.interceptors.request.use((config) => {
      // Don't add DID header for health check endpoint
      if (!config.url?.includes('/health')) {
        config.headers['X-Encoder-DID'] = this.identityService.getDIDKey();
      }
      return config;
    });

    if (this.enabled) {
      log.info('🆘 Gateway Aid fallback enabled');
      log.info(`🌐 Gateway Aid base URL: ${this.baseUrl}`);
    }
  }

  /**
   * Get encoder DID for request body
   */
  private getEncoderDID(): string {
    return this.identityService.getDIDKey();
  }

  /**
   * Check if Gateway Aid is enabled and configured
   */
  isEnabled(): boolean {
    return this.enabled && this.baseUrl.length > 0;
  }

  /**
   * Check if Gateway Aid service is healthy
   */
  async checkHealth(): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    try {
      const response = await this.client.get('/health');
      return response.status === 200 && response.data.status === 'healthy';
    } catch (error) {
      log.error('❌ Gateway Aid health check failed:', error);
      return false;
    }
  }

  /**
   * List available unclaimed jobs from Gateway Aid
   */
  async listAvailableJobs(): Promise<VideoJob[]> {
    if (!this.isEnabled()) {
      return [];
    }

    try {
      // 🔍 DEV MODE: Show we're polling Gateway Aid
      if (process.env.NODE_ENV === 'development') {
        log.info(`🎯 DEV: Polling jobs from GATEWAY AID (REST API fallback)`);
      }
      
      const response = await this.client.post<GatewayAidListResponse>('/list-jobs', {});

      if (response.data.success && response.data.jobs) {
        log.info(`📋 Gateway Aid: ${response.data.total || response.data.jobs.length} jobs available`);
        
        // 🔍 DEV MODE: Show job IDs from Gateway Aid
        if (process.env.NODE_ENV === 'development' && response.data.jobs.length > 0) {
          const jobIds = response.data.jobs.map(j => j.id).join(', ');
          log.info(`🎯 DEV: Gateway Aid jobs: ${jobIds}`);
        }
        
        return response.data.jobs;
      }

      return [];
    } catch (error: any) {
      log.error('❌ Gateway Aid listAvailableJobs failed:', error.message);
      return [];
    }
  }

  /**
   * Claim a job via Gateway Aid REST API
   * Equivalent to gateway.acceptJob() but via REST
   */
  async claimJob(jobId: string): Promise<boolean> {
    if (!this.isEnabled()) {
      throw new Error('Gateway Aid is not enabled');
    }

    try {
      const response = await this.client.post<GatewayAidJobResponse>('/claim-job', {
        job_id: jobId
      });

      if (response.data.success) {
        log.info(`✅ Gateway Aid: Job ${jobId} claimed successfully`);
        
        // 🔍 DEV MODE: Confirm Gateway Aid claim
        if (process.env.NODE_ENV === 'development') {
          log.info(`🎯 DEV: Job ${jobId} claimed via GATEWAY AID (not legacy gateway)`);
        }
        
        return true;
      }

      const errorMsg = response.data.error || response.data.message || 'Unknown error';
      log.warn(`⚠️ Gateway Aid: Failed to claim job ${jobId}: ${errorMsg}`);
      return false;
    } catch (error: any) {
      if (error.response?.status === 401) {
        const errorMsg = error.response.data?.error || 'Encoder not authorized';
        log.error(`🚫 Gateway Aid: ${errorMsg} - DID not approved`);
        log.error('   Contact 3Speak team to request approval');
      } else if (error.response?.status === 409) {
        log.warn(`⚠️ Gateway Aid: Job ${jobId} already claimed by another encoder`);
      } else {
        log.error(`❌ Gateway Aid claimJob failed: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * Update job progress via Gateway Aid
   * Equivalent to gateway.reportProgress() but via REST
   * Also serves as heartbeat to indicate encoder is still working
   */
  async updateJobProgress(jobId: string, progress: number): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    try {
      const response = await this.client.post<GatewayAidUpdateResponse>('/update-job', {
        job_id: jobId,
        status: 'running',
        progress: {
          pct: Math.max(0, progress),
          download_pct: 100
        }
      });

      if (response.data.success) {
        this.lastHeartbeat.set(jobId, Date.now());
        log.debug(`💓 Gateway Aid: Job ${jobId} progress updated to ${progress}%`);
        return true;
      }

      log.warn(`⚠️ Gateway Aid: Failed to update progress for ${jobId}`);
      return false;
    } catch (error: any) {
      log.error(`❌ Gateway Aid updateJobProgress failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send heartbeat for a job (without progress update)
   * Used during encoding to indicate encoder is still alive
   */
  async sendHeartbeat(jobId: string): Promise<boolean> {
    // Don't send heartbeat if we sent one recently (within 30 seconds)
    const lastBeat = this.lastHeartbeat.get(jobId);
    if (lastBeat && (Date.now() - lastBeat) < 30000) {
      return true; // Skip, too soon
    }

    return this.updateJobProgress(jobId, -1); // Progress -1 indicates heartbeat only
  }

  /**
   * Complete a job via Gateway Aid
   * Equivalent to gateway.completeJob() but via REST
   */
  async completeJob(jobId: string, result: EncodedOutput[]): Promise<boolean> {
    if (!this.isEnabled()) {
      throw new Error('Gateway Aid is not enabled');
    }

    try {
      // Find the master CID (highest resolution or first available)
      const masterOutput = result.find(o => o.profile === '1080p') || result.find(o => o.profile === '720p') || result[0];
      
      if (!masterOutput?.ipfsHash) {
        throw new Error('No valid IPFS hash found in encoded outputs');
      }

      log.debug(`📤 Gateway Aid complete request: job=${jobId}, cid=${masterOutput.ipfsHash}`);

      const response = await this.client.post<GatewayAidUpdateResponse>('/complete-job', {
        job_id: jobId,
        result: {
          cid: masterOutput.ipfsHash
        }
      });

      if (response.data.success) {
        log.info(`✅ Gateway Aid: Job ${jobId} completed successfully`);
        this.lastHeartbeat.delete(jobId); // Clean up
        return true;
      }

      const errorMsg = response.data.error || response.data.message || 'Unknown error';
      log.warn(`⚠️ Gateway Aid: Failed to complete job ${jobId}: ${errorMsg}`);
      return false;
    } catch (error: any) {
      if (error.response?.status === 400) {
        log.error(`❌ Gateway Aid completeJob failed with 400: ${error.response?.data?.error || error.message}`);
        log.error(`💡 Note: Gateway Aid can only complete jobs that were claimed through Gateway Aid`);
      } else {
        log.error(`❌ Gateway Aid completeJob failed: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * Report job failure via Gateway Aid
   */
  async failJob(jobId: string, error: string): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    try {
      const response = await this.client.post<GatewayAidUpdateResponse>('/update-job', {
        job_id: jobId,
        status: 'failed',
        progress: {
          pct: 0,
          download_pct: 0
        }
      });

      if (response.data.success) {
        log.info(`✅ Gateway Aid: Job ${jobId} failure reported`);
        this.lastHeartbeat.delete(jobId); // Clean up
        return true;
      }

      return false;
    } catch (error: any) {
      log.error(`❌ Gateway Aid failJob failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get status message for logging
   */
  getStatusMessage(): string {
    if (!this.enabled) {
      return 'Gateway Aid: Disabled (not approved for this node)';
    }
    return `Gateway Aid: Enabled and ready (${this.baseUrl})`;
  }
}
