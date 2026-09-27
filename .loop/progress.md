## Current
item: M0.2 (next)
attempt: 0/5
last oracle: M0.1 fixture NDJSON check PASS (25 files, 369 lines, 0 bad) + docs/spike-m0.md M0.1 section complete
## Done
- M0.1 ✓ 2026-09-27 (commit: see git log "M0.1: Claude Code headless surface") · plan: read --help; ~23 Haiku probes in .spike/sandbox/<scenario>; fixtures + manifest in tools/fake-claude/fixtures; docs/spike-m0.md; oracle = node -e NDJSON parse
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions.md)
- M0.1 · default permission mode acceptEdits (auto unproven: model-gated, Haiku unsupported)
- M0.1 · no --bg/attach integration (sandbox untrusted; trust would edit ~/.claude.json)
- M0.1 · fixtures scrub home dir only
