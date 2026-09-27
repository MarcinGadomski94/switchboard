## Current
item: M0.4 (next)
attempt: 0/5
last oracle: M0.3 fixture NDJSON check PASS (54 files incl. transcripts/*.jsonl, 638 lines, 0 bad; manifest parses, every referenced file exists) + docs/spike-m0.md M0.3 section complete (location/slug, format, History mapping, gap #5, sample parse, usage verdict)
## Done
- M0.1 ✓ 2026-09-27 (commit 4131f06) · plan: read --help; ~23 Haiku probes in .spike/sandbox/<scenario>; fixtures + manifest in tools/fake-claude/fixtures; docs/spike-m0.md; oracle = node -e NDJSON parse
- M0.2 ✓ 2026-09-27 (commit: see git log "M0.2: Questions & permissions") · attempts 1/5 · plan: probe2.mjs control host in .spike; (a) native `--permission-prompt-tool stdio` worked first time → (b)/(c) skipped; 14 Haiku processes (ask-2q, perm-allow, perm-deny, noflag, multiselect, 240 s + 20 min waits, interrupt/cancel, resume, subagent perm/ask, initialize + set_permission_mode); 11 fixtures + manifest entries; verdict: M3.1 uses the stdio control protocol
- M0.3 ✓ 2026-09-27 (commit: see git log "M0.3: Transcripts & usage") · attempts 1/5 · plan: structure-only survey of ~/.claude/projects; probe3.mjs (11 processes, 8 API requests: usage-ctl/usage-turn/usage-cache get_usage, /usage /status /cost, tx-main space+git+--name, slug-chars/long/case, worktree); slug rule read from the binary and verified on 5 folders; parse-transcript.mjs sample parse; verdict: 5-hour % and weekly % reliable via stdin `get_usage` (+ rate_limit_event), cost/transcripts give no %
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
