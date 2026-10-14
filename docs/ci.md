# CI and pull requests (D109)

Switchboard follows the pull request of each session's branch. When a check fails, the failing job's log goes back to the session, so its agent can fix it and push. When the PR is green and approved, the Inbox offers **Merge PR**. Decision: `docs/decisions.md` → D109. Contract: `docs/handoff/contracts/local-api.md` → *CI and pull requests (D109)*. Importing issues as todos is in `docs/todos.md` → *Import issues (D109)*.

## One watcher for everyone

The **PR watcher** (`src/server/ci/watcher.ts`) is shared:

- the sessions' own loop below uses it;
- Plans (D99) reads its items' PRs through it (`PrWatcher.read`, see *Plans* below).

It replaced the separate `gh pr view` of Plans' scheduler. It is not a second D30 poller either: the D30 worktree PR poll (every 5 minutes) still finds PRs and marks merged worktrees removable.

### Which pull requests it watches

The watcher follows a live worktree registered to a session (`worktrees`) when its branch has an **open** PR. It learns about the PR in three ways:

- **D30's worktree PR poll** stored the PR as `OPEN`;
- **a session's turn ended**: the agent may have opened one. For each of the session's worktrees with no known open PR, gh is asked once, at most every 2 minutes per worktree;
- **Plans' Open PR** (D102): the item's worktrees are read at once.

Sessions working in place (no worktree of their own) are not watched (ASSUMED, `.loop/questions.md` → *D109*).

### How often it reads

Every due PR is read with `gh pr view <branch> --json number,state,url,headRefOid,baseRefName,headRefName,mergeable,isDraft,reviewDecision,statusCheckRollup` (`PR_WATCH_FIELDS`):

- **checks still running:** every `ci.pendingPollMinutes` (default **2**);
- **otherwise:** every `ci.idlePollMinutes` (default **10**).

A 30-second tick picks the due ones. Watching stops when the PR is **merged** or **closed**. A worktree that was removed, or whose session is gone, is not read.

The state is stored per worktree in `pr_watch` (migration 0046, `docs/database.md`), so attempts and stops survive a restart.

## A red check

When a PR's head has a failing check:

1. **The log.** The first failing check that is a GitHub Actions job (its details URL names `/actions/runs/<run>/job/<job>`) has its log read with `gh run view <run> --log-failed --job <job>`. The output is trimmed to its last `ci.logTailLines` lines (default **150**), without gh's job / step / timestamp columns and colour codes.
2. **The message.** The session gets a normal message, the same way a typed message travels:
   - queued while the agent works;
   - held while every account pauses for credits (D103);
   - into the mailbox of a hooked terminal session (D72).

   The message reads:
   > CI failed: build — on PR #12 (PROJ-7-checkout), attempt 1 of 3.
   >
   > The end of the failing job's log: *(the excerpt)*
   >
   > Fix it and push.
3. **Once per head.** Reading the same red head again sends nothing. A new red head (the agent pushed, and it failed again) is a new attempt.
4. **The cap and the breaker.** At most `ci.maxAttempts` messages per PR (default **3**). The **same failure twice in a row** also stops. Two failures are the same when they have:
   - the same failing check names;
   - the same log tail, once timestamps, hashes and numbers are taken out.

   Once stopped, nothing more is sent for that PR. The Inbox gets **"CI keeps failing on PR #12 (build) — 3 fixes tried"** (or "— the same failure twice, 1 fix tried") with:
   - **Open PR**;
   - **Open session**;
   - **Try again** (the attempts start over and the current failure is sent);
   - **Dismiss**.

   When the PR's checks turn green, the item closes by itself ("fixed").
5. **Off switch.** *Send CI failures to the session* (`ci.sendFailures`, default on) off: nothing is sent, and the chip still shows the state.

A session that is **closed** gets no message (nothing is counted). A send that fails because the session is detached or closing is not counted either, and is tried again at the next read.

## Green and approved: Merge PR

A PR is **ready to merge** when all of these hold:

- it is open and not a draft;
- every check is green, or none is configured;
- it does not conflict with its base (gh's `mergeable`);
- it is **approved**, or approval is not required. gh reports no review decision when the branch protection asks for none.

Then the Inbox gets **"PR #12 ready to merge"** (source `ci`, label *Ready to merge*) with **Merge PR**, **Open PR** and **Dismiss**. One item per PR head.

- **Merge PR** works only on the developer's click. Switchboard never merges by itself. On the click it:
  1. reads the PR again and refuses with the reason when it is no longer ready ("the checks of PR #12 are still running", "PR #12 still needs an approving review", …);
  2. runs `gh pr merge <n>` with the method from **Merge method** (`ci.mergeMethod`):
     - `repo` (default): the repository's default as gh reports it (`gh repo view --json viewerDefaultMergeMethod`), else **squash**;
     - or `squash`, `merge`, `rebase`.

  Never `--admin` or `--auto`. The branch is kept.
- **After the merge** the item closes (`merge-pr`) and the PR is read again: merged. The worktree's PR is checked through the worktree manager at once, so D30's **"PR #12 merged, so the worktree can be removed"** item (**Remove worktree** / **Keep**) is the clean-up offer. It appears when the worktree has nothing uncommitted or unpushed.
- A PR that stops being ready (a new push with running checks, red checks) closes the item ("not-ready"). It comes back once ready again.

Phones may press Merge PR: it is an Inbox action, an explicit click (D73). Paired machines forward it to the machine whose session it is (D48).

### Notifications

The two items are ordinary Inbox items, so a paired phone or tablet is told about them under its existing **Other Inbox items** push toggle (D73). There is no separate CI toggle.

## The session header's chip

The header's top row shows a small chip for the session's PR, only while it has one:

| Chip | When |
|---|---|
| `PR #12 · CI running` | blue dot: its checks still run |
| `PR #12 · CI failed` | red: a check failed |
| `PR #12 · CI green` | green: all checks pass |
| `PR #12 · ready to merge` | green: ready to merge, as above |
| `PR #12 · merged` | violet: merged |

The most urgent of the session's open PRs is shown. A click opens the PR on GitHub; the tooltip names the repo, branch, failing checks, review state and attempts. The chip is fed by `GET /api/sessions/{id}/ci` and refreshed on `ciChanged`.

A session without a PR shows nothing, so the visual oracle's session header is unchanged.

## Plans (D99)

Plans' scheduler reads its items' PRs through the watcher, not with a gh call of its own: `PlanGit` gets `prs: (repoPath, branch) => ci.read(repoPath, branch)`. That is the same reading the watcher keeps, fresh for 20 seconds. Three more changes:

- **Red checks:** while *Send CI failures to the session* is on, the watcher sends the failure (with the log) and Plans sends no checks message of its own. Off, Plans still sends its D99 message.
- **No second Merge item:** a running plan item's session keeps Plans' own Merge step and its "Ready to merge: <item> (<plan>)" item (D102). The watcher raises no "PR #n ready to merge" for it: Plans registers itself as that session's merge owner (`registerCiMergeOwner`).
- **Faster reactions:** a `ciChanged` of an item's run session makes the scheduler look at the item at once. Its 60-second poll stays.

## Settings

Settings → **CI & pull requests**: `docs/settings.md` → *CI & pull requests (D109)*.

## Tests

`tests/server/ci/watcher.test.ts` (fake gh, temp git repos), `tests/server/ci/credits-hold.test.ts` (the held message, real supervisor), `tests/e2e/ci-loop.spec.ts` (the chip, the message, Merge PR, the clean-up offer, Import issues). Tools: `tools/fake-gh` (`docs/worktrees.md` → *Fake gh*); test servers shorten the watcher with `SWITCHBOARD_CI_TICK_MS` and `SWITCHBOARD_CI_POLL_MS` (`docs/configuration.md`).
