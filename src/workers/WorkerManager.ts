/**
 * 🔧 Worker Thread Manager
 *
 * Manages a pool of video encoding worker threads.
 * Dispatches encoding jobs to workers and aggregates progress updates.
 *
 * Benefits:
 * - Main thread stays responsive (WebSocket, HTTP)
 * - Workers handle heavy FFmpeg encoding
 * - Can run multiple encodings in parallel (if configured)
 */

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '../services/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface EncodingTask {
  taskId: string;
  sourceFile: string;
  profile: { name: string; height: number };
  profileDir: string;
  outputPath: string;
  codec: { name: string; type: string };
  timeoutMs: number;
  profileSettings: any;
  strategy?: any;
  segmentDuration?: number;
  isShortVideo?: boolean;
}

interface WorkerInfo {
  worker: Worker;
  busy: boolean;
  currentTaskId?: string;
}

export class WorkerManager extends EventEmitter {
  private workerPool: WorkerInfo[] = [];
  private maxWorkers: number;
  private taskQueue: Array<{ task: EncodingTask; resolve: Function; reject: Function }> = [];
  private workerPath: string;
  private isCompiled: boolean;

  constructor(maxWorkers: number = 1) {
    super();
    this.maxWorkers = maxWorkers;

    // Detect if running from compiled dist or source (tsx)
    // When running with tsx: src/workers/*.ts
    // When running compiled: dist/workers/*.js
    this.isCompiled = __dirname.includes('/dist/') || __dirname.includes('\\dist\\');
    const workerFileName = this.isCompiled ? 'VideoEncodingWorker.js' : 'VideoEncodingWorker.ts';
    this.workerPath = join(__dirname, workerFileName);

    logger.info(`🔧 WorkerManager initialized with max ${maxWorkers} worker(s) [${this.isCompiled ? 'compiled' : 'tsx'}]`);
  }

  /**
   * Initialize worker pool
   */
  async initialize(): Promise<void> {
    logger.info(`🚀 Creating ${this.maxWorkers} encoding worker(s)...`);

    for (let i = 0; i < this.maxWorkers; i++) {
      try {
        await this.createWorker();
      } catch (error) {
        logger.error(`❌ Failed to create worker ${i}:`, error);
        throw error;
      }
    }

    logger.info(`✅ Worker pool ready with ${this.workerPool.length} worker(s)`);
  }

  /**
   * Create a new worker thread
   */
  private async createWorker(): Promise<WorkerInfo> {
    return new Promise((resolve, reject) => {
      // When running with tsx (TypeScript), we need to pass tsx loader to workers
      // Otherwise workers can't load .ts files
      const workerOptions: any = {};
      
      if (!this.isCompiled) {
        // Running with tsx - workers need tsx loader
        workerOptions.execArgv = [
          '--import', 'tsx/esm',
          '--expose-gc',
          '--max-old-space-size=12288'
        ];
      }

      const worker = new Worker(this.workerPath, workerOptions);

      const workerInfo: WorkerInfo = {
        worker,
        busy: false
      };

      // Handle worker messages
      worker.on('message', (message: any) => {
        this.handleWorkerMessage(workerInfo, message);
      });

      // Handle worker errors
      worker.on('error', (error) => {
        logger.error(`❌ Worker error:`, error);
        this.emit('worker-error', { workerInfo, error });

        // If worker was processing a task, fail it
        if (workerInfo.currentTaskId) {
          this.emit('task-error', {
            taskId: workerInfo.currentTaskId,
            error: error.message
          });
        }

        // Remove failed worker and try to create a replacement
        this.removeWorker(workerInfo);
        this.createWorker().catch(err => {
          logger.error('Failed to create replacement worker:', err);
        });
      });

      // Handle worker exit
      worker.on('exit', (code) => {
        if (code !== 0) {
          logger.warn(`⚠️ Worker exited with code ${code}`);
        }
        this.removeWorker(workerInfo);
      });

      // Wait for worker ready signal
      const readyTimeout = setTimeout(() => {
        reject(new Error('Worker initialization timeout'));
      }, 10000);

      const readyHandler = (message: any) => {
        if (message.type === 'progress' && message.taskId === 'worker-ready') {
          clearTimeout(readyTimeout);
          worker.off('message', readyHandler);
          this.workerPool.push(workerInfo);
          logger.info(`✅ Worker ${this.workerPool.length} ready`);
          resolve(workerInfo);
        }
      };

      worker.on('message', readyHandler);
    });
  }

  /**
   * Handle messages from worker threads
   */
  private handleWorkerMessage(workerInfo: WorkerInfo, message: any): void {
    const { type, taskId } = message;

    // Skip the worker-ready message
    if (taskId === 'worker-ready') return;

    switch (type) {
      case 'progress':
        // Forward progress to main thread listeners
        this.emit('task-progress', {
          taskId,
          percent: message.percent,
          fps: message.fps,
          bitrate: message.bitrate
        });
        break;

      case 'success':
        // Task completed successfully
        this.emit('task-success', {
          taskId,
          result: message.result
        });

        // Mark worker as available
        workerInfo.busy = false;
        delete workerInfo.currentTaskId;

        // Process next queued task if any
        this.processQueue();
        break;

      case 'error':
        // Task failed
        this.emit('task-error', {
          taskId,
          error: message.error,
          errorDetails: message.errorDetails
        });

        // Mark worker as available
        workerInfo.busy = false;
        delete workerInfo.currentTaskId;

        // Process next queued task if any
        this.processQueue();
        break;

      default:
        logger.warn(`⚠️ Unknown worker message type: ${type}`);
    }
  }

  /**
   * Submit encoding task to worker pool
   */
  async submitTask(task: EncodingTask): Promise<any> {
    return new Promise((resolve, reject) => {
      // Find available worker
      const availableWorker = this.workerPool.find(w => !w.busy);

      if (availableWorker) {
        // Worker available - start immediately
        this.executeTask(availableWorker, task, resolve, reject);
      } else {
        // No workers available - queue the task
        logger.info(`📋 No workers available, queuing task ${task.taskId}`);
        this.taskQueue.push({ task, resolve, reject });
      }
    });
  }

  /**
   * Execute task on a specific worker
   */
  private executeTask(
    workerInfo: WorkerInfo,
    task: EncodingTask,
    resolve: Function,
    reject: Function
  ): void {
    workerInfo.busy = true;
    workerInfo.currentTaskId = task.taskId;

    logger.info(`🎬 Worker processing task ${task.taskId} (${task.profile.name})`);

    // Set up one-time listeners for this specific task
    const successHandler = (event: any) => {
      if (event.taskId === task.taskId) {
        this.off('task-success', successHandler);
        this.off('task-error', errorHandler);
        resolve(event.result);
      }
    };

    const errorHandler = (event: any) => {
      if (event.taskId === task.taskId) {
        this.off('task-success', successHandler);
        this.off('task-error', errorHandler);
        reject(new Error(event.error));
      }
    };

    this.on('task-success', successHandler);
    this.on('task-error', errorHandler);

    // Send task to worker
    workerInfo.worker.postMessage(task);
  }

  /**
   * Process queued tasks when workers become available
   */
  private processQueue(): void {
    if (this.taskQueue.length === 0) return;

    const availableWorker = this.workerPool.find(w => !w.busy);
    if (!availableWorker) return;

    const queued = this.taskQueue.shift();
    if (queued) {
      logger.info(`📤 Dequeuing task ${queued.task.taskId}`);
      this.executeTask(availableWorker, queued.task, queued.resolve, queued.reject);
    }
  }

  /**
   * Remove worker from pool
   */
  private removeWorker(workerInfo: WorkerInfo): void {
    const index = this.workerPool.indexOf(workerInfo);
    if (index !== -1) {
      this.workerPool.splice(index, 1);
      logger.info(`🗑️ Worker removed from pool (${this.workerPool.length} remaining)`);
    }
  }

  /**
   * Get worker pool status
   */
  getStatus(): {
    totalWorkers: number;
    busyWorkers: number;
    queuedTasks: number;
  } {
    return {
      totalWorkers: this.workerPool.length,
      busyWorkers: this.workerPool.filter(w => w.busy).length,
      queuedTasks: this.taskQueue.length
    };
  }

  /**
   * Shutdown all workers
   */
  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down worker pool...');

    const terminationPromises = this.workerPool.map(workerInfo => {
      return workerInfo.worker.terminate();
    });

    await Promise.all(terminationPromises);
    this.workerPool = [];
    this.taskQueue = [];

    logger.info('✅ Worker pool shutdown complete');
  }
}
