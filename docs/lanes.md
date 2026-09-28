# Lanes: who fills which file (M1.4)

M1.4 laid out one file per view, tab, modal and API area so the parallel lanes of M3–M8 (D3) can work without editing the same files. Each file below starts as a placeholder (UI) or a 501 route (server) and names its owning backlog item in its header comment.

## Rules for lanes
- **Fill your own files.** Replace the placeholder body; keep the export name and the `data-testid` the placeholder has (the shell E2E checks them).
- **Shared registries take one-line, additive edits only:** `src/server/routes.ts` (route modules), `src/server/main.ts` (real providers), `src/web/shell/Shell.tsx` (view switch), `src/web/router.tsx` (routes), `src/web/api/client.ts` (API calls), `src/core/api.ts` (wire types), `package.json`, the demo data files. Merge conflicts there should be trivial.
- **Implementing a route:** register the real handler in your area module (`src/server/api/<area>.ts`) and delete that route's entry from the module's `*_ROUTES_PENDING` list, in the same change (Fastify refuses a duplicate route). `tests/server/api/routes.test.ts` then needs that row moved out of its 501 table.
- **Wire types:** `src/core/api.ts` is shared by the server and the UI. Types marked *provisional* belong to the item named on them; refine them additively where you can, and keep both sides compiling. The contract (`docs/handoff/contracts/local-api.md`) stays locked.
- **Real code paths (D13):** views read only through `src/web/api/client.ts` and `/hub`. Demo data lives only in `src/server/demo/` (`docs/demo.md`) and reaches the UI through the same API.
- **Visual oracle:** add a spec per view under `tests/e2e/visual/` using `harness.ts` (`docs/visual/README.md`).

## Server: API areas (`src/server/api/*.ts`, registered from `src/server/routes.ts`)
| Route (contract) | Module | Item |
|---|---|---|
| `GET /api/sessions`, `GET /api/sessions/{id}` | `api/sessions.ts` | served since M2.1 (`docs/supervisor.md`); M4.1 added `cwd`, `live`, `resumeCommand`, `chips` to Session; M4.2 added `questions` to SessionDetail (`docs/chat.md`) |
| `POST /api/sessions` | `api/sessions.ts` | served since M2.1 (validation + start); worktrees since M2.2 (`docs/worktrees.md`); M5.2: the first-message payload (`firstMessage` of `SessionSupervisor.start`, built by `sessions/first-turn.ts`; `docs/new-session.md`); M7.1: the flow lives in `sessions/start.ts` (`startNewSession`), shared with the scheduler |
| `POST /api/sessions/{id}/pause · /resume · /detach · /attach` | `api/sessions.ts` | served since M2.1 (D7); the Attach warning (`409 attach-warning` unless `{ confirm: true }`) + transcript import since M4.1 (`docs/supervisor.md` → *Attach here*) |
| `POST /api/sessions/{id}/messages`, `GET /api/sessions/{id}/events` | `api/sessions.ts` | served since M2.1 |
| `GET /api/sessions/{id}/diff` | `api/sessions.ts` | M4.5 (the diff itself is `providers.diff` = the M2.2 `WorktreeManager`) |
| `GET /api/inbox` | `api/inbox.ts` | served since M3.2 (`listInbox` in `inbox/wire.ts`, `docs/inbox.md`); items from M3.1 and M3.3 |
| `POST /api/questions/batch/{batchId}/answers` | `api/inbox.ts` | served since M3.1 (`docs/questions.md`) |
| `POST /api/inbox/{id}/actions/{action}` | `api/inbox.ts` | permission items served since M3.1 (`docs/questions.md`); system items since M3.3 (`docs/system-items.md`) |
| `GET /api/solutions` | `api/solutions.ts` | served since M6.1 (the workspace scan, `docs/solutions.md`); live fields since M6.2 (`LiveSolutions`: branches, status, phase, changes, ledger, artifacts, codebase-memory freshness); `flag` / `conflict` / `conflictSessions` since M6.3 (`docs/solutions.md` → *Conflicts*) |
| `POST /api/solutions/{repo}/isolate` | `api/solutions.ts` | served since M2.2 (gap #2, `docs/worktrees.md`); the UI action since M6.3 (the conflict card) |
| `GET/POST /api/schedules`, `POST /api/schedules/{id}/run · /pause · /resume` | `api/schedules.ts` | served since M7.1 (`Scheduler` in `schedules/scheduler.ts`, `docs/schedules.md`); `POST` = "Save schedule" (`ScheduleInput`, with `id` = Edit) |
| `GET /api/artifacts` | `api/artifacts.ts` | served since M7.3 (`docs/derivations.md` → *Artifacts view*): `ArtifactListItem[]` (+ `sessionName`, `updatedAt`), `type=` comma list, `q=` search; session artifacts M4.6 |
| `GET /api/history` | `api/history.ts` | served since M7.4 (`docs/derivations.md` → *History*): `providers.history`, else `history/transcripts.ts` (`TranscriptHistory`: stored sessions + transcripts under `$CLAUDE_CONFIG_DIR`/`~/.claude`); `HistoryItem` + additive `solutions` |
| `GET/PUT /api/settings` | `api/settings.ts` | served since M8.2 (`docs/settings.md`): editable preferences + read-only values the service reports; keys in `src/core/settings.ts` (M5.1 reads the New-session defaults, M9.1 writes `service.startAtLogin`, M9.2 reads `usage.warnAtPct`) |
| `GET/PUT /api/tools`, `POST /api/tools/{id}/probe` | `api/tools.ts` | served since M8.1 (`docs/tools.md`); additive `GET /api/codebase-memory` + `POST /api/codebase-memory/reindex` (gap #4) in the same module |
| `GET /api/system` | `api/system.ts` | served since M5.3 (`SystemProbe` in `system/probe.ts`: CLI/gh via the configured bins, metrics per gap #11; `docs/setup.md` → *System*); M9.2's `usagePct` / `usageResetsAt` / `usageWarnings` come from `withUsage` around `providers.system` (`docs/usage.md`) |
| `GET/PUT /api/service` (additive, not in the contract table) | `api/service.ts` | served since M9.1: "Start at login" through `providers.loginService` (`docs/service.md`); 501 without the provider |
| `/api/setup*` (additive: wizard state, root check/save, Browse… folders, complete) | `api/setup.ts` | M5.3 (`SetupService` in `setup/service.ts`, `docs/setup.md`) |
| `GET /hub` (SSE) | `api/hub.ts` + `hub/*` | served since M2.3 (`docs/hub.md`); later items publish on `ApiContext.bus` |

Unimplemented routes answer `501 {"error":"not-implemented","item":"<item>"}` behind the usual Host/Origin guard and cookie.

## Server: services on `ApiContext`
| Service | What | Hooks for later lanes |
|---|---|---|
| `supervisor` (`SessionSupervisor`, M2.1) | claude processes | `on('sessionUpdated' / 'event')` → M2.3 hub; `ControlRequestHandler` + `respond()` → M3.1; the outbox (M2.4): undelivered `store.pendingMessages` rows go first in the session's next stdin message, so M3.1 delivers stale answers with `sendMessage(id, text, 'service')` (or enqueues them) and the restart note rides along (`docs/supervisor.md` → *Restart recovery*); pass the same `ControlRequestHandler` so `orphaned` also hears about requests a crash left open |
| `worktrees` (`WorktreeManager`, M2.2) | git worktrees, PR state, removal, isolate, diff | `on('worktreeRemovable')` → M2.3 hub + M3.3 "PR merged" item (wired); `remove(id)` → M3.3 "Remove worktree" action (wired); `store.worktrees` + `inspect(id)` → M6.2 branch chips; `isolate` → M6.3; the diff → M4.5 |
| `questions` (`QuestionPipeline`, M3.1) | question batches + permission items: the supervisor's `ControlRequestHandler`, answers + Allow once / Deny | `questionBatchItem` / `permissionItem` / `inboxCount` in `src/server/inbox/wire.ts` → M3.2's `GET /api/inbox`; the shared `QuestionCard` (`src/web/components/`) → M3.2 Inbox, M4.2 chat (`docs/questions.md`) |
| `systemItems` (`SystemItemService`, M3.3) | system Inbox items: "Scheduled run failed", "PR merged" and their actions (`docs/system-items.md`) | wired to the M7.1 scheduler: it calls `scheduleRunFinished(runId)` for a failed run, and "Retry run" runs through `useScheduleRunner(scheduleRunnerFor(scheduler))` (main.ts; buildApp for the service it makes itself); `sync()` every 30 s picks up any failed run / removable worktree without an item |
| `scheduler` (`Scheduler`, M7.1) | schedules: the cron timer (machine-local time), Run now, Pause / Resume, Save (`docs/schedules.md`) | runs start through `sessions/start.ts`; results follow the supervisor's `sessionUpdated`; `scheduleRun` on the bus; main.ts `start()`s the timer outside demo mode and closes it before the supervisor; buildApp makes its own (no timer) when none is passed |
| `setup` (`SetupService`, M5.3) | first-run wizard state; the workspace root = `SWITCHBOARD_WORKSPACE_ROOT`, else the wizard's (settings `setup.workspaceRoot`) | `liveConfig()` → `ApiContext.config.workspaceRoot` follows a saved root; `onRootChange` → `setWorkspaceRoot` on the supervisor, worktree manager (buildApp) and scanner (main.ts). **M8.2 merge:** `workspace.root` read from `context.config.workspaceRoot` then reports the root in effect; Settings' scan table and the wizard's (`scanRows` in `setup-wizard.ts`) follow the same rule and may share code; "Run setup again" = `open('setup-wizard')` (`docs/setup.md`) |
| `bus` (`HubBus`, M2.3) + `hub` (`SseHub`) | `/hub` events | `bus.publish('questionBatch' / 'inboxChanged')` → M3.1–M3.3, `bus.publish('scheduleRun')` → M7.1; `system` ticks from `providers.system` (M5.3 / M9.2); `hub.clientCount` → M9.2's meter via `buildApp({ usage })` (`docs/hub.md`, `docs/usage.md`) |

## Server: providers (`src/server/providers.ts`)
Computed data sits behind interfaces so the demo can swap implementations (D13). Real implementations are created in `src/server/main.ts` and passed to `buildApp({ providers })`; routes read them from `ApiContext.providers`.

| Provider | Real implementation | Demo implementation |
|---|---|---|
| `DiffProvider` (git diff per session, gap #10) | `WorktreeManager` (M2.2, `src/server/worktrees/manager.ts`), wired in `main.ts` | `src/server/demo/providers.ts` |
| `SolutionsProvider` (workspace scan + live fields) | `LiveSolutions` (M6.2, `src/server/solutions/live.ts`) over the `WorkspaceScanner` (M6.1, `src/server/solutions/scanner.ts`, `docs/solutions.md`), wired in `main.ts`; its optional `isReadOnly` (the scanner's) feeds the NewSession read-only check | same (no `isReadOnly`: matched by row name) |
| `SystemProvider` (CLI/gh, CPU/RAM/processes, usage) | `SystemProbe` (M5.3, `src/server/system/probe.ts`), wired in `main.ts`; M9.2 wraps it with `withUsage` (`src/server/usage/wire.ts`, `docs/usage.md`) | same (not wrapped: the demo's usage is prototype data) |
| `HistoryProvider` (transcripts) | `history/transcripts.ts` (`TranscriptHistory`, M7.4), the route's default | the prototype's `HIST` rows (`various` as the solutions line) |
| `LoginServiceProvider` ("Start at login": the per-user service definition) | `LoginService` (M9.1, `src/server/service/login-service.ts`), wired in `main.ts` | `src/server/demo/login-service.ts` (in-memory, starts on, never touches the OS) |
| `ToolProbeProvider` (tool reachability, M8.1) | `tools/probe.ts` (server-side GET, 3 s), the route's default | always `down`, no network |
| `CodebaseMemoryProvider` (`.codebase-memory-dirty`, M8.1 strip) | `tools/codebase-memory.ts` over the workspace root, the route's default | the prototype's dirty list + indexed count |

## UI: views and parts (`src/web/…`)
| File | What | Item |
|---|---|---|
| `shell/Shell.tsx`, `shell/Sidebar.tsx`, `shell/format.ts`, `shell/shell.css` | App shell, sidebar, footer meters (M1.4). Lanes only adjust badge sources if their data needs it. | M1.4 |
| `views/InboxView.tsx` | Inbox list + detail (+ `inbox.ts`, `inbox.css`; `docs/inbox.md`) | M3.2 |
| `toast/ToastHost.tsx` | Toast host; since M3.4 the `questionBatch` toast + chime + OS notification (`toast/notify.ts`, `toast/useQuestionNotifications.ts`, `docs/notifications.md`) | M1.4, M3.4 |
| `views/session/SessionView.tsx` | Session layout (`1fr | 380px`), tab switch; loads `GET /api/sessions/{id}`, reloads on its `/hub` events | done in M4.1 (`session.css`, class prefix `sb-sv-`: the sidebar owns `sb-session-*`) |
| `views/session/SessionHeader.tsx` | Header, chips, Pause/Resume, terminal handoff buttons + the Attach warning, tabs | done in M4.1 (`session-header.ts`: copy and rules) |
| `views/session/ChatTab.tsx` | Chat | done in M4.2 (`chat.ts`: items, step marks, quick replies; `docs/chat.md`): messages, step lines, the inline `QuestionCard` + answers bubble, quick replies, composer |
| `views/session/RightPanel.tsx` | Agent cards, terminal tail, handoff card | M4.1 added the column and the handoff card (`HandoffCard.tsx`); done in M4.3 (`right-panel.ts`: cards, summary, tail rules; `TerminalTail.tsx`, reusable by M4.4's Timeline terminal; `docs/session-panel.md`) |
| `views/session/TimelineTab.tsx` | Timeline | M4.4 |
| `views/session/DiffTab.tsx` | Diff | M4.5 |
| `views/session/ArtifactsTab.tsx` | Session artifacts | M4.6 |
| `modals/NewSessionModal.tsx` | New session (sections 1–6) + D8 Schedule section | done in M5.1 (+ `new-session.ts`, `new-session.css`, `docs/new-session.md`); the Schedule section since M7.1 (`ScheduleSection.tsx`, `schedule-form.ts`, `open('new-session', { schedule })`; `docs/schedules.md`) |
| `modals/SetupWizard.tsx` | First-run wizard | done in M5.3 (+ `setup-wizard.ts`, `setup-wizard.css`, `FirstRunGate.tsx` mounted in `Shell.tsx`; `docs/setup.md`) |
| `views/SolutionsView.tsx` | Solutions (+ `solutions-format.ts`, `solutions.css`) | done in M6.2 (`docs/solutions.md` → *The view*); the conflict card and action since M6.3 (`SolutionConflictCard.tsx`, `solutions-conflict.ts`); freshness rules since M6.4 (`src/core/codebase-memory.ts`, `docs/solutions.md` → *Codebase-memory freshness*, also the strip's list for M8.1) |
| `views/SchedulesView.tsx` | Schedules & loops | header + schedule table since M7.1 (`ScheduleTable.tsx`, `schedule-table.ts`, `schedule-table.css`; `docs/schedules.md`); loop cards M7.2 |
| `views/ArtifactsView.tsx` | Global artifacts (+ `views/artifacts.css`; filters, search and the location label in `src/core/artifacts-view.ts`) | M7.3 |
| `views/HistoryView.tsx` | History (+ `views/history.css`; rows, dates and the solutions/branches line in `src/core/history.ts`) | M7.4 |
| `views/ToolView.tsx` | Embedded tool (+ `views/tool.css`, `views/tool/CodebaseMemoryStrip.tsx`, shared probe state `tools/probe.ts` also used by the sidebar's TOOLS rows) | M8.1 |
| `views/SettingsView.tsx` | Settings (+ `views/settings.css`, `views/settings/*`; the sidebar reloads its tools on `tools/events.ts`) | M8.2; its Claude Code row holds M9.1's `StartAtLoginToggle` (`views/settings/StartAtLogin.tsx`, `docs/service.md`) |
| `modals/Palette.tsx` | ⌘K palette (the shortcut and Esc already work in `ModalHost.tsx`) | M8.3 |

Each lane adds its view's CSS next to its component (`views/<view>.css`), using the variables in `styles/tokens.css`.

## UI plumbing (M1.4, shared)
- `styles/tokens.css`: every SPEC token as a CSS variable (`--bg-*`, `--border-*`, `--text*`, `--muted-*`, `--status-*`, `--branch-*`, `--question-*`, `--option-selected-*`, `--diff-*`, fonts, radius, shadows, spacing). `styles/global.css`: the prototype's page rules and `.sb-button` (a `<button>` without browser styling).
- `fonts.ts`: Geist 400/500/600 and Geist Mono 400/500 from `@fontsource` (gap #19), bundled by Vite.
- `router.tsx`: `RouterProvider`, `useRouter()`, `<Link to={route}>`, `parseRoute` / `routePath`. Paths: `/` and `/inbox`, `/sessions/:id[/:tab]` (tab `chat` · `timeline` · `diff` · `artifacts`), `/solutions`, `/schedules`, `/artifacts`, `/history`, `/tools/:id`, `/settings[/:section]`; unknown paths show the Inbox.
- `api/client.ts`: `api.<call>()` per contract row, same-origin with the `sb_token` cookie; errors are `ApiError` (`notImplemented` for 501, `unreachable` for a network failure). `api/useApi.ts`: `useApi(fetcher, deps)` → `{ data, error, loading, reachable, reload }`.
- `api/useHub.ts`: `useHubEvent(name, handler)` and `useHubStatus()` over one shared `EventSource('/hub')`; retries with a 2 s → 60 s backoff while the server refuses the stream (the real stream since M2.3, `docs/hub.md`).
- `modals/ModalHost.tsx`: `useModals().open('new-session' | 'setup-wizard' | 'palette', { prefill?, schedule? })` (M7.1: `schedule` = `{}` for "+ New scheduled run", `{ id, cron }` for Edit) (M3.3: `prefill` = the New-session values, passed to `NewSessionModal`, which starts its form from them since M5.1), Esc closes, ⌘K / Ctrl+K opens the palette. `toast/ToastHost.tsx`: `useToasts().show({ id, title, sub, branch, text, sessionId })`; `toast/notify.ts`: `playChime()` / `notifyOs()` for M8.2's "Send test" (`docs/notifications.md`).

## Tests
- **Lane runs:** a lane worktree runs its servers on its own ports with `SWITCHBOARD_TEST_PORTS=<first>-<last>` or a comma list (e.g. `4920-4929`; `tests/helpers/net.ts`, default 4871–4879, never 4870; anything unreadable is an error), e.g. `SWITCHBOARD_TEST_PORTS=4920-4929 npm test` / `npx playwright test`. `playwright.config.ts` anchors its ignore patterns at the repo, because a lane's own path contains `.worktrees/`.
- `tests/e2e/shell.spec.ts`: the shell on the real code path (no demo): API calls reach the 501 routes, navigation, deep links, modals.
- `tests/e2e/visual/shell.spec.ts`: the visual oracle for the shell (`docs/visual/shell.md`).
- `tests/server/api/routes.test.ts`: every contract route is registered and guarded.
- `tests/server/demo/*.test.ts`: demo data verbatim against the prototype, the seed, the demo providers.
- Test ports: each lane runs its suites on its own pool, `SWITCHBOARD_TEST_PORTS=<first>-<last>` (`docs/configuration.md`); stub HTTP servers come from `tests/helpers/stub-http.ts`.
- Specs that load the UI and are not about tools call `stubToolProbes(page)` (`tests/e2e/probes.ts`, M8.1): the sidebar probes configured tools on load, and the default Codebase Memory URL is the developer's `http://localhost:13000`.
