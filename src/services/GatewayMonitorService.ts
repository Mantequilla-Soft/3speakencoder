import axios, { AxiosInstance } from 'axios';
import { logger } from './Logger.js';
import type { EncoderConfig } from '../config/ConfigLoader.js';

/**
 * Gateway Monitor job response interface
 */
export interface GatewayMonitorJob {
  _id: string;
  id: string;
  status: string;
  created_at: string;
  last_pinged: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  assigned_date: string | null;
  metadata: {
    video_owner: string;
    video_permlink: string;
  };
  storageMetadata: {
    app: string;
    key: string;
    type: string;
  };
  input: {
    uri: string;
    size: number;
  };
  result?: {
    cid: string;
  } | null;
  progress?: {
    download_pct: number;
    pct: number;
  };
}

/**
 * 🌐 GATEWAY MONITOR: REST API Verification Service
 * 
 * For community encoders without MongoDB access, this service provides
 * job ownership verification via the gateway-monitor.3speak.tv API.
 * This prevents race conditions without requiring direct database access.
 * 
 * Verification Hierarchy:
 * 1. MongoDB (ground truth - 3speak infra only)
 * 2. Gateway Monitor API (community encoders)
 * 3. Legacy Gateway WebSocket (fallback when nothing else works)
 */
export class GatewayMonitorService {
  private client: AxiosInstance;
  private config: EncoderConfig;
  private enabled: boolean = false;
  private baseUrl: string;

  constructor(config: EncoderConfig) {
    this.config = config;
    
    // Gateway Monitor API URL
    this.baseUrl = config.gateway_monitor?.base_url || 'https://gateway-monitor.3speak.tv/api';
    
    // Only enable if explicitly configured
    this.enabled = config.gateway_monitor?.enabled === true;
    
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': '3Speak-Encoder-Community'
      }
    });

    if (this.enabled) {
      logger.info(`✅ Gateway Monitor verification enabled: ${this.baseUrl}`);
      logger.info(`🌐 Community encoder mode: REST API job verification active`);
    } else {
      logger.info(`📊 Gateway Monitor verification disabled (set GATEWAY_MONITOR_ENABLED=true to enable)`);
    }
  }

  /**
   * Check if Gateway Monitor verification is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get job details from Gateway Monitor API
   * Returns job status, assignment, and metadata
   */
  async getJobDetails(jobId: string): Promise<GatewayMonitorJob | null> {
    if (!this.enabled) {
      throw new Error('Gateway Monitor verification not enabled');
    }

    try {
      logger.info(`🌐 GATEWAY_MONITOR: Fetching job ${jobId} details from REST API...`);
      
      const response = await this.client.get(`/jobs/${jobId}`);
      
      if (response.data?.success && response.data?.data) {
        const job = response.data.data as GatewayMonitorJob;
        
        logger.info(`✅ Found job ${jobId} via Gateway Monitor API:`);
        logger.info(`   📊 Status: ${job.status}`);
        logger.info(`   👤 Assigned to: ${job.assigned_to || 'unassigned'}`);
        logger.info(`   📅 Created: ${job.created_at}`);
        logger.info(`   📅 Last pinged: ${job.last_pinged || 'never'}`);
        
        return job;
      }
      
      logger.warn(`⚠️ Job ${jobId} not found in Gateway Monitor API`);
      return null;
      
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          logger.warn(`⚠️ Job ${jobId} not found (404) in Gateway Monitor API`);
          return null;
        }
        logger.error(`❌ Gateway Monitor API error for job ${jobId}:`, error.response?.data || error.message);
      } else {
        logger.error(`❌ Failed to fetch job ${jobId} from Gateway Monitor:`, error);
      }
      throw error;
    }
  }

  /**
   * 🛡️ OWNERSHIP VERIFICATION: Check if job is already claimed by someone else
   * This is the key method for preventing race conditions in community encoders
   * 
   * Returns:
   * - isOwned: true if job is assigned to expectedOwnerDID
   * - jobExists: true if job exists in the system
   * - actualOwner: the DID of the current owner (null if unassigned)
   * - status: current job status
   * - isSafeToProcess: true if job exists and is assigned to us
   */
  async verifyJobOwnership(jobId: string, expectedOwnerDID: string): Promise<{
    isOwned: boolean;
    jobExists: boolean;
    actualOwner: string | null;
    status: string | null;
    isSafeToProcess: boolean;
  }> {
    if (!this.enabled) {
      throw new Error('Gateway Monitor verification not enabled');
    }

    try {
      logger.info(`🔍 GATEWAY_MONITOR_VERIFICATION: Checking ownership of job ${jobId}`);
      logger.info(`🔍 Expected owner DID: ${expectedOwnerDID}`);
      
      const job = await this.getJobDetails(jobId);
      
      if (!job) {
        logger.warn(`⚠️ Job ${jobId} not found in Gateway Monitor API`);
        return {
          isOwned: false,
          jobExists: false,
          actualOwner: null,
          status: null,
          isSafeToProcess: false
        };
      }

      // Normalize DIDs for comparison (handle format mismatches)
      const normalizeDID = (did: string | null): string => {
        if (!did) return '';
        if (did.startsWith('did:key:')) return did;
        if (did.startsWith('did')) return `did:key:${did.substring(3)}`;
        return did;
      };

      const normalizedExpected = normalizeDID(expectedOwnerDID);
      const normalizedActual = normalizeDID(job.assigned_to);

      logger.info(`🔍 DID_COMPARISON: Expected="${normalizedExpected}"`);
      logger.info(`🔍 DID_COMPARISON: Actual="${normalizedActual}"`);

      const isOwned = normalizedActual === normalizedExpected;
      const isSafeToProcess = isOwned && (job.status === 'assigned' || job.status === 'running');

      if (isOwned) {
        logger.info(`✅ OWNERSHIP_CONFIRMED: Job ${jobId} is assigned to us (status: ${job.status})`);
      } else if (job.assigned_to) {
        logger.warn(`⚠️ OWNERSHIP_CONFLICT: Job ${jobId} is assigned to different encoder: ${job.assigned_to}`);
      } else {
        logger.info(`📊 UNASSIGNED_JOB: Job ${jobId} is not assigned to any encoder yet`);
      }

      return {
        isOwned,
        jobExists: true,
        actualOwner: job.assigned_to,
        status: job.status,
        isSafeToProcess
      };

    } catch (error) {
      logger.error(`❌ Gateway Monitor verification failed for job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Check if a job is safe to claim (not already claimed by someone else)
   * This should be called BEFORE attempting to claim a job
   */
  async isJobAvailableToClaim(jobId: string): Promise<{
    available: boolean;
    reason: string;
    currentOwner: string | null;
    status: string | null;
  }> {
    if (!this.enabled) {
      throw new Error('Gateway Monitor verification not enabled');
    }

    try {
      const job = await this.getJobDetails(jobId);
      
      if (!job) {
        return {
          available: false,
          reason: 'Job not found in system',
          currentOwner: null,
          status: null
        };
      }

      // Check if job is already assigned
      if (job.assigned_to) {
        return {
          available: false,
          reason: `Already assigned to ${job.assigned_to}`,
          currentOwner: job.assigned_to,
          status: job.status
        };
      }

      // Check if job is in a claimable state
      if (job.status === 'complete') {
        return {
          available: false,
          reason: 'Job already completed',
          currentOwner: job.assigned_to,
          status: job.status
        };
      }

      if (job.status === 'failed') {
        return {
          available: false,
          reason: 'Job marked as failed',
          currentOwner: job.assigned_to,
          status: job.status
        };
      }

      // Job is available if unassigned and in pending/queued status
      const claimableStatuses = ['pending', 'queued', 'created'];
      const isClaimable = claimableStatuses.includes(job.status);

      return {
        available: isClaimable,
        reason: isClaimable ? 'Job available to claim' : `Job status is ${job.status}`,
        currentOwner: null,
        status: job.status
      };

    } catch (error) {
      logger.error(`❌ Failed to check job availability for ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Get service status information
   */
  getStatus(): {
    enabled: boolean;
    baseUrl: string;
  } {
    return {
      enabled: this.enabled,
      baseUrl: this.baseUrl
    };
  }
}
