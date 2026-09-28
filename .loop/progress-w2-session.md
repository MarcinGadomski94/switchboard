## Current
item: (none) · M4.3 green, next: M4.4
attempt: 0/5
last oracle: M4.3 PASS · `npm run typecheck` green · `SWITCHBOARD_TEST_PORTS=4910-4919 npm test` 543/543 (52 files) · `SWITCHBOARD_TEST_PORTS=4910-4919 npx playwright test` 27/27 (new: session-panel.spec.ts real path, visual/session-panel.spec.ts gate green, 0 findings) · nothing listening on 4910–4919 afterwards
## Done
- M4.3 ✓ 2026-09-28 (commit: see git log "M4.3: Right panel") · oracle attempts 4/5 (the real-path E2E was green on its first run; the visual gate: 1st run waited on text the prototype splits ("Terminal handoff" + state), 2nd run clicked the wrong prototype child (its runtime wraps the interpolated resume id in an element), 3rd run found the header wrap: a pluralized summary was shorter than the prototype's plural-only copy, so the header did not wrap and every box sat 14 px higher → switched to the prototype's copy verbatim, 4th run green, 0 findings; the full Playwright suite then re-ran it green with the report write) · plan:
  - Server: `#placeAgent` in the recorder: an agent's first successful write into a solution sets `solutionPath` (`solutionFolder`, src/core/derive/artifacts.ts) + the worktree `branch`.
  - Web pure `right-panel.ts`: `agentCards` (status words, `workspace root` fallback, main agent desc = task's first line), `agentSummary` (prototype template verbatim), `terminalLines` (Bash + last 3 output lines, subagent tools prefixed, waits/denials/mismatch, results, lifecycle, `▍` while run, newest 8), `lineTone` (prototype lineColor).
  - `RightPanel.tsx` (header + cards, `TerminalTail.tsx`, M4.1 `HandoffCard`), CSS from the prototype's inline styles (`sb-sv-panel-*`, `sb-agent-*`, `sb-term-*`).
  - Demo seed: terminal lines → successful turn results (`demoResult`), `▍` derived.
  - Tests: tests/web/right-panel.test.ts, tests/core/solution-folder.test.ts, tests/server/supervisor/agent-placement.test.ts, tests/e2e/session-panel.spec.ts (real path), tests/e2e/visual/session-panel.spec.ts (gate green, pixel diff 0.08% / 0.08%).
  - Docs: docs/session-panel.md (new), derivations.md (agents), lanes.md, demo.md, chat.md, docs/visual/session-panel.md + README review.
- M4.2 ✓ 2026-09-28 (commit: see git log "M4.2: Chat tab") · oracle attempts 1/5 (the E2E and the visual gate were both green on their first run; the full Playwright suite and the report write re-ran them green) · plan:
  - Server: `SessionDetail.questions` (additive): every question batch of the session, oldest first (`sessionQuestions` in `src/server/sessions/wire.ts`).
  - Web pure state `chat.ts`: `chatItems(events, questions, mainAgentId)` → user bubbles, agent blocks (text + step lines ✓/●/✕/⏸), batches at their AskUserQuestion call (else last); quick replies verbatim; `answeredLines` uses the source name part.
  - `ChatTab.tsx`: messages, step lines, `QuestionCard variant="chat"` → `POST /answers`, answers bubble + "● Answers written into the briefs…", composer (quick replies fill the draft, Enter / Send → `POST /messages`, "Not sent: …"), stick-to-bottom; SessionView also reloads on `questionBatch`.
  - Demo seed: prototype chat → real payloads + `demoStep` step events; seed test updated.
  - Tests: tests/web/chat.test.ts, tests/server/sessions/questions.test.ts, tests/e2e/session-chat.spec.ts (fake-claude tool-use + ask-2q, composer, quick reply, detached refusal), tests/e2e/visual/session-chat.spec.ts (calendar-func-fix absolute, free-talk-feature relative to the chat top: card, picked, answered, composer; 15 SPEC-token checks).
  - Docs: docs/chat.md, lanes.md, demo.md, supervisor.md, questions.md, docs/visual/chat.md + README review.
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
- M4.2 · SessionDetail gains `questions` (all batches)
- M4.2 · chat = main agent's events only
- M4.2 · step lines + marks (tool / permission / denial / failed turn / mode mismatch)
- M4.2 · batch at its AskUserQuestion call, else last
- M4.2 · SPEC answers note for every answered batch (stale ones too)
- M4.2 · quick replies = prototype copy; fill the draft only
- M4.2 · no optimistic bubble; refusal keeps the draft; composer enabled while detached
- M4.2 · stick-to-bottom scrolling
- M4.2 · demo chat → real payloads (`•` → `✓`)
- M4.2 · answeredLines uses the source name part
- M4.3 · agent placed by its first successful write into a solution (folder + worktree branch)
- M4.3 · unplaced agents show `workspace root`
- M4.3 · main agent desc = the task's first line
- M4.3 · status words (prototype) + `paused` for agents a pause cut off; no `resuming`
- M4.3 · summary = the prototype's plural-only template verbatim
- M4.3 · terminal tail rules (Bash + output, subagent tools, waits, results, lifecycle, `▍`, newest 8)
- M4.3 · demo terminal lines → successful turn results; `▍` derived
## Notes for later items / the merge
- M4.3: `RightPanel` now takes the `SessionDetail` (agents, events, status). `TerminalTail` (src/web/views/session/TerminalTail.tsx) + `terminalLines(events, agents, status)` (right-panel.ts) are ready for M4.4's Timeline terminal (the prototype shows the same `ss.term` there); pass `className` for its box (the panel's `sb-sv-term` adds the 12 px margin and the 150 px min-height).
- M4.3: the demo seed's terminal rows are now `result` events (kind `ok`, `ts` = the session's end, `endTs` null, `source: 'demo'`), not `payload.channel: 'terminal'`; only the timeline rows still use `payload.channel` (M4.4 decides). If the timeline draws blocks from events by kind, it must decide what to do with these zero-length results.
- M4.3: the recorder sets `agents.solution_path` / `branch` on an agent's first successful write into a solution (`docs/derivations.md` → *Agents*); no schema change.
- `POST /attach` without `{ confirm: true }` now answers 409 while the transcript changed < 2 min ago: tests in other lanes that attach right after a detach must confirm.
- `makeSupervisorWorld` passes `listLive` (`claude agents --json` through the fake), so the Attach check adds `agents --json` lines to `FAKE_CLAUDE_LOG`; tests counting spawns after an attach should filter them (`argv` includes `--name` = a session spawn).
- The demo seed's chat events still use `payload.channel` shapes; the M4.1 chat list shows only real `user` / `assistant` payloads (M4.2 decides the demo mapping).
- The handoff card sits at the top of the right panel until M4.3 adds the agent cards and terminal tail above it.
- M4.2: `GET /api/sessions/{id}` now carries `questions` (every batch); the chat reloads the detail on `questionBatch` too. The demo seed's chat rows are real `user` / `assistant` / step payloads (`source: 'demo'`); only the terminal and timeline rows still use `payload.channel` (M4.3 / M4.4 decide those).
- M4.2: chat test ids: `session-chat`, `chat-message` (`data-role`, `data-origin`), `chat-text`, `chat-steps` / `chat-step` (`data-mark`), `question-card` (shared), `chat-answers` / `chat-answer` / `chat-answers-note`, `chat-composer`, `chat-quick-reply`, `chat-input`, `chat-send`, `chat-error`. `chat-message` now wraps text + steps, so a turn that starts with tools adds a `chat-message` without `chat-text`.
