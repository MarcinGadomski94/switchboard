# New-session modal (M5.1)

The form behind "+ New session" (SPEC → Modals → New session; prototype `mNew` with its `ns` state, `pills`, `nsGroups`, `nsSummary`, `canLaunch`, `nsLaunch`). Code: `src/web/modals/NewSessionModal.tsx` (the component), `src/web/modals/new-session.ts` (pure logic: defaults, prefill, chips, summary, Start rules, request body, refusal text), `src/web/modals/new-session.css` (the prototype's inline styles as classes over the SPEC tokens). The server side (`POST /api/sessions`: validation, worktrees, start) is M2.1 / M2.2 / M6.1 (`docs/supervisor.md`, `docs/worktrees.md`, `docs/solutions.md` → *Read-only sessions*); M5.1 adds no route. The first stdin message built from the answers (M5.2) is below under *First-turn payload*; the Schedule section (D8, section 7 and "Save schedule" when opened by "+ New scheduled run" or a schedule's Edit) is in `docs/schedules.md` → *New scheduled run*.

## Layout
1080px, `1fr | 360px` (`.sb-modal-new` in `modals.css`). Left, in order:
0. **Folder** (D14, not numbered, not in the prototype): the saved-folder dropdown (260px, mono), **Browse…** (the add-a-folder panel opens under the row) and the folder's check line (`docs/folders.md` → *UI*). A **repo** folder hides sections 2, 3, 5 and 6 and "Accept recommended"; section 4 becomes `2 · Solution in scope` with the repo as its one fixed chip.
1. **Task definition**: the name (220px, Geist Mono, placeholder `session-name`) and the task (`What should be implemented?`). The task comes first, as the router wants the developer to define the task before any questions.
2. **Work type**: Feature-building · Test-authoring (QA).
3. **Mode**: Single-solution · Workspace orchestrator.
4. **Solutions in scope** with the hint `<n> selected · read-only folders locked`: one row per folder group of `GET /api/solutions` (the workspace scan, M6.1), then the read-only row.
5. **Phase**: UI-first · Integration.
6. **Mobile coordination** (Sequential follow-up · Parallel-twin · No mobile counterpart) only for feature-building + single-solution + a `*-front` in scope; **QA contract** (stack Web · Playwright / Mobile · Appium / Both, then the Confluence page URL and the Figma frame URLs) only for test-authoring. Never both.

Right: "Launch" with the two 32×18 toggles (Worktree per solution · Ultracode (workflows)), "Summary" (the live mono summary) and Cancel / Start session. The header has "Accept recommended".

Pills are radio groups (selected: `#26272c` background, `#8d8c87` border). Solution chips are toggle buttons (selected: blue, `✓ name`); read-only chips are disabled buttons at 40% opacity with a not-allowed cursor.

## Values
| Field | Default | Sent as (`NewSession`, contract) |
|---|---|---|
| name | empty; typing turns whitespace into `-` and lower-cases (prototype `onNsName`) | the field, or `session` while it is empty (prototype `sname`) |
| task | empty | trimmed |
| work type, mode, phase, coordination | the router's recommended answers: feature-building, single-solution, UI-first, sequential. "Accept recommended" sets these four again | `workType`, `mode`, `phase`; `coordination` only while section 6 · Mobile coordination is shown, else `null` |
| solutions | none | in the order picked: each chip's solution name (its `relativePath` when two writable rows share a name, so the server can resolve it) |
| QA stack, Confluence URL, Figma URLs | none, empty, empty | `qa: {stack, confluenceUrl, figmaUrls}` for test-authoring (Figma URLs split on spaces, commas and new lines), else `null` |
| worktrees, ultracode | on, off (the prototype's Settings → Sessions & worktrees: "Worktree per session: on", "Ultracode by default: off"; M8.2 may read them from Settings) | booleans |
| folder (D14) | the prefill's folder while it is saved, else the default folder (once `GET /api/folders` has answered) | `folder` = the saved folder's id; for a **repo** folder the body is a `NewRepoSession`: `{name, task, folder, solutions: [<repo>], worktrees, ultracode}` (no router fields) |

**Prefill** (M3.3 "Open fix session", `useModals().open('new-session', { prefill })`): the defaults with every valid prefill field on top (invalid values and `coordination: null` are ignored; the name is sanitised like typed input). The dialog also carries the prefill as `data-prefill` (JSON), which `tests/e2e/inbox-system.spec.ts` reads. A prefilled solution the scan does not list shows in an extra row `not found`, selected, so it can be removed; the server decides whether it can start.

## Solution chips
- One row per writable group of `GET /api/solutions`, in the API's order (the scanner sorts by name), folder label = the group's `folder` (`microfrontends/`, `mobile/`, …, `other/`). `other/` is on request only (gap #15); picking it in the form is that explicit request.
- **Read-only row:** one locked chip per read-only top folder, taken from each read-only solution's `relativePath`: `<folder>/*` when the solution sits below it, `<folder>` when the folder is the solution; sorted. So a workspace with `deprecated/microfrontends/old-front` and `infrastructure` shows `deprecated/*` and `infrastructure` (the prototype's chips). Archived repos are never listed by name, so an archived `deprecated/mobile` cannot look like the live `mobile`.
- While the scan is loading no rows are shown; a failed scan shows the Solutions view's message (`No folder is saved yet. Add a workspace or a git repository in Settings.` for `409 no-folder`, D14, or the server's), an empty one `No solutions found in the workspace.`
- D14: the chips are the chosen folder's scan (`GET /api/solutions?folder=<id>`); switching folders clears the picked solutions and reads the new folder's scan (the previous folder's chips never show while it loads). A repo folder shows one row `<repo>/` with the chip `✓ <repo>`, selected, disabled and fixed (`data-fixed`; not the read-only lock). A failed `409 no-folder` scan reads `No folder is saved yet. Add a workspace or a git repository with Browse… above.`

## Summary
The prototype's lines, in the router's terms (D14: the `folder` line is added once the folder is known):
```
# claude code · background · Max
folder    <folder name> · workspace             (D14)
cwd       <workspace root>
work      feature-building | test-authoring (QA)
mode      single-solution | workspace orchestrator
phase     UI-first | integration
stack     web | mobile | both | —            (QA only)
mobile    sequential | parallel-twin | no counterpart   (feature + single + *-front only)
ultracode on | off

# worktrees | # no worktrees · edits in place
../<repo>-wt-<name>                           (one per solution, gap #1, while worktrees are on)
⚠ pick at least one solution                  (no solutions)

✓ answers pre-filled → agent confirms, no re-ask
```
- `cwd` is the folder's path (D14); before the saved folders are known, the workspace root derived from the first scanned solution (`path` minus its `relativePath`, as the Solutions view does), in the OS's form (gap #17); `—` before the scan.
- **Repo folder (D14)** (`repoSummaryLines`):
  ```
  # claude code · background · Max
  folder    <repo> · git repo
  cwd       <repo path> | <parent>/<repo>-wt-<name>   (Worktree on)
  ultracode on | off

  # worktree | # no worktree · edits in place
  ../<repo>-wt-<name>                                  (Worktree on)
  ⚠ a session with this name exists                    (when taken)

  ✓ task + worktree note · no router answers | ✓ task only · no router answers
  ```
- `<repo>` is the solution's last path segment, `<name>` the name that will be sent, so the folders are exactly the ones the worktree manager creates (`../{repo}-wt-{name}` next to the repo).
- Lines the prototype does not have, shown only when they apply (they say why Start is disabled): `⚠ a session with this name exists`, and for QA `⚠ pick the stack under test`, `⚠ add the Confluence page URL`, `⚠ add the Figma frame URLs`.
- Lines do not wrap (`nowrap`, runs of spaces collapse as in the prototype) and end in an ellipsis.

## Start session
For a repo folder (D14) only a free name is needed (the repo is the one solution, no QA contract). Otherwise disabled (45% opacity) when no solution is picked, when the name is taken by a session in `GET /api/sessions` (reloaded on `sessionUpdated`, at most once a second), for QA while the stack, the Confluence URL or the Figma URLs are missing, and while a start is running. A click posts `POST /api/sessions`; on `201` the modal closes and the app opens `/sessions/<id>`. A refusal stays in the modal as one line under the summary: `Not started: ` + the validation messages (`422 {errors:[{field, message}]}`, e.g. a name that is not kebab-case, a read-only solution), the server's `message` (`409` worktree / workspace refusals, `docs/worktrees.md`), or the HTTP status. Editing the form clears it. Cancel, Esc and a click on the overlay close the modal without starting anything.

The server remains the authority: it validates the name (unique, kebab-case), the solutions (not empty, never read-only: 422) and `qa` for QA sessions (`src/server/sessions/validate.ts`); the form's checks only keep the button honest.

## Resume a terminal conversation (D16)
Next to the task (a `↻ Resume a terminal conversation` pill at the right of section 1's label line, out of the flow, so the prototype's layout is unchanged; not while scheduling) the form lists the chosen folder's terminal conversations that are not in Switchboard yet: the `GET /api/history` rows with `terminal: true` whose `folder` is the form's folder, newest first, each with its title (the History name) and `<date> · <first prompt>` (`src/web/modals/resume-conversation.ts`). Picking one:
- replaces the task field with the picked conversation (`↻ <title>`, its date, `×` to type a task again) and closes the list; changing the folder drops the pick;
- hides sections 2–6, "Accept recommended" and the Launch toggles (a moved session has no session-start answers, no worktree and no first message; the toggles' place reads "Continues where the conversation started: no worktree, no first message.");
- the name field's placeholder is the name the service will give it (the title in kebab-case, made unique, `src/core/terminal-move.ts`); a typed name must be kebab-case and free;
- the summary reads:
  ```
  # claude code · background · Max
  folder    <folder> · workspace | git repo
  cwd       <where the conversation started>
  resume    claude --resume <claudeSessionId>
  name      <typed name, else the preview>

  # moves the terminal conversation · no first message
  ⚠ a session with this name exists | ⚠ the name must be kebab-case (a-z, 0-9, single dashes)

  ✓ same conversation · history imported · idle
  ```
- **Start session** calls `POST /api/history/{claudeSessionId}/continue` (`{ name }` when one is typed) instead of `POST /api/sessions`; on `201` the modal closes and the session opens. A terminal that may still have the conversation (409 `terminal-open`) or no saved folder holding it (409 `folder-not-saved`) shows the warning under the summary with **Continue anyway** / **Add <folder> and continue** and Cancel; any other refusal reads `Not moved: <reason>`. The server side is `docs/supervisor.md` → *Continue in Switchboard*.

## First-turn payload (M5.2)
The CLI takes no prompt argument (M0.1), so the task and the answers the developer confirmed in this form go into the session's **first stdin user message**: `{"type":"user","message":{"role":"user","content":<payload>}}`. The agent is told they are confirmed, so it confirms them back instead of asking the router's session-start questions again. If it asks anyway, the question batch reaches the Inbox like any other; Switchboard never answers it for the developer. `--append-system-prompt` is not used (not probed in M0).

Code: `src/core/first-turn.ts` (the text), `src/server/sessions/first-turn.ts` (folders + worktrees), `POST /api/sessions` in `src/server/api/sessions.ts` (passes it as `firstMessage` of `SessionSupervisor.start`).

```
<task text, trimmed>

Session-start answers, confirmed by the developer in Switchboard's new-session form before this session started.
Take them as the answers to the session-start questions: confirm them back in one line instead of asking them again.
- Work type: feature-building | test-authoring (QA)
- Mode: single-solution | workspace orchestrator
- Solutions in scope: <folder>, <folder>
- Phase: UI-first | integration
- Mobile coordination: sequential | parallel-twin | no counterpart      (feature + single-solution + a *-front, when given)
- Stack under test: web | mobile | both                                 (QA only, then:)
- Confluence page: <url> | —
- Figma frames: —
  or
- Figma frames:
  - <url>
  - <url>
- Ultracode: on | off
- Worktrees (one per solution; make every change there, not in the main checkout):
  - <folder>: <absolute worktree path> (branch session/<name>)
  or
- Worktrees: no worktrees · edits in place
```
- The values are the modal summary's terms (`summaryLines`); the labels are the router's session-start questions, so the agent can match each answer to its question. Order per BACKLOG M5.2: work type, mode, solutions, phase, then coordination or the QA contract, ultracode, worktrees.
- **Folders** are workspace-relative and `/`-separated like the Solutions view's `relativePath` (`microfrontends/web-front`, `mobile`): taken from the session's worktree record (its `repoPath`), else from `WorktreeManager.resolveRepo` in the session's folder, else the name as posted (a folder that is not a git repository, or one outside the session's folder). Worktree paths are absolute, in the OS's form (gap #17), exactly the folders M2.2 created (`../{repo}-wt-{name}`, gap #1).
- **Repo folder (D14):** no answers block: the router's session-start questions do not apply to a single repo. Without a worktree the first message is the task alone. With Worktree on, the session runs **in** its worktree and the task is followed by only the worktree note (`repoWorktreeNote` in `src/core/first-turn.ts`):
  ```
  Worktree note from Switchboard: this session runs in a git worktree, not in the main checkout of the repository.
  - Worktree: <absolute worktree path> (branch session/<name>, from <base>); it is your working folder: make every change here.
  - Main checkout: <absolute repo path> (leave it as it is).
  ```
  With an empty task the note waits in the outbox like the answers block; without a worktree nothing waits. The chat hides the note like the answers block (`withoutSessionStartBlock`).
- **Mobile coordination** appears only where the router asks it (feature-building, single-solution, a `*-front` in scope) and only when the body carries a value; the form sends `null` elsewhere. It never appears for QA or orchestrator sessions.
- **QA**: an empty Confluence URL or Figma list shows `—` (the API accepts empty strings; the form does not let them through).
- **Empty task**: the process starts idle (M2.1, no model turn before the developer has defined the task, router *Task definition precedes questions*), and the answers block alone waits in the session's outbox (`pending_messages`, kind `session-start`). It goes out ahead of the developer's first message (or Resume's `Continue.`), separated by a blank line, like the restart note (`docs/supervisor.md` → *Outbox*), and only once.
- The chat's first user event (origin `task`) is the whole payload; `SessionDetail.task` stays the task as typed.
- Scheduled runs (M7.1) start through the same flow (`startNewSession` in `src/server/sessions/start.ts`), so their sessions get the same first message.

## Tests
- `tests/server/api/first-turn.test.ts` (M5.2 oracle, real path): `POST /api/sessions` with fake-claude (`FAKE_CLAUDE_LOG`), temp git repos and the real worktree manager; a feature/single session with worktrees, an orchestrator session and a QA session: the exact argv (no prompt argument), exactly one stdin line equal to `{"type":"user","message":{"role":"user","content":<payload>}}` with the payload equal to `tests/fixtures/first-turn/<case>.txt` (`<workspace>` = the temp root); the empty-task outbox case. `tests/core/first-turn.test.ts`: the block's rules, the folder resolution and the repo-folder note (D14). `tests/server/folders/folders.test.ts`: a repo folder's first message on the real path, with and without a worktree.
- `tests/web/new-session.test.ts`: defaults, prefill, name rules, section visibility, chip groups (read-only folders, shared names, `not found`), summary lines, Start rules, the request body, refusal text; D14: the form's folder, the dropdown's labels, the NewRepoSession body, the repo Start rule and summary.
- `tests/e2e/new-session.spec.ts` (oracle, real path, no demo): fake-claude, fake gh, a fixture workspace with git repos and read-only folders. The form (sections, pills, chips, locked read-only chips, coordination and QA visibility, toggles, summary, a taken name), Start → the posted body, the session view, the stored session, the worktrees on disk and the first message the agent got (M5.2), a 422 shown in the modal, the contract's 422s through the API (read-only paths, duplicate name, no solutions, QA without `qa`), and "Open fix session" → the prefilled form → a started session.
- `tests/e2e/visual/new-session.spec.ts`: the visual oracle against the prototype (`docs/visual/new-session.md`); D14: the sections are compared relative to section 1 and the Folder row and the summary's `folder` line are recorded as additions.
- D14: `tests/e2e/folders.spec.ts` (the Folder row switching chips, a repo folder's form and session in its worktree), `tests/e2e/walkthrough-repo.spec.ts`.
- D16: `tests/web/resume-conversation.test.ts` (entries, name preview and checks, Start rule, summary), `tests/e2e/move-conversations.spec.ts` (Resume a terminal conversation → pick → Start moves it, on the real path), and the visual spec's `D16 …` rows (the pill out of the flow).
