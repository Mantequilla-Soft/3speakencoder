import { beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
const info = vi.fn();
vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: (...a: unknown[]) => info(...a), warn: (...a: unknown[]) => warn(...a), debug: vi.fn(), error: vi.fn() },
}));

const { HealthMonitor } = await import('../../src/services/HealthMonitor.js');
type DelaySampler = import('../../src/services/HealthMonitor.js').DelaySampler;

const MS = 1e6;
const RES = 20;

/** Fake histogram: set what the next sample() will read, in ms of *measured* delay. */
class FakeSampler implements DelaySampler {
  p50 = 0; p99 = 0; max = 0; count = 0;
  set(p50: number, p99: number, max: number) {
    this.p50 = p50 * MS; this.p99 = p99 * MS; this.max = max * MS; this.count = 10;
  }
  enable() {}
  disable() {}
  reset() { this.p50 = this.p99 = this.max = 0; this.count = 0; }
  percentile(p: number) { return p === 50 ? this.p50 : this.p99; }
}

function setup() {
  const sampler = new FakeSampler();
  let now = 1_000_000;
  const monitor = new HealthMonitor({
    sampler, resolutionMs: RES, sampleIntervalMs: 5000, windowMs: 60000, warnP99Ms: 500, summaryIntervalMs: 3_600_000, now: () => now,
  });
  const tick = (p50: number, p99: number, max: number) => {
    now += 5000;
    sampler.set(p50 + RES, p99 + RES, max + RES); // native histogram includes the resolution
    monitor.sample();
  };
  return { monitor, tick, advance: (ms: number) => { now += ms; } };
}

describe('HealthMonitor', () => {
  beforeEach(() => { warn.mockClear(); info.mockClear(); });

  it('reports zeros before any samples', () => {
    const { monitor } = setup();
    expect(monitor.getStats()).toMatchObject({ p50Ms: 0, p99Ms: 0, maxMs: 0, windowSec: 60, maxSinceStartMs: 0, maxSinceStartAt: null });
  });

  it('subtracts the timer resolution so an idle loop reads ~0', () => {
    const { monitor, tick } = setup();
    tick(0, 0, 0);
    expect(monitor.getStats()).toMatchObject({ p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });

  it('combines buckets: median of p50, max of p99, max of max', () => {
    const { monitor, tick } = setup();
    tick(1, 10, 20);
    tick(3, 50, 80);
    tick(2, 30, 40);
    expect(monitor.getStats()).toMatchObject({ p50Ms: 2, p99Ms: 50, maxMs: 80 });
  });

  it('drops buckets older than the window', () => {
    const { monitor, tick, advance } = setup();
    tick(5, 400, 900);
    advance(60_000);
    tick(1, 2, 3);
    expect(monitor.getStats()).toMatchObject({ p99Ms: 2, maxMs: 3 });
  });

  it('keeps the worst lag since start after it leaves the window', () => {
    const { monitor, tick, advance } = setup();
    tick(5, 400, 900);
    advance(120_000);
    tick(1, 2, 3);
    const stats = monitor.getStats();
    expect(stats.maxMs).toBe(3);
    expect(stats.maxSinceStartMs).toBe(900);
    expect(stats.maxSinceStartAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('ignores intervals with no samples', () => {
    const { monitor, advance } = setup();
    advance(5000);
    monitor.sample();
    expect(monitor.getStats().maxMs).toBe(0);
  });

  it('warns when p99 exceeds the threshold, at most once per window', () => {
    const { tick } = setup();
    tick(1, 100, 200);
    expect(warn).not.toHaveBeenCalled();
    tick(1, 600, 700);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('p99 600ms');
    tick(1, 800, 900); // 5s later: suppressed
    expect(warn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 11; i++) tick(1, 900, 900); // reaches 60s since the first warning
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs an hourly summary of the worst lag, then starts a new period', () => {
    const { tick } = setup();
    tick(1, 40, 120);
    for (let i = 0; i < 718; i++) tick(0, 0, 0); // 719 ticks x 5s = 3595s
    expect(info).not.toHaveBeenCalled();
    tick(0, 0, 0); // 3600s
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('last 60min: worst p99 40ms, max 120ms');
    for (let i = 0; i < 720; i++) tick(0, 0, 0);
    expect(info.mock.calls[1]?.[0]).toContain('worst p99 0ms, max 0ms (since start: max 120ms)');
  });

  it('measures a real blocked event loop', async () => {
    const monitor = new HealthMonitor({ sampleIntervalMs: 60_000 });
    monitor.start();
    await new Promise(r => setTimeout(r, 100));
    const t = Date.now();
    while (Date.now() - t < 250) { /* block */ }
    await new Promise(r => setTimeout(r, 100));
    monitor.sample();
    monitor.stop();
    expect(monitor.getStats().maxMs).toBeGreaterThanOrEqual(200);
  });
});
