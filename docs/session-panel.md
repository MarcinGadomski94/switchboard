# Session right panel (M4.3)

SPEC → Session → Right panel ("agent cards (dot, name, desc, status; path + ⎇ branch), terminal tail, handoff card (state, explanation, `claude --resume <id>` + copy)"), prototype right column (`ss.agents`, `ss.agentSummary`, `ss.term`, `lineColor`, `handoff`, `copyResume`). The panel reads only `GET /api/sessions/{id}` (the session's `agents`, recent `events`, `status`, `attached`, `resumeCommand`), which the session view reloads on the session's `/hub` events (D13). Code: `src/web/views/session/RightPanel.tsx` (view), `right-panel.ts` (pure rules), `TerminalTail.tsx` (the terminal box, shared with the Timeline tab, M4.4), `HandoffCard.tsx` (M4.1), `session.css` (`sb-sv-panel-*`, `sb-agent-*`, `sb-term-*`, `sb-handoff-*`); server: the agent placement in `src/server/supervisor/recorder.ts`.

Top to bottom (the prototype's order): the header `AGENTS & SOLUTIONS` + the summary, one card per agent, the `TERMINAL` label, the terminal tail, the handoff card. The column scrolls as a whole.

## Agent cards
One card per agent of the session, in creation order (the main agent first; agents = the main agent + one per Agent/Task call, gap #8, `docs/derivations.md` → *Agents*).

| Part | From |
|---|---|
| dot | the agent's status color (SPEC status tokens; `paused` → idle) |
| name | the agent's name (`orchestrator`, the solution's name in single-solution mode, `main`, or a subagent's `subagent_type`) |
| description | the agent's own (a subagent's Agent-call description); the main agent has none, so it shows **the first line of the session's task** |
| status copy | the agent's status text (a subagent's latest `task_progress` description) while it has one, else the status word: `needs you` · `running` · `done` · `failed` · `idle` · `paused` (the prototype's words). While the session is `paused`, an agent the pause cut off (`idle`) reads `paused` with the idle dot, as in the prototype |
| path | the solution folder the agent wrote into (below), else `workspace root`: every agent runs at the session's cwd, the workspace root |
| ⎇ branch | the branch of the session's worktree the agent wrote into; no chip without one |

**Where an agent works** (server, `#placeAgent` in the recorder): the agent's first **successful** write (Write / Edit / MultiEdit / NotebookEdit) into a solution sets its `solutionPath` = the solution's workspace-relative folder (`solutionFolder` in `src/core/derive/artifacts.ts`, the prototype's form: `microfrontends/acme-app-front`, `functions/calendar-func`, `deprecated/<type>/<repo>`, `mobile/`, `infrastructure/`; a file in the session's worktree `<repo>-wt-<session>` maps to its repo's folder) and `branch` = the registered worktree that holds the file (M2.2), else none. Later writes into other solutions do not move it; a later write into the same solution's worktree fills a missing branch. Files at the workspace root (`contracts/…`) place nobody. The stream itself never says where an agent works, and its prompt is not read (no inference).

**Summary** (right of the header): `n agents · n solutions · n branches`, the prototype's `agentSummary` verbatim, plural words even for 1 (`1 agents · 1 solutions · 1 branches`): agents, distinct solution folders (not `workspace root` / `read-only`) and distinct branches of the cards. When it is long, the header wraps onto two lines exactly as the prototype's does.

## Terminal tail
`terminalLines(events, agents, status)`: the session's recent events (the detail's newest 200) in time order (`ts`, then id) turned into lines; the newest **8** are shown, the cursor included. It complements the chat, which already shows the conversation and the main agent's tool steps.

| Event | Line(s) |
|---|---|
| Bash call (any agent) | `$ <first line of the command>`, then the **last 3 non-empty output lines** of its result, verbatim, once it arrived |
| AskUserQuestion | `⏸ <label>` while its request is open, `✓ <label>` once answered (`✕` on an error result) |
| any other tool call of a **subagent** | `<label>` while it runs, `✓ <label>` done, `✕ <label>` failed |
| any other tool call of the main agent | none (the chat's step lines) |
| permission request | `⏸` open · `✓` allowed · `✕` denied, cancelled or stale, + its label |
| automatic denial | `✕ Denied · <tool>` |
| permission-mode mismatch | `⚠ <label>` |
| turn result | its text (the label: the result's first line, the process's output); `✕ <label>` when the turn failed |
| process lifecycle | its label (`Started`, `Paused`, `Continued in a terminal`, …); `✕ <label>` when it failed |
| user / assistant text, subagent prompts, anything else | none |

A subagent's lines start with `[<agent name>] ` (the prototype's `[web] $ dotnet test`). While the session's status is `run`, the last line is the cursor `▍`.

Line colors (prototype `lineColor`, on the text after an optional `[name] ` prefix): `$ …` #6d6c67 · `✓ …` oklch(0.78 0.12 150) · `⏸ …` / `⚠ …` oklch(0.8 0.13 70) · `✕ …` oklch(0.72 0.16 25) · anything else #bfbeb8. Lines are mono 11px/1.7, one line each, cut with an ellipsis; the box (bg-code, 1px #1f2024, 8px radius, 10/12px padding) is at least 150px high.

## Handoff card
Unchanged from M4.1 (`docs/supervisor.md` → *Continue in terminal*): `Terminal handoff` + the state (`attached` green / `in terminal` amber), the prototype's explanation, and the command row `claude --resume <claudeSessionId>` with `copy`. Copy writes the command to the clipboard (when the browser allows it; the command stays selectable otherwise) and reads `copied` for 1.5 s (prototype `copyResume`).

## Demo seed
The prototype's terminal lines are mock text that no real event produces. The seed (`src/server/demo/seed.ts`, `demoResult`) stores each line as a finished **turn result** whose text is the line (kind `ok`, `source: 'demo'`), which the tail shows verbatim and the chat does not show; the prototype's cursor line `▍` is not stored (the tail adds it for the two `run` sessions). So the demo goes through the same renderer as real sessions. button-rollout's tail also starts with `⏸ breaker: 2 consecutive ambiguous items`: M4.2's demo seed turned that chat line into an open permission request, which the tail shows like any open request.

## Test ids
`session-right-panel`, `agents-summary`, `agent-cards`, `agent-card` (`data-agent-id`, `data-status`), `agent-name`, `agent-desc`, `agent-status`, `agent-path`, `agent-branch`, `terminal-tail`, `terminal-line` (`data-tone`: `cmd` / `ok` / `wait` / `fail` / `out`), `handoff-card`, `handoff-state`, `handoff-command`, `handoff-copy`.

## Tests
- `tests/web/right-panel.test.ts`: the card, summary and tail rules, the tones, and the demo lines rendering verbatim.
- `tests/core/solution-folder.test.ts`: the path line's folder.
- `tests/server/supervisor/agent-placement.test.ts`: fake-claude writes place the main agent (worktree branch; root files and later writes do not move it); a subagent's write places the subagent (recorder).
- `tests/e2e/session-panel.spec.ts` (real path, no demo): a worktree session's cards and summary, `$ ls` + output, the subagent's `[general-purpose] ✓ Read · hello.txt`, the cursor while a turn hangs, `Paused` + `paused` after Pause, copy → the clipboard.
- `tests/e2e/visual/session-panel.spec.ts`: the visual oracle (`docs/visual/session-panel.md`).
