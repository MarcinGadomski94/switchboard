## Current
item: M1.1 (next)
attempt: 0/5
last oracle: M0-adapt check PASS (attempt 2/5; attempt 1 failed only on the check script's own item count and a "non-demo" false positive) · 39 BACKLOG items all name an **Oracle:**, no "(adapt after M0)" item left, 9 items adapted (M1.2, M1.3, M2.1, M2.4, M3.1, M4.1, M5.2, M7.4, M9.2), D4–D13 + gap #5/#8 checklist clean; no package.json yet (M1.1), so typecheck/test do not exist
## Done
- M0.1 ✓ 2026-09-27 (commit 4131f06) · plan: read --help; ~23 Haiku probes in .spike/sandbox/<scenario>; fixtures + manifest in tools/fake-claude/fixtures; docs/spike-m0.md; oracle = node -e NDJSON parse
- M0.2 ✓ 2026-09-27 (commit: see git log "M0.2: Questions & permissions") · attempts 1/5 · plan: probe2.mjs control host in .spike; (a) native `--permission-prompt-tool stdio` worked first time → (b)/(c) skipped; 14 Haiku processes (ask-2q, perm-allow, perm-deny, noflag, multiselect, 240 s + 20 min waits, interrupt/cancel, resume, subagent perm/ask, initialize + set_permission_mode); 11 fixtures + manifest entries; verdict: M3.1 uses the stdio control protocol
- M0.3 ✓ 2026-09-27 (commit: see git log "M0.3: Transcripts & usage") · attempts 1/5 · plan: structure-only survey of ~/.claude/projects; probe3.mjs (11 processes, 8 API requests: usage-ctl/usage-turn/usage-cache get_usage, /usage /status /cost, tx-main space+git+--name, slug-chars/long/case, worktree); slug rule read from the binary and verified on 5 folders; parse-transcript.mjs sample parse; verdict: 5-hour % and weekly % reliable via stdin `get_usage` (+ rate_limit_event), cost/transcripts give no %
- M0.4 ✓ 2026-09-27 (commit: see git log "M0.4: Terminal handoff") · attempts 1/5 · plan: probe4.mjs Proc lib + handoff.mjs steps in .spike; 10 Haiku processes / 11 API requests (start+idle pause, terminal -p resume same + other cwd, service re-attach, mid-tool pause + terminal resume, concurrent attach); export4.mjs → 3 NDJSON scenarios + textRuns + 3 transcripts; verdict: id stays, context kept, one transcript file; pause exit 0 (idle) / 1 (mid-turn) both = paused; two live processes on one id fork the chain; interactive TTY left to manual steps
- M0-adapt ✓ 2026-09-27 (commit: see git log "M0: adapt backlog and architecture after spike") · attempts 2/5 · plan: read spike + fixtures + questions; rewrite BACKLOG M5.2 + the items the spike changed (M1.2, M1.3 pointer, M2.1, M2.4, M3.1, M4.1, M7.4, M9.2) with concrete fake-claude oracles; rewrite ARCHITECTURE "Claude Code integration" (+ the M0.3 usage placeholder); log ASSUMED; oracle = scratchpad check script
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
