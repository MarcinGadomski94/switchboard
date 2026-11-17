# Profiles (D165)

Developer request (2026-11-16): profiles so that many people can share one Switchboard (a dev machine used by several developers). Every agent belongs to one profile (**Default** by default) and can be moved between profiles; the profiles work across paired computers. Rulings: `docs/decisions.md` → D165. Code: `src/core/user-profiles.ts`, `src/server/user-profiles/` (`service.ts`, `scope.ts`, `context.ts`, `password.ts`), `src/server/api/user-profiles.ts`, `src/web/v2/profiles/Profiles.tsx`, `src/web/v2/settings/ProfilesSection.tsx`.

Named **user profiles** in code (`user_profiles`, `userProfileId`, `/api/user-profiles`) so they never meet D63's CLI **account** profiles (`cli_profiles`, `Session.profileId`). The UI says "Profiles".

## The model

- **Any number of profiles.** Nothing caps the count. **Default** is seeded by migration 0055 and cannot be deleted; every agent, crew, schedule, phone and sidebar folder from before 0055 is Default's.
- **What a profile owns:** agents (`sessions.user_profile_id`), and through them their todos, loops, artifacts, checkpoints, attachments, processes, plans (by their source session) and moves; crews (`TeamRecord.userProfileId`, a JSON field of `team.db`); schedules (`schedules.user_profile_id`); its own sidebar folder tree (`sidebar_folders.user_profile_id`; pins and places follow their agent); paired phones (`devices.user_profile_id`).
- **Shared by every profile:** the CLI accounts and their logins (Claude Code, Codex, OpenCode), Settings, saved folders, paired computers, phones' pairing, MCP servers, Project memory (per repo knowledge), the history of CLI conversations on disk.
- **Each profile's default account per CLI** on this computer (setting `userProfiles.defaultAccounts`): a new agent of the profile starts on it when nothing else picks an account (`AccountService.pick`'s preference).

## Switching

- A browser works in one profile at a time: the **signed profile cookie** `sb_profile=<id>.<password tag>.<hmac>` (HMAC-SHA256 with the install token; HttpOnly, SameSite=Strict, `Max-Age` 400 days). The password tag changes with the password, so a new password signs every browser out of that profile.
- **Staying signed in (2026-11-16):** the cookie outlives a restart of Switchboard and of the browser (400 days, the longest a browser keeps one; the install token that signs it does not change), so a browser that switched into a profile, password or not, opens in it again without the password. It ends with the new password above, a deleted profile, the browser's own cookie clearing, or a new install token.
- `POST /api/user-profiles/switch { id, password? }` checks the password (scrypt, constant time; 5 wrong tries per profile per minute, then 429) and sets the cookie. The page reloads in the new profile.
- **Without a valid cookie** a browser works in the **Open in** profile (Settings → Profiles; `PUT /api/user-profiles/start { id }`, stored as `userProfiles.startProfileId`, this computer's own; Default when unset or deleted) while it has no password; when it has one, the browser works in **no profile** (it sees no agent) until it switches: it asks once, then stays (above).
- A **paired phone** works in the profile Settings → Devices gives it (`PUT /api/devices/{id} { userProfileId }`); it cannot switch itself.

## Scope (strictly only mine)

Every request gets a scope right after the security guard (`scope.ts`): the browser's profile, a phone's profile, the agent's own session's profile on `/agent/*`, everything (`'*'`) for the hook script and for the peer API's own injected requests (marked by a per-process secret; the bare `x-switchboard-peer` header a browser could add widens nothing). A paired computer's request that names the profile its own request works in (`x-switchboard-user-profile`) runs in that profile. The scope is carried for the request's async work (`AsyncLocalStorage`, `context.ts`).

- **Lists** (`onSend` filter): `GET /api/sessions`, `/api/inbox`, `/api/todos`, `/api/artifacts`, `/api/moves`, `/api/plans`, `/api/processes`, `/api/schedules`, `/api/search`, `/api/team/teams`, every `/api/sidebar*` answer, and D159's `GET /agent/v1/plans` keep only what the scope sees.
- **Ids** (`preHandler`): every route keyed by a session, chat, plan (also `/agent/v1/plans/{planId}`), crew member, crew, Inbox item, question batch, artifact, schedule, move or sidebar folder answers **404** for one of another profile; `GET /api/team` and `/api/team/activity` too for the crew they name (none = the first crew); `POST /api/sidebar/place` and `POST /api/team/members` for a session of another profile.
- **The hub:** each `/hub` client gets only its profile's events (a per-client transform in `SseHub`): session events by session, the sidebar layout cut to the profile's, `notice` toasts by the session they open. Events about no session pass.
- **Pushes:** a phone gets only the notices of its profile's agents.
- **Not protection against the machine's OS user:** transcripts and the database are files on disk. Settings → Profiles says so.

## Creating

A new agent takes, in order: an explicit `userProfileId`; its source's (`continuedFrom`, a todo's or plan item's `todoLink.sourceSessionId`); the request's profile; Default. So the New-agent sheet, chats, teleports, history continues, terminal hooks and crew templates take the browser's profile; fresh continuations and plan / todo runs their source's; scheduled runs their schedule's (`runInProfileScope`); a new crew, schedule or sidebar folder the request's.

## Moving an agent to another profile

`PUT /api/sessions/{id}/user-profile { userProfileId, password? }` (the agent's ⋯ → Move to profile…): the target's password when it has one. Everything that follows the agent goes with it; its sidebar place is cleared (it shows unplaced in the new profile). Its crew and plan keep theirs. A paired computer's agent moves on its computer (the call goes through the peer API). A **conversation** (D106 chat) moves the same way, from its own ⋯ menu (2026-11-17: the menu left it out before).

## Deleting a profile

`DELETE /api/user-profiles/{id} { password? }`: its open agents are **archived** first (the developer's ruling; Archived keeps them), its phones and sidebar folders move to Default, the saved folders bound to it are shared again (D169), and a tombstone stays so the paired computers learn it. If an agent cannot be archived the profile stays (409 `archive-failed`).

## Paired computers

- The profiles (id, name, colour, password hash, clock, deletion) sync with **every** paired computer over `POST /peer/v1/user-profiles` (bearer auth on the Tailscale-only peer listener): a full exchange each time a connection comes (back) online, the changed records on every change. Last write wins per profile (a hybrid clock; equal clocks by value). Default is never deleted by a peer. A hash of another shape is dropped. Each computer's default accounts stay its own.
- A paired computer's agents show in their own profile (`Session.userProfileId` on the wire; an older computer's are Default's).
- A move between computers keeps the agent's profile: the move runs in the initiating request's profile, which is the agent's (strict scope).
- Sidebar folders carry their profile in the D71 records (`userProfileId`; an older computer's arrive as Default's).

## Also scoped (closed before the first release of D165)

- **History** (`GET /api/history`): a conversation that is a Switchboard session shows only in its profile; `POST /api/history/{claudeSessionId}/continue` answers 404 for one another profile holds.
- **Insights and the usage breakdown** (every `/api/insights*` route): the rows count only the profile's sessions' turns, todos and plan steps (merge decisions follow those steps), so every total, trend and breakdown is the profile's. A paired computer's rows come through the peer API in the asking profile (the request names it), and the answer and peer copies are cached per profile. The accounts' usage windows (5-hour, week) stay whole: the accounts are shared by every profile.
- **Crews:** `GET /api/team/needs-you` (and `?teamId=` of another profile's crew: 404), `/api/team/state` (the hidden member sessions and their roles) and `/api/team/suggestions`: the profile's own.
- **The hub:** the `inboxChanged` count is the client's profile's (published with a per-profile map that never leaves the server); `planChanged` and `teamChanged` go only to the clients of the profile that owns the plan / crew.
- **A sidebar position** counted in one profile's rows (Pinned, a folder, the loose order) lands before the same row in the whole list.

## A folder bound to a profile (D169)

A saved folder (D14) may be **bound** to one profile (`folders.user_profile_id`, migration 0057; `NULL` = shared, as before). Per computer: each computer's folders are bound on their own (no matching or syncing between computers).

- **Hidden from the other profiles.** `FolderRepository`'s reads follow the request's profile scope (`folderVisible`): `list`, `get`, `getByCanonicalPath` and `getDefault` leave a folder bound to another profile out, so every caller follows the binding: `GET /api/folders` and its pickers, every folder route (404, as if it did not exist), a new agent there (the start's 422 "no saved folder"), scans (`/api/solutions`, Codebase Memory, by id or path), the take-over target listing and placement (D110: not among the places, a path in it is 403 outside, a checkout under it is not a candidate), History and Project memory, a chat's folders to look at (422 "not available in this profile"), saving the same folder again (422). A profile that cannot see the default folder gets its first visible one as its default. Internal work (startup, schedulers, the `'*'` scope) uses the unscoped `…Any` reads.
- **Paired computers.** A paired computer's requests carry their profile (D165), so its browser in another profile cannot see or use the folder here either; its own folders are bound there.
- **Binding** (Settings → Advanced → Folders → *Bind to profile…*, `PUT /api/folders/{id}/user-profile { userProfileId, password? }`): the target profile's password when it has one; re-binding a bound folder also needs its present owner's (`currentPassword`). First the other profiles' **agents** working there (their saved folder is this one, or their folder / working folder is inside it; open and archived) and their **schedules** starting there move to the owner (`GET …/user-profile/preview?to=` lists them; an agent's tasks and loops follow it, its sidebar place is cleared; a crew member stays in its crew, a plan follows its source session, as D165's move).
- **Unbinding** (`{ userProfileId: null, password? }`): the owner's password when it has one; the folder is shared again.
- **A terminal** in (or under) a bound folder, followed from any profile, joins the owner's profile (the innermost bound folder that holds its working folder).
- **A deleted profile's** bound folders are shared again (ASSUMED: not hidden from everyone for good).
- **Backup / restore (D168):** the binding is a column of `folders` and the profiles travel with their ids, so a restore keeps it, also "start as a new computer".
- **Phones** cannot bind or unbind (local only); a phone's folder list follows its profile.

## The machine's, by design

- **Terminal conversations not in Switchboard yet** (`GET /api/terminal-sessions`, `/api/terminal-loops`) and History's conversations that are no session: they belong to no profile (they are the machine's), so every profile lists them. Once one is followed (hooked) or continued it is a session of the profile that did it, and only that profile sees it; hooking or continuing one another profile already holds answers 404.
- `GET /api/plans/state` carries no plan (only whether Plans is on).
- A folder's memory checks (Project memory) are no profile's session: no profile's Insights count them.
- **The classic (pre-v2) UI** shows the browser's active profile (the same cookie, scoped by the server) and has no switcher: switch in v2.
## Tests

| Test | Covers |
|---|---|
| `tests/server/user-profiles/profiles.test.ts` | three profiles (Default, Ann with a password, Bo): the lists, the password switch (wrong, 429, a forged cookie, a new password), 404 for another profile's agent, folders per profile, move, delete (archive), a locked Default, a new agent's profile, the hub transform, the peers' merge |
| `tests/server/peers/user-profiles.test.ts` | two real Switchboards: a profile and its password sync, a rename comes back, a delete goes everywhere |
| `tests/server/user-profiles/scope-holes.test.ts` | three profiles: History and its continue, Insights / usage rows and the per-profile answer, crews' needs-you / state / suggestions, Plans' state, terminal sessions and hooking, the hub's Inbox count, plan and crew events, a sidebar position |
| `tests/e2e/v2-profiles.spec.ts` | the rail switcher with three profiles and a password |
| `tests/server/user-profiles/folder-binding.test.ts` | D169: bind with the owner's password, the other profile's agent moves; hidden from Bo and Default on every folder route, a new agent, scans, the take-over target listing, a chat's folders, saving it again; a paired computer's request in Bo's profile; unbind; a deleted owner; phones refused |
| `tests/server/backup/roundtrip.test.ts` | D169: a bound folder stays bound after a restore ("start as a new computer") |
