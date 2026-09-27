## Current
item: M0.3 (next)
attempt: 0/5
last oracle: M0.2 fixture NDJSON check PASS (47 files, 566 lines, 0 bad; manifest parses) + docs/spike-m0.md M0.2 section complete (ends with the M3.1 recommendation)
## Done
- M0.1 ✓ 2026-09-27 (commit 4131f06) · plan: read --help; ~23 Haiku probes in .spike/sandbox/<scenario>; fixtures + manifest in tools/fake-claude/fixtures; docs/spike-m0.md; oracle = node -e NDJSON parse
- M0.2 ✓ 2026-09-27 (commit: see git log "M0.2: Questions & permissions") · attempts 1/5 · plan: probe2.mjs control host in .spike; (a) native `--permission-prompt-tool stdio` worked first time → (b)/(c) skipped; 14 Haiku processes (ask-2q, perm-allow, perm-deny, noflag, multiselect, 240 s + 20 min waits, interrupt/cancel, resume, subagent perm/ask, initialize + set_permission_mode); 11 fixtures + manifest entries; verdict: M3.1 uses the stdio control protocol
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
