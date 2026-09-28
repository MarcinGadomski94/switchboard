import { describe, expect, it } from 'vitest';
import { loadDemoData } from '../../../src/server/demo/data.ts';
import { demoFolderChecks } from '../../../src/server/demo/folders.ts';
import { openStore } from '../../../src/server/db/store.ts';
import { FolderService } from '../../../src/server/folders/service.ts';

describe('demo folder check (D14)', () => {
  it("answers the prototype's workspace root as a workspace without touching the disk; other paths are checked on disk", async () => {
    const data = await loadDemoData();
    const checks = demoFolderChecks(data);
    const root = data.solutions.root;
    expect(checks.get(root)).toMatchObject({ path: root, exists: true, kind: 'workspace', router: { title: 'AGENTS.md (Workspace Router)' }, problem: null, message: '' });
    expect(checks.get(root)?.solutionCount).toBe(data.solutions.groups.reduce((n, g) => n + g.solutions.length, 0));

    const store = await openStore(':memory:');
    try {
      const service = new FolderService({ store, knownChecks: checks });
      expect(await service.check(root)).toBe(checks.get(root));
      expect((await service.check('/definitely/not/here')).kind).toBeNull();
    } finally {
      await store.close();
    }
  });
});
