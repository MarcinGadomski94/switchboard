# Tutorial (D85)

An interactive, explain-only tour: each step dims the page, cuts a rounded hole
around one element, and puts a card next to it with **what it is** and **what to
do**. Nothing on the page can be clicked while a tour runs; the card has
**Back · Next · Skip tour** (and **Skip all** in a chain of What's-new tours),
the keyboard has **→ ← Esc**, and focus stays inside the card.

- **Main tour**: ~15 steps over the whole app (`MAIN_TOUR` in `src/core/tutorial.ts`).
  Opens once by itself on a brand-new install (after the setup wizard when that
  runs), and again from **Settings → Tutorial → Show the tutorial** or **⌘K → Tutorial**.
- **What's new**: a 1–3 step mini-tour per feature, from a registry
  (`WHATS_NEW` in `src/core/tutorial.ts`). After an update, an install sees the
  mini-tours of the features introduced since the last version the tutorial ran
  on, once each, one after another. Each can be replayed from Settings → Tutorial.

Code: `src/core/tutorial.ts` (registry, rules, API types), `src/server/tutorial/service.ts`
(state), `src/server/api/tutorial.ts` (routes), `src/web/tutorial/` (the overlay, the
first-run gate, the run store), `src/web/views/settings/TutorialSection.tsx`.

## Two themes (D131): v2 tours and classic tours

Switchboard 2 has two UIs (`docs/v2.md`), and a tour can only highlight elements of the UI
on screen. So every tour belongs to one of them: `WhatsNewFeature.ui` is `'v2'` for a v2
tour and unset for a classic one (the main tour is classic). Each UI opens, lists and
replays only its own tours; the other UI's stay as they are stored (`pending` stays pending).

- **"Welcome to Switchboard 2"** (`welcome-v2`, `V2_WELCOME_ID`, version 2.0.0) is the v2
  tour, six steps: Home and Needs you · the start box · Agents and folders (List / Chats /
  Board, ⌘\) · one agent (the side panel ⌘. and each reply's ⋯ menu) · Projects and Crews
  (with D132's "always on", which the classic `graduated` tour tells) · Settings ›
  Appearance (switch to Classic). Its steps name `v2Route` (a v2 address, or `'agent'` for
  the newest open agent) instead of `route`, and these anchors:

  | Step | Anchors (first one on screen wins) | Where |
  |---|---|---|
  | home | `v2-home-needs`, `v2-needs` | Home's Needs-you heading (desktop / tablet); the top bar's Needs you button; the phone's Needs you tab |
  | start | `v2-start` | Home's start box (both layouts) |
  | agents | `v2-agents-view`, `v2-nav-agents`, `v2-tab-agents` | the List / Chats / Board switch (phone: its own switch) |
  | agent | `v2-agent-details` | the agent header's Details button (⌘.) |
  | projects-crews | `v2-nav-projects`, `v2-tab-more` | the rail's Projects; the phone's More tab |
  | appearance | `v2-theme` | Settings › Appearance's Theme switch |

  The rail and the phone tabs carry `v2-nav-<area>` / `v2-tab-<tab>` on every item.
- **When it opens:** on the first v2 load of a machine where it was never finished or
  skipped (`v2AutoTours`): an existing install has it `pending` after the update (like any
  What's-new tour); a brand-new install queues only the classic main tour, so in v2 the
  welcome opens in its place and the main tour stays pending for a switch to Classic.
  `autoOpen` (demo mode, `SWITCHBOARD_TUTORIAL=off`) applies as before. It is stored like
  every tour (`PUT /api/tutorial/tours/welcome-v2`): once per machine, shared by its
  browsers and phones. When it opened by itself, its outcome is also recorded for the
  classic tours it covers (`V2_COVERS`: `graduated`, `two-themes`) that were still pending.
- **"The Project graph, redrawn"** (`project-graph`, version 2.4.2, `ui: 'v2'`): one step on
  a project's Graph (`v2-project-graph`) when it is on screen, else on Projects in the rail
  (`v2-nav-projects`) or the phone's More tab (`v2-tab-more`); `v2Route: '/projects'`. A v2
  tour because the redrawn graph is v2-only (the classic plan graph is unchanged). An
  existing install that updates to 2.5 gets it `pending`, after the welcome when that is
  pending too (a chain: "(1 of 2)").
- **"The Project graph in full screen"** (`project-graph-fullscreen`, version 2.4.3, `ui: 'v2'`):
  one step on the graph's Full screen button (`v2-graph-fullscreen`), else the graph, Projects
  in the rail or More; `v2Route: '/projects'`. A tour of its own rather than a version bump
  of `project-graph`: a tour once completed or skipped never opens again (its row is never
  re-queued), so a new version on the same id would show nothing to installs that saw it.
  An existing install with all three pending gets them chained ("(1 of 3)").
- **"Pin a crew to the sidebar"** (`crews-pin`, version 2.4.4, `ui: 'v2'`): one step on the
  rail's Pinned list (`v2-rail-pins`), else Crews in the rail (`v2-nav-crews`) or the phone's
  More tab (`v2-tab-more`); `v2Route: '/crews'`. It also mentions the compact teammate cards.
  An existing install with every v2 tour pending gets them chained ("(1 of 5)").
- **The classic What's-new** gains `two-themes` (D131): one step on classic Settings →
  Appearance's Theme row (`theme-switch`). Existing installs that stay on Classic see it.
- **Replay:** v2 Settings › Advanced › What's new tours (`src/web/v2/tour/ToursSection.tsx`)
  lists the v2 tours with their state and replays them in v2 with highlights (recording
  nothing); a note says the other tours point at the Classic theme. Classic Settings →
  Tutorial lists and replays the classic tours only.
- **The v2 host** (`src/web/v2/tour/`): `TourHost.tsx` (the gate and the overlay, mounted by
  `shell/Shell.tsx`, rendered through the v2 `Portal`), `tour-model.ts` (the run store and
  the pure rules), `tour.css`. It reuses the classic geometry (`spotBox`, `placeCard`,
  `sheetEdge`): the card sits next to the cutout, a bottom (or top) sheet on phones; Back ·
  Next / Done · Skip tour (Skip all in a chain), → ← Esc, focus kept in the card and given
  back, the page's address restored at the end, reduced motion respected. A step without its
  anchor (no agent yet) shows its `missing` text in a centred card.
- **Adding a v2 tour:** append a `WhatsNewFeature` with `ui: 'v2'` (up to
  `MAX_V2_TOUR_STEPS` steps, each with `v2Route` and a `missing` text) and put `data-tour` on
  v2 elements (`Segmented` takes a `tour` prop). Tests: `tests/web/v2-tour.test.ts`,
  `tests/e2e/v2-tour.spec.ts`.

## What is stored (one state per machine)

Migration `0037_tutorial.sql` adds `tutorial_tours` (`tour` = `main` or a feature id,
`status` = `pending` / `completed` / `skipped`, the version and time it was written)
and two of the service's own settings keys: `tutorial.lastVersion` (the version the
tutorial system last ran on) and `tutorial.install` (`new` / `existing`).

The state belongs to the machine, not the browser: every browser and paired device
(D73) of one Switchboard shares it. A phone shows the same tour in its own layout
(below). A paired machine's peer API cannot read it (not on `PEER_API_ALLOW`).

## First run or an existing install

Decided once, in the database, by migration 0037:

- The database **had data** when 0037 ran (a session, a schedule, a saved folder or
  a finished setup): it is an install from before the tutorial. 0037 writes
  `tutorial.lastVersion = "1.12.0"` (`PRE_TUTORIAL_VERSION`). It gets the **What's-new**
  mini-tours of every feature after 1.12.0 (D76–D84; D89's *Artifacts are saved on purpose* in 1.14.0) and **not** the main tour (still
  replayable).
- The database was **empty** (a brand-new install): 0037 writes nothing. On the first
  `GET /api/tutorial` the service queues the **main tour** and no What's-new (the main
  tour covers what exists).

On every later start the first read catches up: features with a version newer than
`tutorial.lastVersion` are queued (`pending`) unless they already have a row, and
`tutorial.lastVersion` becomes this build's version (or the newest registry version,
if the registry is ahead of `package.json` on a build before the version bump).
Finished or skipped tours are never queued again.

**A replay records nothing**: only a tour that opened by itself is marked
`completed` (Next on its last step) or `skipped` (Skip tour, Skip all, Esc).

## When a tour opens by itself

The gate (`TourGate` in `src/web/tutorial/TourHost.tsx`) reads `GET /api/tutorial`
once per page load. `autoOpen` is `false` in demo mode and with
`SWITCHBOARD_TUTORIAL=off`; then nothing opens by itself (replays still work). Every
test server gets `SWITCHBOARD_TUTORIAL=off` from `testServerDefaults()`
(`tests/helpers/server-process.ts`), so no tour covers the page a spec or the visual
oracle drives; `tests/e2e/tutorial.spec.ts` turns it back on.

If the main tour is pending it runs; otherwise the pending What's-new tours run as a
chain. The gate waits while the setup wizard is open (and for it to open, when
`GET /api/setup` says it will), never opens over another modal, and never on the
phone's share page.

## How a step finds its element

Each step names `data-tour="…"` anchors in order of preference; the first one on
screen wins (laid out, not inside an `inert` / `aria-hidden` pane, so a closed drawer
does not count). Before looking, a step may:

- go to a `route` (`session` = the newest open session, on its Chat tab or, with
  `tab: 'diff'` (D90), its Diff tab; settings sections; Todos; the Inbox …), and
- on tablets and phones open the ☰ drawer (`drawer: true`, the element is in the
  sidebar) or close it (every other step). On desktop a hidden sidebar is shown for
  `drawer` steps and hidden again at the end.

It looks for ~1.8 s. Not found (no sessions yet, a feature switched off, a hidden
control): a step with a `missing` text shows a **centred card** with that text
under its explanation; a step with `missing: null` is **skipped** in the direction
of travel. A tour can never get stuck. At the end the page, the drawer and the focus
go back to where they were.

On phones (≤ 767 px) the card is a **bottom sheet** (moved to the top when the
highlighted element sits in the lower half); the cutout follows the element as it
scrolls or as a drawer slides in. With `prefers-reduced-motion` nothing animates.

Accessibility: the card is `role="dialog"` with `aria-modal`, labelled by its title
and described by its body; a polite live region reads "Tour, step 3 of 15: …"; Tab
cycles inside the card; the main button has focus on every step.

## Adding a step to the main tour

1. Put `data-tour="<name>"` on the element (a plain attribute: it changes no layout,
   so the visual oracle stays green). Don't reuse a `data-testid`.
2. Add a `TourStep` to `MAIN_TOUR`: `id`, `title`, `what`, `todo` (the developer's
   steps), `anchors`, optional `route` / `drawer`, and a `missing` text (the main
   tour never skips silently: `tests/server/tutorial/tutorial.test.ts` checks it).

## Adding a What's-new mini-tour (every new user-facing feature)

1. Put `data-tour` on what it points at (as above).
2. Append a `WhatsNewFeature` to `WHATS_NEW`:

   ```ts
   {
     id: 'my-feature',          // stable: stored per machine once seen
     decision: 'D86',
     version: '1.14.0',         // the version it ships in
     title: 'My feature',       // Settings → Tutorial lists it
     steps: [
       { id: 'where', title: '…', what: '…', todo: ['…'], anchors: ['my-feature'], route: { view: 'todos' }, missing: 'Shown once …' },
       { id: 'setting', title: '…', what: '…', todo: ['…'], anchors: ['setting-my-feature'], route: { view: 'settings', section: 'sessions' }, missing: null },
     ],
   }
   ```

   1–3 steps; the first always has a `missing` text; later optional ones may use `null`.
   A step's `route` may be `{ view: 'inbox' | 'todos' | 'schedules' | 'mcp' | 'artifacts' }`
   (D89 added `artifacts`), `{ view: 'settings', section }` or `{ view: 'session' }`.
3. That's all: installs updating to that version see it once; new installs see the
   main tour instead (add a main-tour step too if the feature is central).
