# Switchboard 2.0: the build plan

**Decision.** The developer approved Direction D v3 (artifact 999f185057) on 2026-10-25 and asked for it to be built in full, without questions:
- it becomes the **default "v2 theme"**;
- today's UI stays available as the **"classic" theme**;
- experimental features move to general release;
- it ships as **Switchboard 2.0.0**.

## Principles
- **Two UIs, one app.**
  - `src/web/v2/` holds the new UI. The current UI stays as it is ("classic").
  - Both talk to the same server, API, hub events and data.
  - A theme switch (`ui.theme: 'v2' | 'classic'`) lives in Settings in both UIs. It is per browser/device, with a server default of `v2`, and switches at once without a reload.
- **The prototype is the spec.** `docs/design/v2-prototype.html` (Direction D v3) is copied into the repo as the reference. Its screens, wording, plain-language names and behaviour are the target.
- **No new backend unless needed.**
  - v2 is a UI over today's APIs.
  - Small additive server changes are allowed where the UI needs data that no endpoint offers, for example one unified "needs you" feed.
  - Never edit shipped migrations. The next free migrations are main 0050 and plans.db 6.
- **Graduation.**
  - Team (shown as "Crews" in v2), Plans ("Projects") and Project memory ("Notes") become always-on in both themes.
  - The Experimental switches are removed, with a migration of their settings.
  - Classic keeps its current screens for them.
- **Plain language in v2 only.** The glossary module `src/web/v2/glossary.ts` is the single source of the v2 wording. Classic's wording is unchanged.
- **Quality.**
  - Responsive at desktop, tablet and phone.
  - Light and dark.
  - Status always shown as icon + word + colour.
  - 44 px touch targets.
  - Keyboard paths: ⌘K, ⌘⇧F, ⌘., ⌘\, Esc, 1–4 and M.
  - Reduced motion.
  - Live updates via `/hub`.
  - Peers (other computers) and phones (devices) work as in classic, including the allow-lists.
- **No questions to the developer.** Agents record assumptions in `docs/design/v2-decisions.md` (ASSUMED …) and continue.

## Branching
- An integration branch `v2` off master.
- Each lane works in its own worktree on `v2/<lane>`, cut from `v2`, and is merged back into `v2` by the orchestrator.
- At the end, `v2` merges into master and 2.0.0 is released.

## Lanes

**Phase 0 (in parallel)**
- **F: Foundation.**
  - The theme switch end to end (setting, client store, Settings rows in both themes, a no-flash boot).
  - v2 design tokens (light/dark, from the prototype).
  - Base components: Button, IconButton, Chip, StatusBadge, Card, Tabs, Segmented, Menu (⋯), Popover, Sheet, Drawer, Toast with Undo, Skeleton, EmptyState, Avatar, ComputerTag, Kbd.
  - The v2 shell:
    - a left rail with 6 items (Home · Agents · Projects · Crews · Results · Settings) plus a Pinned list;
    - a top bar with Search, ⌘K, a Needs-you count and the status pill (usage, computers, power, background apps);
    - a phone bottom tab bar;
    - the shortcuts list (`?`).
  - The v2 router: routes under the v2 shell, with deep links mapping 1:1 to classic routes where possible.
  - The glossary.
  - Shared **AnswerCard** (single-choice, multi-select with Other…, approval, ask with "Not waiting", stopped, Combine, alert; compact once answered) and **NeedsYou model** (one client-side store merging Inbox items, questions, permissions, waiting-for-you turns, plan stopped / needs-you / ready-for-approval items, crew asks, charters, access requests, memory approvals, routine failures and pick-code-projects, with a source tag). Both are used by several lanes.
  - Area stubs `src/web/v2/<area>/index.tsx` wired into the router, so the lanes never touch the router or shell.
  - Copies the prototype into `docs/design/`.
- **G: Graduation.**
  - Team, Plans and Memory are always on, with the switches removed (server + classic Settings → Experimental removed).
  - A settings migration.
  - The `*-removal.md` docs updated.
  - Tests updated.
  - Peers and devices allow-lists unchanged.

**Phase 1 (after F is merged into v2; up to 5 in parallel)**
- **H: Home + Needs you.** The Home page (start box, Needs you top 3 + See all, Working now, Done today) and the Needs-you page (filters, all kinds, empty state, Undo).
- **A: Agents.**
  - List / Chats / Board views, with the Board group-by Project | Crew | Folder.
  - The folder tree: pins, nested folders, drag, Move to folder (M), create / rename / delete, plan subfolders, Crews sections, other computers' agents with offline states.
  - Drafts card, Closed, Tasks board (Start here / Run in its own agent, import), Notes page (scopes), Routines pages.
- **S: Agent view.**
  - The chat: document-style replies, a line-length cap, Full width, Comfortable / Compact, grouped senders, collapsed activity rows, helper threads, results as attachments, in-chat AnswerCards.
  - The composer: attachments, drafts, queued and paused messages, ⌘↩.
  - The per-reply ⋯ menu.
  - A hideable side panel (⌘.) with How it works (model / engine / account / pin), Working memory + clean slate, Helpers, Background apps, Tasks, Handoff & terminal, Advanced.
  - Tabs: Chat / Changes / Results / Timeline / Helpers.
  - The agent ⋯ menu: Rename, Pause, Move to computer, Continue in terminal, Remote control, Routine, Notes, Make teammate.
  - The automatic-tests chip.
  - The peek sheet.
- **P: Projects + Crews.**
  - **Projects:** list, then detail with Steps / Board / Graph / Timeline views; approval modes; protected destination; per-step Hold; Combine / Send back; Reopen; stopped and needs-you steps; Jira import, Re-read and sync; delete; the run subfolder.
  - **Crews:** a list of all crews (ordered), crew detail with a switcher, teammates, job descriptions, access requests and keys, budgets, hand-offs, Move to crew / computer, Pause, New teammate (templates / adopt / return).
- **R: Results, Search, Insights, Settings, + New, ⌘K.**
  - **Results:** grid / list, filters, the drawer (versions, compare, source / rendered, full screen), PDF.
  - **Search:** filters, exact message, offline-not-searched note.
  - **Insights:** filters.
  - **Settings (v2):**
    - Usage & accounts: order, 98%, all-out rule, switch back, sign in / out, pin, paid extra;
    - Computers: pair, reconnect, power, background apps, shared accounts;
    - Phones: pair QR, per-kind notifications, revoke;
    - Rules for every agent;
    - Appearance: theme v2 / classic, density, light / dark;
    - Advanced: pages for each classic settings section — classic's sections may be reused or embedded where that is cleaner.
  - The **+ New** sheet: agent / conversation / task / project / routine / teammate / crew.
  - The **⌘K** palette (v2).

**Phase 2 (after Phase 1)**
- **X: Integration + polish.**
  - Cross-lane consistency, phone and tablet pass, light / dark contrast, reduced motion.
  - The v2 visual oracle and E2E suite (headless only).
  - The What's-new tour "Welcome to Switchboard 2".
  - The demo seed rendering in v2.
  - README and docs (`docs/v2.md`, theme switch, glossary), CHANGELOG 2.0.0.

**Release:** 2.0.0, with the normal release flow (worktree, targeted tests, package, smoke on a peer-stripped DB copy with process auto-stop off and pids cleared, push, tag, `gh release`).

## Test policy
- Targeted tests only, per lane.
- Browsers headless only, bundled shell, no channel.
- Each lane uses its own `SWITCHBOARD_TEST_PORTS` range.
- Classic E2E specs must stay green: classic is selected in those tests.
