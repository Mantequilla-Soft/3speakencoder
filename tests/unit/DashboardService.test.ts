import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { WebSocket } from 'ws';

const { DashboardService } = await import('../../src/services/DashboardService.js');
const { HealthMonitor } = await import('../../src/services/HealthMonitor.js');
type Dashboard = InstanceType<typeof DashboardService>;

let dashboard: Dashboard | undefined;

async function startDashboard(withMonitor = true, options = {}): Promise<string> {
  const monitor = withMonitor ? new HealthMonitor({ sampleIntervalMs: 60_000 }) : undefined;
  dashboard = new DashboardService(0, monitor, options);
  await dashboard.start();
  const { port } = (dashboard as any).server.address();
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await dashboard?.stop();
  dashboard = undefined;
});

describe('DashboardService /api/status', () => {
  it('includes server start time, uptime and event-loop stats', async () => {
    const base = await startDashboard();
    const body: any = await (await fetch(`${base}/api/status`)).json();

    expect(Date.parse(body.serverStartTime)).toBeLessThanOrEqual(Date.now());
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.eventLoop).toMatchObject({ p50Ms: 0, p99Ms: 0, maxMs: 0, windowSec: 60 });
  });

  it('omits event-loop stats when no monitor is attached', async () => {
    const base = await startDashboard(false);
    const body: any = await (await fetch(`${base}/api/status`)).json();
    expect(body).not.toHaveProperty('eventLoop');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

function connect(base: string, opts: { autoPong?: boolean } = {}) {
  const ws = new WebSocket(base.replace('http', 'ws'), opts);
  const messages: any[] = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
  return { ws, messages, opened, closed };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('DashboardService WebSocket liveness', () => {
  it('sends the current status on connect, before the encoder reports in', async () => {
    const base = await startDashboard();
    const c = connect(base);
    await c.opened;
    await sleep(50);
    expect(c.messages[0]).toMatchObject({ type: 'status', data: { online: false, starting: true } });
    expect(c.messages[0].data.uptimeSec).toBeGreaterThanOrEqual(0);
    c.ws.close();
  });

  it('pulses at the configured cadence with uptime, active jobs and event-loop p99', async () => {
    const base = await startDashboard(true, { pulseIntervalMs: 50, pingIntervalMs: 60_000 });
    const c = connect(base);
    await c.opened;
    await sleep(280);
    const pulses = c.messages.filter(m => m.type === 'pulse');
    expect(pulses.length).toBeGreaterThanOrEqual(3); // ~5 expected; loose for coarse CI timers
    expect(pulses.length).toBeLessThanOrEqual(7);
    expect(pulses[0].data).toMatchObject({ activeJobs: 0, eventLoopP99: 0 });
    expect(pulses[0].data.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(Date.parse(pulses[0].data.serverTime)).not.toBeNaN();
    c.ws.close();
  });

  it('pulse reports the latest active job count', async () => {
    const base = await startDashboard(true, { pulseIntervalMs: 50, pingIntervalMs: 60_000 });
    const c = connect(base);
    await c.opened;
    dashboard!.startJob('job-1', { video_id: 'a/b' });
    await sleep(120);
    const last = c.messages.filter(m => m.type === 'pulse').at(-1);
    expect(last.data.activeJobs).toBe(1);
    c.ws.close();
  });

  it('keeps clients that answer pings', async () => {
    const base = await startDashboard(true, { pulseIntervalMs: 60_000, pingIntervalMs: 40 });
    const c = connect(base);
    await c.opened;
    await sleep(250);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it('terminates a client that misses 2 pongs', async () => {
    const base = await startDashboard(true, { pulseIntervalMs: 60_000, pingIntervalMs: 40 });
    const c = connect(base, { autoPong: false });
    await c.opened;
    // ping #1 at 40ms, ping #2 at 80ms, terminate at 120ms
    const code = await Promise.race([c.closed, sleep(1000).then(() => -1)]);
    expect(code).toBe(1006); // abnormal closure = server terminated the socket
  });

  it('stop() closes even with clients connected', async () => {
    const base = await startDashboard();
    const c = connect(base);
    await c.opened;
    const stopped = await Promise.race([dashboard!.stop().then(() => true), sleep(1000).then(() => false)]);
    dashboard = undefined;
    expect(stopped).toBe(true);
    await c.closed;
  });
});
