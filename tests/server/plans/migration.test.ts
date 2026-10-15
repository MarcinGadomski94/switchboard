/**
 * D99 follow-up 2026-10-15 (plans for anything): `plans.db` migration 3 adds `no_merge` and
 * `allow_protected_target` to `plans` (a missing target is stored as `''`). The released
 * migrations 1 and 2 never change (their checksums are pinned here), and a plan written by a
 * `plans.db` at migration 2 reads exactly as it was after the upgrade.
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PLANS_DB_FILE, PLANS_MIGRATIONS, PlansDb } from '../../../src/server/plans/db.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await removeTempDir(dir);
  dir = undefined;
});

const NOW = '2026-10-15T10:00:00.000Z';

describe('D99 follow-up 2026-10-15 · plans.db migration 3', () => {
  it('keeps the released migrations as they were and adds migration 3', () => {
    expect(PLANS_MIGRATIONS.map((migration) => [migration.version, migration.name])).toEqual([
      [1, 'plans'],
      [2, 'plan_item_spans'],
      [3, 'plans_any_target'],
    ]);
    // Applied migrations are checksummed (even their comments): never edit them, add a new one.
    expect(PLANS_MIGRATIONS[0]?.checksum).toBe('09299d9f83949d7041a0fa60b82d19adc56546746ffb7dc612c1e10ed8c75152');
    expect(PLANS_MIGRATIONS[1]?.checksum).toBe('1cfc9e81157f586976506d6ac2c13bfed10dd950776fdcc4d1f25b5b8b0de803');
  });

  it('a plan from a plans.db at migration 2 reads unchanged after the upgrade; the new fields round-trip', async () => {
    dir = await makeTempDir('plans-migration');
    const old = await PlansDb.open(dir, () => NOW, PLANS_MIGRATIONS.slice(0, 2));
    await old.plans.create({ id: 'p-old', title: 'Old epic', sourceSessionId: 's1', targetBranch: 'feature/PROJ-1-old', repos: ['acme'], baseBranch: 'main', maxConcurrency: 2, usageThreshold: 80, answers: null, external: null });
    old.close();
    // As 1.21.0 wrote it (its columns only).
    const raw = new DatabaseSync(path.join(dir, PLANS_DB_FILE));
    raw.prepare("UPDATE plans SET merge_mode = 'agents-with-holds', state = 'running' WHERE id = 'p-old'").run();
    raw.close();

    const upgraded = await PlansDb.open(dir, () => NOW);
    try {
      expect(await upgraded.plans.get('p-old')).toMatchObject({ targetBranch: 'feature/PROJ-1-old', baseBranch: 'main', mergeMode: 'agents-with-holds', allowProtectedTarget: false, state: 'running', maxConcurrency: 2, usageThreshold: 80 });

      // No target (stored as ''), the none mode (no_merge), the acknowledgement.
      await upgraded.plans.create({ id: 'p-none', title: 'Research', sourceSessionId: 's1', targetBranch: null, repos: [], baseBranch: 'dev', maxConcurrency: 3, usageThreshold: 85, answers: null, external: null });
      expect(await upgraded.plans.get('p-none')).toMatchObject({ targetBranch: null, mergeMode: null, allowProtectedTarget: false });
      await upgraded.plans.update('p-none', { mergeMode: 'none' });
      expect((await upgraded.plans.get('p-none'))?.mergeMode).toBe('none');
      await upgraded.plans.update('p-old', { mergeMode: 'agents', allowProtectedTarget: true, targetBranch: 'dev' });
      expect(await upgraded.plans.get('p-old')).toMatchObject({ mergeMode: 'agents', allowProtectedTarget: true, targetBranch: 'dev' });
      await upgraded.plans.update('p-none', { mergeMode: 'developer' });
      expect((await upgraded.plans.get('p-none'))?.mergeMode).toBe('developer');
    } finally {
      upgraded.close();
    }
  });
});
