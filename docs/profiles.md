# Profiles (D165)

Developer request (2026-11-16): profiles so that many people can share one Switchboard (a dev machine used by several developers). Every agent belongs to one profile (**Default** by default) and can be moved between profiles; the profiles work across paired computers. Rulings: `docs/decisions.md` → D165. Code: `src/core/user-profiles.ts`, `src/server/user-profiles/` (`service.ts`, `scope.ts`, `context.ts`, `password.ts`), `src/server/api/user-profiles.ts`, `src/web/v2/profiles/Profiles.tsx`, `src/web/v2/settings/ProfilesSection.tsx`.

Named **user profiles** in code (`user_profiles`, `userProfileId`, `/api/user-profiles`) so they never meet D63's CLI **account** profiles (`cli_profiles`, `Session.profileId`). The UI says "Profiles".

## The model

- **Any number of profiles.** Nothing caps the count. **Default** is seeded by migration 0055 and cannot be deleted; every agent, crew, schedule, phone and sidebar folder from before 0055 is Default's.
- **What a profile owns:** agents (`sessions.user_profile_id`), and through them their todos, loops, artifacts, checkpoints, attachments, processes, plans (by their source session) and moves; crews (`TeamRecord.userProfileId`, a JSON field of `team.db`); schedules (`schedules.user_profile_id`); its own sidebar folder tree (`sidebar_folders.user_profile_id`; pins and places follow their agent); paired phones (`devices.user_profile_id`).
- **Shared by every profile:** the CLI accounts and their logins (Claude Code, Codex, OpenCode), Settings, saved folders, paired computers, phones' pairing, MCP servers, Project memory (per repo knowledge), the history of CLI conversations on disk.
- **Each profile's default account per CLI** on this computer (setting `userProfiles.defaultAccounts`): a new agent of the profile starts on it when nothing else picks an account (`AccountService.pick`'s preference).

## Switching

- A browser works in one profile at a time: the **signed profile cookie** `sb_profile=<id>.<password tag>.<hmac>` (HMAC-SHA256 with the install token; HttpOnly, SameSite=Strict, no Max-Age). The password tag changes with the password, so a new password signs every browser out of that profile.
- `POST /api/user-profiles/switch { id, password? }` checks the password (scrypt, constant time; 5 wrong tries per profile per minute, then 429) and sets the cookie. The page reloads in the new profile.
- **Without a valid cookie** a browser works in Default while Default has no password; when Default has one, it works in **no profile** (it sees no agent) until it switches.
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

`PUT /api/sessions/{id}/user-profile { userProfileId, password? }` (the agent's ⋯ → Move to profile…): the target's password when it has one. Everything that follows the agent goes with it; its sidebar place is cleared (it shows unplaced in the new profile). Its crew and plan keep theirs. A paired computer's agent moves on its computer (the call goes through the peer API).

## Deleting a profile

`DELETE /api/user-profiles/{id} { password? }`: its open agents are **archived** first (the developer's ruling; Archived keeps them), its phones and folders move to Default, and a tombstone stays so the paired computers learn it. If an agent cannot be archived the profile stays (409 `archive-failed`).

## Paired computers

- The profiles (id, name, colour, password hash, clock, deletion) sync with **every** paired computer over `POST /peer/v1/user-profiles` (bearer auth on the Tailscale-only peer listener): a full exchange each time a connection comes (back) online, the changed records on every change. Last write wins per profile (a hybrid clock; equal clocks by value). Default is never deleted by a peer. A hash of another shape is dropped. Each computer's default accounts stay its own.
- A paired computer's agents show in their own profile (`Session.userProfileId` on the wire; an older computer's are Default's).
- A move between computers keeps the agent's profile: the move runs in the initiating request's profile, which is the agent's (strict scope).
- Sidebar folders carry their profile in the D71 records (`userProfileId`; an older computer's arrive as Default's).

## Not scoped yet

`GET /api/history` (the CLI conversations on disk), Insights, `GET /api/team/needs-you`, `/api/team/state`, `/api/team/suggestions`, `GET /api/plans/state`, `GET /api/terminal-sessions` / `terminal-loops`, the `inboxChanged` count and plan / crew event ids on the hub (the pages read the scoped lists), and the classic (pre-v2) UI, which has no switcher (it works in the cookie's profile, else Default). A loose-row move counts its index in the whole list.

## Tests

| Test | Covers |
|---|---|
| `tests/server/user-profiles/profiles.test.ts` | three profiles (Default, Ann with a password, Bo): the lists, the password switch (wrong, 429, a forged cookie, a new password), 404 for another profile's agent, folders per profile, move, delete (archive), a locked Default, a new agent's profile, the hub transform, the peers' merge |
| `tests/server/peers/user-profiles.test.ts` | two real Switchboards: a profile and its password sync, a rename comes back, a delete goes everywhere |
| `tests/e2e/v2-profiles.spec.ts` | the rail switcher with three profiles and a password |
