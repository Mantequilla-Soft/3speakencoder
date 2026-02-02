import { VideoJob } from '../types/index.js';
import { DirectJob, DirectJobRequest } from '../types/DirectApi.js';
import { logger } from './Logger.js';
import { JobStatus } from '../types/index.js';

export interface JobRetryInfo {
  attempts: number;
  maxAttempts: number;
  lastAttempt: string;
  nextRetry: string;
  errors: string[];
}

export type QueuedJob = VideoJob | DirectJob;

export class JobQueue {
  private jobs: Map<string, QueuedJob> = new Map();
  private pendingQueue: string[] = [];
  private activeJobs: Set<string> = new Set();
  private retryInfo: Map<string, JobRetryInfo> = new Map();
  private cachedResults: Map<string, any> = new Map(); // For smart retries
  private maxConcurrent: number;
  private defaultMaxRetries: number;
  private retryDelayMs: number;

    constructor(maxConcurrent: number = 1, maxRetries: number = 5, retryDelayMs: number = 180000) { // 3 minute delay (more production-friendly)
    this.maxConcurrent = maxConcurrent;
    this.defaultMaxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
  }

  // Add 3Speak gateway job
  addGatewayJob(job: VideoJob): void {
    // 🚨 DUPLICATE PREVENTION: Don't add job if it's already in queue or active
    if (this.jobs.has(job.id)) {
      logger.warn(`⚠️ Job ${job.id} already exists in queue - skipping duplicate`);
      return;
    }
    
    if (this.pendingQueue.includes(job.id)) {
      logger.warn(`⚠️ Job ${job.id} already in pending queue - skipping duplicate`);
      return;
    }
    
    if (this.activeJobs.has(job.id)) {
      logger.warn(`⚠️ Job ${job.id} is currently active - skipping duplicate`);
      return;
    }
    
    this.jobs.set(job.id, job);
    this.pendingQueue.push(job.id);
    logger.info(`📥 Gateway job queued: ${job.id} (position: ${this.pendingQueue.length})`);
  }

  // Add direct API job
  async addDirectJob(request: DirectJobRequest): Promise<DirectJob> {
    const job: DirectJob = {
      id: `direct-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'direct',
      status: JobStatus.QUEUED,
      created_at: new Date().toISOString(),
      request
    };

    this.jobs.set(job.id, job);
    this.pendingQueue.push(job.id);
    
    logger.info(`📥 Direct job queued: ${job.id} (position: ${this.pendingQueue.length})`);
    return job;
  }

  // Get next job to process (first-come-first-served)
  getNextJob(): QueuedJob | null {
    if (this.activeJobs.size >= this.maxConcurrent) {
      return null;
    }

    if (this.pendingQueue.length === 0) {
      return null;
    }

    const jobId = this.pendingQueue.shift()!;
    const job = this.jobs.get(jobId);

    if (!job) {
      logger.warn(`⚠️ Job ${jobId} not found in queue`);
      return this.getNextJob(); // Try next job
    }

    this.activeJobs.add(jobId);
    job.status = JobStatus.RUNNING;
    job.updated_at = new Date().toISOString();

    logger.info(`🚀 Starting job: ${jobId} (${job.type || 'gateway'})`);
    return job;
  }

  // Mark job as completed
  completeJob(jobId: string, result?: any): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = JobStatus.COMPLETE;
      job.updated_at = new Date().toISOString();
      if (result) {
        job.result = result;
      }
    }
    
    this.activeJobs.delete(jobId);
    logger.info(`✅ Job completed: ${jobId}`);
  }

  // Mark job as failed with retry logic
  failJob(jobId: string, error: string, canRetry: boolean = true): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      logger.warn(`⚠️ Cannot fail job ${jobId}: not found`);
      return;
    }

    const retryInfo = this.retryInfo.get(jobId) || {
      attempts: 0,
      maxAttempts: this.defaultMaxRetries,
      lastAttempt: new Date().toISOString(),
      nextRetry: '',
      errors: []
    };

    retryInfo.attempts++;
    retryInfo.lastAttempt = new Date().toISOString();
    retryInfo.errors.push(error);

    // Check if we should retry
    if (canRetry && retryInfo.attempts < retryInfo.maxAttempts) {
      // Use shorter delay for 500 server errors (likely temporary gateway issues)
      const is500Error = (typeof error === 'object' && error !== null && 
                         ((error as any)?.status >= 500 && (error as any)?.status < 600)) || 
                         (typeof error === 'object' && error !== null &&
                         ((error as any)?.response?.status >= 500 && (error as any)?.response?.status < 600)) ||
                         (typeof error === 'string' && error.includes('status code 500'));
      const retryDelay = is500Error ? Math.min(this.retryDelayMs / 2, 120000) : this.retryDelayMs; // Max 2 minutes for 500 errors
      
      const nextRetryTime = new Date(Date.now() + retryDelay);
      retryInfo.nextRetry = nextRetryTime.toISOString();
      this.retryInfo.set(jobId, retryInfo);
      
      // Set job back to queued for retry
      job.status = JobStatus.QUEUED;
      job.updated_at = new Date().toISOString();
      job.error = `Retry ${retryInfo.attempts}/${retryInfo.maxAttempts}: ${error}`;
      
      this.activeJobs.delete(jobId);
      // Will be picked up by retry logic in processRetries()
      
      // Better messaging for users
      const retryMinutes = Math.round(retryDelay / 60000);
      const statusMessage = is500Error ? 'Gateway server issue' : 'Job failed';
      logger.warn(`⚠️ ${statusMessage} for job ${jobId} (attempt ${retryInfo.attempts}/${retryInfo.maxAttempts}), will retry in ${retryMinutes} minutes: ${error}`);
      if (is500Error) {
        logger.info(`🔄 This is likely a temporary gateway issue and should resolve automatically`);
      }
    } else {
      // Final failure - no more retries
      job.status = JobStatus.FAILED;
      job.updated_at = new Date().toISOString();
      job.error = `Failed after ${retryInfo.attempts} attempts: ${retryInfo.errors.join('; ')}`;
      
      this.activeJobs.delete(jobId);
      this.retryInfo.delete(jobId);
      
      logger.error(`❌ Job permanently failed: ${jobId} - ${job.error}`);
    }
  }

  // Update job progress
  updateProgress(jobId: string, progress: number): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.progress = progress;
      job.updated_at = new Date().toISOString();
    }
  }

  // Get job by ID
  getJob(jobId: string): QueuedJob | null {
    return this.jobs.get(jobId) || null;
  }

  // Check if job exists in queue or is active
  hasJob(jobId: string): boolean {
    return this.jobs.has(jobId) || this.activeJobs.has(jobId) || this.pendingQueue.includes(jobId);
  }

  // Get queue stats
  getPendingCount(): number {
    return this.pendingQueue.length;
  }

  getActiveCount(): number {
    return this.activeJobs.size;
  }

  getTotalCount(): number {
    return this.jobs.size;
  }

  // Process jobs ready for retry
  processRetries(): string[] {
    const now = Date.now();
    const readyForRetry: string[] = [];

    for (const [jobId, retryInfo] of this.retryInfo) {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== JobStatus.QUEUED) {
        continue;
      }

      const nextRetryTime = new Date(retryInfo.nextRetry).getTime();
      if (now >= nextRetryTime) {
        // Add back to pending queue for retry
        if (!this.pendingQueue.includes(jobId)) {
          this.pendingQueue.push(jobId);
          readyForRetry.push(jobId);
          logger.info(`🔄 Job ${jobId} ready for retry (attempt ${retryInfo.attempts + 1}/${retryInfo.maxAttempts})`);
        }
      }
    }

    return readyForRetry;
  }

  // Detect stuck jobs that have been active too long
  detectStuckJobs(maxActiveTimeMs: number = 3600000): string[] { // 1 hour default
    const now = Date.now();
    const stuckJobs: string[] = [];

    for (const jobId of this.activeJobs) {
      const job = this.jobs.get(jobId);
      if (!job) continue;

      const lastUpdate = new Date(job.updated_at || job.created_at).getTime();
      if (now - lastUpdate > maxActiveTimeMs) {
        stuckJobs.push(jobId);
      }
    }

    return stuckJobs;
  }

  // Abandon a stuck job (remove from active, don't retry)
  abandonJob(jobId: string, reason: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = JobStatus.FAILED;
      job.updated_at = new Date().toISOString();
      job.error = `Abandoned: ${reason}`;
    }
    
    this.activeJobs.delete(jobId);
    this.retryInfo.delete(jobId);
    logger.warn(`🚫 Job abandoned: ${jobId} - ${reason}`);
  }

  // Get retry info for a job
  getRetryInfo(jobId: string): JobRetryInfo | null {
    return this.retryInfo.get(jobId) || null;
  }

  // Clean up old completed jobs (optional)
  cleanup(maxAge: number = 86400000): void { // 24 hours default
    const cutoff = Date.now() - maxAge;
    const toDelete: string[] = [];

    for (const [jobId, job] of this.jobs) {
      const jobTime = new Date(job.created_at).getTime();
      if (jobTime < cutoff && (job.status === JobStatus.COMPLETE || job.status === JobStatus.FAILED)) {
        toDelete.push(jobId);
        this.retryInfo.delete(jobId); // Clean up retry info too
      }
    }

    for (const jobId of toDelete) {
      this.jobs.delete(jobId);
      this.cachedResults.delete(jobId); // Clean up cached results too
      
      // 🐛 FIX: Remove ghost job IDs from pendingQueue to prevent phantom positions
      const queueIndex = this.pendingQueue.indexOf(jobId);
      if (queueIndex !== -1) {
        this.pendingQueue.splice(queueIndex, 1);
      }
    }

    if (toDelete.length > 0) {
      logger.info(`🧹 Cleaned up ${toDelete.length} old jobs`);
    }
  }

  /**
   * Cache processing results for smart retries
   * This allows retries to skip expensive download/encode/upload steps
   */
  cacheResult(jobId: string, result: any): void {
    this.cachedResults.set(jobId, result);
    logger.debug(`💾 Cached result for job ${jobId} (smart retry optimization)`);
  }

  /**
   * Get cached processing result for a job
   * Returns null if no cached result exists
   */
  getCachedResult(jobId: string): any | null {
    return this.cachedResults.get(jobId) || null;
  }

  /**
   * Clear cached result for a job (called on successful completion)
   */
  clearCachedResult(jobId: string): void {
    if (this.cachedResults.has(jobId)) {
      this.cachedResults.delete(jobId);
      logger.debug(`🗑️ Cleared cached result for job ${jobId}`);
    }
  }

  /**
   * 🚨 FIX: Cleanup old cached results to prevent memory leaks
   */
  cleanupOldCache(): void {
    const maxCacheAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    let cleaned = 0;
    
    for (const [jobId, result] of this.cachedResults) {
      const job = this.jobs.get(jobId);
      if (!job || !job.updated_at || (now - new Date(job.updated_at).getTime()) > maxCacheAge) {
        this.cachedResults.delete(jobId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.info(`🗑️ Cleaned ${cleaned} old cached results from memory`);
    }
  }

  /**
   * Get statistics about cached results
   */
  getCacheStats(): { count: number; jobIds: string[] } {
    return {
      count: this.cachedResults.size,
      jobIds: Array.from(this.cachedResults.keys())
    };
  }
}