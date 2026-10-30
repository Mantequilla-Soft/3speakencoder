import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkInterfaces } from 'os';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { DashboardService } = await import('../../src/services/DashboardService.js');
const { safeEqual } = await import('../../src/common/auth.js');

let dashboard: InstanceType<typeof DashboardService> | undefined;
afterEach(async () => { await dashboard?.stop(); dashboard = undefined; });

async function start(options: { host?: string; password?: string; allowedHosts?: string[] } = {}, encoder?: any) {
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

describe('DNS rebinding / cross-origin protection', async () => {
  const http = await import('http');
  const { WebSocket } = await import('ws');
  const { hostname } = await import('os');
  const { createHostCheck, originMatchesHost } = await import('../../src/common/hostCheck.js');

  /** Raw request so we can forge Host/Origin like a rebound page would. */
  function raw(port: number, method: string, path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
      req.end();
    });
  }

  it('createHostCheck accepts IPs, localhost, this machine and configured names only', () => {
    const ok = createHostCheck(['encoder.lan']);
    for (const h of ['127.0.0.1:3001', '192.168.1.113:3001', '[::1]:3001', 'localhost:3001', 'app.localhost', `${hostname()}:3001`, 'ENCODER.LAN:3001']) {
      expect(ok(h), h).toBe(true);
    }
    for (const h of ['evil.example:3001', 'evil.example', '127.0.0.1.evil.example', '', undefined]) {
      expect(ok(h as any), String(h)).toBe(false);
    }
  });

  it('originMatchesHost', () => {
    expect(originMatchesHost(undefined, '127.0.0.1:3001')).toBe(true);
    expect(originMatchesHost('http://127.0.0.1:3001', '127.0.0.1:3001')).toBe(true);
    expect(originMatchesHost('http://evil.example', '127.0.0.1:3001')).toBe(false);
    expect(originMatchesHost('http://127.0.0.1:9999', '127.0.0.1:3001')).toBe(false);
    expect(originMatchesHost('null', '127.0.0.1:3001')).toBe(false);
  });

  it('refuses a rebound request (foreign Host) even with the CSRF header and no password', async () => {
    const encoder = fakeEncoder();
    const { port } = await start({ host: '127.0.0.1' }, encoder);
    const status = await raw(port, 'POST', '/api/retry-job/j1', {
      Host: `evil.example:${port}`, Origin: `http://evil.example:${port}`, 'X-Dashboard-Request': '1',
    });
    expect(status).toBe(403);
    expect(encoder.releaseStuckJob).not.toHaveBeenCalled();
    expect(await raw(port, 'GET', '/api/status', { Host: `evil.example:${port}` })).toBe(403);
  });

  it('refuses a cross-origin POST to the real host', async () => {
    const encoder = fakeEncoder();
    const { port } = await start({}, encoder);
    const status = await raw(port, 'POST', '/api/retry-job/j1', {
      Host: `127.0.0.1:${port}`, Origin: 'https://evil.example', 'X-Dashboard-Request': '1',
    });
    expect(status).toBe(403);
    expect(encoder.releaseStuckJob).not.toHaveBeenCalled();
  });

  it('still serves the page and same-origin actions by IP, LAN-style', async () => {
    const encoder = fakeEncoder();
    const { port } = await start({}, encoder);
    expect(await raw(port, 'GET', '/', { Host: `192.168.1.50:${port}` })).toBe(200);
    expect(await raw(port, 'POST', '/api/retry-job/j1', {
      Host: `192.168.1.50:${port}`, Origin: `http://192.168.1.50:${port}`, 'X-Dashboard-Request': '1',
    })).toBe(200);
  });

  it('accepts a name from DASHBOARD_ALLOWED_HOSTS', async () => {
    const { port } = await start({ allowedHosts: ['encoder.lan'] });
    expect(await raw(port, 'GET', '/api/status', { Host: `encoder.lan:${port}` })).toBe(200);
  });

  function wsResult(url: string, opts: any): Promise<string> {
    return new Promise(resolve => {
      const ws = new WebSocket(url, opts);
      ws.once('open', () => { ws.close(); resolve('open'); });
      ws.once('unexpected-response', (_req: unknown, res: any) => resolve(`rejected ${res.statusCode}`));
      ws.once('error', () => resolve('error'));
    });
  }

  it('WebSocket: refuses foreign Origin and foreign Host, allows the dashboard itself', async () => {
    const { port } = await start({ host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${port}`;
    expect(await wsResult(url, { origin: 'https://evil.example' })).toBe('rejected 401');
    expect(await wsResult(url, { headers: { Host: `evil.example:${port}` } })).toBe('rejected 401');
    expect(await wsResult(url, { origin: `http://127.0.0.1:${port}` })).toBe('open');
    expect(await wsResult(url, {})).toBe('open'); // non-browser client, no Origin
  });
});

describe('self-update endpoints', () => {
  function updater(enabled = true, password: string | null = 'up-pw') {
    return {
      isEnabled: () => enabled && !!password,
      getPassword: () => password ?? undefined,
      getState: () => ({ phase: 'idle' }),
      checkEligibility: vi.fn(async () => ({ eligible: true, docker: false, supervised: false, checks: [], checkedAt: '' })),
      start: vi.fn(async () => ({ phase: 'draining' })),
      cancel: vi.fn(() => { throw Object.assign(new Error('Nothing to cancel (idle)'), { status: 409 }); }),
    };
  }
  async function startWith(u: any) {
    const r = await start();
    dashboard!.setUpdater(u);
    return r.base;
  }
  const hdr = (pw?: string) => ({ 'X-Dashboard-Request': '1', ...(pw ? { 'X-Update-Password': pw } : {}) });

  it('GET /api/update reports state and eligibility', async () => {
    const u = updater();
    const base = await startWith(u);
    const body = await (await fetch(`${base}/api/update`)).json();
    expect(body).toMatchObject({ available: true, enabled: true, state: { phase: 'idle' }, eligibility: { eligible: true } });
    await fetch(`${base}/api/update`);
    expect(u.checkEligibility).toHaveBeenCalledOnce(); // cached
  });

  it('GET /api/update without an updater', async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/api/update`)).json()).toEqual({ available: false });
  });

  it('refuses without the CSRF header, when disabled, or without a password configured', async () => {
    let base = await startWith(updater());
    expect((await post(`${base}/api/update`, { 'X-Update-Password': 'up-pw' })).status).toBe(403);
    await dashboard!.stop();

    base = await startWith(updater(false));
    expect((await post(`${base}/api/update`, hdr('up-pw'))).status).toBe(403);
    await dashboard!.stop();

    base = await startWith(updater(true, null));
    expect((await post(`${base}/api/update`, hdr(''))).status).toBe(403);
  });

  it('401 with a missing or wrong password; 202 with the right one', async () => {
    const u = updater();
    const base = await startWith(u);
    expect((await post(`${base}/api/update`, hdr())).status).toBe(401);
    expect((await post(`${base}/api/update`, hdr('nope'))).status).toBe(401);
    expect(u.start).not.toHaveBeenCalled();

    const res = await post(`${base}/api/update`, hdr('up-pw'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: { phase: 'draining' } });
  });

  it('the dashboard password does not unlock updates', async () => {
    dashboard = new DashboardService(0, undefined, { password: 'dash-pw' });
    dashboard.setUpdater(updater() as any);
    await dashboard.start();
    const base = `http://127.0.0.1:${(dashboard as any).server.address().port}`;
    expect((await post(`${base}/api/update`, { 'X-Dashboard-Request': '1', 'X-Dashboard-Password': 'dash-pw' })).status).toBe(401);
  });

  it('maps service errors to their HTTP status', async () => {
    const u = updater();
    u.start.mockRejectedValueOnce(Object.assign(new Error('Already up to date'), { status: 409 }));
    const base = await startWith(u);
    const res = await post(`${base}/api/update`, hdr('up-pw'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Already up to date' });
    expect((await post(`${base}/api/update/cancel`, hdr('up-pw'))).status).toBe(409);
  });
});
