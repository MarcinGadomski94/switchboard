# Settings (M8.2)

SPEC → Settings: `230px nav | content (max 860px)` with seven sections, one per URL (`/settings/<section>`; `/settings` and unknown sections show Claude Code). Rows are label + description on the left and the value or control on the right, as in the prototype's `vSettings` markup. Preferences are stored by the service in SQLite; tool URLs are saved by Switchboard too (gap #13).

## API (`src/server/api/settings.ts`, keys in `src/core/settings.ts`)
The contract's `Settings` is a key → JSON value object. `GET /api/settings` returns every key below; `PUT /api/settings` takes any subset of the **editable** keys, stores them in one transaction (`settings.setMany`, table `settings`) and answers like `GET`. A read-only or unknown key, a wrong type or an out-of-range value → `422 {error:"invalid", errors:[{field, message}]}` and nothing is stored.

| Key | Kind | Value | Default / source | Read by |
|---|---|---|---|---|
| `sessions.worktrees` | editable | boolean | `true` | M5.1: pre-selects the Worktree toggle of the New-session form |
| `sessions.ultracode` | editable | boolean | `false` | M5.1: pre-selects Ultracode |
| `usage.warnAtPct` | editable | whole number 1–100 | `90` | M9.2: the usage warning threshold |
| `service.startAtLogin` | read-only | boolean | stored value, `false` until set | M9.1 owns the toggle and writes it when it installs the service |
| `service.address` | read-only | string | `127.0.0.1:<port>` from the configuration | Claude Code → Background service |
| `workspace.root` | read-only | string \| null | `SWITCHBOARD_WORKSPACE_ROOT`, `null` when not configured | Workspace & solutions |
| `workspace.router` | read-only | string \| null | the first `# ` heading of `<root>/AGENTS.md` (first 16 KiB, read asynchronously), `AGENTS.md` without one, `null` without the file or a root | Workspace & solutions |
| `github.prPollMinutes` | read-only | number | the worktree manager's `DEFAULT_PR_POLL_MS` (5) | GitHub → PR merge detection |

Nothing is stored until something is set; a stored value of the wrong type reads as the default. `GET` never returns other rows of the `settings` table (e.g. the demo marker `demo.seed`).

## The sections (`src/web/views/SettingsView.tsx`, `views/settings/*`, `views/settings.css`)
Values the API cannot tell read **unknown** (never invented).
- **Claude Code**: CLI (path + `detected` / `not found`) and Account (`signed in` / `not signed in`) from `GET /api/system` (M5.3); Background service `<service.address> · running` (the page is served by it); Bind address `localhost only`; Start at login `on`/`off`; Permissions `managed by Claude Code`, described as "Only agent questions and permission requests surface here." (D6: permission requests reach the Inbox); **Run setup again** opens the setup wizard (M5.3).
- **Workspace & solutions**: Workspace root = `<root> · <router title>` in Geist Mono (`not configured` / `no AGENTS.md`), **Rescan** asks `GET /api/solutions` again (the M6.1 scanner reads the router on every request). The scan table has one row per top-level folder: a solution's folder is the first segment of its path under the root, so the API's single "read-only" group splits back into `deprecated/` and `infrastructure/` (in the order its note names them); without a root the group's own folder is used. Count = solutions in the folder, examples = the first three names + ", …", rule = the strictest rule (`editable` #8d8c87, `on request only` / `read-only` oklch(0.72 0.1 70)). A failed scan shows a note instead of the table.
- **Sessions & worktrees**: fixed rules (workspace root, `../{repo}-wt-{session}`, keep until merged, from AGENTS.md) and the two editable defaults, shown like the prototype's values (`on` / `off`); a click flips and saves them.
- **Notifications & usage**: **Send test** shows the toast "Test notification · now · this is how questions arrive · Sound, toast and OS notification all fire together." (no session, so no Jump button), plays the two-tone chime (784 → 1046 Hz) and sends the OS notification "Switchboard / Test notification" when allowed. OS notifications shows the permission (`✓ allowed`, `✕ blocked in browser settings`, `not asked yet`, `not supported here`); **Allow** asks for it and confirms with "Notifications are on.". Warn at Max usage is a `<select>` styled as the value (50–100% in steps of 5, plus a stored odd value). Near the limit: `just warn`. The chime and OS-notification helpers (`views/settings/notify.ts`) copy the prototype's `beep()` / `notifyOS()`; M3.4's triggers should share them (the lane merge keeps one copy).
- **Schedules**: `GET /api/schedules` (M7.1): dot (paused = idle, else the last run's result color), name, the cron as a readable label (`src/core/cron-label.ts`: `02:00 daily`, `every 4h`, `08:30 weekdays`, `Mon 07:00`; anything else verbatim), description. "No schedules." when there are none (gap #6).
- **Embedded tools**: one card per tool (dot + state from the shared probe state: reachable / not reachable / checking… / not tested / not set; name, description, URL field, **Test**, **Open**), plus **Remove** on each card (after a confirm) and an **Add a tool** card (name + URL) (gap #14). Every change is a `PUT /api/tools` of the whole list (`docs/tools.md`), and the page announces it so the sidebar's TOOLS rows reload (`src/web/tools/events.ts`; `/hub` has no tools event). A URL is saved on blur or Enter, and before Test / Open; the service's 422 message shows under the field. The sidebar probes a newly saved URL (M8.1: probe state keyed by id + URL); a cleared URL reads "not set" at once without a request.
- **GitHub**: gh login (`✓ signed in` / `not signed in`, M5.3), PR merge detection `every <prPollMinutes> min`, Repositories = every solution of `GET /api/solutions` (`n repos`).

## Demo
The demo seed stores `service.startAtLogin: true` (`src/server/demo/data/setup.json` → `settings`), so Claude Code shows the prototype's "Start at login · on".

## Tests
- `tests/server/api/settings.test.ts`: defaults + reported values, PUT subsets, the values surviving a reopened database, every 422 case, root/router variants, stored mistyped values, the guard.
- `tests/web/settings-model.test.ts`: the scan table, the unknown values, repos/poll copy, schedule dots, notification copy, threshold options, `cronLabel` against the prototype's four schedules.
- `tests/e2e/settings.spec.ts` (oracle, real code path): the real server with fake-claude / fake gh, a fixture workspace and stub tool servers: every section and deep link, Run setup again, the router title, Rescan, toggles and threshold persisted across a service restart, Send test / Allow with a mocked `Notification` and `AudioContext`, the tool editor (invalid URL, save, Test, clear, add, Open, remove, reload) with the sidebar following. One test renders the scan table and the repository count from the real scan; it is marked `test.fail` until the lane merge wires M6.1's `GET /api/solutions` (D13), and the merge must remove that line. Another pins how contract-shaped `/api/system`, `/api/schedules` and `/api/solutions` answers render (answered in the browser).
- `tests/e2e/visual/settings.spec.ts`: D10 for all seven sections (`docs/visual/settings.md`).
