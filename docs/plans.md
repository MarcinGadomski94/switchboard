# Plans (D99)

A **plan** groups todo items of one session (D68) into a dependency graph ("B after A") and runs them by itself: a scheduler starts every ready item as a todo run (D76) in its own session and worktree, cut from the plan's **target branch** (the epic's feature branch), keeps at most *N* running at once, and moves an item to done once its work is merged into the target under the plan's **merge mode**. When every item is done, the Inbox says "Plan ready: `<target>` → `<base>`" and the developer merges the epic.

Plans is **experimental**: switchable and revertible like Team (D100). Contract → *Plans (D99)* in `docs/handoff/contracts/local-api.md`; the Plans page (web UI) → `docs/plans-ui.md`; removal → `docs/plans-removal.md`; decision → D99 in `docs/decisions.md`; assumptions → `.loop/questions.md` → *D99*.

## The switch

Settings → Experimental → **Plans** (`experimental.plans`), **off by default**, next to Team.

- **Off:** every plan route answers 404 `plans-off` except `GET /api/plans/state` (the switch); the scheduler does not listen to the hub, polls no PR checks and runs no timer; `plans.db` is not opened (on an install that never switched Plans on it does not exist); the `switchboard` MCP helper registers no plan tools. Nothing runs in the background.
- **On:** `<dataDir>/plans.db` is opened (created on first use), the plans whose source session is gone are deleted, the running ones resume (their items' sessions are followed again; work merged meanwhile is picked up), and the plan tools appear in sessions whose helper starts from then on.
- **Switched off while plans run:** every running plan is **paused** with the reason "Plans was switched off" (`pausedReason`, also shown as `held`). Running items are not stopped: their sessions finish their current turn; nothing new starts and nothing is merged or followed. The file is closed and stays on disk.
- **Switched on again:** those plans show **paused** with the reason; the developer resumes each one (`POST /api/plans/{id}/resume`), which clears the reason and starts ready items again.
- **A broken `plans.db`** (not a database, a failed migration) breaks nothing else: `GET /api/plans/state` reports `{ enabled: true, available: false, problem }`, the plan routes answer 503 `plans-unavailable`, the scheduler does not run, the plan tools are not registered, and every other route works.
- Demo mode never starts Plans (it answers "off").

## Storage

Everything of Plans is in its own SQLite file, `<dataDir>/plans.db`, with its own migration list (`src/server/plans/db.ts`, `PLANS_MIGRATIONS`) run by the main database's runner (`db/migrate.ts`, the one Team's `team.db` uses). No migration in `switchboard.db` (the earlier, never released `0043_plans.sql` was removed).

Tables: `plans` (title, source session, target / base branch, repos, merge mode, concurrency, usage threshold, start answers, state, external ref, `held_reason`, `paused_reason`), `plan_items` (todo id, key, hold, solutions, stored state, reason, note, waiting-on, run session, branch, the target tip it was cut from, PR url, checks, conflict count, timeline) and `plan_edges`. Items and edges go with their plan. Session ids are plain text (no foreign key across files): the service deletes a plan whose source session no longer exists (at activation and at every scheduling cycle).

## A plan

- Made from a session (`sourceSessionId`) whose folder is a git repository (a repo folder, or a workspace's solution repos); a plain folder is refused (409 `not-a-repo`).
- **Target branch** required, never equal to the base. **Base branch** default `dev`. **Repos**: a workspace's solution names (default the session's); a repo folder's one repo.
- **Max concurrency** 1–16 (default 3); **usage threshold** 1–100 % (default 85).
- **Start answers** (`answers`: work type, mode, phase, coordination, notes) default to the source session's; a workspace item's run is a Full start with them (D76-workspace); `notes` are added to every item's brief.
- **External** `{ system: 'jira', key }`: stored and shown only (the Jira lane fills it).
- States: `draft` → `running` ⇄ `paused` → `done` | `cancelled`. Delete is refused while running.

## Items and dependencies

- An item is an existing todo of the source session (`todoId`), or a new todo added to its list (`todo: { title, description, plan, priority, estimateMinutes }`). A done or in-review todo cannot be planned. At most 100 items.
- Optional ticket **key** (`PROJ-123`): the run branch becomes `PROJ-123-<slug>` (else `todo/<slug>`, D76's form; `-2`, `-3`, … when taken).
- **Hold** (agents-with-holds: the developer merges this one), **solutions** (a subset of the plan's repos), **after** (ids or keys it runs after).
- A dependency that would close a **cycle** is refused (409 `cycle`, naming the loop).
- View states: `waiting`, `ready`, `running`, `question` (its session waits in the Inbox), `review` (waits for the developer's Merge), `done`, `blocked` (failed, discarded, could not start, its session stopped with an error, a second conflict; and every dependent of a blocked item, with the reason "waiting on PROJ-12, which was discarded"). The view also carries the critical path, progress and the estimated time left.

## Merge modes (required at start, no default)

`POST /api/plans/{id}/start` requires `mergeMode` (422 `merge-mode-required`); the UI pre-selects `agents-with-holds` as the recommendation, the server never picks one. The `plan_start` tool's description tells the agent to ASK the developer and never choose.

- `agents`: each item's agent opens a PR into the target and merges it once its checks are green.
- `agents-with-holds`: the same, except held items wait for the developer's Merge on their Review card (D79).
- `developer`: every item waits for the developer's Merge.

The mode can change while a plan runs (`PUT /api/plans/{id}/mode`), as can holds (`PUT /api/plans/{id}/holds`); running items whose rule changed are told their new rule.

## Safeguards

- **Agents merge only into the target branch.** An agent mode is refused (422 `target-forbidden`) when the target is `dev`, `develop`, `master`, `main`, the repo's default branch or a protected branch (gh, best effort); the brief says never to merge anywhere else. Developer mode may target any branch.
- **Green checks first.** In agent modes an item is done when its work is merged into the target and its PR's checks are green or absent (gh `statusCheckRollup`). Without a remote or gh, merged into the local target counts, with a note.
- **Red checks go back to the session**: once per head and failure, the session gets a message; the item stays running and its dependents wait.
- **Conflicts**: the first conflict with the target asks the agent to rebase; a **second** becomes an Inbox item for the developer and the item shows blocked.
- **Failed / discarded / blocked items block their dependents** with a reason. Retry (`POST …/items/{itemId}/retry`) puts a failed item back; Mark done (`…/done`) counts it as done.
- **Usage**: no new item starts while the account it would use (D82 routing, then D63's pick; D98's merged readings) is at or above the threshold of its 5-hour or weekly window, or spent; `held` says why. Running items go on.

## Item runs

An item's run is D76's todo run with the plan's overrides (`TodoRunOverrides` in `src/server/todos/run.ts`): the branch above, cut from the target's tip in each repo it works in (the target is created locally from the base when missing, never pushed), the plan's start answers, and a brief: the todo, its plan / acceptance criteria, the notes, then "commit, push, open a PR into the target, merge rule, mark the todo done".

The scheduler is event driven (run sessions' status, review resolutions, todo changes, usage updates), polls the checks of items waiting on them (60 s), and reads git / gh only for items whose session changed. On restart it resumes the running plans.

## Agents (MCP tools)

While Plans is on, the `switchboard` MCP helper (`src/hook/sb-plan-tools.ts`) adds `plan_create`, `plan_add_item`, `plan_add_dependency`, `plan_status`, `plan_start` (the helper asks `GET /agent/v1/plans` once at its start; 200 = on). They act only on plans whose source is the agent's own session. The helper's server instructions never name them (they exist only while on).

## Seam for an external list (Jira)

`PlanService.createFromExternal({ sourceSessionId, title, targetBranch, external, items: [{ ref, key, title, … }], edges: [{ from, to }] })` makes one draft plan: every item becomes a new todo and a plan item; edges name items by `ref`; everything is checked (unknown refs, a cycle) before anything is written. `PlanService.findByExternal(system, key)` finds the plans made from a list. Both need Plans on (404 / 503 otherwise). In the web UI, **Import from Jira…** on the Plans list calls the UI seam `registerPlanImporter` (`src/web/plans/import-seam.tsx`, `docs/plans-ui.md` → *Import from Jira*).

## Team interplay (D100)

Team hand-offs are todos (D68) and keep working with Plans off; Team never calls Plans. `TeamHandoff.planRef` is stored text only. Any future Team → Plans use must check both switches (Plans' calls already refuse with 404 `plans-off` while Plans is off).

## Phones and paired machines

Devices (D73) may use every plan route (a start is ▸ Run in new session many times; the safeguards hold on any device), including `GET /api/plans/state`. Paired machines (D48) read and act on each other's plans through the peer API (a plan id `r~<machine>~<id>`); a machine with Plans off answers 404 and its plans are simply not listed. `planChanged` is forwarded between peers.
