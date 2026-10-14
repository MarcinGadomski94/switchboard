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
- Demo mode never starts Plans (it answers "off"), except the README screenshot run (`SWITCHBOARD_DEMO_EXTRAS=1`, `docs/demo.md` → *Screenshot extras*).

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

- An item is an existing todo of the source session (`todoId`), or a new todo added to its list (`todo: { title, description, plan, priority, estimateMinutes }`). A done todo cannot be planned. At most 100 items.
- Optional ticket **key** (`PROJ-123`): the run branch becomes `PROJ-123-<slug>` (else `todo/<slug>`, D76's form; `-2`, `-3`, … when taken).
- **Hold** (agents-with-holds: the developer merges this one), **solutions** (a subset of the plan's repos), **after** (ids or keys it runs after).
- A dependency that would close a **cycle** is refused (409 `cycle`, naming the loop).
- View states: `waiting`, `ready`, `running`, `question` (its session waits in the Inbox), `ready-to-merge` (D102: its run finished and it waits for the developer's Merge, "Waiting for your merge"; see *Merge step*), `done`, `blocked` (failed, discarded, could not start, its session stopped with an error, a second conflict; and every dependent of a blocked item, with the reason "waiting on PROJ-12, which was discarded"). The view also carries the critical path, progress and the estimated time left.

## Item history (the Timeline)

Each item keeps its history as **spans** (`plan_item_spans` in `plans.db`, migration 2): `running` (its agent works, also while its PR's checks run), `waiting-you` (a question, waiting for your merge, a second conflict or a stopped session), `waiting-dependency` (an item it runs after is not done or is blocked), `paused-usage` (ready, but the usage threshold holds new starts) and `paused-plan` (the plan is paused, by the developer or because Plans was switched off). Every plan change publishes `planChanged`, and with it the service compares each item's kind now with its open span: a changed kind closes the open span and opens the new one (at most one open per item). A draft has none; a done, failed or about-to-start item has none open; a finished or cancelled plan has every span closed. At activation (a restart, Plans switched on) every plan is brought up to date the same way, so nothing doubles up. While Plans is off nothing changes: open spans stay open (the time off counts in them). `GET /api/plans/{id}` answers each item's newest 200 spans, oldest first (`PlanItem.spans`); "Waiting on you: X h" is the sum of its `waiting-you` spans.

## Merge modes (required at start, no default)

`POST /api/plans/{id}/start` requires `mergeMode` (422 `merge-mode-required`); the UI pre-selects `agents-with-holds` as the recommendation, the server never picks one. The `plan_start` tool's description tells the agent to ASK the developer and never choose.

- `agents`: each item's agent opens a PR into the target and merges it once its checks are green.
- `agents-with-holds`: the same, except held items wait for the developer's Merge (*Merge step* below).
- `developer`: every item waits for the developer's Merge (*Merge step* below).

The mode can change while a plan runs (`PUT /api/plans/{id}/mode`), as can holds (`PUT /api/plans/{id}/holds`); running items whose rule changed are told their new rule.

## Safeguards

- **Agents merge only into the target branch.** An agent mode is refused (422 `target-forbidden`) when the target is `dev`, `develop`, `master`, `main`, the repo's default branch or a protected branch (gh, best effort); the brief says never to merge anywhere else. Developer mode may target any branch.
- **Green checks first.** In agent modes an item is done when its work is merged into the target and its PR's checks are green or absent (gh `statusCheckRollup`). Without a remote or gh, merged into the local target counts, with a note.
- **Red checks go back to the session**: once per head and failure, the session gets a message; the item stays running and its dependents wait. D109: the PRs are read through the shared PR watcher (`docs/ci.md` → *Plans*); while *Send CI failures to the session* is on, the watcher sends the failure with the failing job's log (at most `ci.maxAttempts` per PR) instead of Plans' own message, and it raises no "PR #n ready to merge" for a running item's session (Plans' Merge step stays).
- **Conflicts**: the first conflict with the target asks the agent to rebase; a **second** becomes an Inbox item for the developer and the item shows blocked.
- **Failed / discarded / blocked items block their dependents** with a reason. Retry (`POST …/items/{itemId}/retry`) puts a failed item back; Mark done (`…/done`) counts it as done.
- **Usage**: no new item starts while the account it would use (D82 routing, then D63's pick; D98's merged readings) is at or above the threshold of its 5-hour or weekly window, or spent; `held` says why. Running items go on.

## Item runs

An item's run is D76's todo run with the plan's overrides (`TodoRunOverrides` in `src/server/todos/run.ts`): the branch above, cut from the target's tip in each repo it works in (the target is created locally from the base when missing, never pushed), the plan's start answers, and a brief: the todo, its plan / acceptance criteria, the notes, then "commit, push, open a PR into the target, merge rule, mark the todo done".

The scheduler is event driven (run sessions' status, todo changes, usage updates), polls the checks of items waiting on them (60 s), and reads git / gh only for items whose session changed. On restart it resumes the running plans.

## Merge step (D102)

Until D102 the developer's Merge was the run session's Review card (D79); review cards were removed, so Plans has its own step. It applies to the items the developer merges: every item in `developer` mode, the held ones in `agents-with-holds`.

- **Ready:** an item's run is finished when its todo is done (the brief's last step, the agent's `todo_done`) and its session's turn is over, or when every pull request of its branch is open with green (or no) checks while its session is idle. The item then waits on `merge` (`waitingOn: 'merge'`, view state **`ready-to-merge`**, "Waiting for your merge", violet; stored as `waiting_on = 'review'`, the value `plans.db`'s migration 1 CHECK allows) until it is merged or sent back. Its time counts as `waiting-you`.
- **Inbox:** becoming ready raises a system item **"Ready to merge: <item> (<plan>)"** (kind `plan-ready-to-merge`, source `plans`, on the item's run session; actions **Merge** and **Open plan**; `InboxItem.route` = `/plans/<id>`). **Merge** runs the plan's Merge (refusals answer 409 with the reason; the item stays open); **Open plan** only navigates (the item stays open). It is closed when the item is merged (here or by the agent), sent back, or fails. A paired machine's item names its plan by its remote id.
- **Merge** (`POST /api/plans/{id}/items/{itemId}/merge`): the item's branch in every repo it worked in (its run session's worktrees on that branch) is merged into the plan's target **locally, never pushed, never forced**. Every repo is checked before any is merged (`src/server/worktrees/branch-merge.ts`, `BranchMergeGit`, moved from the old review cards' `ReviewGit`): refused 409 `uncommitted` (the worktree has uncommitted changes: they would not be merged), `target-dirty` (the target is checked out somewhere with uncommitted tracked changes), `conflicts` with `conflicts: [files]` (`git merge-tree --write-tree`, no working tree touched), `target-missing`, `no-branch`; also `not-ready` (not waiting for your merge), `busy` (its session's turn runs, or another action on the item runs), `finished` (the plan is done / cancelled). Then where the target is checked out `git merge --no-edit <branch>` runs there (hooks run; a failure is aborted), else the target ref moves with `git update-ref` (a fast-forward, or a merge commit `Merge branch '<branch>' into <target>` from the conflict-free tree); a target that exists only as `origin/<target>` is created locally. The item is done (`note`: "merged by you into <target>"), its todo done, its dependents may start. The developer's Merge is the developer's choice: it is not limited to agent-safe targets.
- **Open PR** (`…/open-pr`): `git push -u origin <branch>` (never forced; 409 `no-remote` without an `origin`), then an open PR of the branch is reused or `gh pr create --base <target>` opens one; its URL is the item's `prUrl`. The item stays ready.
- **Send back** (`…/send-back`, `{ comment }`, 1–4,000 characters, else 422): the comment goes to the item's session ("Plans: your work on "<item>" was sent back with this comment: …"; the normal message path), its todo goes back in progress, the item runs again (ready again when its run finishes once more: a new Inbox item).
- **Open diff**: the run session's Diff tab (UI only).
- **The agent merged it itself** (against the rule): the next look at git (a turn end, the poll) finds the branch merged into the target (`git merge-base --is-ancestor`, or its PR merged) and the item is done with the note "merged into <target> without your Merge". In agent modes this is how every item is done (unchanged).
- Phones may Merge, Open PR and Send back (as on the cards before); a paired machine's plan item is acted on there through the peer API.

## Continue in a fresh session (D83)

When a plan's source session is continued in a fresh session, the plan follows it: its source becomes the fresh session (`plansFollowContinuation`, called by `POST /api/sessions/{id}/fresh` right after the todos, loops and worktrees move). The todos move with their ids, so every item keeps its todo and pending items still start (their runs are cut from the fresh session). An item whose **run** session is continued is run by the fresh session from then on. While Plans is off (or `plans.db` is broken) the hook does nothing and nothing is recorded: when Plans is switched on, the service follows the sessions' own links (`continuedTo`, or the fresh session's `continuedFrom` when the old one was deleted, along the whole chain) for every source and run session before anything else, and does the same at every scheduling cycle.

## Agents (MCP tools)

While Plans is on, the `switchboard` MCP helper (`src/hook/sb-plan-tools.ts`) adds `plan_create`, `plan_add_item`, `plan_add_dependency`, `plan_status`, `plan_start` (the helper asks `GET /agent/v1/plans` once at its start; 200 = on). They act only on plans whose source is the agent's own session. The helper's server instructions never name them (they exist only while on).

## Seam for an external list (Jira)

`PlanService.createFromExternal({ sourceSessionId, title, targetBranch, external, items: [{ ref, key, title, … }], edges: [{ from, to }] })` makes one draft plan: every item becomes a new todo and a plan item; edges name items by `ref`; everything is checked (unknown refs, a cycle) before anything is written. `PlanService.findByExternal(system, key)` finds the plans made from a list. Both need Plans on (404 / 503 otherwise). The Jira lane uses it: *Jira import and status sync* below. In the web UI, **Import from Jira…** (the Plans list, a session's Plan strip) opens the Jira lane's `ImportJiraDialog` (`docs/plans-ui.md` → *Import from Jira*).

## Team interplay (D100)

Team hand-offs are todos (D68) and keep working with Plans off; Team never calls Plans. D102: a plan's "Ready to merge" Inbox item of a member's session shows in Team's Needs you (it is an Inbox item of that session). `TeamHandoff.planRef` is stored text only. Any future Team → Plans use must check both switches (Plans' calls already refuse with 404 `plans-off` while Plans is off).

## Phones and paired machines

Devices (D73) may use every plan route (a start is ▸ Run in new session many times; the safeguards hold on any device), including `GET /api/plans/state`. Paired machines (D48) read and act on each other's plans through the peer API (a plan id `r~<machine>~<id>`); a machine with Plans off answers 404 and its plans are simply not listed. `planChanged` is forwarded between peers.

## Jira import and status sync

A plan can be made from a Jira epic: its child issues become the items, their "blocks / is blocked by" links the dependencies. Optionally, Switchboard keeps the tickets in step with the plan. Code: `src/server/plans/jira/` (client, credentials, store, service, routes, `install.ts`), `src/core/plans-jira.ts` (shapes and pure rules), `src/web/plans/jira/` (the dialog, a plan's Jira section, the credentials form). Contract → *Plans · Jira (D99)*. Like the rest of Plans it is experimental: every route answers 404 `plans-off` and nothing reads or writes Jira while Plans is off.

### Import

1. **Import from Jira…** (the Plans page mounts `ImportJiraDialog`): paste an epic key (`PROJ-10`) or its link (`…/browse/PROJ-10`, `…?selectedIssue=PROJ-10`).
2. **Preview** reads, and creates nothing:
   - the epic (`GET /rest/api/3/issue/{key}`) and its children (`GET /rest/api/3/search/jql`, `parent = PROJ-10`, at most 100; more are reported as cut);
   - per child: summary, description, acceptance criteria, components, status, assignee, original estimate. Acceptance criteria come from a custom field named "Acceptance criteria" (found through `GET /rest/api/3/field`, any case) or else from a description section with that heading (an ADF heading, or a line "Acceptance criteria:"; the section runs to the next heading of the same or a higher level);
   - **dependencies**: every `Blocks` link between two children ("PROJ-12 waits on PROJ-11"); both sides of a link are read and deduplicated; other link types are ignored;
   - **outside links**: a `Blocks` link to an issue outside the epic is a note ("PROJ-15 waits on PROJ-99 (outside the epic)"), never a dependency;
   - **cycles**: links are taken in ticket order (by the waiting issue, then the one it waits on); a link that would close a cycle is left out and named with the cycle ("PROJ-14 waits on PROJ-13 was left out: PROJ-13 → PROJ-14 → PROJ-13 would be a cycle"). The plan core refuses cycles, so nothing cyclic is ever sent to it;
   - items without any dependency inside the epic are flagged ("no links").
3. **Create plan** reads the epic again (the server never trusts a preview the page held) and calls the core's seam `PlanService.createFromExternal` with:
   - one item per child: `ref` and `key` = the issue key, title "KEY Summary", the todo's description = the ticket's description, then "Acceptance criteria:" with them, then a line with the ticket's link, components and assignee (cut to the todo's 4,000 characters, the acceptance criteria kept first), the estimate in minutes, **no solutions** (the components are shown as a hint; the developer picks the solutions on the plan);
   - the preview's dependencies;
   - `external: { system: 'jira', key: <epic> }`;
   - the title, target branch, base branch and repos from the dialog (title and target pre-filled: "PROJ-10 Acme checkout", `feature/PROJ-10-acme-checkout`).

   The plan is a **draft**; its merge mode is chosen at Start (the core requires it). A failure of the core (no target branch, a forbidden branch, too many items) creates nothing.

### Proposed order (ruling D99-Jira-q1 (b))

The missing order is proposed on the plan, not in the dialog:

- **Asking.** After an import whose epic has items without links (`askedForOrder: true` in the answer), and on **Propose order** for any draft plan (`POST /api/plans/{id}/proposals/ask`), Switchboard sends the plan's **source session** a message the normal way (queued while it works; a hooked session's mailbox): the plan, its items with the unlinked ones marked, its dependencies, and the ask to call `plan_propose_dependencies` once. A failed ask after an import is a line of the plan's Jira activity; the import still succeeds.
- **The tool.** `plan_propose_dependencies { plan_id, proposals: [{ from, to, reason }] }` (from = the item that goes first, to = the one that waits; keys or item ids; at most 50) is registered with the other plan tools, only while Plans is on, and only for the plan's own source session. Its description says these are proposals for the developer, not changes. Skipped, with the reason: an unknown item, the same item twice, a dependency the plan has, a pair proposed before.
- **Deciding.** Proposals live in `plans.db` (`plan_edge_proposals`), `pending` / `accepted` / `rejected`. **Accept** adds the dependency through the core's edge API, so a cycle is refused there: the proposal stays pending with the reason (`note`), and a single Accept answers 409 `cycle`. **Reject** records it. Accept all / Reject all act on every pending one. Each decision publishes `planChanged`.
- **UI.** `PlanEdgeProposals { planId }` (the page mounts it on the plan): rows "PROJ-15 should wait on PROJ-14 — <reason>" with ✓ / ✕ and Accept all; nothing when no proposal is pending. Phones may accept and reject; a paired machine's plan is decided on its machine.

### Status sync

A per-plan setting, chosen in the dialog (default **off**) and changeable on the plan (`PlanJiraPanel`, `PUT /api/plans/{id}/jira`):

- **off**: nothing is read or written after the import.
- **read-only**: the tickets are read again (title, status, description, with the import's fields) on **Refresh now** and every 30 minutes while the plan runs. A still-pending item's todo takes the new title and description (an item that started keeps its brief). Each item shows a **drift note** when Jira says Done and the item is not done, still says To Do (category `new`) while the item's run works, or its status changed since the import.
- **write**: read-only, plus, as the plan's items move (followed through `planChanged`, while the plan runs, is paused or just finished):
  - the item's run starts → the **In Progress** transition;
  - its pull request opens → the **In Review** transition and a comment "Pull request opened: <url>";
  - it waits on a developer question → a comment (one per question episode: it is in `question` again after it left);
  - it is merged into the target → a comment "Merged into <target>." **Never Done**: the team's own process moves the ticket there. An item the developer marks done gets no comment.

  The transition names are per plan (defaults "In Progress", "In Review") and resolved through the issue's available transitions (`GET …/transitions`) by the transition's name or its target status' name, case-insensitive. An issue already in that status is left alone. **A missing transition is a soft failure**: noted on the item (`syncNote`) and in the activity, never retried, never blocking.

**Idempotent writes.** Each write is one event per item (`start:<run>`, `pr-transition:<url>`, `pr-comment:<url>`, `question:<n>`, `merged`) recorded in `plan_jira_writes`: done or soft once, never again. A comment ends with a marker `[switchboard:<plan>:<item>:<event>]`; before posting, the issue's comments are read and a comment with that marker counts as posted (a retry after a lost answer adds no second one). A failed write (network, 5xx, 401) stays pending and is retried at the next `planChanged` or refresh, at most 5 times; a deleted issue is given up at once. Every write, soft failure, give-up, refresh and settings change is a line of the plan's **Jira activity** (`GET /api/plans/{id}/jira`, newest 200).

### Credentials

Jira Cloud REST API v3 with basic auth (the account's email and an API token): from **Settings → Experimental → Plans → Jira connection** (ruling D99-Jira-q3: `JiraCredentialsForm`, part of the Plans row and shown only while Plans is on; stored as one value in the OS keychain through the Team access lane's `SecretStore`, item "Switchboard Jira" / "default"), else from the environment `ATL_BASE_URL`, `ATL_USER`, `ATL_TOKEN`. Settings win when both are set. Requests go only to that base URL (`https://`, or `http://` on loopback for the tests' fake); redirects are refused. See `docs/security.md` → *Jira credentials (D99)*.

### Storage

Plans' `plans.db` (its own connection, opened on first use while Plans is on and closed when it is seen off), tables created when missing (`CREATE TABLE IF NOT EXISTS`, outside the core's migration list): `plan_jira` (epic, base URL, sync, transition names, last refresh), `plan_jira_items` (issue key, status at import and as last read, drift, last soft failure, question episodes), `plan_jira_writes`, `plan_jira_activity`, and `plan_edge_proposals` (the proposed order, for any plan). No secret. A deleted plan's rows go with its `planChanged` (`state: null`).

### Machines and devices

Import and sync run on the machine that owns the plan (the source session's machine): a remote session or plan id is forwarded by the peers' proxy and answered there with that machine's credentials. The token never travels: the credential routes are refused to peers and phones. Phones may preview, import and change a plan's sync (D73 ruling 2026-10-13); the credential settings are this computer's only.

### Tests

`tests/server/plans/jira.test.ts` (the fake Jira `tests/helpers/fake-jira.ts`: an epic with five children, blocks links with a cycle and a link outside the epic, a workflow without "In Review" for one issue, comments, injected failures), `tests/server/plans/jira-proposals.test.ts` (the proposed order on the real path: a fake-claude source session gets the ask, the MCP tool proposes, accept / cycle / reject, the tool only while Plans is on), `tests/core/plans-jira.test.ts` (rules, route classification), `tests/e2e/plans-jira.spec.ts` (the dialog's dev mount against the fake Jira, desktop and 360 px; the proposals rows; the Jira connection under Settings → Experimental → Plans). Tests never call the real Jira and never read the developer's `ATL_*` (test servers drop them; in-process tests read no environment).
