import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { DashboardService } = await import('../../src/services/DashboardService.js');
const { HealthMonitor } = await import('../../src/services/HealthMonitor.js');
type Dashboard = InstanceType<typeof DashboardService>;

let dashboard: Dashboard | undefined;

async function startDashboard(withMonitor = true): Promise<string> {
  const monitor = withMonitor ? new HealthMonitor({ sampleIntervalMs: 60_000 }) : undefined;
  dashboard = new DashboardService(0, monitor);
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
    const body = await (await fetch(`${base}/api/status`)).json();

    expect(Date.parse(body.serverStartTime)).toBeLessThanOrEqual(Date.now());
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.eventLoop).toMatchObject({ p50Ms: 0, p99Ms: 0, maxMs: 0, windowSec: 60 });
  });

  it('omits event-loop stats when no monitor is attached', async () => {
    const base = await startDashboard(false);
    const body = await (await fetch(`${base}/api/status`)).json();
    expect(body).not.toHaveProperty('eventLoop');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});
