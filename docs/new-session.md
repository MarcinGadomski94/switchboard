# New-session modal (M5.1)

The form behind "+ New session" (SPEC → Modals → New session; prototype `mNew` with its `ns` state, `pills`, `nsGroups`, `nsSummary`, `canLaunch`, `nsLaunch`). Code: `src/web/modals/NewSessionModal.tsx` (the component), `src/web/modals/new-session.ts` (pure logic: defaults, prefill, chips, summary, Start rules, request body, refusal text), `src/web/modals/new-session.css` (the prototype's inline styles as classes over the SPEC tokens). The server side (`POST /api/sessions`: validation, worktrees, start) is M2.1 / M2.2 / M6.1 (`docs/supervisor.md`, `docs/worktrees.md`, `docs/solutions.md` → *Read-only sessions*); M5.1 adds no route. The first stdin message built from the answers is M5.2; the Schedule section (D8) is M7.1.

## Layout
1080px, `1fr | 360px` (`.sb-modal-new` in `modals.css`). Left, in order:
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

**Prefill** (M3.3 "Open fix session", `useModals().open('new-session', { prefill })`): the defaults with every valid prefill field on top (invalid values and `coordination: null` are ignored; the name is sanitised like typed input). The dialog also carries the prefill as `data-prefill` (JSON), which `tests/e2e/inbox-system.spec.ts` reads. A prefilled solution the scan does not list shows in an extra row `not found`, selected, so it can be removed; the server decides whether it can start.

## Solution chips
- One row per writable group of `GET /api/solutions`, in the API's order (the scanner sorts by name), folder label = the group's `folder` (`microfrontends/`, `mobile/`, …, `other/`). `other/` is on request only (gap #15); picking it in the form is that explicit request.
- **Read-only row:** one locked chip per read-only top folder, taken from each read-only solution's `relativePath`: `<folder>/*` when the solution sits below it, `<folder>` when the folder is the solution; sorted. So a workspace with `deprecated/microfrontends/old-front` and `infrastructure` shows `deprecated/*` and `infrastructure` (the prototype's chips). Archived repos are never listed by name, so an archived `deprecated/mobile` cannot look like the live `mobile`.
- While the scan is loading no rows are shown; a failed scan shows the Solutions view's message (`No workspace root is configured (SWITCHBOARD_WORKSPACE_ROOT).` or the server's), an empty one `No solutions found in the workspace.`

## Summary
The prototype's lines, in the router's terms:
```
# claude code · background · Max
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
- `cwd` is the workspace root derived from the first scanned solution (`path` minus its `relativePath`, as the Solutions view does), in the OS's form (gap #17); `—` before the scan.
- `<repo>` is the solution's last path segment, `<name>` the name that will be sent, so the folders are exactly the ones the worktree manager creates (`../{repo}-wt-{name}` next to the repo).
- Lines the prototype does not have, shown only when they apply (they say why Start is disabled): `⚠ a session with this name exists`, and for QA `⚠ pick the stack under test`, `⚠ add the Confluence page URL`, `⚠ add the Figma frame URLs`.
- Lines do not wrap (`nowrap`, runs of spaces collapse as in the prototype) and end in an ellipsis.

## Start session
Disabled (45% opacity) when no solution is picked, when the name is taken by a session in `GET /api/sessions` (reloaded on `sessionUpdated`, at most once a second), for QA while the stack, the Confluence URL or the Figma URLs are missing, and while a start is running. A click posts `POST /api/sessions`; on `201` the modal closes and the app opens `/sessions/<id>`. A refusal stays in the modal as one line under the summary: `Not started: ` + the validation messages (`422 {errors:[{field, message}]}`, e.g. a name that is not kebab-case, a read-only solution), the server's `message` (`409` worktree / workspace refusals, `docs/worktrees.md`), or the HTTP status. Editing the form clears it. Cancel, Esc and a click on the overlay close the modal without starting anything.

The server remains the authority: it validates the name (unique, kebab-case), the solutions (not empty, never read-only: 422) and `qa` for QA sessions (`src/server/sessions/validate.ts`); the form's checks only keep the button honest.

## Tests
- `tests/web/new-session.test.ts`: defaults, prefill, name rules, section visibility, chip groups (read-only folders, shared names, `not found`), summary lines, Start rules, the request body, refusal text.
- `tests/e2e/new-session.spec.ts` (oracle, real path, no demo): fake-claude, fake gh, a fixture workspace with git repos and read-only folders. The form (sections, pills, chips, locked read-only chips, coordination and QA visibility, toggles, summary, a taken name), Start → the posted body, the session view, the stored session and the worktrees on disk, a 422 shown in the modal, the contract's 422s through the API (read-only paths, duplicate name, no solutions, QA without `qa`), and "Open fix session" → the prefilled form → a started session.
- `tests/e2e/visual/new-session.spec.ts`: the visual oracle against the prototype (`docs/visual/new-session.md`).
