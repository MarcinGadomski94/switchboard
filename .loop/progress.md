## Current
item: M1.1 (next)
attempt: 0/5
last oracle: M0.4 fixture NDJSON check PASS (63 files incl. transcripts/*.jsonl, 815 lines, 0 bad; manifest parses, every referenced file exists; 37 scenarios + 4 textRuns + 4 transcripts) + docs/spike-m0.md M0.4 section complete (3 steps with exact commands, transcript behavior, D7 pause exit codes, concurrent-attach fork, picker/cross-dir notes, verdict, manual TTY steps, implications)
## Done
- M0.1 ✓ 2026-09-27 (commit 4131f06) · plan: read --help; ~23 Haiku probes in .spike/sandbox/<scenario>; fixtures + manifest in tools/fake-claude/fixtures; docs/spike-m0.md; oracle = node -e NDJSON parse
- M0.2 ✓ 2026-09-27 (commit: see git log "M0.2: Questions & permissions") · attempts 1/5 · plan: probe2.mjs control host in .spike; (a) native `--permission-prompt-tool stdio` worked first time → (b)/(c) skipped; 14 Haiku processes (ask-2q, perm-allow, perm-deny, noflag, multiselect, 240 s + 20 min waits, interrupt/cancel, resume, subagent perm/ask, initialize + set_permission_mode); 11 fixtures + manifest entries; verdict: M3.1 uses the stdio control protocol
- M0.3 ✓ 2026-09-27 (commit: see git log "M0.3: Transcripts & usage") · attempts 1/5 · plan: structure-only survey of ~/.claude/projects; probe3.mjs (11 processes, 8 API requests: usage-ctl/usage-turn/usage-cache get_usage, /usage /status /cost, tx-main space+git+--name, slug-chars/long/case, worktree); slug rule read from the binary and verified on 5 folders; parse-transcript.mjs sample parse; verdict: 5-hour % and weekly % reliable via stdin `get_usage` (+ rate_limit_event), cost/transcripts give no %
- M0.4 ✓ 2026-09-27 (commit: see git log "M0.4: Terminal handoff") · attempts 1/5 · plan: probe4.mjs Proc lib + handoff.mjs steps in .spike; 10 Haiku processes / 11 API requests (start+idle pause, terminal -p resume same + other cwd, service re-attach, mid-tool pause + terminal resume, concurrent attach); export4.mjs → 3 NDJSON scenarios + textRuns + 3 transcripts; verdict: id stays, context kept, one transcript file; pause exit 0 (idle) / 1 (mid-turn) both = paused; two live processes on one id fork the chain; interactive TTY left to manual steps
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
