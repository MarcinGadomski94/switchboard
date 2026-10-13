# Plans page (D99, UI lane)

The web UI of Plans (decision D99; the core — storage, scheduler, API, MCP tools, the switch — is described in `docs/plans.md`). Built from the developer's approved clickable mockup. Experimental like Team (D100): everything here renders **only while Settings → Experimental → Plans is on**; while it is off the pages are as they were (the visual specs of the shell, the session panel and Settings pass unchanged). Removal: `docs/plans-removal.md`. Assumptions: `.loop/questions.md` → *D99-UI*.

Code: `src/web/plans/` — `store.ts` (the switch + the plans list, shared), `api.ts` (the calls), `model.ts` (pure rules, `tests/web/plans.test.ts`), `PlansNav.tsx` (nav item, the session's Plan tab), `PlansPage.tsx` (the list), `PlanPage.tsx` (a plan), `PlanGraph.tsx`, `PlanTimeline.tsx`, `PlanDetail.tsx`, `dialogs.tsx`, `import-seam.tsx`, `plans.css`, and the core lane's `PlansSwitchRow.tsx` (Settings → Experimental → Plans).

## The switch

The page reads `GET /api/plans/state` (always answered) once, again after the hub reconnects, on `planChanged` (coalesced, ≤ 4 a second) and after the Settings row changes the switch; only while `enabled && available` does it read `GET /api/plans`. Off: no nav item, no Plan tab, no What's-new entry; `/plans` and `/plans/{id}` show "Plans is off" with a link to Settings → Experimental. A plan the switch paused shows **paused · Plans was switched off** (the core's `pausedReason`) until ▶ Resume.

## Nav, routes, Plan tab

- **Plans** in the sidebar nav after the others (and after Team), with the number of running plans.
- `/plans` lists plans; `/plans/{id}` is a plan's page (`router.tsx`: views `plans`, `plan`).
- The session that created a plan (`sourceSessionId`) gets a **Plan** strip at the top of its right panel: one link per plan with its progress and state. The right panel has no tabs, so this is the "tab" (ASSUMED).

## The Plans page

A card per plan (this machine's first, newest first): title, external key chip, state (`paused · <reason>`, `running · held: <why>`), ⎇ target → base, the merge-mode text, progress ("4/7 done", bar, "~3h left"). **＋ New plan**: the session whose todos the plan runs (open, non-plain-folder sessions of this machine), title, target branch, base (default `dev`), and the session's open todos as checkboxes (`POST /api/plans`, then `POST …/items { todoId }` per ticked todo); it opens the new plan.

### Import from Jira

**Import from Jira…** calls the seam in `import-seam.tsx`: the Jira lane registers an importer (`registerPlanImporter({ id: 'jira', render })`, imported once from `PlansPage.tsx`); its `render({ onImported, onClose })` draws its dialog and `onImported(plan)` opens the draft it made. With none registered the page shows "Import from Jira is coming soon."

## The plan page

**Header:** "Plans ›", the title, the external key chip, `⎇ target → base`, the state; progress "N/M done", a bar and "~3h left" (`estimatedMinutesLeft`; none while an item is blocked). Chips: **merge mode** ("Merge: agents · hold ⚑ 3165" / "Merge: agents" / "Merge: I merge each one" / "Merge mode: not chosen yet"; click → the mode dialog, Start in a draft), **limits** ("3 at once · 85 %"; click → a small dialog, `PUT /api/plans/{id}`), **Critical path on/off** (page-local, on by default). Buttons: ✎ Edit dependencies (draft, running, paused; not on phones), ⏸ Pause / ▶ Resume, ▶ Start plan (draft with items). A paired machine's plan is read-only here. While new starts are held (usage) a line says why.

**Tabs:** Graph (default), Timeline, List. The **detail** of the selected item sits under every view.

### Graph

Left to right; layers by the **longest path** (an item one layer right of its furthest dependency), a layer ordered by the mean row of its dependencies (one barycentre pass), ties by plan order (`graphLayout`; no layout dependency). Cards 190 × 86 px, 48 px between layers: a 3 px coloured left border by state, the state icon, key, "⚑ you" on hold items, title, the status line, a mono "repo · ~estimate".

| State | Icon | Colour | Status line |
|---|---|---|---|
| waiting | ○ | `--status-idle` #5a5955 | waiting on 3157, 3160 |
| ready | ◌ | `--muted-1` #a9a8a3 | ready |
| running | ● | `--status-run` | running (· checks) |
| question | ? | `--status-need` | needs your answer |
| in review | ◐ | `oklch(0.75 0.12 310)` | in review |
| done | ✔ | `--status-done` | done · merged |
| blocked | ✖ | `--status-fail` | blocked (the reason in the detail) |

Keys shorten to their number when every keyed item shares one project prefix (`PROJ-3157` → `3157`), as the design shows. Edges are SVG cubic curves with arrowheads; the **critical path** (`criticalPath.itemIds` of the core) is amber with 2 px edges and dashed card outlines; every item without dependents leads (dashed) into the final dashed **◇ "target → base · yours"** node. The legend sits under the graph. On a tablet the graph scrolls sideways inside its box.

**Edit dependencies:** a hint line "Click the ticket that must finish first." → "Now click the ticket that depends on X…"; the second click adds "Y after X" (`POST …/edges`). A loop is refused before anything is sent (and on the server's 409 `cycle`) with the toast "Refused: X already waits on Y — that would be a loop". A click on an existing edge removes it. **＋ Add items from todos** picks the source session's open todos not in the plan.

### Timeline

One bar per item, grouped by repository (its first solution, else the plan's one repo, else "all repos"), on a time axis from the plan's start to the last projected end, a **now** line across. Segments: agent working (run blue, from `startedAt`), waiting on you (amber, from `waitingSince` of a question / review / conflict), waiting on a dependency (hatched grey, before it starts), paused for usage (red 60 %, a ready item while the plan is held), projected (dashed: each open item after its dependencies' projected ends, for its estimate, or what is left of it). Summary: "Waiting on you: 8.6 h of 24 · longest: 3165 review (3 h) · Projected finish: tomorrow 07:30". The core keeps no history of earlier waits, so only each item's current wait on you is known (ASSUMED; no additive history read was added — see the questions file).

### List

Compact rows (state icon, key, title, status, repo · estimate) with an inline **Answer** (selects the item: its question card is in the detail) or **Merge** (the item's Review card's merge). It is the phone's layout.

### Detail

The state icon, key, title, status; its worktree branch, **Open session**, **Jira ↗** (only when the plan's external ref carries a `baseUrl` / `url`; the core's ref has only `system` and `key` today), **PR ↗**, and **⚑ I merge this one** (`PUT …/holds`). Then by state: the real **QuestionCard** with **Reply…** (or a permission request's actions), **Merge / Send back / Open diff** (the Review card's actions; Send back asks for a comment), the reason on a red rule (with **Retry** for a failed item), the agent's latest message (running), "Starts by itself when X and Y are done." (waiting), "Merged into <target> · checks ✔" (done).

### The merge-mode dialog

"How should finished tickets be merged into the epic branch?" / "You have to choose — there is no default. You can change it while the plan runs." Three options — **Agents merge**, **Agents merge, with hold points** (tagged *recommended*, with a hold checkbox per open item, pre-ticked from the items' `hold`), **I merge each one** — none pre-selected; Start stays disabled until one is chosen. Footer: "Always on: agents merge only into <target> — never dev or master · checks must be green · a second conflict comes to your Inbox." The same dialog changes the mode of a started plan (**Apply**, `PUT …/mode`, holds first).

## Responsive

Desktop (≥ 1280): as above. Tablet: the same, padding 16 px, the graph scrolls sideways. Phone (≤ 767): the List only (no tabs, no dependency editing), a tap opens the detail full screen with "‹ <plan>"; dialogs are full-screen sheets; no sideways page overflow.

## What's new

`plans` (1.18.0, D99): three steps (the nav item; ＋ New plan; Import from Jira, on the Jira dialog's epic field `jira-epic`, else the Plans list's Import button `plans-import`). It is offered and listed only while Plans is on (`TourHost.tsx`, `TutorialSection.tsx` filter it); while off it stays pending and shows the first time the page loads with Plans on.

## Tests

- `tests/web/plans.test.ts`: state look, status lines, chips, graph layers (longest path, barycentre order), critical path edges, loop refusal texts, timeline segments and summary.
- `tests/e2e/plans.spec.ts` (real path, fake claude / temp git / fake gh): off by default; create from todos; a dependency and a refused loop; Start needs a merge mode; a question answered in the detail; running → review → merged → the dependent starts; pause / resume; the timeline; the phone list; the session's Plan tab; the What's-new entry; switched off → paused with the reason.
- `tests/e2e/visual/plans.spec.ts`: a plan in every state at desktop / tablet / phone; screenshots and `docs/visual/plans.md`.
