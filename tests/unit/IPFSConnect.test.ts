import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { IPFSService } = await import('../../src/services/IPFSService.js');

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

/** A free port with nothing listening yet */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise(r => probe.close(r));
  return port;
}

const service = (port: number, waitMs: number) => {
  const svc = new IPFSService({ ipfs: { apiAddr: `/ip4/127.0.0.1/tcp/${port}` } } as any);
  svc.connectWaitMs = waitMs;
  svc.connectRetryMs = 50;
  return svc;
};

describe('IPFSService.initialize waits for a daemon that starts after the encoder', () => {
  it('connects once the daemon comes up', async () => {
    const port = await freePort();
    const svc = service(port, 5000);
    // The "daemon" starts 300ms after the encoder began connecting
    setTimeout(() => {
      server = createServer((_req, res) => res.end(JSON.stringify({ ID: '12D3KooWlate' })));
      server.listen(port, '127.0.0.1');
    }, 300);
    await svc.initialize();
    expect(await svc.getPeerId()).toBe('12D3KooWlate');
  });

  it('gives up after the wait', async () => {
    const svc = service(await freePort(), 200);
    const started = Date.now();
    await expect(svc.initialize()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
