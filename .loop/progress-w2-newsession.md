## Current
item: (none; M5.2 done)
attempt: 1/5 (M5.2)
last oracle: tests/server/api/first-turn.test.ts PASS (2/2: three golden cases + empty-task outbox) · tests/core/first-turn.test.ts PASS (7/7) · full suite: typecheck, vitest 516/516, playwright 27/27 (new-session.spec re-run 5/5 with the M5.2 first-message check)
plan (M5.2):
- Pure builder `src/core/first-turn.ts`: the session-start answers block in the modal summary's terms (work type, mode, solutions in scope as `/`-separated workspace folders, phase, then mobile coordination (feature + single + a `*-front`, when given) or QA stack + Confluence/Figma, ultracode on/off, absolute worktree paths + branch or "no worktrees · edits in place"), and the payload = task text, blank line, block.
- Server glue `src/server/sessions/first-turn.ts`: folders from the created worktree records / `WorktreeManager.resolveRepo` (fallback: the name as given), relative to the canonical workspace root.
- `POST /api/sessions` passes the payload as the first stdin message; an empty task keeps the process idle (M2.1) and queues the block in the outbox (`pending_messages`, kind `session-start`) so it rides with the developer's first message.
- Oracle `tests/server/api/first-turn.test.ts`: real route + supervisor + worktree manager, fake-claude with `FAKE_CLAUDE_LOG`, temp git repos; feature/single with worktrees, orchestrator, QA; exact argv (no prompt), first stdin line exact, payload = golden file `tests/fixtures/first-turn/*.txt` (`<workspace>` placeholder). Plus the empty-task outbox case and unit tests of the builder.
- Docs: `docs/new-session.md` → *First-turn payload*, supervisor.md note, derivations pointer; ASSUMED lines.
attempts (M5.2):
1. first-turn.test.ts (API oracle) + core unit tests: PASS; then the whole suite green; visual: not applicable (no UI change)
## Done
- M5.1 ✓ 2026-09-28 (commit 103bc05, "M5.1: New-session modal")
- M5.2 ✓ 2026-09-28 (commit: see `git log --oneline -1` on lane/w2-newsession, "M5.2: First-turn payload")
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w2-newsession.md)
- M5.1: recommended answers as defaults; QA stack + sources required; read-only chips per top folder; extra ⚠ / refusal / `not found` lines; coordination only when shown; static "Max" copy.
- M5.2: empty task → idle + answers in the outbox (kind `session-start`); payload wording/labels; folders `/`-relative with name fallback, coordination only when applicable and given, `—` for empty QA sources.
