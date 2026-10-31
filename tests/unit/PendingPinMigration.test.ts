import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../src/services/Logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { PendingPinService } = await import('../../src/services/PendingPinService.js');
const { significantChanges } = await import('../../src/services/VersionService.js');

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pins-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('PendingPinService storage', () => {
  it('migrates pins from the legacy tracked file and never writes it', async () => {
    const legacy = JSON.stringify({
      pending_pins: [{ hash: 'QmA', job_id: 'j1', created_at: '2026-10-01T00:00:00Z', attempts: 0, size_mb: 1, type: 'directory' }],
      last_cleanup: '2026-10-01T00:00:00Z',
    }, null, 2);
    await writeFile(join(dir, 'pending_pins.json'), legacy);

    const svc = new PendingPinService(dir);
    await svc.initialize();

    const migrated = JSON.parse(await readFile(join(dir, 'pending-pins.json'), 'utf8'));
    expect(migrated.pending_pins.map((p: any) => p.hash)).toEqual(['QmA']);

    await svc.addPendingPin('QmB', 'j2', 2, 'file');
    await svc.flush();
    expect(await readFile(join(dir, 'pending_pins.json'), 'utf8')).toBe(legacy); // untouched
    const now = JSON.parse(await readFile(join(dir, 'pending-pins.json'), 'utf8'));
    expect(now.pending_pins.map((p: any) => p.hash)).toEqual(['QmA', 'QmB']);
  });

  it('starts empty without a legacy file, and ignores a corrupt one', async () => {
    await writeFile(join(dir, 'pending_pins.json'), '{not json');
    await new PendingPinService(dir).initialize();
    const data = JSON.parse(await readFile(join(dir, 'pending-pins.json'), 'utf8'));
    expect(data.pending_pins).toEqual([]);
  });

  it('does not re-migrate once the new file exists', async () => {
    await writeFile(join(dir, 'pending-pins.json'), JSON.stringify({ pending_pins: [], last_cleanup: 'x' }));
    await writeFile(join(dir, 'pending_pins.json'), JSON.stringify({ pending_pins: [{ hash: 'QmOld' }], last_cleanup: 'x' }));
    await new PendingPinService(dir).initialize();
    expect(JSON.parse(await readFile(join(dir, 'pending-pins.json'), 'utf8')).pending_pins).toEqual([]);
  });
});

describe('significantChanges', () => {
  it('keeps real changes and drops the legacy runtime file', () => {
    expect(significantChanges(' M data/pending_pins.json\n M src/index.ts\nA  new.ts\n')).toEqual(['src/index.ts', 'new.ts']);
    expect(significantChanges(' M data/pending_pins.json\n')).toEqual([]);
    expect(significantChanges('')).toEqual([]);
  });
});
