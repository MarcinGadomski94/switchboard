## Current
item: M2.1 (next)
attempt: 0/5
last oracle: M1.4 PASS (attempt 3/5; attempt 1 red: SPEC oklch tokens looked missing because Vite minifies `oklch(0.8 0.14 70)` to `oklch(80% .14 70)` → tokens now compared as browser-computed colors, and the footer's "claude code" box wraps in the prototype only because of its process count → copy/style-only check; attempt 2 E2E green) · `npm run typecheck` green · `npm test` 214/214 (25 new: tests/server/api/routes.test.ts every contract route 501 + guarded; tests/server/demo/{data,seed,providers}.test.ts verbatim strings vs the prototype, seed rows/timestamps/links, idempotent, refuses real data + app-data dir, rollback, demo providers; tests/web/format.test.ts; main.test.ts demo seeds once / non-demo DB empty) · `npx playwright test` 6/6 (tests/e2e/shell.spec.ts non-demo: real 501 API calls, nothing invented, nav + deep links, modals + ⌘K/Ctrl+K; tests/e2e/visual/shell.spec.ts: 29 parts, all chrome boxes equal to the prototype's, copy exact, 21 SPEC color tokens defined, 16 computed-style checks, pixel diff 5.32% page / 5.42% sidebar advisory → docs/visual/shell.md + side-by-side PNGs; agent review in docs/visual/README.md) · main.test.ts pre-existing flake (~1 in 6: SIGTERM right after "Server listening" beat the handler registration) fixed by installing the shutdown handlers before listen: 8/8 reruns green
## Done
- M0.1 ✓ 2026-09-27 (commit 4131f06) · plan: read --help; ~23 Haiku probes in .spike/sandbox/<scenario>; fixtures + manifest in tools/fake-claude/fixtures; docs/spike-m0.md; oracle = node -e NDJSON parse
- M0.2 ✓ 2026-09-27 (commit: see git log "M0.2: Questions & permissions") · attempts 1/5 · plan: probe2.mjs control host in .spike; (a) native `--permission-prompt-tool stdio` worked first time → (b)/(c) skipped; 14 Haiku processes (ask-2q, perm-allow, perm-deny, noflag, multiselect, 240 s + 20 min waits, interrupt/cancel, resume, subagent perm/ask, initialize + set_permission_mode); 11 fixtures + manifest entries; verdict: M3.1 uses the stdio control protocol
- M0.3 ✓ 2026-09-27 (commit: see git log "M0.3: Transcripts & usage") · attempts 1/5 · plan: structure-only survey of ~/.claude/projects; probe3.mjs (11 processes, 8 API requests: usage-ctl/usage-turn/usage-cache get_usage, /usage /status /cost, tx-main space+git+--name, slug-chars/long/case, worktree); slug rule read from the binary and verified on 5 folders; parse-transcript.mjs sample parse; verdict: 5-hour % and weekly % reliable via stdin `get_usage` (+ rate_limit_event), cost/transcripts give no %
- M0.4 ✓ 2026-09-27 (commit: see git log "M0.4: Terminal handoff") · attempts 1/5 · plan: probe4.mjs Proc lib + handoff.mjs steps in .spike; 10 Haiku processes / 11 API requests (start+idle pause, terminal -p resume same + other cwd, service re-attach, mid-tool pause + terminal resume, concurrent attach); export4.mjs → 3 NDJSON scenarios + textRuns + 3 transcripts; verdict: id stays, context kept, one transcript file; pause exit 0 (idle) / 1 (mid-turn) both = paused; two live processes on one id fork the chain; interactive TTY left to manual steps
- M0-adapt ✓ 2026-09-27 (commit: see git log "M0: adapt backlog and architecture after spike") · attempts 2/5 · plan: read spike + fixtures + questions; rewrite BACKLOG M5.2 + the items the spike changed (M1.2, M1.3 pointer, M2.1, M2.4, M3.1, M4.1, M7.4, M9.2) with concrete fake-claude oracles; rewrite ARCHITECTURE "Claude Code integration" (+ the M0.3 usage placeholder); log ASSUMED; oracle = scratchpad check script
- M1.1 ✓ 2026-09-28 (commit: see git log "M1.1: Node project skeleton + loopback-only server") · attempts 4/5 (1 red: a wrong config test case; 3 red: e2e spec needed DOM lib → tsconfig.e2e.json) · plan: package.json exact pins + lockfile, tsconfig/web/e2e, vite/vitest/playwright configs excluding .worktrees/.spike/dist/node_modules; config.ts env (PORT, DATA_DIR #18, WORKSPACE_ROOT, CLAUDE_BIN/GH_BIN argv prefix, DEMO); security.ts Host/Origin guard + default-deny sb_token cookie (#20); token.ts; listen.ts 127.0.0.1-only; web.ts dist/web + placeholder; routes.ts registry; tools/dev.ts; docs/security.md + docs/configuration.md
- M1.2 ✓ 2026-09-28 (commit: see git log "M1.2: tools/fake-claude") · attempts 1/5 · plan: tools/fake-claude/{main,args,fixtures,rewrite,scenarios,session,transcript,log,command}.ts; fixture compiler (preamble, turns split at result, replay/request/answer/wait/ack steps); runner state machine (blocking can_use_tool, interrupt/cancel tails, SIGINT, EOF, control requests, --max-turns, perm-noflag, siblings); transcript + sessions/<pid>.json under CLAUDE_CONFIG_DIR; tests/helpers/fake-claude.ts + tests/tools/*.test.ts; docs/fake-claude.md
- M1.3 ✓ 2026-09-28 (commit: see git log "M1.3: SQLite schema + migrations") · attempts 3/5 · plan: 0001_initial.sql STRICT tables for every data-model entity + M0 stored fields + inbox permission/system items + outbox/usage/history cache; database.ts (WAL, FKs, busy timeout, sync transaction helper) + migrate.ts (NNNN_name.sql, schema_migrations with LF-normalized sha256, one transaction per migration, foreign_key_check, edited/newer refusal); table.ts typed row mapper + src/server/db/repos/* (Promise API) + store.ts openStore; main.ts opens <dataDir>/switchboard.db, ApiContext.store; src/core/model.ts enums; docs/database.md
- M1.4 ✓ 2026-09-28 (commit: see git log "M1.4: App shell, lane scaffolding, demo seed, visual harness") · attempts 3/5 · plan: fonts + prototype runtime deps; tokens.css/global.css, router, Shell + Sidebar fed only by the typed API client (501 → empty, "—"); placeholders per view/tab/modal + ToastHost, api/client.ts + useApi + useHub (SSE), src/server/api/* 501 modules from routes.ts, providers.ts; demo data files + seed + demo providers (SWITCHBOARD_DEMO=1, throwaway data dir only); visual harness (offline prototype, boxes ±2 px, copy, tokens, canvas pixel diff, side-by-side); docs/lanes.md, docs/demo.md, docs/visual/README.md

## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions.md)
- M0.1 · default permission mode acceptEdits (auto unproven: model-gated, Haiku unsupported)
- M0.1 · no --bg/attach integration (sandbox untrusted; trust would edit ~/.claude.json)
- M0.1 · fixtures scrub home dir only
- M0.2 · acceptEdits stays default; zero-cost auto switch (initialize.models[].supportsAutoMode + set_permission_mode) documented, not adopted
- M0.2 · ctl-init fixture also scrubs account email/organization
- M0.2 · (b) Agent SDK and (c) hook bridge not probed ((a) worked)
- M0.3 · transcript fixture line-filtered (instructions/memory/account/listing attachments dropped)
- M0.3 · get_usage money amounts scrubbed to 0 in fixtures
- M0.3 · /usage and /cost outputs documented, not exported
- M0.3 · usage source = experimental get_usage + rate_limit_event, else "unknown"
- M0.4 · automated "terminal" = text-mode `claude -p --resume`; interactive TTY from the binary + manual steps
- M0.4 · concurrent-attach probe used a live -p stream-json process as the open-terminal stand-in
- M0.4 · text-mode runs in manifest `textRuns` (not NDJSON fixtures)
- M0.4 · handoff transcripts line-filtered as M0.3
- M0-adapt · D6 fallback applied: acceptEdits on every spawn; auto switch documented, not enabled
- M0-adapt · env scrub + no --model/--max-turns in normal runs; --forward-subagent-text + --replay-user-messages on
- M0-adapt · fake-claude control surface (FAKE_CLAUDE_SCENARIO, [fake:…] tokens, FAKE_CLAUDE_LOG, hang/crash, sessions/<pid>.json)
- M0-adapt · multiSelect answered with one option (contract has one answerIndex)
- M0-adapt · question source = main agent always
- M0-adapt · stale batches stay answerable → sent as a user message on next run; stale permission items close
- M0-adapt · restart stops leftover children first; need sessions resume idle
- M0-adapt · Attach warning = mtime < 2 min OR live in `claude agents --json`; additive SessionDetail liveness fields
- M0-adapt · handoff copy `claude --resume <id>`; terminal questions stay in the terminal while detached
- M0-adapt · M5.2 answers only in the first stdin message; re-asks never auto-answered
- M0-adapt · History hides headless sdk-cli files not in the DB and stubs
- M0-adapt · usagePct = max(5-hour, weekly); poll cadence 60 s live / 5 min poller while UI connected
- M0-adapt · M1.3 pointer + ARCHITECTURE usage section filled in (beyond the brief's list)
- M1.1 · @playwright/test 1.62.1 (cached Chromium 1234 matches; no download)
- M1.1 · Host/Origin allowlist = 127.0.0.1 / localhost with the exact port; other loopback ports are foreign
- M1.1 · sb_token session cookie (Path=/; HttpOnly; SameSite=Strict); no Sec-Fetch-Site → no cookie
- M1.1 · default-deny cookie guard (only UI page + static files public; /api*, /hub* always protected); JSON error bodies
- M1.1 · no default SWITCHBOARD_WORKSPACE_ROOT (null)
- M1.1 · CLAUDE_BIN / GH_BIN accept a JSON array argv prefix
- M1.1 · Linux data dir honours absolute $XDG_DATA_HOME; token file <dataDir>/sb_token 0600
- M1.1 · npm run dev = vite build --watch + node --watch server (no Vite dev server)
- M1.1 · no ESLint; typecheck = 3 tsconfigs
- M1.2 · rate_limit_event replayed as recorded (first turn only), not injected per turn
- M1.2 · no CLAUDE_CONFIG_DIR → no files written, --resume refused (never ~/.claude)
- M1.2 · EOF exit 1 iff last result is_error; EOF keeps a hang/tool wait alive; EOF with an open request → "Stream closed" failure; unknown --resume id → exit 1
- M1.2 · recorded reply text after answers; sibling recordings on a different decision, else default "OK"; exhausted scenario → default turn
- M1.2 · invented outputs (auth status silent, agents text, unknown control subtype error, [fake:write] content, synthetic after both markers, crash leaves live file)
- M1.2 · no separate `fail` scenario: crash + max-turns cover it
- M1.3 · Promise API over synchronous node:sqlite (atomic per call, sync transaction callbacks)
- M1.3 · schema beyond the minimum (batches+questions, permission/system tables, pending_messages, usage, history cache, extra nullable columns)
- M1.3 · CHECK only on locked enums; other vocabularies are TS unions
- M1.3 · sessions.work_type / mode nullable
- M1.3 · ISO timestamps, event id cursor, UUID ids, batch id = request_id, worktree path unique among live ones
- M1.3 · answer rules (label recorded, answered when complete, no double answer, stale stays stale)
- M1.3 · store opened in main.ts, required ApiContext.store, exit 1 on migration errors
- M1.3 · no seeded rows (tool defaults left to M8.1)
- M1.4 · demo mode only on a throwaway data dir, seeds an empty DB once
- M1.4 · all contract routes 501 with owner item; /hub left to M2.3
- M1.4 · provisional wire types in src/core/api.ts; /api/system units + additive usageResetsAt
- M1.4 · sidebar shows only API data (empty / "—" / "unknown" while 501)
- M1.4 · badge, mode-line and age derivations
- M1.4 · ⌘K on Apple platforms, "Ctrl K" elsewhere
- M1.4 · in-house history router
- M1.4 · @fontsource fonts; prototype runtime via npm aliases + overrides
- M1.4 · visual reports to docs/visual only with SWITCHBOARD_VISUAL_REPORT=1
- M1.4 · empty-shell gate: data-dependent parts by size / bottom / copy only
- M1.4 · in-browser canvas pixel diff (no image deps)
- M1.4 · demo seed mapping (ids, timeline base, payload.channel, artifacts list)
- M1.4 · e2e global setup builds dist/web
