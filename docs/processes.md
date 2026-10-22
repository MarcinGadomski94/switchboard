# Processes sessions leave running (D127)

An agent's builds, test runs and dev servers can outlive its turn. A .NET build leaves MSBuild worker nodes (`/nodeReuse:true`) and the Roslyn compiler server (`VBCSCompiler`) running for minutes after it ends. Across many sessions and worktrees these add up to gigabytes. Switchboard now:

- starts agents' .NET builds without the servers that linger;
- tracks what each session starts;
- lists those processes;
- stops them when the session no longer needs them.

The decision is D127 in `docs/decisions.md`.

| Part | Where |
|---|---|
| Pure rules: classification, parsers, tree, auto-stop decision, labels | `src/core/processes.ts` |
| `process_keep` tool definition | `src/core/process-keep.ts` |
| OS listings | `src/server/processes/scan.ts` |
| Tracker: sampling, Keep, Stop, auto-stop | `src/server/processes/service.ts` |
| Wiring | `src/server/processes/wire.ts` |
| Routes | `src/server/api/processes.ts` |
| UI | `src/web/processes/*`, `src/web/views/settings/ProcessesSection.tsx` |

## The environment of a spawned CLI

Every CLI Switchboard spawns gets these variables on top of its base environment (`SessionSupervisor.#spawn`, `AGENT_BUILD_ENV`). This applies to Claude Code, Codex and OpenCode, and to every spawn: a start, a resume, a switch or a recovery.

| Variable | Value | Effect |
|---|---|---|
| `SWITCHBOARD_SESSION` | the session's id | The marker. Every process the agent starts inherits it, also once it detaches (ppid 1). |
| `MSBUILDDISABLENODEREUSE` | `1` | MSBuild's worker nodes exit with the build: no `/nodeReuse:true` nodes stay behind. |
| `DOTNET_CLI_USE_MSBUILD_SERVER` | `0` | No MSBuild server process (.NET 7+). |
| `UseSharedCompilation` | `false` | The Roslyn compiler server (`VBCSCompiler`) is not used, see below. |

There is no environment variable named for VBCSCompiler itself. MSBuild, however, reads every environment variable as a property. `UseSharedCompilation` is the documented property of the Csc / Vbc tasks: when it is `false`, they compile in-process instead of through the shared compiler server. So no VBCSCompiler is started, and none lingers. The Razor build server (`rzc … server`) is no longer used by current SDKs; it is still classified and stopped like a build server if one appears.

**Trade-off: agents' builds are slower.** Each build starts its MSBuild nodes and loads the compiler afresh. That costs roughly a second or two per project on an incremental build of a multi-project solution, and much less on a single project. A cold build is about the same.

**Scope.** Only the processes Switchboard spawns get these variables. The developer's global environment, shell profiles, terminals and IDE (Rider) are never touched.

A hooked terminal session (D48 P4) is a `claude` the developer started. Switchboard cannot change its environment, so its builds keep their servers. The tree tracking below still covers those processes where it can.

## Tracking per OS

Every 30 s (`PROCESS_SAMPLE_MS`), the tracker reads one listing of this user's processes. The first read is 5 s after the start. It also reads on demand: a view opened with `?fresh=1`, Stop, Keep, `process_keep`, or a close.

The listings are read-only commands with a time limit, never as root and never through a shell string:

- **macOS:** `ps -E -ww -o pid=,ppid=,rss=,etime=,pcpu=,command= -U <uid>`.
  - `-E` prints each process's environment after its command line. macOS allows that without root for one's own processes.
  - The marker is the last `SWITCHBOARD_SESSION=<id>` word of the line.
  - Then `ps -ww -o pid=,command= -p <pids>` gives the clean command lines of the few processes that matter.
- **Linux:** `ps -u <uid> -ww -o pid=,ppid=,rss=,etimes=,pcpu=,args=`, and each listed process's `/proc/<pid>/environ`. That file is readable for one's own processes.
- **Windows:** one PowerShell call, `Get-CimInstance Win32_Process`.
  - It reads the pid, the parent pid, the creation time (epoch ms, computed in PowerShell), the working set and the command line.
  - Reading another process's environment needs native code. So a session's processes are followed by **process tree** instead, starting from its live CLI's pid.
  - Every process whose parent is the CLI or an already known process belongs to the session. Such a process must have started after its parent: a parent pid that was reused does not count.
  - A known process stays known after its parent exits (Windows keeps a dead parent's pid as `ParentProcessId`).
  - A known pid whose creation time changed is forgotten: that pid was reused.

A session's processes are those that carry its marker or sit in its tree. The tracker leaves some of them out:

- **the CLI itself** (its live pid, else the last pid stored on the session);
- **Switchboard's own MCP helpers** (`sb-mcp`, `sb-access-mcp`);
- **the CLI's own helpers while it runs**: a direct child of the CLI that is not a shell, such as an MCP server, and everything under it. These end with the CLI. A CLI's tools run commands in a shell, so what the agent started stays listed.

Markers of sessions that are not in this Switchboard's own database belong to another Switchboard, for example a test instance, and are ignored.

**Hooked sessions** have no marker. They are followed by tree on every OS, from the pid their hooks reported (`HookService.terminalRoots`), until the session ends. That pid is not checked against the CLI's registry, because that would run a CLI every 30 s. A root is taken only when its command line names `claude`. If the terminal's pid is unknown (an older hook), the session's processes are not tracked.

**Sampling cost,** measured on the developer's Mac (817 processes): about 70 ms of wall time per sample, mostly the `ps` process itself, and about 10 ms of Switchboard's CPU. Every 30 s that is under 0.3 % of one core. On Windows the PowerShell call takes a few hundred ms.

## Classification

`classifyProcess` sorts each process by its command line into one of four kinds:

| Kind | Matches |
|---|---|
| `build-server` | MSBuild with `/nodemode:` or `/nodeReuse:true`, `VBCSCompiler`, the Razor server (`rzc.dll … server`), `dotnet build-server` |
| `test-host` | `testhost`, `vstest.console`, `dotnet test` / `vstest`, `vitest`, `jest`, `playwright test`, `pytest` |
| `dev-server` | the long-running commands of `derive/background.ts` (2026-10-16): `dotnet run` / `watch`, `npm`/`pnpm`/`yarn`/`bun` `run dev`/`start`/`serve`/…, `vite` (not `vite build`), `next dev`, `docker compose up` without `-d`, `tail -f`, `nodemon`, `uvicorn`, `--watch`, … |
| `other` | everything else |

A process also gets a short name: `MSBuild node`, `VBCSCompiler`, `testhost`, `node vite`, `dotnet App.dll`, `npm run dev`. The rows show its resident memory (the working set on Windows) and its age. Its CPU % is read where `ps` gives it.

## Auto-stop

A session's leftover processes, all but those marked **Keep**, are stopped:

- **when the session is closed:** at once (`sessionUpdated` triggers a sample);
- **when it has been idle for the delay:** Settings → Processes, `processes.idleStopMinutes`, default **10**.

The rules:

- **Idle** means the session does not work by the 1.23 rules (`sessionWorking`):
  - its stored status is not `run`;
  - no turn runs, also one waiting on a question mid-turn;
  - no pending background task is one it waits on (subagents, a GitHub wait, a wake-up, a shell within its window).
- Idle is counted from the session's last sign of work: the last sample that saw it working, else its last activity, whichever is later.
- A dev server the agent only left running is not a wait. So it is stopped too, unless kept.
- **Never** while the session works or waits on a background task. A closed session that somehow still works is not touched either.
- **Delay 0** turns the idle stop off. A close still stops the processes.
- **Keep** protects the process, its ancestors among the session's processes and everything under it. Stopping `npm run dev` would end the kept `vite`.

How a process is stopped:

- Right before the signals, the processes are listed again. Only pids that are still that session's, with the same start, are signalled.
- **macOS / Linux:** SIGTERM to each process, then SIGKILL after 5 s (`PROCESS_STOP_GRACE_MS`).
- **Windows:** `taskkill /PID <pid> /T`, then `/F` after 5 s.
- The processes under it are the session's processes too, so they are stopped with it.

Each stop is a lifecycle note on the session's timeline, shown in its chat as a divider: action `processes-stopped`, with `reason` and `stoppedProcesses`. For example:

- "Stopped 6 build servers (1.9 GB) after 10 min idle"
- "Stopped 1 test host (8.5 GB) when the session was closed"
- "Stopped 1 process (300 MB) (Stop in Processes)"

The note is appended directly, so it does not reset the idle clock.

**What is never touched:**

- a process without the session's marker or tree link;
- another session's process;
- a process of a session in another Switchboard's database;
- Switchboard itself, its helpers, and the CLI;
- the developer's own processes: their terminals, Rider, their dotnet, their running Switchboard.

## Keep

- **The developer:** the **Keep** toggle on a row (`PUT /api/sessions/{id}/processes/{pid}/keep`).
- **The agent:** the `process_keep` tool of the built-in `switchboard` MCP server (`docs/mcp.md`).
  - Input: `{ pid | match, keep, reason? }`.
  - It acts only on the caller session's own processes.
  - Its description says to keep a server only when the developer needs it running after the turn.

A Keep mark is stored by pid and start time in the internal `settings` row `processes.keep`, so it survives a restart. It is dropped once the process is gone, or once its pid belongs to another process.

## The UI

- **The session's right panel** (`SessionProcessesSection`) has a **Processes** section above Terminal, shown only while the session has processes:
  - per process: name, kind, RAM, age, **Keep** and **Stop**;
  - under the rows, when they stop by themselves ("Stops in 4 min if it stays idle", "Working now: nothing is stopped while it works", "All kept: never stopped automatically").
  - It reads every 15 s while open. Stop and Keep answer with the new list.
  - On a phone the panel is a bottom sheet.
- **Settings → Processes:**
  - the idle delay (never, 5, 10, 15, 30, 60, 120 or 240 min);
  - a note on the .NET build defaults;
  - every session's processes with the totals, grouped by session, the most memory first.
  - A paired machine's sessions are listed with its machine tag. Their Stop and Keep go to that machine (the session routes are forwarded). A machine that could not be asked is named.
- **The sidebar footer:** a `procs <memory>` line under RAM and PWR while this machine tracks any process (`SystemInfo.trackedProcesses`). It opens Settings → Processes.

## Limits

- **Hooked sessions:** no environment can be injected, so their builds keep their servers. Their processes are tracked only by tree, from the terminal's reported pid. Processes started before Switchboard learned that pid, or after the terminal's `claude` ended, are not linked.
- **Windows:**
  - tree tracking only;
  - a process started after its parent already exited cannot be linked (Windows names a dead parent);
  - a session's processes from before a Switchboard restart are not linked (the tree starts at the new CLI);
  - no CPU %.
- **macOS:** the environment `ps -E` shows is the one the process started with. A process that clears its environment and re-executes itself loses the marker.
- **Cost:** see *Tracking per OS*.

## Tests

| Test | Covers |
|---|---|
| `tests/core/processes.test.ts` | the classification table (anonymised real command lines); the `ps -E` and `Win32_Process` parsers; the tree with its pid-reuse guard; the leftovers rule; the auto-stop decision; the labels; the tool's definition |
| `tests/server/processes/service.test.ts` | real dummy processes: found after the parent exits; the idle stop; Keep; working; close; delay 0; SIGKILL escalation; never an unmarked or another session's process; `process_keep` |
| `tests/server/processes/api.test.ts` | fake-claude's `[fake:leave-process]` (`docs/fake-claude.md`) through the real spawn: the routes, the agent's Keep, Stop with its timeline note, the close |
| `tests/server/supervisor/supervisor.test.ts` | the spawned CLI's environment |
| `tests/e2e/processes.spec.ts` | the panel, Settings → Processes and the footer, desktop and phone |
