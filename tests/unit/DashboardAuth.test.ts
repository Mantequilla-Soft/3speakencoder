import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkInterfaces } from 'os';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { DashboardService } = await import('../../src/services/DashboardService.js');
const { safeEqual } = await import('../../src/common/auth.js');

let dashboard: InstanceType<typeof DashboardService> | undefined;
afterEach(async () => { await dashboard?.stop(); dashboard = undefined; });

async function start(options: { host?: string; password?: string } = {}, encoder?: any) {
  dashboard = new DashboardService(0, undefined, options);
  if (encoder) dashboard.setEncoder(encoder);
  await dashboard.start();
  const { port, address } = (dashboard as any).server.address();
  return { base: `http://127.0.0.1:${port}`, port, address };
}

const post = (url: string, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers });
const fakeEncoder = () => ({
  releaseStuckJob: vi.fn().mockResolvedValue(undefined),
  config: { ipfs: { enable_local_fallback: true }, storage_admin: { password: 'store-pw' } },
  getPinnedItems: vi.fn().mockResolvedValue([]),
});

describe('safeEqual', () => {
  it('compares strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('state-changing endpoints', () => {
  it.each(['/api/retry-job/j1', '/api/maintenance/release-job/j1'])('%s rejects requests without X-Dashboard-Request (CSRF)', async path => {
    const { base } = await start({}, fakeEncoder());
    const res = await post(base + path);
    expect(res.status).toBe(403);
  });

  it('without a password, works with the header (backward compatible)', async () => {
    const encoder = fakeEncoder();
    const { base } = await start({}, encoder);
    const res = await post(`${base}/api/retry-job/j1`, { 'X-Dashboard-Request': '1' });
    expect(res.status).toBe(200);
    expect(encoder.releaseStuckJob).toHaveBeenCalledWith('j1');
  });

  it('with a password: 401 when missing or wrong, 200 when right', async () => {
    const encoder = fakeEncoder();
    const { base } = await start({ password: 's3cret' }, encoder);
    const url = `${base}/api/maintenance/release-job/j1`;

    const missing = await post(url, { 'X-Dashboard-Request': '1' });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ authRequired: true });
    expect((await post(url, { 'X-Dashboard-Request': '1', 'X-Dashboard-Password': 'nope' })).status).toBe(401);
    expect(encoder.releaseStuckJob).not.toHaveBeenCalled();

    expect((await post(url, { 'X-Dashboard-Request': '1', 'X-Dashboard-Password': 's3cret' })).status).toBe(200);
    expect(encoder.releaseStuckJob).toHaveBeenCalledOnce();
  });

  it('read-only endpoints stay open', async () => {
    const { base } = await start({ password: 's3cret' });
    expect((await fetch(`${base}/api/status`)).status).toBe(200);
  });
});

describe('storage admin (constant-time compare)', () => {
  it('accepts the right password and rejects others', async () => {
    const { base } = await start({}, fakeEncoder());
    const auth = (password: unknown) => fetch(`${base}/api/storage-admin/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
    });
    expect((await auth('store-pw')).status).toBe(200);
    expect((await auth('wrong')).status).toBe(401);
    expect((await auth(123)).status).toBe(401);
    expect((await fetch(`${base}/api/storage-admin/pins`, { headers: { 'x-storage-password': 'store-pw' } })).status).toBe(200);
    expect((await fetch(`${base}/api/storage-admin/pins`)).status).toBe(401);
  });
});

describe('DASHBOARD_HOST', () => {
  it('binds to the given interface only', async () => {
    const { address, port } = await start({ host: '127.0.0.1' });
    expect(address).toBe('127.0.0.1');

    const lanIp = Object.values(networkInterfaces()).flat()
      .find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    if (lanIp) {
      await expect(fetch(`http://${lanIp}:${port}/api/health`)).rejects.toThrow();
    }
  });

  it('listens on all interfaces by default', async () => {
    const { address } = await start();
    expect(['::', '0.0.0.0']).toContain(address);
  });
});
