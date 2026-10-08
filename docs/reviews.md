# Review queue (D79)

When a session with changes goes idle it gets a **Review card**: in the Inbox (a new item kind, **Review**) and as a badge on the session's header. The card shows what changed and offers the actions that fit how the session works (its own worktree and branch, or directly in a folder). Developer rulings 2026-10-08, `docs/decisions.md` → D79.

Reviews are **post-hoc and advisory**: they never block an agent. Agents keep committing (and doing anything else) on their own; a card reflects the state when it is shown and is read from git again before every action.

Code: `src/core/reviews.ts` (wire types, pure helpers, the shared `ReviewResolvedEvent`), `src/server/reviews/service.ts` (`ReviewService`: raising, reading, actions), `src/server/reviews/git.ts` (`ReviewGit`: every git / gh step), `src/server/reviews/wire.ts` (stored row → `Review`, the Inbox item), `src/server/db/repos/reviews.ts` + migration `0033_session_reviews.sql`, `src/server/api/reviews.ts` (routes); web: `src/web/components/ReviewCard.tsx` + `review-card.ts` / `.css`, `src/web/views/session/SessionReview.tsx` (the header badge), the Inbox's review branch (`InboxView.tsx`).

## When a card is raised
- **Trigger:** one of this machine's sessions goes from `run` to `idle` or `done` (a turn ended; read from the bus's `sessionUpdated`, exactly as the D73 push notifier and the D75 reminder read it), it is not closed, and **Settings → Sessions → Raise review cards when a session with changes goes idle** (`sessions.reviewCards`, default **on**) is on. A paired machine's sessions are reviewed by their own machine.
- **Changes** = uncommitted changes in the working tree (staged, unstaged, untracked) **or** commits not merged into the base (see *Base*). For a session working in a folder: uncommitted changes, or commits made since the session started that are on no remote (`git log --since=<session start − 1 s> HEAD --not --remotes`).
- **Once per change set:** a **fingerprint** is the sha256 over each changed repo's HEAD, its `git diff --binary HEAD` and its untracked files (names + `git hash-object`). The newest card of the session decides:
  - same fingerprint (open or resolved) → nothing (a dismissed change set never comes back);
  - an open **pending** card with another fingerprint → that card is **refreshed** (its data and fingerprint), not duplicated;
  - otherwise (none, or the newest is resolved) → a **new** card.
  When a card is resolved, its fingerprint becomes the change set *after* the action (e.g. after Commit), so the next turn end raises a new card only when something changed again.
- Nothing is raised for a session without changes, and nothing is ever read from the prototype's mock data.

## Which repositories
- **Worktree / own-branch session** (`mode: branch`): the session's live worktrees (`worktrees` rows with its `session_id`: created by Switchboard, D38-adopted, D40 task worktrees, "Move to worktree"). Only repos with changes are on the card.
- **Session working in a folder** (`mode: folder`): its solutions resolved in its folder (the worktree manager's `resolveRepo`; a repo folder's one solution), else the repository its working folder (`cwd`) is in.

## Base
A branch session's base is "the branch it was created from", recorded as the worktree row's `base_ref` when the worktree was made:
1. `base_ref` = `origin/<b>` (D40 task worktrees, adopted ones) → the **local** branch `<b>`; while there is no local `<b>`, its tip is `origin/<b>` and Merge creates the local branch there (`baseSource: origin`).
2. `base_ref` = a local branch name (`session/<name>` worktrees: the branch the main checkout was on) → that branch (`baseSource: local`).
3. no `base_ref` → the repo's default branch (`origin/HEAD`), else the branch the main checkout is on (`baseSource: default`).
4. `base_ref` = a commit (cut from a detached HEAD) or the branch itself → no base: the card still shows the changes; Merge / Open PR / Discard are refused with `base-missing`.

"Commits not merged" = `git log <base tip>..HEAD` (at most 50 listed). The diff stats are `git diff --numstat <merge-base(base, HEAD)>` (working tree included) plus the untracked files (every line added; a file with a NUL byte or over 1 MiB counts as binary). For a folder session the stats start at the parent of the oldest listed commit (else HEAD).

## The card (`Review`)
Session (its display title), folder, per repo `⎇ branch → base` (the PR link once opened), the stats line (`3 files · +40 −2 · 1 uncommitted · 2 commits`), the changed files (each opens the session's Diff tab; the first 12, then `+ n more`), the commits, the **agent's last message** (the main agent's last assistant text, cut to 2,000 characters) as its summary, and the **tests line**: the last test-like `Bash` command of the transcript (best effort: `npm test`, `npm run test:*`, `npx vitest|jest|playwright test`, `pytest`, `go|cargo|dotnet test`, `make test|check`, …, `isTestCommand`) and its exit code (Claude Code reports a failure as an error result starting `Exit code <n>`; a non-error result is 0) → `Tests passed · <cmd>` / `Tests failed (exit n) · <cmd>`, else `Tests not reported`. The last action's note and a refused Merge's conflicting files stay on the card.

**Inbox item** (`kind: "review"`, `InboxItem.review` = the card): source = the session; status `need` while pending, `done` while only Clean up is offered; label `Review` / `Clean up`; title `n files changed (+a −r)` (or `n commits to review`, `Merged — clean up the worktree?`); detail = the tests line; one branch chip per repo `<repo> ⎇ <branch> → <base>`. Open cards come after the system items, oldest first, and count in `inboxChanged.count`. Picking one in the Inbox reads it from git again.

**Session header:** a `Review` badge (amber, the question colors) at the start of the chips row while the session has a pending card, `Clean up` while a merged / discarded card offers clean-up; a click opens the same card under the header's top row. It leads the chips rather than sitting in the top row so the title and the actions keep their room; where the chips row hides (the D74 *short* layout, ≤ 500 px high) the Inbox still has the card. Nothing is mounted without an open card (the visual oracle's header is unchanged).

## Actions (`POST /api/reviews/{id}/<action>`)
Every action reads the card from git again first (`409 gone` when its changes are gone, `409 not-offered` when the action is not offered now) and answers the card afterwards. The first action is primary.

| Mode | Actions offered (pending) |
|---|---|
| `branch` | **Merge**, **Open PR** (until a PR is known), **Send back**, **Discard**, **Dismiss** |
| `folder`, with uncommitted changes | **Commit**, **Send back**, **Discard**, **Dismiss** |
| `folder`, everything committed | **Send back**, **Dismiss** (the card shows its commits) |
| after Merge / Discard of a branch session (`cleanup`) | **Clean up**, **Dismiss** (= keep the worktree) |

- **Merge** (`branch`): every repo is checked before any is merged: refused with `uncommitted` while the worktree has uncommitted changes (they would not be merged: send it back or commit them), with `conflicts` + the files (`git merge-tree --write-tree`, which touches no working tree), with `base-dirty` when the base is checked out somewhere with uncommitted tracked changes. Then, **locally only, never pushed, never forced**: where the base is checked out (usually the main checkout) `git merge --no-edit <branch>` runs there (hooks run; a failure is aborted with `git merge --abort`); otherwise the base ref is moved with `git update-ref <ref> <new> <old>` (a fast-forward, or a merge commit `Merge branch '<branch>' into <base>` made from the conflict-free tree with `git commit-tree`). Already contained → nothing to do. Resolved `merged`; Clean up offered.
- **Open PR** (`branch`, a separate click): `git push -u origin <branch>` (the session's own branch only, never forced; `no-remote` without an `origin`), then an open PR for the branch is reused (`gh pr view`) or `gh pr create --base <base> --head <branch> --title <session title> --body <summary + "Opened from a Switchboard review card.">`. The card stays pending with the PR link (the worktree poller picks the PR up as before).
- **Commit** (`folder`): `{ message }` (1–4,000 characters; drafted from the agent's summary: its first line without Markdown marks, ≤ 72 characters, then the rest; editable). `git add -A` then `git commit -m <message>` in each repo with uncommitted changes (the repo's hooks run; nothing is pushed). Resolved `committed`.
- **Send back**: `{ comment }` (1–4,000 characters) goes to the session as the developer's message (`Review: your changes were sent back with this comment:` + the comment; the normal message path: queued while busy, a paused session resumed, a hooked session's mailbox). Resolved `sent-back`; the agent's next changes raise a new card.
- **Discard**: `{ confirm: true }` (else 422). `branch`: the worktree is reset to its base (`git reset --hard <base tip>` + `git clean -fd`: its commits, uncommitted changes and new files are gone; ignored files stay); the branch then points at the base and **Clean up** deletes it with the worktree. Resolved `discarded`, Clean up offered. `folder`: only the card's uncommitted files: tracked ones restored from HEAD (`git restore --staged --worktree`), new ones deleted (`git clean -f -- <files>`); commits stay. Resolved `discarded`.
- **Clean up** (`cleanup` state): `{ confirm: true }`. Refused while the session's turn runs (`busy`), while the worktree holds uncommitted changes again, or when the branch has commits that are not in its base (`not-merged`). Then `git worktree remove <path>` (never forced) and `git branch -D <branch>` (safe: it is contained in the base, checked first); the worktree row is marked removed. The card is resolved (no second event).
- **Dismiss**: resolved `dismissed` (pending), or "keep the worktree" (clean-up offer closed, no event).
- A pending card whose changes are gone when it is read (the agent pushed, reverted, merged itself) is resolved as `dismissed` with the note *No changes left*.

Refusals: `{ error, message }` (+ `conflicts` for a refused Merge): 404 unknown review, 404 for an unknown action route, 409 `not-offered` / `gone` / `busy` / `send-failed` / a git refusal (`conflicts`, `uncommitted`, `base-missing`, `base-dirty`, `no-branch`, `no-remote`, `not-merged`, `git-failed`, `gh-failed`), 422 `invalid` (comment, message, confirm). The Inbox's `POST /api/inbox/{id}/actions/{action}` runs a review's action too (204).

## `reviewResolved` (shared contract with the todo lane)
`src/core/reviews.ts`:
```ts
export interface ReviewResolvedEvent {
  sessionId: string;
  outcome: 'merged' | 'committed' | 'discarded' | 'sent-back' | 'dismissed';
}
```
Published on the bus (`HubEvents['reviewResolved']`, also on `/hub`) once per resolution, by `ReviewService.#resolved` (Merge, Commit, Discard, Send back, Dismiss, and a pending card closed because its changes are gone → `dismissed`). Clean up and "keep the worktree" do not publish it again. This machine's only: never forwarded between peers (a peer's todos follow its own reviews). `reviewsChanged { sessionId }` (raised, refreshed, acted on) reloads the header badges; it is forwarded between peers with the remote session id.

## Peers (D48)
`GET /api/reviews` adds the paired machines' cards (`PEER_LISTS.reviews`, fetched when older than 10 s and on their `reviewsChanged`, snapshotted), namespaced (`r~<machine>~<id>`, `peerReview`) and tagged; the Inbox shows them through the peers' Inbox items (`peerInboxItem` maps the card too). An action on a remote id goes to that machine through the normal forwarding and runs there (`PEER_API_ALLOW` has the list and every action).

## Devices (D73)
Allowed for a paired phone or tablet (normal use): `GET /api/reviews`, **Merge** (local only), **Open PR**, **Commit**, **Send back**, **Dismiss**. **Discard** and **Clean up** stay desktop-only (`DEVICE_REFUSED`: they destroy work or remove folders); the card does not offer them on a device. Push: a new card notifies devices that have the new toggle **Ready for review** (`review`, default on; `<session> is ready for review`, the card's title, opens the Inbox).

## Tests
- `tests/core/reviews.test.ts`: the event's shape, `isTestCommand` / `bashExitCode` / `testsFromCalls`, `draftCommitMessage`, `reviewActions`, the git output parsers, the device and peer allow-lists, the peer mappings.
- `tests/server/reviews/reviews.test.ts` (temp repos, isolated git, fake gh): raising once per change set, refresh, the setting, closed sessions, Dismiss and a new change, changes gone; Merge into a checked-out base and by moving the ref (merge commit), refused on conflicts and uncommitted changes; Open PR (push to the bare origin + `gh pr create`); Discard + Clean up; Send back; folder Commit, commits only, Discard; `reviewResolved` payloads.
- `tests/server/reviews/routes.test.ts`: the routes' answers and refusals, the Inbox item and its action route, the setting.
- `tests/e2e/reviews.spec.ts` (real server, fake-claude, fake gh): the card in the Inbox, Merge refused then merged, Clean up; the header badge on a phone and Commit with the drafted message; screenshots to `/tmp/lane-b-shots/`.
