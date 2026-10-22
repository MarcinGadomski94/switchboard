import { describe, expect, it } from 'vitest';
import type { BackgroundTask, SessionActivity } from '../../src/core/api.ts';
import {
  AGENT_BUILD_ENV,
  SESSION_MARKER_ENV,
  advanceTree,
  autoStoppable,
  descendsFrom,
  autoStopAt,
  autoStopReason,
  classifyProcess,
  countsLabel,
  markerIn,
  markerInEnviron,
  memoryLabel,
  parseEtime,
  parsePsCommands,
  parsePsListing,
  parseWin32Processes,
  processName,
  processesToStop,
  sessionLeftovers,
  sessionProcessEnv,
  sessionWorking,
  shortCommand,
  stoppedLabel,
  subtreeOf,
} from '../../src/core/processes.ts';
import { PROCESS_KEEP_TOOL, processKeepAnswer } from '../../src/core/process-keep.ts';

/**
 * D127 (`docs/processes.md`): the pure parts of the process tracker: the classification of
 * real command lines (paths anonymised), the `ps -E` and `Win32_Process` parsers, the tree
 * tracking with its pid-reuse guard, which rows are a session's leftovers, the auto-stop
 * decision and the timeline label.
 */

const DOTNET = '/usr/local/share/dotnet/dotnet';
const SDK = '/usr/local/share/dotnet/sdk/9.0.305';
const S1 = '11111111-aaaa-4bbb-8ccc-000000000001';

/** Command lines like the ones the orchestrator saw on the developer's Mac (2026-10-22), anonymised. */
const COMMANDS = {
  msbuildNode: `${DOTNET} ${SDK}/MSBuild.dll /noautoresponse /nologo /nodemode:1 /nodeReuse:true /low:false`,
  msbuildNodeDash: `${DOTNET} ${SDK}/MSBuild.dll -nologo -nodemode:1 -nodeReuse:true`,
  vbcs: `${SDK}/Roslyn/bincore/VBCSCompiler -pipename:Q2xhdWRlRmFrZVBpcGU`,
  vbcsDll: `${DOTNET} exec ${SDK}/Roslyn/bincore/VBCSCompiler.dll -pipename:abc`,
  buildServer: `${DOTNET} build-server shutdown`,
  dotnetTest: `${DOTNET} test Acme.Tests.E2E/Acme.Tests.E2E.csproj --filter Category=E2E`,
  vstest: `${DOTNET} exec ${SDK}/vstest.console.dll --port:61234 --parentprocessid:4242`,
  testhost: `${DOTNET} exec --runtimeconfig /Users/dev/src/acme/tests/bin/Debug/net9.0/Acme.Tests.runtimeconfig.json /Users/dev/.nuget/packages/microsoft.testplatform.testhost/17.11.1/lib/net8.0/testhost.dll --port 61235`,
  vite: 'node /Users/dev/src/acme-web/node_modules/.bin/vite --port 5173',
  npmDev: 'npm run dev',
  dotnetWatch: `${DOTNET} watch run --project Acme.Web`,
  dotnetRun: `${DOTNET} run --project Acme.Api`,
  viteBuild: 'node /Users/dev/src/acme-web/node_modules/.bin/vite build',
  app: '/Users/dev/src/acme/src/Acme.Api/bin/Debug/net9.0/Acme.Api',
  mcpServer: 'node /Users/dev/.local/lib/acme-mcp/server.js --stdio',
  shell: '/bin/zsh -c -l source /Users/dev/.claude/shell-snapshots/snapshot.sh && eval \'dotnet build\'',
  sbMcp: 'node --max-semi-space-size=1 /Users/dev/switchboard/dist/hook/sb-mcp.js --switchboard-mcp 13001 s1',
};

describe('D127 · the environment of a spawned CLI', () => {
  it('sets the marker and the three build defaults', () => {
    expect(sessionProcessEnv(S1)).toEqual({ MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0', UseSharedCompilation: 'false', [SESSION_MARKER_ENV]: S1 });
    expect(SESSION_MARKER_ENV).toBe('SWITCHBOARD_SESSION');
    expect(Object.keys(AGENT_BUILD_ENV)).toHaveLength(3);
  });
});

describe('D127 · classification and names', () => {
  it.each([
    ['msbuildNode', 'build-server', 'MSBuild node'],
    ['msbuildNodeDash', 'build-server', 'MSBuild node'],
    ['vbcs', 'build-server', 'VBCSCompiler'],
    ['vbcsDll', 'build-server', 'VBCSCompiler'],
    ['buildServer', 'build-server', 'dotnet build-server'],
    ['dotnetTest', 'test-host', 'dotnet test'],
    ['vstest', 'test-host', 'vstest.console'],
    ['testhost', 'test-host', 'testhost'],
    ['vite', 'dev-server', 'node vite'],
    ['npmDev', 'dev-server', 'npm run dev'],
    ['dotnetWatch', 'dev-server', 'dotnet watch'],
    ['dotnetRun', 'dev-server', 'dotnet run'],
    ['viteBuild', 'other', 'node vite'],
    ['app', 'other', 'Acme.Api'],
    ['mcpServer', 'other', 'node server.js'],
  ] as const)('%s → %s (%s)', (key, kind, name) => {
    expect(classifyProcess(COMMANDS[key])).toBe(kind);
    expect(processName(COMMANDS[key])).toBe(name);
  });

  it('names Windows programs without .exe, and inline code by its flag', () => {
    expect(processName('"C:\\Program Files\\dotnet\\dotnet.exe" "C:\\Program Files\\dotnet\\sdk\\9.0.305\\MSBuild.dll" /nodemode:1 /nodeReuse:true')).toBe('MSBuild node');
    expect(processName('C:\\Tools\\acme.exe --serve')).toBe('acme');
    expect(processName('node -e setTimeout(() => {}, 1000)')).toBe('node -e');
  });

  it('shortens the home folder and long lines', () => {
    expect(shortCommand('node /Users/dev/src/a.js  --x', '/Users/dev')).toBe('node ~/src/a.js --x');
    const long = shortCommand(`node ${'x'.repeat(400)}`, null);
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('D127 · ps listings', () => {
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
  const LISTING = [
    `  101     1  245760   27:13   0.0 ${COMMANDS.msbuildNode} TERM=xterm PATH=/usr/bin ${SESSION_MARKER_ENV}=${S1} HOME=/Users/dev`,
    `  102   101 1843200   10:02   0.5 ${COMMANDS.vbcs} ${SESSION_MARKER_ENV}=${S1}`,
    `  103   500    4096   01:00   0.0 /bin/zsh -l HOME=/Users/dev PATH=/usr/bin`,
    `  104     1    2048 1-02:03:04  0,3 node -e x ${SESSION_MARKER_ENV}=22222222-aaaa-4bbb-8ccc-000000000002`,
    'garbage line',
  ].join('\n');

  it('parses elapsed times', () => {
    expect(parseEtime('27:13')).toBe(27 * 60 + 13);
    expect(parseEtime('10:00:01')).toBe(36_001);
    expect(parseEtime('1-02:03:04')).toBe(93_784);
    expect(parseEtime('nope')).toBeNull();
  });

  it('keeps the marked rows of a `ps -E` listing (the marker read from the environment part)', () => {
    const rows = parsePsListing(LISTING, NOW, true);
    expect(rows.map((row) => [row.pid, row.ppid, row.marker])).toEqual([
      [101, 1, S1],
      [102, 101, S1],
      [104, 1, '22222222-aaaa-4bbb-8ccc-000000000002'],
    ]);
    expect(rows[0]?.rssBytes).toBe(245_760 * 1024);
    expect(rows[0]?.startedAtMs).toBe(NOW - (27 * 60 + 13) * 1000);
    expect(rows[2]?.cpuPct).toBe(0.3);
    // Without -E every row (no marker), Linux's `etimes` (plain seconds) too.
    expect(parsePsListing(LISTING, NOW, false)).toHaveLength(4);
    expect(parsePsListing('  7 1 100 3600 0.0 sleep 1', NOW, false)[0]?.startedAtMs).toBe(NOW - 3_600_000);
  });

  it('reads the marker: the last one of a line, a NUL-separated environ, nothing in the arguments alone', () => {
    expect(markerIn(`a ${SESSION_MARKER_ENV}=x1 b ${SESSION_MARKER_ENV}=x2`)).toBe('x2');
    expect(markerIn(`a X${SESSION_MARKER_ENV}=x1`)).toBeNull();
    expect(markerInEnviron(`PATH=/bin\0${SESSION_MARKER_ENV}=${S1}\0HOME=/h\0`)).toBe(S1);
    expect(markerInEnviron('PATH=/bin\0')).toBeNull();
  });

  it('parses `ps -o pid=,command=`', () => {
    expect([...parsePsCommands(`  101 ${COMMANDS.msbuildNode}\n  102 ${COMMANDS.vbcs}\n`)]).toEqual([
      [101, COMMANDS.msbuildNode],
      [102, COMMANDS.vbcs],
    ]);
  });
});

describe('D127 · Windows: Win32_Process and the tree', () => {
  const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);
  const JSON_LIST = JSON.stringify([
    { ProcessId: 4000, ParentProcessId: 900, Created: T0, WorkingSetSize: 209_715_200, Name: 'claude.exe', CommandLine: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.exe --print' },
    { ProcessId: 4100, ParentProcessId: 4000, Created: T0 + 60_000, WorkingSetSize: 10_485_760, Name: 'bash.exe', CommandLine: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "dotnet build"' },
    { ProcessId: 4200, ParentProcessId: 4100, Created: T0 + 61_000, WorkingSetSize: 262_144_000, Name: 'dotnet.exe', CommandLine: '"C:\\Program Files\\dotnet\\dotnet.exe" "C:\\Program Files\\dotnet\\sdk\\9.0.305\\MSBuild.dll" /nodemode:1 /nodeReuse:true' },
    { ProcessId: 4300, ParentProcessId: 4000, Created: T0 + 5_000, WorkingSetSize: 52_428_800, Name: 'node.exe', CommandLine: 'node C:\\Users\\dev\\mcp\\server.js' },
    // A pid that names the CLI as its parent but started before it: a reused parent pid, not a child.
    { ProcessId: 5000, ParentProcessId: 4000, Created: T0 - 3_600_000, WorkingSetSize: 1_048_576, Name: 'old.exe', CommandLine: null },
    // Windows PowerShell 5.1's date format, a missing command line (its name instead).
    { ProcessId: 6000, ParentProcessId: 900, CreationDate: `/Date(${T0})/`, WorkingSetSize: 4096, Name: 'svc.exe', CommandLine: null },
    { ProcessId: 'x' },
  ]);

  it('parses the listing (epoch ms or /Date()/, the name when the command line is unknown)', () => {
    const rows = parseWin32Processes(JSON_LIST);
    expect(rows.map((row) => row.pid)).toEqual([4000, 4100, 4200, 4300, 5000, 6000]);
    expect(rows[5]).toMatchObject({ startedAtMs: T0, command: 'svc.exe', marker: null, cpuPct: null });
    expect(rows[2]?.rssBytes).toBe(262_144_000);
    expect(parseWin32Processes(JSON.stringify({ ProcessId: 1, ParentProcessId: 0, Created: T0, WorkingSetSize: 1, Name: 'a', CommandLine: 'a' }))).toHaveLength(1);
    expect(parseWin32Processes('not json')).toEqual([]);
  });

  it('follows the tree from the CLI, keeps a child after its parent exits, drops a reused pid', () => {
    const rows = parseWin32Processes(JSON_LIST);
    const known = advanceTree([], rows, [{ pid: 4000, startedAtMs: T0 }]);
    expect(known.map((entry) => entry.pid).sort()).toEqual([4000, 4100, 4200, 4300]);
    // The CLI and the shell exit; the detached MSBuild node lives on (its parent pid still names the dead shell).
    const later = rows.filter((row) => row.pid === 4200 || row.pid === 6000);
    expect(advanceTree(known, later, []).map((entry) => entry.pid)).toEqual([4200]);
    // Its pid is reused by another process (a different start): forgotten.
    const reused = [{ ...(rows[2] as (typeof rows)[number]), startedAtMs: T0 + 3_600_000 }];
    expect(advanceTree(known, reused, [])).toEqual([]);
  });

  it("a session's leftovers: not the CLI, not its own helpers while it runs; the shell's work stays", () => {
    const rows = parseWin32Processes(JSON_LIST).filter((row) => [4000, 4100, 4200, 4300].includes(row.pid));
    expect(sessionLeftovers(rows, 4000).map((row) => row.pid)).toEqual([4100, 4200]);
    // Once the CLI is gone, whatever it left is listed (an MCP server that outlived it too).
    expect(sessionLeftovers(rows.filter((row) => row.pid !== 4000), 4000).map((row) => row.pid)).toEqual([4100, 4200, 4300]);
    expect(subtreeOf(rows, 4100)).toEqual([4100, 4200]);
  });

  it('a CLI behind a launcher: its helpers are left out, the shells its tools run (and what they start) stay', () => {
    const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, rssBytes: 1, startedAtMs: 0, cpuPct: null, command, marker: S1 });
    const rows = [
      row(10, 1, 'node /usr/local/bin/claude --print'),
      row(11, 10, '/Users/dev/.local/share/claude/versions/2.1.300'),
      row(12, 11, 'node /Users/dev/mcp/server.js'),
      row(13, 11, COMMANDS.shell),
      row(14, 13, COMMANDS.dotnetTest),
      row(15, 12, 'node /Users/dev/mcp/worker.js'),
    ];
    expect(sessionLeftovers(rows, 10).map((r) => r.pid)).toEqual([13, 14]);
    expect(descendsFrom(rows, 14, 10)).toBe(true);
    expect(descendsFrom(rows, 14, null)).toBe(false);
    expect(descendsFrom([row(20, 1, 'x')], 20, 10)).toBe(false);
  });

  it('under a running CLI only build servers, test hosts and dev servers stop by themselves', () => {
    expect(autoStoppable('other', true)).toBe(false);
    expect(autoStoppable('dev-server', true)).toBe(true);
    expect(autoStoppable('build-server', true)).toBe(true);
    expect(autoStoppable('other', false)).toBe(true);
  });

  it("never lists Switchboard's own MCP helper", () => {
    const row = { pid: 7, ppid: 1, rssBytes: 1, startedAtMs: 0, cpuPct: null, command: COMMANDS.sbMcp, marker: S1 };
    expect(sessionLeftovers([row], null)).toEqual([]);
  });
});

describe('D127 · auto-stop decision', () => {
  const NOW = 1_000_000_000;
  const MIN = 60_000;
  const base = { closed: false, working: false, idleSinceMs: NOW - 11 * MIN, nowMs: NOW, delayMs: 10 * MIN };

  it('closed → at once; idle ≥ the delay → idle; not yet idle long enough → nothing', () => {
    expect(autoStopReason({ ...base, closed: true, idleSinceMs: NOW })).toBe('closed');
    expect(autoStopReason(base)).toBe('idle');
    expect(autoStopReason({ ...base, idleSinceMs: NOW - 10 * MIN })).toBe('idle');
    expect(autoStopReason({ ...base, idleSinceMs: NOW - 9 * MIN })).toBeNull();
    expect(autoStopReason({ ...base, idleSinceMs: null })).toBeNull();
  });

  it('never while the session works (also when closed); the delay 0 turns the idle stop off, not the close', () => {
    expect(autoStopReason({ ...base, working: true })).toBeNull();
    expect(autoStopReason({ ...base, working: true, closed: true })).toBeNull();
    expect(autoStopReason({ ...base, delayMs: 0 })).toBeNull();
    expect(autoStopReason({ ...base, delayMs: 0, closed: true })).toBe('closed');
  });

  it('working: run, a turn (also one waiting on a question), a waited-on background task; not a dev server left running', () => {
    const task = (patch: Partial<BackgroundTask>): BackgroundTask => ({ id: 't', toolUseId: null, kind: 'bash', summary: 's', startedAt: '2026-10-22T10:00:00Z', github: false, waiting: false, ...patch }) as BackgroundTask;
    const activity = (state: SessionActivity['state'], background: BackgroundTask[] = []): Pick<SessionActivity, 'state' | 'background'> => ({ state, background });
    expect(sessionWorking('run', null)).toBe(true);
    expect(sessionWorking('need', activity('waiting'))).toBe(true);
    expect(sessionWorking('done', activity('background', [task({ waiting: true })]))).toBe(true);
    expect(sessionWorking('done', activity('background', [task({ kind: 'agent', waiting: undefined })]))).toBe(true);
    expect(sessionWorking('done', activity('background', [task({ waiting: false })]))).toBe(false);
    expect(sessionWorking('idle', null)).toBe(false);
    expect(sessionWorking('paused', null)).toBe(false);
  });

  it('Keep: kept processes are never in the stop list; when the stop is due', () => {
    expect(processesToStop([{ keep: true }, { keep: false }])).toEqual([{ keep: false }]);
    expect(autoStopAt({ working: false, idleSinceMs: NOW, delayMs: 10 * MIN })).toBe(NOW + 10 * MIN);
    expect(autoStopAt({ working: true, idleSinceMs: NOW, delayMs: 10 * MIN })).toBeNull();
    expect(autoStopAt({ working: false, idleSinceMs: NOW, delayMs: 0 })).toBeNull();
  });
});

describe('D127 · labels and the tool', () => {
  it('the timeline line', () => {
    const builds = Array.from({ length: 6 }, () => ({ kind: 'build-server' as const, rssBytes: (1.9 * 1024 * 1024 * 1024) / 6 }));
    expect(stoppedLabel(builds, { kind: 'idle', minutes: 10 })).toBe('Stopped 6 build servers (1.9 GB) after 10 min idle');
    expect(stoppedLabel([{ kind: 'test-host', rssBytes: 8.5 * 1024 ** 3 }], { kind: 'closed' })).toBe('Stopped 1 test host (8.5 GB) when the session was closed');
    expect(stoppedLabel([{ kind: 'other', rssBytes: 300 * 1024 ** 2 }], { kind: 'developer' })).toBe('Stopped 1 process (300 MB) (Stop in Processes)');
    expect(countsLabel([{ kind: 'build-server' }, { kind: 'build-server' }, { kind: 'test-host' }, { kind: 'other' }])).toBe('2 build servers, 1 test host and 1 other process');
    expect(memoryLabel(512)).toBe('1 KB');
  });

  it('process_keep: its schema and hints; the answer', () => {
    expect(PROCESS_KEEP_TOOL.name).toBe('process_keep');
    expect(PROCESS_KEEP_TOOL.annotations).toEqual({ title: 'Keep a process running', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(PROCESS_KEEP_TOOL.inputSchema['required']).toEqual(['keep']);
    expect(PROCESS_KEEP_TOOL.description).toContain('ONLY when the developer needs it running');
    expect(processKeepAnswer([{ pid: 9, name: 'node vite', keep: true }], true)).toContain('Kept running: node vite (pid 9)');
    expect(processKeepAnswer([{ pid: 9, name: 'node vite', keep: false }], false)).toContain('Handed back');
  });
});
