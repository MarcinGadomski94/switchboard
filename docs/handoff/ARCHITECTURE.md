# Architecture

> Stack changed on 2026-09-27 by developer ruling: **Node.js**, one project, one process (see `docs/decisions.md`). The .NET plan in the original handoff is superseded.

## Processes (all on the developer's PC)
```
Browser (Switchboard UI, React)  ⇄  Switchboard service (Node.js + Fastify, 127.0.0.1:4870)
                                   ├─ SessionSupervisor → N × `claude` child processes (headless, stream-json)
                                   ├─ WorktreeManager   → git / gh CLI
                                   ├─ Scheduler         → starts sessions from templates on cron
                                   ├─ WorkspaceScanner  → reads the router AGENTS.md + folders
                                   ├─ SQLite (node:sqlite) → sessions, events, questions, artifacts, schedules, settings
                                   ├─ REST /api/*       → per contracts/local-api.md
                                   └─ SSE  /hub         → live events to the UI (Server-Sent Events)
Embedded tools (iframes): Codebase Memory UI (localhost:13000), Acme Tool (URL from settings)
```

**Stack:** Node.js ≥ 24 + TypeScript (strict; the server runs `.ts` directly via Node's type stripping), Fastify for HTTP, React + Vite for the UI (built to `dist/web`, served by the same process), built-in `node:sqlite` with plain SQL migrations, Vitest for unit/integration tests, `@playwright/test` for E2E + screenshots. One `package.json`, one install, one port, cross-platform (Windows, macOS, Linux).

Suggested layout (one package):
```
src/core/     domain types, stream-json parser, derivations, scanner, cron, worktrees (no HTTP)
src/server/   Fastify app: REST, SSE hub, security, supervisor, scheduler, db
src/web/      React UI (Vite root)
tools/fake-claude/   fake CLI + recorded fixtures
tests/        vitest (unit + integration) and e2e/ (Playwright)
```

## Claude Code integration
- Each session is a `claude` process started with cwd = workspace root, so the router AGENTS.md applies.
- Baseline flags (confirm in M0): `-p --output-format stream-json --verbose --input-format stream-json`, `--session-id <uuid>` on start, `--resume <id>` to continue. **Permission mode:** the same auto mode the developer uses interactively if M0 confirms it works headless, otherwise `acceptEdits`; any permission request that still arises is surfaced in the Inbox as *Allow once / Deny* with the tool and input verbatim (developer ruling).
- **Auth:** the CLI's own subscription login (`claude auth status` to check). Switchboard never reads, stores or proxies credentials. No API key.
- **Questions:** mechanism picked in M0.2. Whatever the transport, the stored `Question` keeps the text **verbatim**, the source (subagent/orchestrator) and the options. The answer goes back unchanged. Hooks, if used, are injected per session via `--settings <file owned by Switchboard>`; the workspace and user `.claude/settings*.json` are never edited.
- **Pause / restart:** Pause interrupts the current turn and stops the process (status paused). Resume = `--resume <id>` with "Continue.". After a service restart, sessions that were running are resumed automatically with a note that Switchboard restarted.
- **Terminal handoff:** "Continue in terminal" stops the supervised process cleanly and shows `claude --resume <id>`. "Attach here" resumes it under supervision. History and terminal-started sessions are read from the local transcripts.
- **Tests never call the real CLI.** Use `tools/fake-claude` with recorded fixtures.

## Data model (minimum)
- **Session**: id, name, claudeSessionId, status (need | run | done | fail | idle | paused), workType, mode, phase, coordination, qaStack, ultracode, solutions[], createdAt, attached(bool)
- **Agent**: sessionId, name, description, solutionPath, branch, status
- **Event**: sessionId, agent, ts, kind (plan | impl | loop | ask | ok | tool | text | error), label, payload(json). Drives the chat, timeline and terminal tail.
- **Question**: id, sessionId, batchId, source, text, options[], answerIndex?, answeredAt?
- **Worktree**: repo, branch, path, sessionId, prNumber?, prState, removable
- **Artifact**: type (PR | BRANCH | DIFF | DOC | CONTRACT | QA | FOLLOWUP | TICKET), name, solution, branch, sessionId, meta, createdAt
- **Schedule**: name, cron, template(session config + prompt), paused, runs[] (ts, result)
- **Loop**: sessionId, kind, iteration, cap, breakerCount, expiresAt
- **Tool**: id, name, url, showInSidebar
- **Setting**: key, value

## Workspace rules (from the router AGENTS.md)
- `microfrontends/*-front`, `mobile/`, `nugets/*-nuget`, `microservices/*-microservice`, `functions/*-func` → editable
- `other/*` → editable **only when explicitly chosen**
- `deprecated/**`, `infrastructure/` → **read-only**: never selectable as a write target
- Two sessions writing the same repo → each must have its own worktree, or a conflict warning appears.

## Usage meter (M0.3)
There is no documented usage API. Candidates: cost/usage fields in stream-json `result` events, local transcripts, or the CLI's own usage command, if one exists on the installed version. If none is reliable, show "unknown". Never invent a percentage.

## Security
- Bind to loopback only and reject non-loopback Host/Origin headers (CSRF / DNS-rebinding guard).
- A random per-install token set as a SameSite=Strict cookie is required on every API and `/hub` call. The cookie is set when the UI page is loaded from a loopback Host (see `docs/decisions.md` #20).
- Child processes are started with an argv array (`shell: false`), never a shell string.
- Iframes load only URLs configured in Settings.
- Data and the token live in the per-user app-data folder (macOS `~/Library/Application Support/Switchboard`, Windows `%LOCALAPPDATA%\Switchboard`, Linux `~/.local/share/switchboard`); tests always use temp folders.
