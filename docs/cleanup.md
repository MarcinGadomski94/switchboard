# Clean-up (D84)

Developer ruling 2026-10-08 (`docs/decisions.md` → D84). **Settings → Clean-up** finds what Switchboard created and no longer needs, shows it as a checklist with sizes, ages and exactly what each item removes, and removes only what you tick and confirm. It runs on this machine only, by hand (no schedule).

Code: `src/core/cleanup.ts` (shapes, rules, the run body), `src/server/cleanup/service.ts` (scan and run), `src/server/cleanup/created-branches.ts` (the created-branches record), `src/server/api/cleanup.ts` (routes), `src/web/views/settings/CleanupSection.tsx` + `cleanup.ts` + `cleanup.css` (the page). Contract: `docs/handoff/contracts/local-api.md` → *Clean-up (D84)*.

## Where it lives

Settings → **Clean-up**, the last Settings section (`/settings/cleanup`). It is an occasional task, so it gets no sidebar entry. On phones it is a Settings detail page like the others (D74); on a paired device it only says that clean-up runs on the computer itself.

## What counts as Switchboard's

Nothing outside Switchboard's own records is ever listed:

| Group | Listed only when |
|---|---|
| **Worktrees** | it is a live row of the `worktrees` table (a worktree Switchboard created, or one the agent of a Switchboard session created and Switchboard adopted, D38). A worktree the developer made by hand has no row. |
| **Local branches** | the branch is named in a `worktrees` row (live or removed) **and** has Switchboard's naming (`session/…`, lane A's `todo/…`), **or** it is in the created-branches record. A branch with Switchboard-like naming but no record (`session/handmade`) is not listed. **Older task branches (ruling 2026-10-08):** any other branch a `worktrees` row (live or removed) names, e.g. a ticket-named D40 task branch from before the created-branches record (or a picked / reused one), is listed **only when merged** into its base, never ticked for you (chip "not known to be made by Switchboard"), and never its remote copy. A branch no row names is never listed. |
| **Remote branches** | a take-over leftover (D65, `switchboard/takeover/…`, recorded by the take-over service), or the remote copy of a branch from the row above that Switchboard made new (not one that only tracked a branch already on `origin`). |
| **Closed sessions** | a Switchboard session closed longer ago than the limit (default 30 days). |
| **Data** | files under Switchboard's data folder only: `attachments/`, `handovers/`, `takeover/`. |

**The created-branches record** (`cleanup.createdBranches`, a settings value like the take-over leftovers; no migration): the worktree manager adds `{ repoPath, branch, kind }` whenever it runs `git worktree add -b` itself, i.e. a session's `session/{name}` and a D40 task branch that did not exist (`kind: new`), or a new local branch tracking an existing `origin/<task>` (`kind: tracking`: the local branch is Switchboard's, the remote one is not). A reused local branch is never recorded. Branches created before this version are known by their `session/…` / `todo/…` naming, or (when merged) by a `worktrees` row naming them. Clean-up forgets an entry when it deletes the branch.

## When an item is listed

- **Worktrees:** the branch is merged into its base (the row's `base_ref`; `git merge-base --is-ancestor HEAD <base>`), or its PR is `MERGED`; or its session is closed / deleted and nothing changed for **14 days** (the newest of the last commit, uncommitted files' times, the session's last activity and closing); or its folder is gone (the row and git's entry for it are pruned). An **open** session's worktree is listed only once its PR is merged (a new worktree with no commits is trivially "merged" into its base). A worktree of a **running** session is never listed. A row without a session less than a day old is skipped (a start in progress).
- **Local branches:** merged into its base (or PR merged and every commit on a remote), or all its worktrees are gone, or all its sessions are closed / deleted. An older task branch (above) only when merged. Never one checked out in the main checkout, or in a worktree that is not itself listed (a branch held by a listed worktree is removed after it: "tick that too").
- **Remote branches:** the same conditions, read from the remote-tracking refs of the last fetch (a scan makes no network call).
- **Closed sessions:** closed longer ago than **Closed sessions … days** (1–3650, default 30, saved as `cleanup.closedSessionDays`). Never a running one.
- **Data:** attachments past their 30 days (D57; normally already removed at start), files in `attachments/` no row owns and folders of sessions that no longer exist, chat exports in `handovers/` untouched for 30 days, take-over staging folders (`takeover/<op>`) of no running operation untouched for a day.

## What each item shows

Title (path, branch, session), its repo / session, reason chips, size (folders walked without following symlinks, at most 200 000 entries, then "≥"), last change, warnings, and **What goes**: the exact paths, `repo: branch at <sha>`, `remote URL: branch` (credentials stripped), the session record with its event / todo / attachment counts and folders. **Kept** says what stays on purpose (a worktree's branch and commits; a session's worktrees and the CLI's own transcript).

## Ticks and confirmations

- Ticked when the page opens: items that need no confirmation (a merged branch only when every worktree holding it is ticked too).
- **Uncommitted changes** (a worktree): never ticked for you; the warning lists the files (up to 200). Removing it needs the dialog's extra confirmation listing them; only then is `git worktree remove --force` used. A change that appears after the preview stops that item.
- **Unmerged local branches:** never ticked for you; the warning says how many commits are not in the base and how many are on no remote; extra confirmation.
- **Remote branches:** never ticked for you, and the group's checkbox never ticks them; each is ticked by hand and needs its own confirmation ("Delete these branches on their remotes").
- **Clean up selected** opens the confirmation: the full list of what goes, then one block per needed confirmation with its items; **Clean up** stays disabled until each is ticked.

## The run

`POST /api/cleanup/runs` re-scans first (without sizes). An item no longer listed, or whose **fingerprint** (what it removes, its warnings' files, the branch tip, the confirmation it needs) changed since the preview, fails with "changed since the preview: scan again" and is not touched. A ticked item that needs a confirmation the request does not carry refuses the whole run (422 `confirmation-required`). Items run one at a time in group order (worktrees first, so their branches can go); the dialog shows each step (· … ✓ ✕), then **Removed n · freed X · m failed (nothing else was affected)** with each failure's reason. One run at a time (409 `busy`); the last ten runs are kept in memory.

How each kind is removed:
- worktree: `git worktree remove <path>` (`--force` only after the uncommitted confirmation), then the row is marked removed; a missing folder: `git worktree remove` of that one entry (never `git worktree prune`, which would touch others), then the row;
- local branch: refused when checked out anywhere or moved; `git update-ref -d refs/heads/<b> <previewed sha>` (git refuses if it moved in between), then its `branch.<b>` config section;
- remote branch: `git push --force-with-lease=refs/heads/<b>:<previewed sha> <remote> :refs/heads/<b>` (the remote refuses if its branch is not where the preview saw it); a take-over leftover through the take-over service's own delete;
- session: refused if reopened or running; its `attachments/<id>` and `handovers/<id>` folders, then the record (events, agents, questions, todos and attachment rows go with it; worktree rows keep their branch);
- data: the listed files and folders (each checked to be under `attachments/`, `handovers/` or `takeover/` of the data folder).

Never: `git gc`, `git worktree prune`, `git branch -D`, anything in the main checkout's working tree, lane C's checkpoint refs (`refs/switchboard/checkpoints/*`).

## Peers and devices

- **This machine only** (D84 ruling option, recorded): a paired machine's leftovers are cleaned on that machine's own Switchboard. Proxying would mean adding destructive routes to the peer API and a second confirmation round-trip for a rare task. The routes refuse peer requests (403 `peer-forbidden`) and are not on `PEER_API_ALLOW`.
- **Devices:** refused (`DEVICE_REFUSED`: `/api/cleanup…`, 403 `local-only`), also through the machine proxy.

## Tests

`tests/server/cleanup/service.test.ts` (temp git repos with a local bare remote: only Switchboard's items, the developer's branches / worktrees / look-alike names never listed; the listing rules; uncommitted, unmerged and remote protections; dry run equals the run; a failure isolated; one run at a time; sessions and the limit; data files; no `gc` / `prune` / `-D`), `tests/server/api/cleanup.test.ts` (routes, validation, devices and peers refused), `tests/core/cleanup.test.ts`, `tests/web/cleanup.test.ts`, E2E `tests/e2e/cleanup.spec.ts` (the real server: the page, the confirmation, the run and the result; screenshots with `SWITCHBOARD_SHOTS_DIR`).
