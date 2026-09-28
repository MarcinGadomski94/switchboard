## Current
item: (none) · M4.1 green, next: M4.2
attempt: 0/5
last oracle: M4.1 PASS · `npm run typecheck` green · `SWITCHBOARD_TEST_PORTS=4910-4919 npm test` 513/513 (47 files) · `SWITCHBOARD_TEST_PORTS=4910-4919 npx playwright test` 23/23 (new: session-handoff.spec.ts real path, visual/session-header.spec.ts gate green) · nothing listening on 4910–4919 afterwards
## Done
- M4.1 ✓ 2026-09-28 (commit: see git log "M4.1: Session header") · oracle attempts 3/5 (E2E green on the 1st run; visual: 1st run a wait on text the prototype splits, 2nd run found the class clash with the sidebar's `sb-session-*` (renamed to `sb-sv-*`) and the data-dependent chip wrap (compared relative to the chip row + a second, fully absolute session), 3rd run green) · plan:
  - Server Attach (gap #5, M0.4): `src/core/transcript-sync.ts` (newest-leaf chain, entries after the sync uuid, synthetic/sidechain/meta skipped) + `src/server/supervisor/attach.ts` (find `<configDir>/projects/*/<id>.jsonl`, mtime < 2 min or `claude agents --json` lists the id or cannot be read → warning; import the terminal turns as events before the `--resume` spawn, sync point moved). `POST /attach` → 409 `attach-warning` unless `{ confirm: true }`; attach calls serialized per session.
  - Wire (additive): Session `cwd`, `live`, `resumeCommand`, `chips` (`src/core/derive/chips.ts`); user origin `terminal`.
  - UI: SessionView grid `1fr | 380px` (`session.css`, `sb-sv-*`), SessionHeader (dot, name, root line, Pause/Resume, ⇄ buttons, Attach warning card, chips, tab links with counts), HandoffCard in RightPanel, minimal ChatTab message list.
  - Tests: unit (transcript-sync on the M0.4 fixtures, chips, header copy, chat), supervisor attach (fake text-mode terminal turn), route 409/confirm, E2E real path, visual header.
  - Docs: supervisor.md → *Attach here*, derivations.md → *Session chips* + terminal prompts, lanes.md rows, visual/session-header.md + README review, core README.
## Blocked
- (none)
## Breaker
consecutive_blocked: 0
## Assumptions (see .loop/questions-w2-session.md)
- M4.1 · Attach warning enforced server-side (409 `attach-warning` unless `{confirm:true}`)
- M4.1 · agents --json unreadable → `liveness-unknown` warning
- M4.1 · warning copy/look (no prototype design)
- M4.1 · header chips = session-start answers + QA stack + blue loop/run chips; mock-only chips not derived
- M4.1 · Session gains `cwd`, `live`, `resumeCommand`, `chips`
- M4.1 · Pause/Resume rule; disabled while detached
- M4.1 · imported terminal turns: transcript timestamps, origin `terminal`, no subagents/artifacts
- M4.1 · handoff card + minimal chat list built early (M4.3 / M4.2 extend)
- M4.1 · demo sessions get the demo root as `cwd`
- M4.1 · visual oracle on calendar-func-fix (absolute) + free-talk-feature (relative to the wrapped chip row)
## Notes for later items / the merge
- `POST /attach` without `{ confirm: true }` now answers 409 while the transcript changed < 2 min ago: tests in other lanes that attach right after a detach must confirm.
- `makeSupervisorWorld` passes `listLive` (`claude agents --json` through the fake), so the Attach check adds `agents --json` lines to `FAKE_CLAUDE_LOG`; tests counting spawns after an attach should filter them (`argv` includes `--name` = a session spawn).
- The demo seed's chat events still use `payload.channel` shapes; the M4.1 chat list shows only real `user` / `assistant` payloads (M4.2 decides the demo mapping).
- The handoff card sits at the top of the right panel until M4.3 adds the agent cards and terminal tail above it.
