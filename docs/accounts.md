# CLI accounts and automatic switching on usage limits (D63)

Each CLI (Claude Code, Codex CLI, OpenCode) can have **more than one subscription login**, called an **account profile**. When a session hits its **session (5-hour) or weekly limit**, Switchboard moves it to the next account that still has allowance and it carries on, in the same chat and folder. Everything is controlled in **Settings → Accounts**; signing in and out is done from the same page. Switchboard never reads, stores or logs a token: the sign-in is the CLI's own (`docs/security.md` → *Accounts*).

Built from the CLIs' own behaviour (Claude Code 2.1.285 read from its binary; Codex and OpenCode from their source / OpenAPI, as D62), never against a real login: tests drive the fakes (`docs/fake-claude.md`, `docs/fake-codex.md`, `docs/fake-opencode.md` → *Accounts*). `docs/spike-providers.md` lists the probes to run with real accounts.

## Profiles
- **Default** (one per CLI, built in): the developer's own login, no folder override (the CLI's own `~/.claude`, `~/.codex`, OpenCode's data). It can be ordered, enabled / disabled and checked here, but **not signed in or out, renamed or deleted** here: it is the developer's own login, managed in a terminal (ASSUMED D63-default-readonly). Its folder is never touched or deleted.
- **Other profiles** (Add account): a name (1–40 characters, unique per CLI) and a folder Switchboard creates, `<dataDir>/profiles/<cli>/<id>` (mode 0700). A process of the profile runs with the folder in its environment: `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `XDG_DATA_HOME` (OpenCode: its data folder is `<dir>/opencode`; its *config* in `~/.config/opencode` is shared by itself, ASSUMED D63-opencode-data).
- Why a folder per account works on Claude Code: **VERIFIED** (2.1.285 binary, read-only) with `CLAUDE_CONFIG_DIR` set, the macOS Keychain service name carries a suffix `-<first 8 hex of sha256(config dir, NFC)>` (`CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides the folder used for the hash), so each folder holds its own subscription login; transcripts live under `<config dir>/projects/<cwd slug>/<session id>.jsonl`.
- **Priority order** per CLI (↑ ↓ buttons or drag and drop); **Enabled** toggle (a disabled profile is never a target and cannot be picked for a new session); **Delete** (confirm; refused for a Default or while a process runs on it; its sessions go back to the Default; its folder stays unless "Delete and remove its folder", and only a folder inside `<dataDir>/profiles/` is ever removed; its login is not signed out; a paused session whose conversation lives only in that folder should be switched to another account first, ASSUMED D63-delete).
- **Status** per profile: signed in / signed out / unknown with the account the CLI reports (Claude Code: `claude auth status --json` → email and plan; Codex: the line of `codex login status`; OpenCode: the credentials count of `auth list`; a non-Default OpenCode profile with none is signed out), the latest usage reading (`5h 62% · week 10%`, windows that have not reset), when it is spent ("Out of usage until 14:05 (session limit)") and how many open sessions run on it. **Check** (and **Check all**) runs the status commands again (cached 60 s otherwise).

### Sharing the Default's settings
Option per profile, **on by default** (a switched session must behave like the one before; ASSUMED D63-share-default-on). `src/server/accounts/share.ts`:

| CLI | Shared from the Default's folder (symlink; a copy where links are refused) | Never |
|---|---|---|
| Claude Code | `settings.json`, `CLAUDE.md`, `agents/`, `commands/`, `skills/`, `keybindings.json`; the user-level **MCP servers**: only the `mcpServers` key of `<config dir>/.claude.json` is **merged** into the profile's own `.claude.json` (the profile's own servers win) | `.credentials.json`, `projects/`, the account identity in `.claude.json`, anything else |
| Codex | `config.toml` (its `[mcp_servers]` too), `AGENTS.md`, `prompts/`, `skills/` | `auth.json`, `sessions/` |
| OpenCode | nothing to link: only the data folder is overridden, its config is shared already | its `auth.json`, SQLite store |

Existing files in the profile are never overwritten; turning the option on later links what is missing; `POST …/sync-settings` does it again after the Default changed. (Symlinks are followed by the CLIs; the MCP merge is a copy, so a server added to the Default later needs a sync.)

## Signing in and out from Settings
`src/server/accounts/signin.ts` → `SignInManager`; routes below. Sign-in runs the CLI's **own** login with the profile's folder in the environment:

| CLI | Sign in | Sign out |
|---|---|---|
| Claude Code | `claude auth login --claudeai [--email <optional email field>]` (**VERIFIED** options; output lines "Opening browser to sign in…", "If the browser didn't open, visit: <url>", "Paste code here if prompted > ", then "Login successful.") | `claude auth logout` |
| Codex | `codex login`; the **use a device code** checkbox adds `--device-auth` (the one-time code is shown with the verification page) | `codex logout` |
| OpenCode | an `opencode serve` on the profile's data folder and its provider OAuth routes (**VERIFIED** OpenAPI v1.18.34: `GET /provider/auth`, `POST /provider/{id}/oauth/authorize` → `{url, method: auto \| code, instructions}`, `POST /provider/{id}/oauth/callback`); or an **API key** field for providers that use keys (`PUT /auth/{id}` to that server only: never stored or logged) | the same server: `DELETE /auth/{id}` for every connected provider |

- **The page opens in a new tab** (D61's pattern): the click opens `about:blank`, the server answers with the URL the CLI printed (the first page URL that is not the CLI's own `http://localhost:<port>` callback server), the tab is pointed at it; the panel also keeps an "Open the sign-in page again" link. `BROWSER=true` is set on the login process so the CLI does not open a second tab by itself (best effort, ASSUMED D63-browser-env).
- **Progress and completion:** "Finish the sign-in in the tab that opened"; the page polls the sign-in every second; completion is **the CLI's status command** (every 2 s; for a re-sign-in of an account that was already signed in, the CLI's exit instead), or the login's exit 0 checked against the status. A signed-out answer after exit 0 is a failure.
- **5-minute limit:** then the login is stopped and the panel says "The sign-in was not finished in 5 minutes", with the terminal command and **Copy terminal command** (`CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai`, `CODEX_HOME=<dir> codex login`, `XDG_DATA_HOME=<dir> opencode auth login`), then **Check**. The command is shown from the start of the sign-in too.
- **A paired machine's profiles** (the page's *Machine* picker, through the D48 peer API): the login runs on that machine, the tab opens here, and when the browser cannot reach that machine's localhost callback the panel offers the **paste-back**: the address the browser ended on (a `http://localhost:…` redirect, delivered to the CLI's callback server **from that machine**; only loopback URLs are ever fetched) or the code (written to the CLI's stdin, or to OpenCode's `code` callback); Codex's device code needs no paste. (ASSUMED D63-paste-back: Claude Code takes the pasted code at its "Paste code here" prompt as printed; the redirect-URL delivery is the same path for Claude Code and Codex.)
- **Sign out** asks first, then runs the CLI's logout for that profile and checks the status again.

## Rules (all in Settings → Accounts)
Stored in the `accounts.settings` setting (`src/core/accounts.ts` → `AccountSettings`):

| Rule | Default |
|---|---|
| Switch accounts automatically (master) and per CLI | on, on (ASSUMED D63-defaults: adding a second account is the opt-in; a single login is never touched, see *Dormant*) |
| Switch earlier, before the limit error: **5-hour %** and **weekly %** (separate), on / off | on, 98 % and 98 % |
| After a reset: *Stay on the current account* or *Switch back to the first account* (an idle session on a lower-priority account returns to a higher one that has allowance again) | stay |
| New sessions start on: *the first account with allowance* or *a fixed account* (per CLI) | first with allowance |
| When every account of a CLI is out of usage: *Stop and notify* (an Inbox item) or *Switch to another CLI* (the D62 handover, CLI chosen) | stop and notify |
| Cooldown between two threshold / reset switches of one session (seconds; API only) | 120 |

**The decision** is the pure `decideAccountSwitch` (`src/core/accounts.ts`, tested exhaustively in `tests/core/accounts.test.ts`):
- **limit error** (always acts, cooldown or not): the profile is marked **spent until its reset** and the session goes to the first *other* profile with allowance (enabled, not signed out, not spent, under the thresholds; failing that just under 100 %); none left → the "every account is out of usage" rule;
- **threshold**: the profile is past a threshold → a profile under the thresholds, never a stop; nothing happens when there is none (the real limit error is the next trigger);
- **reset**: only for "switch back", only for an idle session;
- a **pinned** session never switches (a limit error still marks its profile and raises an Inbox item saying the session is pinned); toggles off → nothing;
- **no loops**: a profile known spent is never a target until its reset, and the periodic switches keep the cooldown.

**Limit detection** (`parseLimitError`): the **CLI's own error text** of a failed turn, plus the usage readings for the thresholds. Claude Code: "You've hit your session limit · resets 2pm" / "… weekly limit …" / "… Opus limit …" (**VERIFIED** strings in the 2.1.285 binary; its own `rate_limit` error kind); a monthly-spend, team-budget or credits message is *not* a plan limit and is left alone. Codex: "You've hit your usage limit … try again at …" (`usage_limit_reached`). OpenCode reports no plan windows, only the provider's 429 / quota error (ASSUMED D63-oc-limit). The **reset time** is read when the text has one ("resets 2pm", "resets Oct 5, 9am", "try again at 3:20 PM", "in 3 hours"; a time of day is read in this machine's zone, the next such time: ASSUMED D63-reset-zone); otherwise the usage reading's reset, otherwise a fallback by window (session 5 h, weekly 24 h, unknown 1 h: ASSUMED D63-reset-fallback).

**Dormant:** a CLI with a single enabled account is never touched: no marks, no switches, no Inbox items (unless "Switch to another CLI" is the rule, which then also works for a single login). The 30-second periodic check (thresholds, resets) runs only for live sessions and reads each profile's sign-in status first (cached 60 s), so a profile that is signed out is never a target.

**Every switch** is logged (`switchboard accounts: <session> switched account (<reason>)`), shown in the chat as a divider, and a **failed** switch (or "every account spent", or a pinned session at its limit) raises an **Inbox item** ("Could not switch the account of …", "Every Claude Code account is out of usage"; dismiss-only, once per session and reset).

## Per session
- **New-session forms** (Simple and Full): an **Account** select next to the CLI choice, shown when the CLI has more than one enabled account ("Account: automatic" = the rule; a spent account is listed marked, it can still be picked). `NewSession.profileId` (422 for another CLI's, disabled or unknown profile).
- **Header:** the account the session runs on, as a picker (**Switch account**: asks first, then the switch), and a **Pin** toggle (aria-pressed) that stops automatic switching for the session. Shown when the CLI has more than one account. While a switch runs: "Switching account…" (`Session.accountSwitching`); messages, Resume and Attach answer 409 `switching`.
- The session's profile is `sessions.profile_id` (NULL = the Default of its CLI); `GET /api/sessions` carries `profileId`, `profileName`, `profilePinned`. A mid-session **CLI** switch (D62) picks the new CLI's profile by the rule and clears the pin.

## Switching (`SessionSupervisor.switchAccount`)
Stop the process (D7's stop: interrupt, EOF, exit), **copy (never move)** the CLI's own conversation to the new profile's folder, record the new profile, spawn with the new folder, record the divider **"Switched account: A → B (session limit, resets 14:05)"** (lifecycle action `account-switched`, `fromProfile`, `toProfile`, `reason`):
- **Claude Code:** `projects/<cwd slug>/<id>.jsonl` and the `projects/<cwd slug>/<id>/` folder (subagents, tool results) are copied from the old folder to the new one, then `--resume <id>` with the new `CLAUDE_CONFIG_DIR`. The original stays (the old profile can resume it).
- **Codex:** the thread's rollout file is copied to the same `sessions/YYYY/MM/DD/` place under the new `CODEX_HOME` and `thread/resume` follows (**ASSUMED D63-codex-resume**: resume reads the rollout by thread id from its own home; unverified). If the copy fails, the D62 handover inside Codex is the fallback.
- **OpenCode:** its storage (SQLite) is not safely copyable: the D62 handover inside OpenCode (the chat exported under `<dataDir>/handovers/<session>/…-opencode-to-opencode.md`, a **new** OpenCode session on the new data folder reads it first).
- **A conversation that cannot be carried over** (any CLI) takes the same handover path (Claude Code starts a fresh conversation with the session's id and reads the exported chat), with a note in the chat saying why.
- **The interrupted turn is lost** (the turn the limit ended, or one the switch stopped): after the resume the session gets a short service message, "Continue where you left off: the account changed because of a usage limit, and the turn that was running was interrupted." (ASSUMED D63-continue; nothing is sent after a switch of an idle session or of a paused one).
- A **paused** session only changes profile (the divider is recorded, nothing starts; the next resume runs on the new profile). A switch that fails records an error step, brings the session back up on the account it had and leaves it there.

## Usage per account
- Claude Code readings carry their profile (`usage_readings.profile_id`; every earlier reading is the Default's). `UsageMeter` reads each enabled profile: a **live session of it between turns** answers `get_usage` (≤ 1 per minute); a profile with no live session is read by the **poller** with its `CLAUDE_CONFIG_DIR` (≤ 1 per 5 minutes, only while a `/hub` client is connected, as D17); `rate_limit_event`s of its turns bring free readings. One reading per tick.
- The meter's bars (`usagePct`, `usageWindows`) are the **active account's** (the one a new session would start on: the first with allowance, else the first enabled).
- **D66: the footer's usage grid** shows **one line per account**: a small `5h` / `Week` header, then per line a `●` on the active account (only while its CLI has more than one), the label (a Claude Code account by its profile name, another CLI's by its short label and the account's name: `Codex Work`; developer ruling 2026-10-04: also with a single account, `Default`), and a mini-bar with its % for the 5-hour and the weekly window (`—` while unknown). A spent account shows "out until 14:05" across its bars. The line's tooltip has each window's reset, the pace (Claude Code accounts keep D23 / D46's colors and marker on their bars) and each model's weekly limit in use. A click opens Settings → Accounts. Lines all have one height; with a single account overall the grid is one line.
- Where the lines come from: `SystemInfo.accountUsage` (only while a CLI has more than one enabled account), each row with its own `windows` (D66, additive): a Claude Code profile's from its own readings through the meter (`UsageMeter.profileWindows`: Session, Week and the model limits in use, read like `usageWindows`), a Codex profile's from the windows its sessions' bridges reported (`recordProviderUsage`); the active Claude Code account's bars are `usageWindows`. A CLI with a single account gets one line instead, named after it by `SystemInfo.activeAccounts` (`{ cli, profileId, name }` per CLI, sent also with one account; "Claude" / "Codex" while unknown, e.g. in demo mode): Claude Code from `usageWindows` (always listed), Codex from `cliUsage` (its windows carry `key`: `session` / `week`) while it has any. Every enabled account of a CLI with several has a line, `—` for a window that is unknown (ruling 2026-10-04); OpenCode reports no limits, so it has no line.

## Limits and open points (see `.loop/questions.md` → *D63 · CLI accounts*)
- Threshold switching needs fresh readings: the poller reads only while a Switchboard tab is open; during turns `rate_limit_event`s arrive anyway. The limit error always acts.
- History's terminal-conversation listing and Workflow runs' files (D51) look in the Default's Claude Code folder only; sessions on another profile show in the chat as always, their transcripts are found for Attach / long-message restore / the context meter across every profile folder.
- OpenCode has no plan-limit reporting: its accounts switch on the provider's 429 / quota error only; a Codex account's windows are known only while one of its sessions has reported them.
- Codex sign-in output (the URL line, the device code format) and `thread/resume` from a copied rollout were never run: marked unverified, probes in `docs/spike-providers.md`.
- Account routes are on the peer allow-list (`docs/peers.md`), the one place a peer may change another machine's configuration (pairing is the trust, D63-peer-routes).

## API
`docs/handoff/contracts/local-api.md` → *CLI accounts (D63)*. Code: `src/core/accounts.ts` (pure), `src/server/accounts/` (`service.ts`, `signin.ts`, `share.ts`, `transplant.ts`, `auto-switch.ts`), `src/server/api/accounts.ts`, `SessionSupervisor.switchAccount`, `src/server/usage/` (per profile), migration `0024_cli_accounts.sql` (`docs/database.md`), UI `src/web/views/settings/AccountsSection.tsx`, `src/web/views/session/AccountSwitcher.tsx`, `src/web/components/AccountPicker.tsx`.

## Tests
`tests/core/accounts.test.ts` (decision, parsers, settings), `tests/server/accounts/profiles.test.ts` (CRUD, folders, sharing, routes), `signin.test.ts` (the three CLIs' sign-in against the fakes, timeout, paste-back, sign out), `switch.test.ts` (Claude transcript copy + resume with the new `CLAUDE_CONFIG_DIR`, the continue message, the fallbacks, Codex rollout copy, OpenCode handover), `auto-switch.test.ts` (limit error → switch, no loops, pin, toggles, "switch to another CLI", thresholds, cooldown, switch back), `usage.test.ts` (per-profile readings, `accountUsage` and its D66 `windows`), `tests/server/db/migrate.test.ts` → *0024*, `tests/web/accounts.test.ts` and `tests/web/format.test.ts` (D66: the grid's lines), `tests/e2e/accounts.spec.ts` (add a profile, sign in through the new tab, a session hits the limit and moves, the divider, Switch account, pin, order).
