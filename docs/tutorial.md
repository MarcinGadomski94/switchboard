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
