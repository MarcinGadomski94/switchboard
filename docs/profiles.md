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
- **The hub:** each `/hub` client gets only its profile's events (a per-client transform in `SseHub`): session events by session, the sidebar layout cut to the profile's, `notice` toasts by their agent (D178: the notice's `sessionId`; only a notice that names no agent by the session its link opens). Events about no session pass.
- **Pushes:** a phone gets only the notices of its profile's agents (D178: by the notice's agent too, not only its link: an Inbox notice links to `/inbox`).
- **Needs you (Home, the Needs you page, the counts; D178):** an Inbox item belongs to its **agent** (`inboxItemSession`: its session; a failed move's moved agent, a paired computer's `r~<machine>~<id>` when it is not this computer's) and shows only in that agent's profile. **An item of no agent is every profile's:** an update available, an account's credits or sign-in, Project memory proposals, a crew member's memory copy (the computer's, like Project memory itself).
- **Switchboard's own work runs in no profile** (D178, `runOutsideProfileScope`): a paired computer's connection and the copies of its lists every profile shares are fetched naming no profile, whatever browser request started or refreshed them.
- **Not protection against the machine's OS user:** transcripts and the database are files on disk. Settings → Profiles says so.

## Creating

A new agent takes, in order: an explicit `userProfileId`; its source's (`continuedFrom`, a todo's or plan item's `todoLink.sourceSessionId`); the request's profile; Default. So the New-agent sheet, chats, teleports, history continues, terminal hooks and crew templates take the browser's profile; fresh continuations and plan / todo runs their source's; scheduled runs their schedule's (`runInProfileScope`); a new crew, schedule or sidebar folder the request's.

## Moving an agent to another profile

`PUT /api/sessions/{id}/user-profile { userProfileId, password? }` (the agent's ⋯ → Move to profile…): the target's password when it has one. Everything that follows the agent goes with it; its sidebar place is cleared (it shows unplaced in the new profile). Its crew and plan keep theirs. A paired computer's agent moves on its computer (the call goes through the peer API). A **conversation** (D106 chat) moves the same way, from its own ⋯ menu (2026-11-17: the menu left it out before).

## Deleting a profile

`DELETE /api/user-profiles/{id} { password? }`: its open agents are **archived** first (the developer's ruling; Archived keeps them), its phones and sidebar folders move to Default, the saved folders bound to it are shared again (D169), and a tombstone stays so the paired computers learn it. If an agent cannot be archived the profile stays (409 `archive-failed`).

## Paired computers

- The profiles (id, name, colour, password hash, clock, deletion; D173 admin and access, D176 `decidedFor`) sync with **every** paired computer over `POST /peer/v1/user-profiles` (bearer auth on the Tailscale-only peer listener): a full exchange each time a connection comes (back) online, the changed records on every change; D176: the records a paired computer's exchange wrote go on to the other paired computers. Last write wins per profile (a hybrid clock; equal clocks by value). Default is never deleted by a peer. A hash of another shape is dropped. Each computer's default accounts stay its own.
- A paired computer's agents show in their own profile (`Session.userProfileId` on the wire; an older computer's are its Default's). D178: an agent of a paired computer not in its last known list yet takes the profile its Inbox items or notices name (`InboxItem.userProfileId`, a notice's `userProfileId`), else that computer's Default: never this computer's own Default (before D178 it was, so this computer's Default got a new agent's items there).
- A move between computers keeps the agent's profile: the move runs in the initiating request's profile, which is the agent's (strict scope).
- Sidebar folders carry their profile in the D71 records (`userProfileId`; an older computer's arrive as Default's).

## Identity across computers (D172)

The D165 sync matched profiles by id, and every install seeds its Default as `default`: two paired computers' Defaults were one record, so renaming either renamed both (the 2026-11-17 report: a Default renamed "Claudiu" on the other PC renamed this one). Now profiles of different computers are **never** the same unless you merge them (below), not even with equal names.

- **Local id vs peer-link id.** Each computer keeps its Default under the local id `default` (cookies, phones, agents, folders, settings unchanged: no data re-keyed). On the peer link it travels as that computer's own id, `default-<machine id>` (`homeDefaultId`), with `homeOf: <machine id>`. Other profiles' ids are UUIDs, the same everywhere.
- **Translated on receive** (`UserProfileService.fromRemote(machine, id)`): every profile id a paired computer sends: its profile records, its sessions' `userProfileId` (`profileOfSession` of `r~<machine>~…`), the profile header of its forwarded requests (`PeerService.api`) and terminal sockets, its crews (team sync) and its sidebar folders (D71). Its `default` is **its** Default here (`userProfiles.peerDefaults[<machine>]`, else `default-<machine>`); this computer's own peer-link id (`userProfiles.defaultWireId`, else `default-<self>`) is the local `default`; a merged-away id is its survivor. Senders always send their own local ids, so every version can talk to every version.
- **Mixed versions.** An older (D165) computer sends its Default as `default`: here it becomes `default-<that machine>`, a profile of its own (no collision). The older computer still merges this computer's Default into its own by id unless it is updated too (it never sees `default` from this one any more, but its own copy stays as before): update both.
- **A computer's own Default is never sent back to it** (an older one would list it twice); a Default (any computer's) can't be deleted, only merged.
- **Before the update**: a Default already renamed by the bug keeps the name it has (there is no record of which write was local): rename it back in Settings → Profiles. Folders and crews of the two Defaults that were synced under `default` stay in this computer's Default.

## Merging profiles (D172)

Settings → Profiles → **Merge…** on a profile: pick the other one (this computer's or a paired computer's), give both passwords (where set) and pick whose **name**, **colour** and **password** the merged profile keeps (`POST /api/user-profiles/merge { a, b, passwordA?, passwordB?, keep: { name, color, password } }`, each `'a'` or `'b'`; wrong passwords: 401 / 429 as switching).

- **The survivor's id**: this computer's Default when it is one of the two, else the older profile (then the id). The other one becomes a tombstone with `merged_into` (migration 0059) = the survivor's peer-link id.
- **Its data moves here**: sessions, phones, schedules, sidebar folders, bound saved folders (D169), crews (team.db), open terminals, default accounts (the survivor's win per CLI), the Open-in profile; the session index is rebuilt.
- **On the paired computers**: the two records travel (the survivor's new name / colour / hash, the tombstone naming it); each computer moves its own data of the merged-away id to the survivor. When the merged-away profile is **that computer's own Default**, it can't go: that computer's Default **adopts** the survivor's peer-link id (`userProfiles.defaultWireId`), takes its name / colour / password, and its local copy of the survivor folds into it. So merging this PC's Default with the Mac's makes one profile that is both computers' Default.
- **Browsers and phones**: a browser whose cookie names the merged-away profile is in no profile any more (its cookie no longer matches a live profile): it lands in the Open-in profile, or asks for the survivor's password. Phones of it are moved to the survivor.

## Admins and computer access (D173)

An **admin** profile decides which computers each profile may use. Settings → Profiles shows an *Admin* chip and, on every profile, the computers it may use (*All computers*, or *Only …*); an admin changes both with **Computers…** (its own password confirms). Non-admins see them read-only.

- **The first admin (bootstrap, ASSUMED):** while no profile is an admin, a profile with a password may make itself admin with its password. Afterwards only an admin (its password) marks or unmarks admins and changes access (`PUT /api/user-profiles/{id}/admin { admin, adminPassword }`, `PUT /api/user-profiles/{id}/access { computers: 'all' | [machine ids], adminPassword }`).
- **The rules:** at least one admin stays (409 `last-admin`); an admin has a password (making a password-less profile admin: 409 `needs-password`; removing an admin's password: 409 `admin-needs-password`). Admins get nothing else: everything else is as before.
- **Stored and synced:** `user_profiles.admin` and `computers` (machine ids; `NULL` = every computer; migration 0060) travel with the profile over the profile exchange (one clock per record: the last change of the record wins). A merge (D172) keeps admin if either was and joins the two lists.
- **On a computer a profile may not use:** the rail switcher lists it greyed out with "Not allowed on this computer…" (2026-11-18: hidden, it read as missing; the row's *Switch* is hidden; the route answers 403 `not-allowed-here`); a browser whose cookie names it falls back (Open in, else no profile); its phones get nothing; a paired computer's request or terminal in it is refused (403 / close 4403).
- **On every computer:** its lists, ids, the hub and pushes hide its agents on the computers it may not use (remote sessions `r~<machine>~…` included); `/api/machines` and `machineState` hide those computers (the status pill and Computers pages show only the allowed ones); a move or take-over to one is refused (403 `not-allowed-there`).
- **Its agents keep running:** losing a computer hides them, it stops nothing; giving the computer back shows them again.
- **Not security:** an admin organises who works where in Switchboard; anyone signed in to the computer can still read its files (`docs/security.md`).

### Computers the admin can't see (D176)

Paired computers form a chain, not a circle: your PC, your home PC and a shared Mac Studio are paired, and a colleague's laptop is paired **only** with the Mac Studio. The profile exchange passes every record on, so a checklist set on your PC reaches the laptop through the Mac Studio. Under D173 a checklist meant "only these computers": the laptop was not on it (your PC could not list it), so the colleague's own profile was locked out of their own Switchboard.

- **A checklist decides only for the computers it was set for.** With the list, the profile keeps `decidedFor` (migration 0061 `decided_for`): the computers the checklist showed. A computer outside it was never decided and **stays allowed**; one inside it follows the ticks. *All computers* is unchanged. A D173 list saved before (no `decidedFor`) still decides for every computer until it is saved again.
- **The checklist lists the computers known through a paired one** ("ThinkPad · through Mac Studio"): each paired computer reports its own paired computers (id, name) in the profile exchange (`computers`, both ways, at every exchange; a new or removed pairing is announced to the other paired computers at once). `GET /api/user-profiles` answers them as `otherComputers`.
- **A computer that appears later** (paired after the list was set) shows "not decided yet: allowed", ticked, until the admin saves the list again (then it is decided too). The row reads *Not on …* (the computers it is blocked on) for these lists, *Only …* for a D173 list.
- **Passed on at once:** a change a paired computer sends is passed on to the other paired computers right away (before, a computer paired only with the sender learned it at its next reconnect). It ends: a record already the same there is not written, so not passed on again.
- **Merge (D172):** allowed where either profile was allowed: either on every computer → every computer; else the lists joined, decided only where both decided (`mergedAccess`).
- **Limit, mixed versions:** a computer before D176 ignores `decidedFor` and applies the list as D173 did, and passes the record on without it. A computer with D176 that gets a record without `decidedFor` keeps its own while the list is the same. Update every computer in the chain (the Mac Studio too).

## Also scoped (closed before the first release of D165)

- **History** (`GET /api/history`): a conversation that is a Switchboard session shows only in its profile; `POST /api/history/{claudeSessionId}/continue` answers 404 for one another profile holds.
- **Insights and the usage breakdown** (every `/api/insights*` route): the rows count only the profile's sessions' turns, todos and plan steps (merge decisions follow those steps), so every total, trend and breakdown is the profile's. A paired computer's rows come through the peer API in the asking profile (the request names it), and the answer and peer copies are cached per profile. The accounts' usage windows (5-hour, week) stay whole: the accounts are shared by every profile.
- **Crews:** `GET /api/team/needs-you` (and `?teamId=` of another profile's crew: 404), `/api/team/state` (the hidden member sessions and their roles) and `/api/team/suggestions`: the profile's own.
- **The hub:** the `inboxChanged` count is the client's profile's (published with a per-profile map that never leaves the server); `planChanged` and `teamChanged` go only to the clients of the profile that owns the plan / crew.
- **A sidebar position** counted in one profile's rows (Pinned, a folder, the loose order) lands before the same row in the whole list.

## Layout and profiles (D179)

- **Shared layout per profile:** Settings → Computers → Shared layout is each profile's switch; a profile's folders and places reach another computer only when that profile shares on both (`docs/sidebar.md` → *Per profile (D179)*). Another person's folders never mix into yours.
- **Never hidden by layout:** an agent or conversation of this profile in a folder of another profile shows loose; deleting a folder with its agents archived (D141) archives only the agents the deleting profile sees.
- **A merged-away or deleted profile's data:** a session still naming a merged-away profile reads as its survivor's (the merged-into chain), and at start `repairOrphans` moves every such reference (sessions, folders, phones, schedules, crews, terminals) to it, once. Since 2026-11-23 a deleted profile without a survivor goes to **the one live profile of the same name**; with none (or more than one) it goes **nowhere**: never to Default by itself (Default can be another person). Its agents stay and Settings › Profiles lists them under *Agents of removed profiles* with **Move to**. A new agent is never created on a deleted profile (it takes the successor at once). Each start-up move is recorded with the agents it moved (`userProfiles.repairs`). Tests: `tests/server/user-profiles/layout-profiles.test.ts`, `repair-same-name.test.ts`.

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
| `tests/server/user-profiles/home-scope.test.ts` | D178: Home's list per profile (an item linking to the Inbox too; the items of no agent everyone's), the toast and the push of an item that links to the Inbox, a paired computer's failed move and an agent not known yet |
| `tests/server/peers/user-profile-inbox.test.ts` | D178 with two real Switchboards: Ann's agent's question on A shows on B only in Ann, named with its profile; the pairing request's profile does not stay on the connection |
| `tests/core/user-profiles-access.test.ts` | D173: the access rule, the bootstrap, the admin rules |
| `tests/server/peers/user-profile-access.test.ts` | D173 with two real Switchboards: the bootstrap, a non-admin refused, the last admin, Bo limited to A (refused on B, B's agents hidden on A, forwards and moves refused, its agent kept), syncing both ways |
| `tests/e2e/v2-profiles.spec.ts` | the rail switcher with three profiles and a password |
| `tests/server/user-profiles/folder-binding.test.ts` | D169: bind with the owner's password, the other profile's agent moves; hidden from Bo and Default on every folder route, a new agent, scans, the take-over target listing, a chat's folders, saving it again; a paired computer's request in Bo's profile; unbind; a deleted owner; phones refused |
| `tests/server/backup/roundtrip.test.ts` | D169: a bound folder stays bound after a restore ("start as a new computer") |
