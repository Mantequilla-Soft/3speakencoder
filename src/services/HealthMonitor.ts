import { monitorEventLoopDelay } from 'perf_hooks';
import { logger } from './Logger.js';

/**
 * Event-loop lag monitor.
 *
 * Uses Node's native monitorEventLoopDelay() histogram, read and reset every
 * `sampleIntervalMs`. Each read becomes one bucket; the last `windowMs` worth of
 * buckets form the rolling window. Histograms from monitorEventLoopDelay can't
 * be merged, so window stats are combined from bucket summaries:
 *   p50 = median of bucket p50s, p99 = max of bucket p99s, max = max of bucket maxes.
 * p99 is therefore conservative (never under-reports).
 *
 * The native histogram records the time between its timer ticks, so an idle
 * loop reads ~resolution. We subtract the resolution to report pure lag
 * (idle ≈ 0ms).
 */

export interface EventLoopStats {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  windowSec: number;
  /** Worst lag seen since the monitor started, and when. */
  maxSinceStartMs: number;
  maxSinceStartAt: string | null;
}

export interface DelaySampler {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(p: number): number; // nanoseconds
  readonly max: number; // nanoseconds
  readonly count: number;
}

interface Bucket {
  at: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface HealthMonitorOptions {
  resolutionMs?: number;
  sampleIntervalMs?: number;
  windowMs?: number;
  warnP99Ms?: number;
  /** How often to log an INFO summary, so lag history survives in encoder.log. */
  summaryIntervalMs?: number;
  sampler?: DelaySampler;
  now?: () => number;
}

const NS_PER_MS = 1e6;

export class HealthMonitor {
  private readonly resolutionMs: number;
  private readonly sampleIntervalMs: number;
  private readonly windowMs: number;
  private readonly warnP99Ms: number;
  private readonly summaryIntervalMs: number;
  private readonly sampler: DelaySampler;
  private readonly now: () => number;
  private buckets: Bucket[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastWarnAt = -Infinity;
  private maxSinceStartMs = 0;
  private maxSinceStartAt: number | null = null;
  private summaryStartAt: number;
  private summaryMaxMs = 0;
  private summaryP99Ms = 0;

  constructor(options: HealthMonitorOptions = {}) {
    this.resolutionMs = options.resolutionMs ?? 20;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 5000;
    this.windowMs = options.windowMs ?? 60000;
    this.warnP99Ms = options.warnP99Ms ?? 500;
    this.summaryIntervalMs = options.summaryIntervalMs ?? 60 * 60 * 1000;
    this.sampler = options.sampler ?? monitorEventLoopDelay({ resolution: this.resolutionMs });
    this.now = options.now ?? Date.now;
    this.summaryStartAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.sampler.enable();
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs);
    this.timer.unref();
    logger.info(`🩺 Event-loop monitor started (${this.sampleIntervalMs / 1000}s samples, ${this.windowMs / 1000}s window)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sampler.disable();
  }

  /** Read the native histogram into a bucket and reset it. Public for tests. */
  sample(): void {
    const now = this.now();
    if (this.sampler.count > 0) {
      const bucket: Bucket = {
        at: now,
        p50Ms: this.toLagMs(this.sampler.percentile(50)),
        p99Ms: this.toLagMs(this.sampler.percentile(99)),
        maxMs: this.toLagMs(this.sampler.max),
      };
      this.buckets.push(bucket);

      if (bucket.maxMs > this.maxSinceStartMs) {
        this.maxSinceStartMs = bucket.maxMs;
        this.maxSinceStartAt = now;
      }

      if (bucket.p99Ms > this.warnP99Ms && now - this.lastWarnAt >= this.windowMs) {
        this.lastWarnAt = now;
        logger.warn(`🐢 Event loop lag high: p99 ${bucket.p99Ms}ms, max ${bucket.maxMs}ms over the last ${this.sampleIntervalMs / 1000}s`);
      }

      this.summaryMaxMs = Math.max(this.summaryMaxMs, bucket.maxMs);
      this.summaryP99Ms = Math.max(this.summaryP99Ms, bucket.p99Ms);
    }

    if (now - this.summaryStartAt >= this.summaryIntervalMs) {
      const minutes = Math.round((now - this.summaryStartAt) / 60000);
      logger.info(`🩺 Event loop lag, last ${minutes}min: worst p99 ${this.summaryP99Ms}ms, max ${this.summaryMaxMs}ms (since start: max ${this.maxSinceStartMs}ms)`);
      this.summaryStartAt = now;
      this.summaryMaxMs = 0;
      this.summaryP99Ms = 0;
    }
    this.sampler.reset();
    this.buckets = this.buckets.filter(b => now - b.at < this.windowMs);
  }

  getStats(): EventLoopStats {
    const now = this.now();
    const live = this.buckets.filter(b => now - b.at < this.windowMs);
    return {
      p50Ms: median(live.map(b => b.p50Ms)),
      p99Ms: Math.max(0, ...live.map(b => b.p99Ms)),
      maxMs: Math.max(0, ...live.map(b => b.maxMs)),
      windowSec: this.windowMs / 1000,
      maxSinceStartMs: this.maxSinceStartMs,
      maxSinceStartAt: this.maxSinceStartAt === null ? null : new Date(this.maxSinceStartAt).toISOString(),
    };
  }

  private toLagMs(ns: number): number {
    return Math.max(0, Math.round(ns / NS_PER_MS - this.resolutionMs));
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
