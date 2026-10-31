import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { EmbedPollerService } = await import('../../src/services/EmbedPollerService.js');

const SHA = 'a'.repeat(40);

function poller(reportCommit: boolean, info: any = { commit: SHA, behindBy: 4 }) {
  const config: any = {
    node: { name: 'node-1', cryptoAccounts: { hive: 'alice' } },
    embed_system: { enabled: true, mode: 'community', gateway_url: 'https://embed.example', report_commit: reportCommit },
  };
  const identity: any = { createJWS: vi.fn(async (payload: unknown) => JSON.stringify(payload)) };
  const svc = new EmbedPollerService(config, identity, {} as any, () => info);
  (svc as any).client = { post: vi.fn(async () => ({ data: { success: true, encoder: {} } })) };
  return { svc, identity };
}

async function payloads(reportCommit: boolean, info?: any) {
  const { svc, identity } = poller(reportCommit, info);
  await (svc as any).registerNode();
  await (svc as any).sendHeartbeat();
  return { register: identity.createJWS.mock.calls[0][0], heartbeat: identity.createJWS.mock.calls[1][0] };
}

describe('embed payload version fields (#46)', () => {
  it('off by default: payloads are exactly as before', async () => {
    const { register, heartbeat } = await payloads(false);
    expect(register).toEqual({ node_info: { name: 'node-1', cryptoAccounts: { hive: 'alice' }, commit_hash: '2.0.0' } });
    expect(Object.keys(heartbeat).sort()).toEqual(['timestamp', 'version']);
    expect(heartbeat.version).toBe('2.0.0');
  });

  it('on: adds encoder_commit and behind_by, keeps commit_hash/version unchanged', async () => {
    const { register, heartbeat } = await payloads(true);
    expect(register.node_info).toMatchObject({ commit_hash: '2.0.0', encoder_commit: SHA, behind_by: 4 });
    expect(heartbeat).toMatchObject({ version: '2.0.0', encoder_commit: SHA, behind_by: 4 });
  });

  it('on, but unknown commit or no check yet: sends only what is known', async () => {
    expect((await payloads(true, { commit: 'unknown', behindBy: null })).register.node_info).not.toHaveProperty('encoder_commit');
    expect((await payloads(true, { commit: 'abc1234', behindBy: 2 })).heartbeat).not.toHaveProperty('encoder_commit'); // short SHA
    const { heartbeat } = await payloads(true, { commit: SHA, behindBy: null });
    expect(heartbeat.encoder_commit).toBe(SHA);
    expect(heartbeat).not.toHaveProperty('behind_by');
  });
});
