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
      [4, 'plans_repos_ask'],
      [5, 'plans_sidebar_folder'],
    ]);
    // Applied migrations are checksummed (even their comments): never edit them, add a new one.
    expect(PLANS_MIGRATIONS[0]?.checksum).toBe('09299d9f83949d7041a0fa60b82d19adc56546746ffb7dc612c1e10ed8c75152');
    expect(PLANS_MIGRATIONS[1]?.checksum).toBe('1cfc9e81157f586976506d6ac2c13bfed10dd950776fdcc4d1f25b5b8b0de803');
    // D115 follow-ups 2026-10-20: migration 3 is released too.
    expect(PLANS_MIGRATIONS[2]?.checksum).toBe('ba41d940c4acea0565f48d1ec6f54a72d3b6bcc06f57c823f2d1eee88bb7f358');
    // D130: migration 4 is released too (1.33 / 1.34).
    expect(PLANS_MIGRATIONS[3]?.checksum).toBe('f73bd0e7fa82262a9ef972c96661793764a9e35a0cb4f15ab99a99c236ddbdc0');
  });

  it('D130 · migration 5: a plan from a plans.db at migration 4 has no runs\' subfolder; the subfolder round-trips', async () => {
    dir = await makeTempDir('plans-migration-5');
    const old = await PlansDb.open(dir, () => NOW, PLANS_MIGRATIONS.slice(0, 4));
    await old.plans.create({ id: 'p-old', title: 'Old epic', sourceSessionId: 's1', targetBranch: null, repos: [], baseBranch: 'dev', maxConcurrency: 3, usageThreshold: 85, answers: null, external: null });
    old.close();
    const upgraded = await PlansDb.open(dir, () => NOW);
    try {
      expect((await upgraded.plans.get('p-old'))?.sidebarFolder).toBeNull();
      await upgraded.plans.update('p-old', { sidebarFolder: { id: 'f1', name: 'Acme epic' } });
      expect((await upgraded.plans.get('p-old'))?.sidebarFolder).toEqual({ id: 'f1', name: 'Acme epic' });
    } finally {
      upgraded.close();
    }
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

describe('D115 follow-ups 2026-10-20 · plans.db migration 4', () => {
  it('a plans.db at migration 3 upgrades: its plans read unchanged, with no repositories ask; the ask round-trips', async () => {
    dir = await makeTempDir('plans-migration-4');
    const old = await PlansDb.open(dir, () => NOW, PLANS_MIGRATIONS.slice(0, 3));
    await old.plans.create({ id: 'p-ws', title: 'Acme epic', sourceSessionId: 's1', targetBranch: 'feature/PROJ-10-acme', repos: [], baseBranch: 'main', maxConcurrency: 3, usageThreshold: 85, answers: null, external: null });
    await old.plans.update('p-ws', { mergeMode: 'agents-with-holds', allowProtectedTarget: true });
    old.close();

    const upgraded = await PlansDb.open(dir, () => NOW);
    try {
      const plan = await upgraded.plans.get('p-ws');
      expect(plan).toMatchObject({ targetBranch: 'feature/PROJ-10-acme', repos: [], mergeMode: 'agents-with-holds', allowProtectedTarget: true, reposAskedAt: null, reposAskRaised: false });
      await upgraded.plans.setReposAsk('p-ws', { askedAt: '2026-10-20T10:00:00.000Z', raised: true });
      expect(await upgraded.plans.get('p-ws')).toMatchObject({ reposAskedAt: '2026-10-20T10:00:00.000Z', reposAskRaised: true, updatedAt: plan?.updatedAt });
      await upgraded.plans.setReposAsk('p-ws', { askedAt: null });
      expect(await upgraded.plans.get('p-ws')).toMatchObject({ reposAskedAt: null, reposAskRaised: true });
    } finally {
      upgraded.close();
    }
  });
});
