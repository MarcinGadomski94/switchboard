import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_FOLDERS,
  type FolderSpec,
  type ScannedFolder,
  type WorkspaceScan,
  mergeFolderRules,
  parseRouterRules,
  readOnlyCheck,
  ruleFromText,
  stricterRule,
  toSolutionGroups,
} from '../../src/core/workspace-rules.ts';
import { REPO_ROOT } from '../helpers/net.ts';

/** The folder-rule parts of the real router AGENTS.md, verbatim. */
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

describe('ruleFromText', () => {
  it('reads the rule words of the router', () => {
    expect(ruleFromText(' — top-level **read-only archive** of solutions')).toBe('read-only');
    expect(ruleFromText(' — **Read-only**: agents read it')).toBe('read-only');
    expect(ruleFromText(' is read-only.** Solutions under it are never edited')).toBe('read-only');
    expect(ruleFromText(' — archive; never modify anything under it')).toBe('read-only');
    expect(ruleFromText(' — **Editable, but only when the developer explicitly directs a task there**')).toBe('on-request');
    expect(ruleFromText(' — non-product; editable only on explicit developer request')).toBe('on-request');
    expect(ruleFromText(' is non-product, edit-on-request.**')).toBe('on-request');
    expect(ruleFromText(' — tools, on request only')).toBe('on-request');
    expect(ruleFromText(' — the mobile cloned repo (single solution)')).toBe('editable');
    expect(ruleFromText(' — They are backend-only — no UI, already cloned, thread-safe')).toBe('editable');
  });

  it('read-only wins over on-request in one text', () => {
    expect(ruleFromText(' — on request only; read-only for agents')).toBe('read-only');
  });
});

describe('stricterRule', () => {
  it('orders read-only > on-request > editable', () => {
    expect(stricterRule('editable', 'on-request')).toBe('on-request');
    expect(stricterRule('on-request', 'editable')).toBe('on-request');
    expect(stricterRule('on-request', 'read-only')).toBe('read-only');
    expect(stricterRule('read-only', 'editable')).toBe('read-only');
    expect(stricterRule('editable', 'editable')).toBe('editable');
  });
});

describe('parseRouterRules (the real router phrasing)', () => {
  it('finds every folder of the router with its rule and depth, in first-mention order', async () => {
    const rules = parseRouterRules(await readFile(ROUTER_FIXTURE, 'utf8'));
    expect(rules).toEqual([
      { folder: 'mobile', rule: 'editable', depth: 0 },
      { folder: 'microfrontends', rule: 'editable', depth: 1 },
      { folder: 'nugets', rule: 'editable', depth: 1 },
      { folder: 'microservices', rule: 'editable', depth: 1 },
      { folder: 'functions', rule: 'editable', depth: 1 },
      { folder: 'deprecated', rule: 'read-only', depth: 2 },
      { folder: 'infrastructure', rule: 'read-only', depth: 0 },
      { folder: 'other', rule: 'on-request', depth: 1 },
    ]);
  });

  it('ignores items that do not start with a backticked folder, files, fenced code, hidden and nested-list mentions', () => {
    const text = [
      '- Microfrontend → `tools/<repo>/` (a mention later in the line)',
      '- `mobile/AGENTS.md` — a file, not a folder',
      '- `codebase-memory-mcp` is a tool, not a folder',
      '- `.claude/agents/` — hidden folder',
      '- `contracts/<feature>.md` — a file pattern',
      '| `docs/` | a table row |',
      '```',
      '- `bogus/` — inside a fence',
      '```',
      '~~~md',
      '- `bogus2/` — inside a tilde fence',
      '~~~',
      '1. `numbered/` — a numbered item is not a folder bullet',
      '- `tools/<repo>/` — shared tooling',
    ].join('\n');
    expect(parseRouterRules(text)).toEqual([{ folder: 'tools', rule: 'editable', depth: 1 }]);
  });

  it('reads bold-wrapped items, `*`/`+` bullets, CRLF, a BOM and indented continuation lines', () => {
    const text = [
      '﻿# Router',
      '* `archive/<repo>/` — old snapshots kept for reference,',
      '  never edited by agents',
      '+ **`labs/` is experimental.** Editable on request.',
      '- `plain/` — editable',
      '  - `nested/` — its own item, not a continuation of plain/',
    ].join('\r\n');
    expect(parseRouterRules(text)).toEqual([
      { folder: 'archive', rule: 'read-only', depth: 1 },
      { folder: 'labs', rule: 'on-request', depth: 0 },
      { folder: 'plain', rule: 'editable', depth: 0 },
      { folder: 'nested', rule: 'editable', depth: 0 },
    ]);
  });

  it('merges several items for one folder: strictest rule, deepest pattern; caps the depth at 3', () => {
    const text = [
      '- `lab/` — grouping folder',
      '- `lab/<team>/<repo>/` — each repo',
      '- **`lab/` is read-only.**',
      '- `deep/<a>/<b>/<c>/<d>/` — too deep',
    ].join('\n');
    expect(parseRouterRules(text)).toEqual([
      { folder: 'lab', rule: 'read-only', depth: 2 },
      { folder: 'deep', rule: 'editable', depth: 3 },
    ]);
  });

  it('an empty or unrelated file gives no rules', () => {
    expect(parseRouterRules('')).toEqual([]);
    expect(parseRouterRules('# Nothing here\n\nJust prose about `mobile/`.\n')).toEqual([]);
  });
});

describe('mergeFolderRules', () => {
  it('without a router: the ARCHITECTURE baseline', () => {
    const specs = mergeFolderRules([]);
    expect(specs.map((s) => [s.folder, s.rule, s.depth, s.type, s.inRouter])).toEqual([
      ['microfrontends', 'editable', 1, 'Web', false],
      ['mobile', 'editable', 0, 'Mobile', false],
      ['nugets', 'editable', 1, 'NuGet', false],
      ['microservices', 'editable', 1, 'Backend', false],
      ['functions', 'editable', 1, 'Backend', false],
      ['other', 'on-request', 1, 'Other', false],
      ['deprecated', 'read-only', 2, 'Read-only', false],
      ['infrastructure', 'read-only', 0, 'Read-only', false],
    ]);
  });

  it('the real router matches the baseline and marks every folder as named by it', async () => {
    const specs = mergeFolderRules(parseRouterRules(await readFile(ROUTER_FIXTURE, 'utf8')));
    expect(specs.map(({ inRouter, ...rest }) => rest)).toEqual(BASELINE_FOLDERS);
    expect(specs.every((s) => s.inRouter)).toBe(true);
  });

  it('the router can tighten and deepen a baseline folder, never loosen it, and add folders in its order', () => {
    const specs = mergeFolderRules([
      { folder: 'tools', rule: 'editable', depth: 1 },
      { folder: 'nugets', rule: 'read-only', depth: 1 },
      { folder: 'other', rule: 'editable', depth: 0 },
      { folder: 'deprecated', rule: 'editable', depth: 1 },
      { folder: 'microfrontends', rule: 'editable', depth: 2 },
      { folder: 'archive', rule: 'read-only', depth: 0 },
    ]);
    const byFolder = new Map(specs.map((s) => [s.folder, s]));
    expect(byFolder.get('nugets')).toMatchObject({ rule: 'read-only', type: 'Read-only' });
    expect(byFolder.get('other')).toMatchObject({ rule: 'on-request', depth: 1, type: 'Other' });
    expect(byFolder.get('deprecated')).toMatchObject({ rule: 'read-only', depth: 2 });
    expect(byFolder.get('microfrontends')).toMatchObject({ rule: 'editable', depth: 2, type: 'Web' });
    expect(specs.slice(BASELINE_FOLDERS.length)).toEqual([
      { folder: 'tools', rule: 'editable', depth: 1, type: 'Other', inRouter: true },
      { folder: 'archive', rule: 'read-only', depth: 0, type: 'Read-only', inRouter: true },
    ]);
  });
});

describe('readOnlyCheck (NewSession validation)', () => {
  const root = path.join(path.sep, 'ws', 'work space');
  const specs: FolderSpec[] = mergeFolderRules([{ folder: 'archive', rule: 'read-only', depth: 1 }]);
  const none = { always: false, candidates: [] };

  it('a path that starts in a read-only folder is always read-only, whatever the slashes', () => {
    for (const solution of ['deprecated', 'deprecated/microfrontends/old-chat-front', 'deprecated\\mobile', 'infrastructure', './infrastructure', 'archive/old-repo', 'archive']) {
      expect(readOnlyCheck(specs, root, solution), solution).toEqual({ always: true, candidates: [] });
    }
  });

  it('a live solution that shares its name with an archived one (deprecated/mobile/) has nothing read-only to resolve to', () => {
    for (const solution of ['mobile', 'acme-app-front', 'old-chat-front', 'other/it-dashboard', 'microfrontends/acme-app-front']) {
      expect(readOnlyCheck(specs, root, solution), solution).toEqual(none);
    }
  });

  it('a bare name lists the folders it can resolve to inside a folder the router made read-only (read-only when one exists)', () => {
    const tightened = mergeFolderRules([{ folder: 'nugets', rule: 'read-only', depth: 1 }]);
    expect(readOnlyCheck(tightened, root, 'typography-nuget')).toEqual({ always: false, candidates: [path.join(root, 'nugets', 'typography-nuget')] });
    expect(readOnlyCheck(tightened, root, 'mobile')).toEqual({ always: false, candidates: [path.join(root, 'nugets', 'mobile')] });
    expect(readOnlyCheck(tightened, root, 'nugets/typography-nuget')).toEqual({ always: true, candidates: [] });
  });

  it('leaves names that are no workspace solution to the other checks', () => {
    for (const solution of ['', '.', '../elsewhere', '/abs/path']) {
      expect(readOnlyCheck(specs, root, solution), solution).toEqual(none);
    }
  });
});

describe('toSolutionGroups', () => {
  const root = path.join(path.sep, 'ws');
  const folder = (folder: string, solutions: string[], exists = true): ScannedFolder => {
    const spec = mergeFolderRules([]).find((s) => s.folder === folder) as FolderSpec;
    return {
      ...spec,
      exists,
      solutions: solutions.map((relativePath) => ({
        name: relativePath.split('/').at(-1) as string,
        relativePath,
        path: path.join(root, ...relativePath.split('/')),
        git: true,
      })),
    };
  };
  const scan = (folders: ScannedFolder[]): WorkspaceScan => ({ root, router: { path: path.join(root, 'AGENTS.md'), found: true, lines: 10 }, folders });

  it('one group per writable folder, other/ on request, every read-only folder in one read-only group', () => {
    const groups = toSolutionGroups(
      scan([
        folder('microfrontends', ['microfrontends/workspace-front', 'microfrontends/Auth-front', 'microfrontends/acme-app-front']),
        folder('mobile', ['mobile']),
        folder('nugets', []),
        folder('microservices', [], false),
        folder('other', ['other/it-dashboard']),
        folder('deprecated', ['deprecated/mobile', 'deprecated/microfrontends/old-chat-front']),
        folder('infrastructure', ['infrastructure']),
      ]),
    );
    expect(groups.map((g) => [g.folder, g.note, g.rule, g.solutions.map((s) => s.name)])).toEqual([
      ['microfrontends/', '', 'editable', ['Auth-front', 'acme-app-front', 'workspace-front']],
      ['mobile/', '', 'editable', ['mobile']],
      ['other/', 'on request only', 'on-request', ['it-dashboard']],
      ['read-only', 'deprecated/ · infrastructure/ · never edited', 'read-only', ['infrastructure', 'mobile', 'old-chat-front']],
    ]);
    const [web, , other, readOnly] = groups;
    expect(web?.solutions[1]).toEqual({
      name: 'acme-app-front',
      path: path.join(root, 'microfrontends', 'acme-app-front'),
      relativePath: 'microfrontends/acme-app-front',
      type: 'Web',
      status: 'idle',
      rule: 'editable',
      phase: '—',
      changes: '—',
      flag: '',
      conflict: false,
      branches: [],
      // Neutral until LiveSolutions (M6.2) fills them.
      ledger: null,
      artifacts: [],
      codebaseMemory: 'unknown',
    });
    expect(other?.solutions[0]).toMatchObject({ type: 'Other', rule: 'on-request' });
    expect(readOnly?.solutions.map((s) => [s.path, s.type, s.rule, s.changes])).toEqual([
      [path.join(root, 'infrastructure'), 'Read-only', 'read-only', 'locked'],
      [path.join(root, 'deprecated', 'mobile'), 'Read-only', 'read-only', 'locked'],
      [path.join(root, 'deprecated', 'microfrontends', 'old-chat-front'), 'Read-only', 'read-only', 'locked'],
    ]);
  });

  it('the read-only note names only the read-only folders that have solutions; no groups for an empty scan', () => {
    const groups = toSolutionGroups(scan([folder('deprecated', []), folder('infrastructure', ['infrastructure'])]));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ folder: 'read-only', note: 'infrastructure/ · never edited' });
    expect(toSolutionGroups(scan([]))).toEqual([]);
  });
});
