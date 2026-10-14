# Multi-user mode (design proposal)

Status: **proposal, not decided.** No code, no D-number. Nothing here is built until the developer approves a direction (the open questions are at the end). Todo: "v2 (nice-to-have): Team mode (multiple developers, roles, handing sessions over)". The file keeps that name, `team-mode.md`.

> **Not D100 Team.** D100 Team (`docs/team.md`) runs several *role agents* ("members") for **one** developer from one page. Multi-user mode is about several **human developers** sharing Switchboard. The two are independent; section 9 covers how they meet.

Example names in this doc: Acme, `alice@acme.example`, `bob@acme.example`, machines `mac-alice` and `pc-bob`, tailnet `acme.ts.net`.

---

## 0. Where Switchboard is today

One install equals one person. Every door it opens authenticates a *thing*, never a *person*:

| Door | Listener | Credential | Who it really is today | Code / doc |
|---|---|---|---|---|
| UI | `127.0.0.1:13001` | `sb_token` cookie (`HttpOnly; SameSite=Strict`, issued on any page load with `Sec-Fetch-Site: none / same-origin`) | anyone who can open a browser on this machine | `src/server/security.ts`, `docs/security.md` |
| Devices (D73) | `127.0.0.1:13003`, published by `tailscale serve` on `:8443` | `__Host-sb_device` per-device cookie (hashed, revocable) + optional `Tailscale-User-Login` match | "the developer's phone" | `src/server/devices/`, `docs/devices.md` |
| Peers (D48) | Tailscale IPv4 `:13002`, plain HTTP over WireGuard | bearer token per pair and direction (sha256 stored) | "the developer's other machine" | `src/server/peers/`, `docs/peers.md` |
| Hooks (D48 P4) | UI listener, `/hook/*` | `<dataDir>/hook-token` | the developer's terminal `claude` | `docs/security.md` → *Hook endpoints* |
| Agents (D68) | UI listener, `/agent/*` | HMAC of the session id under `sb_token` | one session's own agent | `src/server/todos/agent-token.ts` |

Implicit single-user assumptions that a multi-user mode has to break or keep on purpose:

1. **Loopback = the owner.** The UI cookie is handed to *any* browser on this machine that loads the page directly. On a laptop that is the developer. On a shared host with several OS accounts (SSH, a build box) it is everyone with a shell.
2. **Pairing = full trust.** `PEER_API_ALLOW` (`src/server/peers/service.ts`) lets a paired machine manage this machine's CLI accounts and sign-ins (D63), MCP servers (D61) and take-over operations (D65). D98 exchanges account identities and usage. D71 merges the sidebar. D100 syncs `team.db`. D97 search fans out to every online peer. All of this is right for "my two computers" and wrong for "my colleague's computer".
3. **One Inbox, one "you".** Questions, permission requests (D6), plan merges (D99/D102), Team gates, Memory proposals (D107) and pushes (D73/D87) all go to "the developer".
4. **No owner column anywhere.** Sessions, todos, artifacts, loops, schedules and plans carry no author or owner.
5. **One OS user runs everything.** Every `claude` process runs as the host's OS user, with that user's files, keychain (D100-T2 access values) and CLI logins (D63 profiles under `<dataDir>/profiles/`).

---

## 1. Topology (decide this first)

Everything else depends on *where the other people's sessions run*.

| | **A. Shared host** | **B. Federation** | **C. Both** |
|---|---|---|---|
| Shape | one Switchboard; several people log in to it | every person runs their own Switchboard; installs pair *across people* | B by default, A for a shared build box |
| Whose CPU / repos | the host's | each person's own | — |
| Whose CLI login runs a session | the host's OS user (a D63 profile per person at best) | the session owner's own, on their own machine | — |
| Whose OS user can read everything | the host's (keychain, transcripts, profile folders) | each person reads only their own machine | — |
| Reuses | D73 device listener, `DEVICE_ALLOWED` | D48 peers, the proxy, D65 take-over | both |
| New trust surface | browsers of other people reaching `:8443` | colleagues' machines reaching `:13002` | both |
| Hand-over | change of owner on one machine | D65 take-over to the other person's machine | — |
| Fits | a team box, pair sessions, a lead watching | individual developers who collaborate | — |

**Risks of A:** every person's agent runs as the host's OS user, so "private" is only a UI promise against the host's owner; a member's CLI login stored on the host can be used by the host's OS user; one machine's subscription may end up serving several people (section 6).
**Risks of B:** two installs must both be upgraded; visibility enforcement lives in the *serving* install (a person cannot be forced to share what their machine holds back, which is the right direction).

**Recommendation: B first, A later and optional.** B keeps the per-install invariants unchanged (loopback trust, one CLI login per person, keychain per person), and most of the plumbing exists: the proxy already shows another machine's sessions, Inbox and search, and D65 already moves a session between machines. What B needs is a **narrower trust class for a peer that belongs to another person**. The rest of the doc covers both and marks what applies to which.

---

## 2. Identities

### Options

| Option | How | + | − / risk | Applies to |
|---|---|---|---|---|
| **2a. Local users** (password / passkey) | `people.db` with users; argon2/scrypt hash or a WebAuthn credential; login page on the device listener | no external dependency; passkeys need HTTPS, which `tailscale serve` provides | Switchboard becomes a password store; reset flows; brute-force limits; passkey UX per device | A |
| **2b. SSO** (OIDC: GitHub, Google, Entra) | OIDC code flow + PKCE; the callback on the `*.ts.net` origin | real identities; org offboarding | needs a client registration per install, a public-ish redirect URI, token handling, a library; outbound calls to the IdP; heavy for a local tool | A |
| **2c. Tailscale identity** | `Tailscale-User-Login` / `-Name` headers that `tailscale serve` adds (A); `tailscale whois <ip>` of the caller's address on the peer listener (B) | the tailnet already *is* the org directory; ACLs and offboarding come with it; zero passwords | **the headers can be forged** by any local process that calls `127.0.0.1:13003` directly, bypassing `tailscaled` (why D73 uses it only as an extra check); tagged nodes carry no user identity; node sharing across tailnets is UNVERIFIED | A, B |
| **2d. Per-device / per-pair credentials extended to people** | a pairing (D73 device, D48 peer) is approved by the owner *for a named person*; the credential then means "this person on this device" | already built, hashed, revocable, rate-limited, single-use codes; no login page; revoke is instant (sockets closed) | identity is only as good as the owner's choice at pairing; a person has several credentials to revoke | A, B |

### Notes

- **Spoofing (2c).** The device listener binds loopback, so a local process can send any `Tailscale-User-Login`. For B, the peer listener sees the real tailnet source address, so `tailscale whois` gives a *strong* identity of the calling node's user (UNVERIFIED for tagged nodes: they have no user). For A, possible hardening (to verify): have `tailscale serve` proxy to a Unix socket readable only by `tailscaled` and the owner, so no other local process can reach the listener.
- **Session cookies per person.** Whatever the identity, A needs a per-person browser credential. The `__Host-` per-device cookie (D73) already is one; it just has to carry a `personId`.

### Recommendation

**2d anchored by 2c**, with no passwords and no SSO:
- A person record is `{ id, displayName, tailscaleLogin, role }`.
- Pairing a device (A) or a machine (B) for someone else requires the owner to pick or create the person. The pairing code flow stays as it is (10 min, single use, 5 tries).
- The person's `tailscaleLogin` **must** match on every request: the `Tailscale-User-Login` header on A, `tailscale whois` of the source address on B. A mismatch → 401, and an audit entry.
- Revoking a person revokes all their credentials.

SSO (2b) goes to *what not to build*. Local passwords (2a) only come back if the developer needs people without Tailscale, which this design does not support (section 7).

---

## 3. Roles

Three roles, deliberately coarse. **Owner** is the person whose machine it is (the loopback user). There is exactly one owner per install.

| Capability | Owner | Member | Viewer |
|---|:-:|:-:|:-:|
| Machine administration: the `DEVICE_REFUSED` set (devices, machines, hooks, MCP edits, updates, Start at login, CLIs, accounts / sign-ins, tools, folders and setup, take-over start, terminal attach / teleport, test hooks) | ✓ (loopback only, as today) | — | — |
| People, roles, audit log | ✓ | — | own entries |
| Start sessions on this machine (A) / ask this machine to run one (B) | ✓ | ✓ (only if the owner allows "may run sessions here"; off by default) | — |
| Read shared / team-visible sessions, their diff, artifacts, todos | ✓ | ✓ | ✓ |
| Send messages, stop, pause / resume in sessions they own | ✓ | ✓ | — |
| … in sessions *shared with them as collaborator* | ✓ | ✓ | — |
| Answer questions (AskUserQuestion) | ✓ | owner of the session, or collaborator | — |
| Approve **permission requests** (D6) | ✓ | owner of the session only (default; delegation is a decision) | — |
| Plan merge step (D99 / D102), Team gates, Memory approvals (D107) | ✓ | of their own plans / members / folders | — |
| Hand-over (section 4) | ✓ | of their own sessions | — |
| Search (D97), Insights | ✓ all | what they can read | what they can read |

### Mapping onto route classes

The existing classification is the right skeleton. Every `/api` route is already on exactly one of `DEVICE_ALLOWED` / `DEVICE_REFUSED` (`src/server/devices/local-only.ts`, enforced by `tests/server/devices/units.test.ts`). Peers have `PEER_API_ALLOW`.

- **Owner on loopback:** unchanged, everything.
- **Owner's own devices and machines:** unchanged (`DEVICE_ALLOWED` / `PEER_API_ALLOW`).
- **Member:** `DEVICE_ALLOWED` ∩ a new `MEMBER_ALLOWED`. This removes, at least, the account / MCP / take-over operations that are on `PEER_API_ALLOW` today, D98's `POST /api/accounts/shared`, D71's `POST /peer/v1/sidebar`, D100's `POST /api/team/sync`, settings writes (`PUT /api/settings`: they are per-install), and the schedules / loops of sessions they do not own. Everything left is then **filtered by session visibility** (section 4).
- **Viewer:** the GET subset of the member's routes, plus `/hub`, filtered the same way.

Same mechanics as today: one list per role, a test that fails when a registered route is unclassified, and percent-decoded path matching (`docs/devices.md` → *What a device may do*). The list is the security boundary. The UI hiding a button is not.

**Risk:** the route lists alone do not filter *data*. `GET /api/sessions`, `/api/inbox`, `/api/search`, `/hub` events and pushes all return everything today, so each needs a per-person filter. That filter, not the route lists, is most of the work and most of the bug surface (section 10).

---

## 4. Per-session ownership, visibility and hand-over

### 4.1 Ownership and visibility

Every session (and chat, D106) gets an `ownerId` and a `visibility`:

| Visibility | Who sees it | Who may act |
|---|---|---|
| **private** | owner only (and the install owner, see below) | owner |
| **shared** | named people | collaborators act; viewers read |
| **team-visible** | every person paired with this install | owner acts; others read; "Ask to collaborate" |

- **Install owner and private sessions.** On A the install owner's OS user can read every transcript on disk anyway, so "private" means *hidden in the UI*, not *protected*. The UI must say so. On B the problem does not arise: a session lives on its owner's machine.
- **Default visibility.** This is a decision. The recommendation is **private**, with a per-folder default such as "sessions in `acme-api` are team-visible".
- **Derived objects follow their session:** todos (D68), artifacts (D89), attachments (D57), checkpoints (D80), loops (D94), subagent and workflow chats (D51), plan items' run sessions (D99).

### 4.2 Acting in a shared session

| Action | Rule (proposal) | Why |
|---|---|---|
| Send a message | owner + collaborators; each message records its author (`event.authorId`), and the chat shows "Bob:" on others' messages | the agent sees one conversation; authorship is for people and the audit log |
| Answer a question | owner + collaborators; first answer wins (today's batch semantics) | — |
| Approve a permission request | **owner only** by default | a permission runs code as the *machine owner's* OS user with the *session owner's* subscription |
| Merge (plan merge step) | owner of the plan | it writes to shared branches |
| Stop / pause | owner + collaborators | low risk, needed in emergencies |
| Close / delete / hand over | owner | irreversible or reassigning |

### 4.3 Inbox and Needs you, per person

- The Inbox (`listInbox` + `PeerService.remoteInbox()`) is filtered to the items the person **may act on**: owner-only permission items go only to the owner; question items go to the owner and collaborators.
- **Push (D73 / D87)** follows the same filter. Today a paired machine's items notify *this* machine's devices. For a person-peer that has to become "only items routed to me".
- D100's **Needs you** derives from the Inbox, so it inherits the filter. Team's own requests (gates, budget, access, charter) go to the owner of the member's session.
- Optional, phase 3: **escalation.** An item unanswered for N minutes is offered to the other collaborators. Out of the MVP.

### 4.4 Hand-over between people (reuse D65)

The D65 shape stays: **checks, then a move**, with a dialog preview and nothing changed before the checks pass.

| Topology | Hand-over is | Mechanism |
|---|---|---|
| A (one machine) | an owner change plus a visibility change | a database update; no files move; the CLI account of the session (D63 pin) has to change too, see below |
| B (two machines) | a D65 take-over *to the receiver's machine* | `TakeoverRunner` unchanged: WIP push, conversation transfer, apply, resume, source closed with "Moved to …" |

Additions to D65 for people:

1. **The receiver accepts.** A hand-over request lands in the receiver's Inbox ("Alice hands you *api-auth-fix*") with Accept / Decline. Today the *initiating* machine drives the run. For people, the receiver's machine starts the take-over after Accept, which reuses "Take over to this machine" as it already exists.
2. **The checks add:** the receiver has a CLI login for the session's CLI; the receiver's role allows starting sessions; the session is not mid-turn (as for a Team member move).
3. **The conversation moves in full.** The transcript, tool outputs, attachments and pasted content go to another person. That can include secrets the agent printed, and paths or names from the giver's machine. The dialog shows this and offers the alternative **"Hand over a summary"**: a D83 fresh session whose handover note travels instead of the transcript. D65's code still travels through git either way.
4. **Account change.** On B the session resumes under the receiver's CLI login (their machine, their D63 profiles), which is clean. On A the session's D63 profile pin has to move to a profile of the receiver's, else the giver keeps paying; it is a check that blocks.
5. **Pending items.** Open questions and permission requests are cancelled at the move (D65 already pauses), queued messages are marked handed over (as now), loops and schedules move (D100's move already does this without double firing), and D100-T2 access values never move (as now).
6. **Audit:** `handover.requested / accepted / declined / completed / rolled-back` (section 5).

---

## 5. Audit log

### What is recorded

Who (person id + credential id: device or peer), what, on which object, when, from which door (loopback / device / peer), and the outcome.

| Category | Events |
|---|---|
| Identity | person added / removed / role changed; pairing code made / used / failed; credential revoked; Tailscale-login mismatch |
| Access | 403 `local-only` / role refusals (sampled, at most 1 per person per route per minute) |
| Sessions | start, close, delete, visibility change, collaborator added / removed, hand-over steps |
| Control | message sent (id only, never the text), question answered, permission allowed / denied (tool name + one-line label, as in the Inbox), stop |
| Merges and writes | plan merge / open PR / send back (D99), Team gate approvals (D100), Memory approve / reject (D107), checkpoint revert (D80) |
| Admin | settings changed (keys only), multi-user switch on / off |

**Never recorded:** message bodies, tool inputs beyond the Inbox's one-line label, credential values, Team access values (D100-T2 already guarantees that).

### Storage, retention, display

- `<dataDir>/audit.db` with its own migrations, the same pattern as `team.db` / `plans.db`, so nothing goes into `switchboard.db`. It is append-only from the API: no update or delete route.
- Retention: **90 days** by default (decision), pruned at start like attachments' 30 days. Export as CSV / JSONL from Settings.
- Shown in Settings → **People → Audit** (the owner sees everything; a person sees their own lines), and as a short "who did what" strip in a shared session's Timeline.
- B: each machine audits what *it* served. No sync of audit logs between machines: an audit log is evidence of what this machine did, and merging copies would blur that.
- Risk: the audit log is only as trustworthy as the host. On A the host's OS user can edit `audit.db`. State that; don't pretend it is tamper-proof.

---

## 6. CLI accounts and logins vs people

| Option | How | + | − / risk |
|---|---|---|---|
| **6a. Each person's own login** | B: each machine signs in its own CLI (D63 as today). A: a D63 profile per person under `<dataDir>/profiles/<cli>/<id>`, signed in by that person, pinned to their sessions | usage and credits are per person; clean billing | A: the host's OS user can use the stored login, so the person must trust the host |
| **6b. Shared subscription accounts** | several people's sessions run on one Max / Team login | cheaper on paper | **ToS: unclear, needs checking (below)**; usage limits shared and contended; D63 auto-switch moves people's sessions between accounts silently |
| **6c. Organisation plan / API keys** | each person a seat on an org plan, or an org API key per person | billing designed for teams | API keys are billed per token; per-seat logins are still 6a in practice |

**ToS and terms: needs checking.** Whether one person's Claude subscription may serve sessions driven by other people, and whether driving Claude Code from a tool like this is within a given plan's terms at all, are **not** settled here and need a check of the current consumer and commercial terms. The second question is already open in `docs/decisions.md` → *Open for the developer*. This doc draws no legal conclusion. The design should **default to 6a** and must not make 6b easy: no "share this account with people" button.

### Billing, usage and credits (D63, D98, D103)

- **Usage attribution:** usage readings are per *account*, not per person. With 6a account = person, so the footer grid and Insights can say "Bob's account". With 6b they can't, and Insights would have to estimate per-person share from turns (coarse, like D100's budgets).
- **Credits (D103):** "Use credits" spends *money* of the account owner. In multi-user mode the switch from allowance to credits on someone else's session needs the account owner's consent. Proposal: credits only on the owner's own sessions; others' sessions *pause* (D103's existing "Pause new turns until an account resets" behaviour) instead of spending.
- **D98 account sharing** stays between *one person's* machines. It is never on for person-peers: it exchanges account identities (emails), usage and spent marks.
- **Auto-switch (D63)** never moves a session onto an account of another person.

---

## 7. Network exposure

| Topic | Rule |
|---|---|
| Reachability | Tailscale only. A: `tailscale serve` (HTTPS, `*.ts.net` certificate). B: the D48 peer listener on the Tailscale IPv4. **Never `tailscale funnel`**, never a LAN or public bind. Unchanged from `docs/security.md`. |
| ACLs per user | A tailnet policy grants each person access to the host's `:8443` (A) or `:13002` (B), e.g. `group:acme-devs` → `tag:switchboard:8443`. Switchboard can't enforce ACLs, but it can **read and show** who is allowed (`tailscale status --json` peers) and warn when the policy is wider than the people list. Note: a tagged host has no user, which is fine for the server side. |
| Identity source | A: the `Tailscale-User-Login` header (forgeable locally, see 2c). B: `tailscale whois` of the source address (strong). |
| TLS | A: terminated by `tailscaled` (serve). B: plain HTTP over WireGuard, as D48 does today; acceptable because WireGuard authenticates the node, and `whois` binds it to a person. |
| **Loopback cookie on a shared host** | The UI cookie goes to any local browser page load. On a single-user laptop that is fine. On a shared host with other OS users (SSH, a build box) **every local user becomes owner**. Mitigation for A: a host check that refuses multi-user mode while other interactive users are logged in, or (better) an owner passkey / a one-time owner code on the loopback page in multi-user mode. That is a decision. |
| CSRF / Origin | The Origin checks stay as they are and are per *origin*, not per person, so they still stop cross-site pages. New for A: per-person cookies on the device origin keep `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, plus the Origin check on writes (D73's step 3). |
| Cookie on `127.0.0.1` | It has no `Secure` and is shared by every loopback port's page (cookies are not port-isolated, `docs/security.md`). It must stay owner-only: never accepted on the device listener (as now), never issued with a person. |
| Hooks and agent tokens | `/hook/*` and `/agent/*` stay loopback-only. On A, a session's agent token is in a 0600 file of the host's OS user, so other *people* never hold one. |
| Peer API for person-peers | A separate trust class (section 3): no account / MCP / take-over-source operations, no D98 / D71 / D100 sync, no forwarding chains (already refused). |

---

## 8. Data model and migration

Pattern: the same **switchable and revertible** rule as D99 / D100 / D107. Settings → Experimental → **Multi-user** (`experimental.multiUser`, off by default), all data in `<dataDir>/people.db` and `<dataDir>/audit.db`, **no migration in `switchboard.db`**, hooks marked `Multi-user hook`, plus a removal doc (`docs/multi-user-removal.md`, like `docs/team-removal.md`).

`people.db` (sketch):

| Table | Columns |
|---|---|
| `people` | `id`, `display_name`, `tailscale_login`, `role` (`owner` / `member` / `viewer`), `created_at`, `revoked_at` |
| `credentials` | `person_id`, `kind` (`device` / `peer`), `ref` (device id / machine id) |
| `session_access` | `session_id` (local or `r~…`), `owner_id`, `visibility`, `updated_at` |
| `session_collaborators` | `session_id`, `person_id`, `role` (`collaborator` / `viewer`) |
| `handovers` | `id`, `session_id`, `from`, `to`, `state`, `takeover_run_id`, timestamps |

Message authorship (`authorId`) lives in `session_access`-style side data keyed by event id, not in the events table, so switching off loses nothing the core needs.

### Migration from a single-user install

1. Switching on creates `people.db` with **one person, the owner** (display name = the machine user's name, editable; `tailscale_login` read from `tailscale status --json` `Self`).
2. Every existing session, chat, plan and Team member is **owned by the owner, visibility private**. Nothing becomes visible to anyone by switching on.
3. Existing paired devices (D73) and machines (D48) are attached to the owner (they are the owner's) and keep their full trust. A machine paired *afterwards for a person* gets the person-peer class.
4. A missing `session_access` row means "owner, private". So sessions created while the switch was off, and every peer session from an install without multi-user, are private to the owner.

### Rollback

- **Switch off:** person-peers and members' devices are refused (401) while off; filters off; owner-only behaviour exactly as today. `people.db` / `audit.db` stay on disk; switching on again restores the state.
- **Remove:** delete the two files and the hooked code (the removal doc).
- **Mixed versions (B):** an older peer refuses the new person-peer handshake (403), so the pairing fails visibly. Never fall back to full trust.

---

## 9. Interaction with existing features

| Feature | Question | Proposal |
|---|---|---|
| **D100 Team** | whose agents? | Members belong to the owner of their session. A team is owned by one person; others see it read-only if the team is team-visible. Gates, budget, access and charter requests route to the member's session owner. `POST /api/team/sync` only between one person's own machines. Team access values (T2) stay in the keychain of the machine's OS user: on A, a member must never set up access values on someone else's host (refuse it). |
| **D99 Plans** | who merges? | A plan has an owner (its source session's owner). Only they start, change the merge mode or click Merge. Item run sessions inherit owner and visibility. Jira credentials (D99) are per install and never used for someone else's plan import on A without the owner's consent. |
| **D107 Memory** (in progress, `feature/memory`) | who approves? | Memory is per folder scope and injected into every session in that folder, so an approved entry affects other people's agents. Approval is the **install owner's** (or a per-folder "maintainer"; decision). A member may propose; their proposals carry the author. On B each machine has its own memory; there is no cross-person sync in the MVP. |
| **D97 Search** | leaks? | Filter results by visibility on the *serving* side: the peer answering a search drops what the caller may not read. Search must never be the side channel that bypasses visibility. History (terminal transcripts) stays owner-only. |
| **Insights** (in progress, `feature/insights`) | per person? | Per person only with 6a (account = person). Owner sees all; others see their own. Cost per todo uses the account's credits (D103). |
| **D48 peers** (multi-machine + multi-user) | two trust classes | **My machine** (today's `PEER_API_ALLOW`) vs **person-peer** (narrow, filtered). The class is chosen at pairing and shown in Settings → Machines. One person can have several machines; each person-peer pairing maps to exactly one person. |
| **D65 take-over** | between people? | Section 4.4: receiver accepts; summary option; account check. "My machine" take-over unchanged. |
| **D73 phones** | a member's phone? | A: a member's phone pairs as a device *of that person* (owner approves). B: a member's phone pairs with the member's own Switchboard; it sees the shared sessions through that install's proxy. |
| **D106 Chats** | private by nature? | Chats default to private and cannot be team-visible in the MVP (they hold thinking-out-loud). |
| **D71 shared sidebar / D98 accounts** | — | Own machines only; never with person-peers. |
| **D94 loops, schedules** | who fires? | They run as the session's owner. Members can't create loops in sessions they don't own. |
| **D64 standing instruction** | whose? | Per install (the owner's). On A, a member's sessions get the owner's instruction unless per-person instructions are added (phase 3). |

---

## 10. Effort, phasing, and what not to build

Agent pace: about **30–60 minutes per lane** (recent estimates ran high, so read these as upper bounds). Lanes in one phase can run in parallel.

### Phase 1: MVP, federation (B) with person-peers

| Lane | Scope | Est. |
|---|---|---|
| P1 | Switch, `people.db`, owner bootstrap, migration rules, removal doc | 45 min |
| P2 | Person-peer trust class: pairing for a person, `tailscale whois` check, `PERSON_PEER_ALLOW`, refuse D98 / D71 / D100 sync and account / MCP routes, the classification test | 60 min |
| P3 | Visibility: `session_access`, filters on sessions, Inbox, `/hub` / peer events, search, pushes | 60 min |
| P4 | Audit log (`audit.db`, writers at the doors and actions, Settings → People → Audit, export) | 45 min |
| P5 | Hand-over between people: request / accept in the Inbox, D65 run from the receiver, summary option, checks | 60 min |
| P6 | UI: Settings → People, visibility chip and Share… dialog, author labels in chat, What's new entry | 60 min |
| P7 | Two-process e2e (two people, two machines), security doc section, test classification | 60 min |

About **6–7 agent-hours** in total, or about 2–3 hours wall time with 3 lanes in parallel. It needs no change to the UI or device listeners' trust.

### Phase 2: shared host (A), only if wanted

Per-person device credentials (a person on the D73 cookie), `MEMBER_ALLOWED` / `VIEWER_ALLOWED` on the device listener, the owner gate for the loopback page on multi-user hosts, per-person D63 profile pinning, credits consent. **4–5 lanes, about 4 hours.**

### Phase 3: nice-to-haves

Collaborators answering permissions (delegation), Inbox escalation, per-person standing instructions, per-folder memory maintainers, Insights per person. About 1 lane each.

### What NOT to build

- **SSO / OIDC, local passwords, password reset.** Tailscale is the directory.
- **Any public exposure:** Funnel, a LAN bind, a reverse-proxy recipe.
- **Credential sharing:** copying or syncing CLI logins between people, or a "share this account" action (D98 already never copies credentials).
- **Fine-grained RBAC** beyond owner / member / viewer plus per-session collaborators.
- **Real-time co-editing** of one composer, or presence cursors. Authored messages are enough.
- **OS-level isolation per person on a shared host** (separate OS users or containers per person). If that is needed, use B.
- **Audit-log sync between machines,** or tamper-proofing claims.
- **Cross-person Memory or Team sync** in the MVP.

---

## 11. Recommendation

1. Build **federation (B)** first: every developer runs their own Switchboard; installs pair across people over Tailscale.
2. A pairing is approved for a **named person** and bound to their **Tailscale login**, checked by `tailscale whois` on every peer request. No passwords, no SSO.
3. Add a **person-peer trust class** next to today's "my machine" class: a narrow allow-list, no account / MCP / sync routes, the classification test extended.
4. Three roles: **owner / member / viewer**. Every session has an owner and a visibility: **private by default**, shared, or team-visible.
5. **Filter data on the serving side** (sessions, Inbox, `/hub`, search, push). The route lists are not enough.
6. **Permission requests stay owner-only** by default. Questions go to the owner and collaborators.
7. **Hand-over** is D65 take-over started by the receiver after Accept, with a "summary only" option. The account always becomes the receiver's own.
8. **Each person uses their own CLI login.** Shared subscriptions are not facilitated, pending a terms check by the developer. Credits are never spent on someone else's session without consent.
9. An **append-only `audit.db`** with 90-day retention, shown in Settings → People. Message bodies are never recorded.
10. **Experimental, off by default,** in its own `people.db` / `audit.db`, revertible with a removal doc. The shared host (A) is a later, optional phase.

---

## 12. Decisions for the developer

1. **Topology?** (a) federation only; (b) shared host only; (c) federation now, shared host later *(recommended)*; (d) don't build multi-user.
2. **Identity anchor?** (a) pairing for a named person plus a required Tailscale login match *(recommended)*; (b) pairing only (Tailscale login optional, as D73 today); (c) local passkeys; (d) SSO.
3. **Default visibility of new sessions?** (a) private *(recommended)*; (b) team-visible; (c) a per-folder default.
4. **Who may approve permission requests in a shared session?** (a) the session owner only *(recommended)*; (b) owner + collaborators; (c) owner, with per-session delegation.
5. **Hand-over content?** (a) full transcript plus code (D65 as is); (b) summary plus code (D83 fresh session); (c) the giver chooses each time *(recommended)*. And: must the receiver accept? (yes *(recommended)* / no)
6. **CLI logins?** (a) each person's own, shared accounts not supported *(recommended)*; (b) allow shared subscription accounts after a terms check; (c) decide after the terms check. Who does the terms check, and against which plan?
7. **Credits on others' sessions (D103)?** (a) never: pause instead *(recommended)*; (b) allowed with the account owner's per-session consent.
8. **Memory approvals (D107) with several people?** (a) install owner only *(recommended)*; (b) per-folder maintainers; (c) any member.
9. **Audit retention?** (a) 30 days; (b) 90 days *(recommended)*; (c) 1 year; (d) until deleted.
10. **Shared host and the loopback cookie** (only if A is wanted): (a) refuse multi-user mode while other OS users are logged in; (b) gate the loopback page with an owner passkey or code in multi-user mode; (c) accept the risk and document it.
