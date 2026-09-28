import { describe, expect, it } from 'vitest';
import { loadDemoData } from '../../../src/server/demo/data.ts';
import { folderRef } from '../../helpers/folders.ts';
import { createDemoProviders, parseBranchRefs, parseDelta } from '../../../src/server/demo/providers.ts';

/** D14: the demo providers ignore the folder; this is the demo's one folder. */
const DEMO_FOLDER = folderRef('D:\\acme', 'workspace', 'demo');

const NOW = new Date('2026-09-28T12:00:00.000Z');
const GIB = 1024 ** 3;

describe('demo providers (D13: alternate implementations, demo mode only)', () => {
  it('diff: the prototype files of a session, filterable by path', async () => {
    const { diff } = createDemoProviders(await loadDemoData(), () => NOW);
    const files = await diff.diff('free-talk-feature');
    expect(files.map((f) => [f.solution, f.path, f.added, f.removed])).toEqual([
      ['acme-app-front', 'Pages/FreeTalk/FreeTalk.razor', 118, 0],
      ['acme-app-front', 'Pages/FreeTalk/TopicChips.razor', 51, 12],
      ['mobile/', 'Views/FreeTalkView.xaml', 96, 0],
      ['mobile/', 'ViewModels/FreeTalkViewModel.cs', 88, 0],
      ['root', 'contracts/free-talk.md', 62, 0],
    ]);
    expect(files[4]?.branch).toBeNull();
    expect(files[1]?.lines[1]).toBe('-    <AcmChip Size="Compact" @bind-Selected="topic.Selected">');
    expect(await diff.diff('free-talk-feature', 'contracts/free-talk.md')).toHaveLength(1);
    expect(await diff.diff('prod-monitoring')).toEqual([]);
    expect(await diff.diff('unknown')).toEqual([]);
  });

  it('solutions: groups with rules, conflicts and branch owners', async () => {
    const { solutions } = createDemoProviders(await loadDemoData(), () => NOW);
    const groups = await solutions.solutions(DEMO_FOLDER);
    expect(groups.map((g) => [g.folder, g.rule])).toEqual([
      ['microfrontends/', 'editable'],
      ['mobile/', 'editable'],
      ['nugets/', 'editable'],
      ['microservices/', 'editable'],
      ['functions/', 'editable'],
      ['read-only', 'read-only'],
    ]);
    const mobile = groups[1]?.solutions[0];
    expect(mobile).toMatchObject({
      name: 'mobile',
      path: 'D:\\acme\\mobile',
      relativePath: 'mobile',
      conflict: true,
      flag: '⚠ shared working tree',
      codebaseMemory: 'dirty',
      ledger: [
        { interface: 'FreeTalkService', phase: 'UI-first', seam: 'seam TODO · FreeTalkViewModel.cs:41' },
        { interface: 'PushPreferencesClient', phase: 'integration', seam: 'Tier A pending on BFF route' },
      ],
    });
    expect(mobile?.artifacts.map((a) => [a.type, a.name, a.meta])).toEqual([
      ['CONTRACT', 'contracts/free-talk.md', 'locked'],
      ['FOLLOWUP', 'mobile-followups/from-acme-app-front.md', '2 pending'],
      ['QA', 'coverage-matrix.md', '12/18'],
    ]);
    // The prototype's detail paths (sd.path), verbatim.
    const byName = new Map(groups.flatMap((g) => g.solutions).map((s) => [s.name, s]));
    expect(byName.get('acme-app-front')?.path).toBe('D:\\acme\\microfrontends\\acme-app-front');
    expect(byName.get('infrastructure')?.path).toBe('D:\\acme\\infrastructure');
    expect(byName.get('old-chat-front')).toMatchObject({ path: 'D:\\acme\\deprecated\\microfrontends\\old-chat-front', ledger: null, artifacts: [] });
    expect(byName.get('typography-nuget')?.codebaseMemory).toBe('fresh');
    expect(mobile?.branches[1]).toEqual({ branch: 'feature/button-variants', worktree: null, sessionId: 'button-rollout', owner: 'button-rollout', status: 'need' });
    expect(groups.flatMap((g) => g.solutions).filter((s) => s.conflict).map((s) => s.name)).toEqual(['mobile']);
    expect(groups[5]?.solutions.every((s) => s.rule === 'read-only')).toBe(true);
  });

  it('system: the prototype footer as contract units', async () => {
    const { system } = createDemoProviders(await loadDemoData(), () => NOW);
    expect(await system.system()).toEqual({
      cli: 'C:\\Users\\dev\\.local\\bin\\claude.exe',
      cliVersion: null,
      signedIn: true,
      ghSignedIn: true,
      cpu: 38,
      ramUsed: 11.2 * GIB,
      ramTotal: 32 * GIB,
      processes: 9,
      usagePct: 62,
      usageResetsAt: '2026-09-28T13:48:00.000Z',
      // D17: the prototype's one Max figure is the Session window; it has no Week figure, so no Week window.
      usageWindows: [{ key: 'session', label: 'Session', pct: 62, resetsAt: '2026-09-28T13:48:00.000Z' }],
    });
  });

  it('system (D17): a Week figure in the demo data becomes the Week window; none, or another shape, stays unknown', async () => {
    const data = await loadDemoData();
    const withWeek = { ...data, system: { ...data.system, footer: { ...data.system.footer, week: '18% · 74h12' } } };
    expect((await createDemoProviders(withWeek, () => NOW).system.system()).usageWindows).toEqual([
      { key: 'session', label: 'Session', pct: 62, resetsAt: '2026-09-28T13:48:00.000Z' },
      { key: 'week', label: 'Week', pct: 18, resetsAt: '2026-10-01T14:12:00.000Z' },
    ]);
    const odd = { ...data, system: { ...data.system, footer: { ...data.system.footer, max: 'n/a', week: '18%' } } };
    const info = await createDemoProviders(odd, () => NOW).system.system();
    expect(info).not.toHaveProperty('usagePct');
    expect(info).not.toHaveProperty('usageWindows');
  });

  it('history: the prototype rows, searchable', async () => {
    const { history } = createDemoProviders(await loadDemoData(), () => NOW);
    const rows = await history.history();
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({
      name: 'speaking-page-360',
      outcome: 'PR #231 merged',
      status: 'done',
      branches: [
        { solution: 'acme-app-front', branch: 'feature/speaking-page' },
        { solution: 'mobile', branch: 'feature/speaking-page' },
      ],
    });
    expect(new Date(rows[0]!.startedAt).getMonth()).toBe(8);
    expect((await history.history('speaking')).map((r) => r.name)).toEqual(['speaking-page-360', 'qa-speaking-page']);
    expect((await history.history('various'))[0]).toMatchObject({ branches: [], solutions: ['various'] });
    expect(rows[0]?.solutions).toEqual([]);
  });

  it('tools (M8.1): every probe is down without touching the network; the prototype dirty list with its times', async () => {
    const { toolProbe, codebaseMemory } = createDemoProviders(await loadDemoData(), () => NOW);
    expect(await toolProbe.probe('http://localhost:13000')).toBe('down');
    const status = await codebaseMemory.status(DEMO_FOLDER);
    expect(status.indexed).toEqual({ projects: 16, mode: 'full' });
    expect(
      status.projects.map((p) => {
        const at = new Date(p.markedAt!);
        return [p.name, p.path, `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`];
      }),
    ).toEqual([
      ['mobile', null, '10:31'],
      ['acme-app-front', null, '10:22'],
      ['components-library-nuget', null, '09:58'],
    ]);
  });

  it('parses deltas and branch lists', () => {
    expect(parseDelta('+51 −12')).toEqual({ added: 51, removed: 12 });
    expect(parseDelta('+118')).toEqual({ added: 118, removed: 0 });
    expect(parseBranchRefs('hubspot-func ⎇ fix/retry-429')).toEqual([{ solution: 'hubspot-func', branch: 'fix/retry-429' }]);
    expect(parseBranchRefs('various')).toEqual([]);
  });
});
