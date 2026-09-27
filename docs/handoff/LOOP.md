# Loop delivery

Build Switchboard by running a **Ralph outer loop** over `BACKLOG.md`, with **plan-act-verify** inside each item. This follows the loop rules in the workspace router (four gates, oracle per item, caps, circuit breaker).

> **Overnight authorization, 2026-09-27 (developer ruling, see `docs/decisions.md`).** Scope M0–M9 in one unattended run. The M0 review stop and the per-milestone review stops are **waived**; the developer reviews everything the next morning. The escalation and breaker rules below are the overnight versions and replace the original "stop the run" behavior.

## Gates
1. **Entry.** Authorized: M0–M9, max 5 attempts per item. M0 runs first; its findings are adopted directly and the *(adapt after M0)* items are rewritten from them before M1 starts.
2. **Iteration cap / circuit breaker.** Max **5** plan-act-verify cycles per item. An item that is still red after 5 attempts is marked **BLOCKED** and skipped, together with items that depend on it. The run **stops** after **3 consecutive BLOCKED items**.
3. **Escalation (assume, flag, continue).** On ambiguity (no oracle, contract ambiguity, missing design detail): pick the most conservative, reversible option, log it in `.loop/questions.md` as `ASSUMED`, and continue. **Hard stop** (write the question, end the run) only for anything that would touch files outside the repo beyond the authorized list in `docs/decisions.md` (npm/Playwright caches, `.spike/` real-CLI probes with Haiku, final read-only smoke scan).
4. **Exit.** The developer reviews the whole delivery (diff + demo) in the morning. Local commits per item are allowed. **No push, PR or merge without explicit approval.**

## Oracles available
- `npm run typecheck` / `npm test` (Vitest: unit + integration)
- `npx playwright test`: E2E tests and screenshots of the running app
- **Visual oracle:** a screenshot of the real app (demo seed, `docs/decisions.md` #21) at 1440×900 compared with the same view in `docs/handoff/prototype/Switchboard App.dc.html` (prototype prop `simulateIncoming` off unless the view needs the toast). **Gate:** computed-style checks on the `SPEC.md` tokens, key box sizes/positions within ±2px, copy matched exactly, and an agent review of both screenshots side by side. The pixel-diff % is recorded in `docs/visual/` but does not gate. Anything that differs is a finding to fix, not a new spec.
- **Contract oracle:** `contracts/local-api.md`. Service responses and events must match it field by field.
- **CLI fake:** `tools/fake-claude` (built in M1) replays recorded stream-json so tests never call the real Claude.

## State file (fresh context each iteration)
`.loop/progress.md`, updated at the end of every iteration:
```
## Current
item: M3.2
attempt: 2/5
last oracle: e2e inbox-answer.spec FAIL (send button enabled before all answered)
## Done
- M0.1 ✓ 2026-09-28 (commit abc123)
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions.md)
- (none)
```

## Per-item recipe
1. Read the item, its acceptance criteria, the matching `SPEC.md` section and `docs/decisions.md`.
2. Plan in 3–6 bullets in the progress file.
3. Implement the smallest change that satisfies it.
4. Run the oracle. If it's red and the cause is mechanical, fix and rerun (counts as an attempt). If the spec is ambiguous, apply the escalation policy above (assume, flag, continue).
5. Green → tick, commit, update progress.
