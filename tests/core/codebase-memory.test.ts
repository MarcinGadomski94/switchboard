import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  HOOK_CATEGORIES,
  codebaseMemoryProjectId,
  concernsSolution,
  dirtyLines,
  dirtyProject,
  dirtyTargets,
  type FreshnessRow,
  parseDirtyFile,
  solutionFreshness,
} from '../../src/core/codebase-memory.ts';

/**
 * M6.4 oracle: `.claude/.codebase-memory-dirty` parsed into per-project entries,
 * the freshness of each Solutions row and the Codebase Memory strip's list, on
 * byte-exact fixture files (`tests/fixtures/codebase-memory/`):
 * - `hook-posix.txt`: what the workspace's dirty-tracker hook writes on macOS
 *   (sorted, `\n`, a root with a space, two `mobile/<folder>` lines);
 * - `hook-windows-crlf.txt`: a Windows root (`D:\…`), CRLF line ends;
 * - `messy.txt`: BOM, padding, blank and whitespace lines, a repeat in another
 *   case, a longer sibling name, another root, a folder outside the hook's
 *   categories, the root and a category alone, a lone `\r` line end;
 * - `empty.txt`.
 */
const FIXTURES = new URL('../fixtures/codebase-memory/', import.meta.url);
const POSIX_ROOT = '/Users/dev/Acme Corp/workspace';
const POSIX_ID = 'Users-dev-Acme Corp-workspace';
const WINDOWS_ROOT = 'D:\\riderprojects\\acme\\workspace';
const WINDOWS_ID = 'D-riderprojects-acme-workspace';

/** The rows a scan of the router layout gives (`Solution.name` / `relativePath`). */
const ROWS: readonly FreshnessRow[] = [
  { name: 'acme-app-front', relativePath: 'microfrontends/acme-app-front' },
  { name: 'web-front', relativePath: 'microfrontends/web-front' },
  { name: 'mobile', relativePath: 'mobile' },
  { name: 'auth-nuget', relativePath: 'nugets/auth-nuget' },
  { name: 'components-library-nuget', relativePath: 'nugets/components-library-nuget' },
  { name: 'auth-microservice', relativePath: 'microservices/auth-microservice' },
  { name: 'calendar-func', relativePath: 'functions/calendar-func' },
  { name: 'switchboard', relativePath: 'other/switchboard' },
  { name: 'old-front', relativePath: 'deprecated/microfrontends/old-front' },
  { name: 'mobile', relativePath: 'deprecated/mobile' },
  { name: 'infrastructure', relativePath: 'infrastructure' },
];

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), 'utf8');
}

/** Freshness of every row, keyed by relative path. */
function freshnessByRow(projects: Parameters<typeof solutionFreshness>[0], roots: readonly string[]): Record<string, string> {
  return Object.fromEntries(ROWS.map((row) => [row.relativePath, solutionFreshness(projects, roots, row.relativePath)]));
}

describe('project ids (the dirty-tracker hook’s form)', () => {
  it('absolute path with runs of `:` `/` `\\` turned into one `-`; spaces and case kept', () => {
    expect(codebaseMemoryProjectId(WINDOWS_ROOT, 'nugets/auth-nuget')).toBe(`${WINDOWS_ID}-nugets-auth-nuget`);
    expect(codebaseMemoryProjectId('D:/riderprojects/acme/workspace/', 'nugets\\auth-nuget\\')).toBe(`${WINDOWS_ID}-nugets-auth-nuget`);
    expect(codebaseMemoryProjectId(`${POSIX_ROOT}/`, 'microfrontends/web-front')).toBe(`${POSIX_ID}-microfrontends-web-front`);
    expect(codebaseMemoryProjectId(POSIX_ROOT)).toBe(POSIX_ID);
  });

  it('every hook category round-trips: the id of <root>/<category>/<repo> names that folder again', () => {
    for (const root of [POSIX_ROOT, WINDOWS_ROOT]) {
      for (const category of HOOK_CATEGORIES) {
        const id = codebaseMemoryProjectId(root, `${category}/some-repo.v2`);
        expect(dirtyProject(id, [root])).toEqual({ id, relativePath: `${category}/some-repo.v2` });
      }
    }
  });
});

describe('hook-posix.txt (macOS, as the hook writes it)', () => {
  it('parses one project per line in file order, naming <category>/<folder>', async () => {
    expect(parseDirtyFile(await fixture('hook-posix.txt'), [POSIX_ROOT])).toEqual([
      { id: `${POSIX_ID}-functions-calendar-func`, relativePath: 'functions/calendar-func' },
      { id: `${POSIX_ID}-microfrontends-acme-app-front`, relativePath: 'microfrontends/acme-app-front' },
      { id: `${POSIX_ID}-mobile-Acme.Mobile`, relativePath: 'mobile/Acme.Mobile' },
      { id: `${POSIX_ID}-mobile-Acme.Mobile.Gateway`, relativePath: 'mobile/Acme.Mobile.Gateway' },
      { id: `${POSIX_ID}-nugets-components-library-nuget`, relativePath: 'nugets/components-library-nuget' },
      { id: `${POSIX_ID}-other-switchboard`, relativePath: 'other/switchboard' },
    ]);
  });

  it('per-row freshness: listed repos dirty, `mobile/` by its sub-folder lines, the rest fresh', async () => {
    const projects = parseDirtyFile(await fixture('hook-posix.txt'), [POSIX_ROOT]);
    expect(freshnessByRow(projects, [POSIX_ROOT])).toEqual({
      'microfrontends/acme-app-front': 'dirty',
      'microfrontends/web-front': 'fresh',
      mobile: 'dirty',
      'nugets/auth-nuget': 'fresh',
      'nugets/components-library-nuget': 'dirty',
      'microservices/auth-microservice': 'fresh',
      'functions/calendar-func': 'dirty',
      'other/switchboard': 'dirty',
      'deprecated/microfrontends/old-front': 'fresh',
      // The archived mobile shares the name, not the folder.
      'deprecated/mobile': 'fresh',
      infrastructure: 'fresh',
    });
  });

  it('the root matches case-insensitively and with a trailing slash; any of its forms counts (configured, real path)', async () => {
    const text = await fixture('hook-posix.txt');
    const expected = freshnessByRow(parseDirtyFile(text, [POSIX_ROOT]), [POSIX_ROOT]);
    const lower = ['/users/dev/acme corp/workspace/'];
    expect(freshnessByRow(parseDirtyFile(text, lower), lower)).toEqual(expected);
    // Configured through a symlink; the hook saw the real path.
    const forms = ['/Volumes/link/ws', POSIX_ROOT];
    expect(parseDirtyFile(text, forms).every((project) => project.relativePath !== null)).toBe(true);
    expect(freshnessByRow(parseDirtyFile(text, forms), forms)).toEqual(expected);
    // Another root: nothing is this workspace's.
    const other = ['/Users/dev/elsewhere'];
    expect(parseDirtyFile(text, other).map((project) => project.relativePath)).toEqual([null, null, null, null, null, null]);
    expect(Object.values(freshnessByRow(parseDirtyFile(text, other), other)).every((state) => state === 'fresh')).toBe(true);
  });

  it('strip list: one chip per solution (`mobile` once, with both lines), in first-line order', async () => {
    const projects = parseDirtyFile(await fixture('hook-posix.txt'), [POSIX_ROOT]);
    expect(dirtyTargets(projects, [POSIX_ROOT], ROWS)).toEqual([
      { name: 'calendar-func', relativePath: 'functions/calendar-func', solution: true, ids: [`${POSIX_ID}-functions-calendar-func`] },
      { name: 'acme-app-front', relativePath: 'microfrontends/acme-app-front', solution: true, ids: [`${POSIX_ID}-microfrontends-acme-app-front`] },
      {
        name: 'mobile',
        relativePath: 'mobile',
        solution: true,
        ids: [`${POSIX_ID}-mobile-Acme.Mobile`, `${POSIX_ID}-mobile-Acme.Mobile.Gateway`],
      },
      {
        name: 'components-library-nuget',
        relativePath: 'nugets/components-library-nuget',
        solution: true,
        ids: [`${POSIX_ID}-nugets-components-library-nuget`],
      },
      { name: 'switchboard', relativePath: 'other/switchboard', solution: true, ids: [`${POSIX_ID}-other-switchboard`] },
    ]);
  });
});

describe('hook-windows-crlf.txt (a Windows root, CRLF)', () => {
  it('parses the D:\\ root with CRLF line ends; `\\` and `/` root spellings agree', async () => {
    const text = await fixture('hook-windows-crlf.txt');
    const expected = [
      { id: `${WINDOWS_ID}-infrastructure-network`, relativePath: 'infrastructure/network' },
      { id: `${WINDOWS_ID}-microservices-auth-microservice`, relativePath: 'microservices/auth-microservice' },
      { id: `${WINDOWS_ID}-mobile-src`, relativePath: 'mobile/src' },
      { id: `${WINDOWS_ID}-nugets-auth-nuget`, relativePath: 'nugets/auth-nuget' },
    ];
    expect(parseDirtyFile(text, [WINDOWS_ROOT])).toEqual(expected);
    expect(parseDirtyFile(text, ['d:/RiderProjects/Acme/Workspace'])).toEqual(expected);
  });

  it('per-row freshness: whole-folder rows (`infrastructure/`, `mobile/`) by their sub-folder lines', async () => {
    const projects = parseDirtyFile(await fixture('hook-windows-crlf.txt'), [WINDOWS_ROOT]);
    expect(freshnessByRow(projects, [WINDOWS_ROOT])).toEqual({
      'microfrontends/acme-app-front': 'fresh',
      'microfrontends/web-front': 'fresh',
      mobile: 'dirty',
      'nugets/auth-nuget': 'dirty',
      'nugets/components-library-nuget': 'fresh',
      'microservices/auth-microservice': 'dirty',
      'functions/calendar-func': 'fresh',
      'other/switchboard': 'fresh',
      'deprecated/microfrontends/old-front': 'fresh',
      'deprecated/mobile': 'fresh',
      infrastructure: 'dirty',
    });
    expect(dirtyTargets(projects, [WINDOWS_ROOT], ROWS).map((target) => target.name)).toEqual(['infrastructure', 'auth-microservice', 'mobile', 'auth-nuget']);
  });
});

describe('messy.txt (lenient reading)', () => {
  it('lines: BOM, padding, blank / whitespace lines, a case-only repeat and `\\r\\n` / `\\r` / `\\n` ends', async () => {
    expect(dirtyLines(await fixture('messy.txt'))).toEqual([
      `${POSIX_ID}-microfrontends-acme-app-front`,
      `${POSIX_ID}-nugets-auth-nuget-v2`,
      'Users-dev-Other Place-workspace-nugets-auth-nuget',
      `${POSIX_ID}-deprecated-microfrontends-old-front`,
      `${POSIX_ID}-tools-scripts`,
      POSIX_ID,
      `${POSIX_ID}-other-switchboard`,
      `${POSIX_ID}-mobile`,
    ]);
  });

  it('only the hook’s <root>-<category>-<folder> form names a folder', async () => {
    expect(parseDirtyFile(await fixture('messy.txt'), [POSIX_ROOT]).map((project) => project.relativePath)).toEqual([
      'microfrontends/acme-app-front',
      'nugets/auth-nuget-v2',
      null, // another root
      null, // `deprecated/` is not a hook category
      null, // neither is `tools/`
      null, // the root alone
      'other/switchboard',
      null, // a category alone
    ]);
  });

  it('per-row freshness: a longer sibling and another root do not count; a row’s own id always does', async () => {
    const projects = parseDirtyFile(await fixture('messy.txt'), [POSIX_ROOT]);
    expect(freshnessByRow(projects, [POSIX_ROOT])).toEqual({
      'microfrontends/acme-app-front': 'dirty',
      'microfrontends/web-front': 'fresh',
      // `<root>-mobile` is the mobile row's own project id.
      mobile: 'dirty',
      // `auth-nuget-v2` is another project; `Other Place` another workspace.
      'nugets/auth-nuget': 'fresh',
      'nugets/components-library-nuget': 'fresh',
      'microservices/auth-microservice': 'fresh',
      'functions/calendar-func': 'fresh',
      'other/switchboard': 'dirty',
      // Not a hook category, but the line is exactly this row's project id.
      'deprecated/microfrontends/old-front': 'dirty',
      'deprecated/mobile': 'fresh',
      infrastructure: 'fresh',
    });
  });

  it('strip list: solutions first-line ordered, unmatched lines by folder name or id', async () => {
    const projects = parseDirtyFile(await fixture('messy.txt'), [POSIX_ROOT]);
    expect(dirtyTargets(projects, [POSIX_ROOT], ROWS)).toEqual([
      { name: 'acme-app-front', relativePath: 'microfrontends/acme-app-front', solution: true, ids: [`${POSIX_ID}-microfrontends-acme-app-front`] },
      { name: 'auth-nuget-v2', relativePath: 'nugets/auth-nuget-v2', solution: false, ids: [`${POSIX_ID}-nugets-auth-nuget-v2`] },
      {
        name: 'Users-dev-Other Place-workspace-nugets-auth-nuget',
        relativePath: null,
        solution: false,
        ids: ['Users-dev-Other Place-workspace-nugets-auth-nuget'],
      },
      {
        name: 'old-front',
        relativePath: 'deprecated/microfrontends/old-front',
        solution: true,
        ids: [`${POSIX_ID}-deprecated-microfrontends-old-front`],
      },
      { name: `${POSIX_ID}-tools-scripts`, relativePath: null, solution: false, ids: [`${POSIX_ID}-tools-scripts`] },
      { name: POSIX_ID, relativePath: null, solution: false, ids: [POSIX_ID] },
      { name: 'switchboard', relativePath: 'other/switchboard', solution: true, ids: [`${POSIX_ID}-other-switchboard`] },
      { name: 'mobile', relativePath: 'mobile', solution: true, ids: [`${POSIX_ID}-mobile`] },
    ]);
  });
});

describe('empty / missing / unreadable', () => {
  it('an empty file lists nothing: every row fresh, nothing to reindex', async () => {
    const projects = parseDirtyFile(await fixture('empty.txt'), [POSIX_ROOT]);
    expect(projects).toEqual([]);
    expect(Object.values(freshnessByRow(projects, [POSIX_ROOT])).every((state) => state === 'fresh')).toBe(true);
    expect(dirtyTargets(projects, [POSIX_ROOT], ROWS)).toEqual([]);
    expect(dirtyLines('\n \r\n\t\n')).toEqual([]);
  });

  it('a list that could not be read (`null`) makes every row unknown', () => {
    expect(Object.values(freshnessByRow(null, [POSIX_ROOT])).every((state) => state === 'unknown')).toBe(true);
  });
});

describe('solutions nested deeper than the hook records', () => {
  it('a coarse hook folder concerns every solution inside it; each gets its own chip', () => {
    const rows: FreshnessRow[] = [
      { name: 'x-front', relativePath: 'microfrontends/group/x-front' },
      { name: 'y-front', relativePath: 'microfrontends/group/y-front' },
      { name: 'z-front', relativePath: 'microfrontends/z-front' },
    ];
    const projects = parseDirtyFile(`${POSIX_ID}-microfrontends-group\n`, [POSIX_ROOT]);
    expect(rows.map((row) => solutionFreshness(projects, [POSIX_ROOT], row.relativePath))).toEqual(['dirty', 'dirty', 'fresh']);
    expect(dirtyTargets(projects, [POSIX_ROOT], rows).map((target) => [target.name, target.ids])).toEqual([
      ['x-front', [`${POSIX_ID}-microfrontends-group`]],
      ['y-front', [`${POSIX_ID}-microfrontends-group`]],
    ]);
    // A root-level relative path never matches by overlap.
    expect(concernsSolution(projects[0] as (typeof projects)[number], [POSIX_ROOT], '')).toBe(false);
  });
});
