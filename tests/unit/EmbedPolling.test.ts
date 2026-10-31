import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { EmbedPollerService } = await import('../../src/services/EmbedPollerService.js');

describe('EmbedPollerService.isPolling (drain must wait for an in-flight myJob)', () => {
  it('is true while myJob is outstanding and false after, even on error', async () => {
    const config: any = { node: { name: 'n' }, embed_system: { enabled: true, mode: 'community', gateway_url: 'https://embed.example' } };
    const identity: any = { createJWS: vi.fn(async () => 'jws') };
    const queue: any = { isIntakePaused: () => false, addDirectJob: vi.fn(async () => ({ id: 'j' })) };
    const svc = new EmbedPollerService(config, identity, queue);

    let answer!: (v: unknown) => void;
    (svc as any).client = { post: vi.fn(() => new Promise(r => { answer = r; })) };
    const poll = (svc as any).pollForJob();
    await vi.waitFor(() => expect((svc as any).client.post).toHaveBeenCalled());
    expect(svc.isPolling()).toBe(true);
    answer({ data: { success: true, job: { owner: 'a', permlink: 'b', input_cid: 'Qm', webhook_url: 'https://h', api_key: 'k', short: false } } });
    await poll;
    expect(svc.isPolling()).toBe(false);
    expect(queue.addDirectJob).toHaveBeenCalledOnce();

    (svc as any).client.post = vi.fn(async () => { throw new Error('network'); });
    await (svc as any).pollForJob();
    expect(svc.isPolling()).toBe(false);
  });

  it('does not poll at all while intake is paused', async () => {
    const svc = new EmbedPollerService({ node: { name: 'n' }, embed_system: { gateway_url: 'https://e' } } as any, {} as any, { isIntakePaused: () => true } as any);
    (svc as any).client = { post: vi.fn() };
    await (svc as any).pollForJob();
    expect((svc as any).client.post).not.toHaveBeenCalled();
    expect(svc.isPolling()).toBe(false);
  });
});
