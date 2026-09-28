# src/core

Domain code with no HTTP: domain types, the stream-json parser, derivations, the workspace scanner, cron and worktree logic (`docs/handoff/ARCHITECTURE.md` → layout). Runs under Node type stripping like `src/server`, so erasable TypeScript only.

`api.ts` holds the local API's wire types (contract), shared by the server and the UI (`docs/lanes.md`).

M2.1: `stream-json.ts` (typed view of the CLI's stdout), `stdin.ts` (the lines Switchboard writes), `event-payload.ts` (`SessionEvent.payload` shapes) and `derive/` (event kinds gap #7, agents gap #8, artifacts gap #9, session status), documented in `docs/derivations.md`.

M4.1: `transcript-sync.ts` (which transcript entries a terminal added while the session was detached, and what they show; `docs/supervisor.md` → *Attach here*), `derive/chips.ts` (the session header chips, `docs/derivations.md` → *Session chips*).

M6.1: `workspace-rules.ts` (router `AGENTS.md` folder rules, the baseline layout, the read-only check of a NewSession solution, `GET /api/solutions` grouping), documented in `docs/solutions.md`; the file-system walk is `src/server/solutions/scanner.ts`.

M6.3: `conflicts.ts` (two or more open sessions writing one repo while one has no worktree of its own: the row flag, the card copy and its "Move … to worktree" actions), documented in `docs/solutions.md` → *Conflicts*.

M6.4: `codebase-memory.ts` (`.claude/.codebase-memory-dirty` lines named after the workspace hook's project ids, the freshness of each Solutions row and the Codebase Memory strip's list), documented in `docs/solutions.md` → *Codebase-memory freshness*.

M9.1: `service-files.ts` (the launchd agent, systemd `--user` unit and Task Scheduler task + env file of the per-user background service, their escaping, and the install / uninstall step plans; pure) and `login-service.ts` (the wire types of `GET/PUT /api/service`), documented in `docs/service.md`; the I/O is `src/server/service/`.
