# Terminals (D170)

A real terminal (PowerShell, cmd, bash, zsh…) on this computer or on a paired one, in the browser: on this computer's own page, from a paired computer's Switchboard, and on a paired phone. No extra password per terminal: whoever can use this Switchboard (and its profile) can open one. That makes it **the most powerful thing Switchboard exposes**; see *Security* below and `docs/security.md` → *Terminals (D170)*.

Phase 1 is the terminals themselves. Phase 2 (D171) is an agent's **CLI tab**: the agent's own conversation as the interactive `claude` in one of these terminals, with a switch back to the chat; see *CLI mode (D171)* below. The service runs any **program** (argv, folder, environment, owner), not only a shell.

## Using it

- **Open:** the Terminals page (`/terminals`; the sidebar's **Terminals** item since 2.5.2, the palette's *Terminals*, *More → Terminals* on a phone) → **New terminal**, or *+ New → New terminal* in the palette. Pick the computer (this one, or a paired one that is online), the shell, and the start folder (your home folder or one of the profile's saved folders). The terminal's page opens.
- **The page** (`/terminals/<machine>/<id>`, `local` = this computer): xterm.js fitted to the window, the Switchboard mono font, clickable links (opened in a new tab), **copy / paste** with Ctrl+Shift+C / Ctrl+Shift+V (⌘C / ⌘V on a Mac; plain Ctrl+C goes to the program as an interrupt). A dropped connection reconnects by itself (the scrollback is replayed); a paired computer that went away shows *unreachable* and keeps trying.
- **It keeps running** when you leave the page or close the browser: open it again from the list. Several tabs (or the phone and the PC) can show the same terminal at once; the last one to resize sets its size.
- **Close** (on the page or in the list) ends the shell and what runs under it, and every tab showing it.
- **On a phone** a key bar under the terminal: Esc, Tab, a sticky **Ctrl** (the next letter typed becomes its control character: Ctrl, then `c` = ^C), the four arrows, and ^C.

## Getting back to a terminal

A terminal keeps running when you leave its page. Before 2.5.2 the Terminals page had no entry in the desktop and tablet sidebar (only the palette and a phone's More), so a terminal you left was hard to find again. The sidebar now has a **Terminals** item between Tasks and Settings: it lights on the list and on a terminal's own page, and its badge counts the terminals open **on this computer** (read on each page change and every 15 s, `useOpenTerminalCount`; there is no hub event for terminals). Paired computers' terminals are not counted in the badge (it would poll every computer from every page); the Terminals page lists them. On a phone it stays under **More**.
## The agent's terminal (D182)

Under an agent's conversation, **Message | Terminal | Both** switches between the message box, a terminal, or both at once (the terminal above the message box; drag the line between them; Ctrl+` shows or hides the terminal; the choice and the height are remembered in this browser; a phone has the two tabs only).

- **Where:** the default shell in the agent's folder (its working folder: the workspace root for a workspace agent), on this computer, in the agent's profile. `POST /api/sessions/{id}/terminal` → the terminal (its socket, input and close are the ones above).
- **When:** it starts the first time Terminal or Both is shown. Back to Message only hides it. **Leaving the conversation closes it** (another agent or page, or the agent's CLI / Results / Timeline tab); a closed browser tab or a lost connection closes it 20 s after its last tab (`AGENT_TERMINAL_GRACE_MS`), so a reload reconnects.
- **Not on the Terminals page** (it lives with its conversation); it counts toward the 16.
- **Not for** a paired computer's agent (open a terminal on that computer from the Terminals page), an archived agent, or an agent whose folder is gone.

## Limits and settings

| | |
|---|---|
| Open terminals per computer | 16 (`TERMINAL_MAX_OPEN`), across profiles; the 17th is refused (409) |
| Scrollback kept on the server | the last 256 KB of output (`TERMINAL_SCROLLBACK_CHARS`), replayed on every attach; the browser keeps 5 000 lines |
| Idle limit | `terminals.idleHours` (default **12**, 0 = never, at most 168): a terminal **no tab has been showing** for that long is closed (checked once a minute). A terminal shown somewhere never idles out. |
| Input | at most 64 KB per frame; sizes 2–1000 columns / rows |
| Switchboard stops | every terminal ends (its program is killed); they are not restored after a restart |

`terminals.idleHours` is an editable setting (`PUT /api/settings`); it has no control in Settings yet (open).

## Shells

`GET /api/terminals` lists the shells this computer has (found on `PATH`):

- **Windows:** *Default* = PowerShell 7 (`pwsh.exe`), else Windows PowerShell, else `cmd.exe`; also Git Bash (`bash.exe --login`) when it is on `PATH`.
- **macOS / Linux:** *Default* = your login shell (`$SHELL -l`), else zsh, bash, sh; also `pwsh` when installed.

A shell is started directly by its argv in a pseudo-terminal (`@lydell/node-pty`, ConPTY on Windows), never through a shell string.

## The environment

A terminal gets Switchboard's own environment **minus Switchboard's variables**: every `SWITCHBOARD_*` (the data folder, test switches, a session marker), npm's `npm_*` (from `npm start`) and the test runner's `VITEST*`. `TERM=xterm-256color` and `COLORTERM=truecolor` are set. Nothing else is removed: your own `GITHUB_TOKEN`, `PATH` and the rest stay, as in any terminal you open yourself. `src/core/terminals.ts` → `terminalEnv`.

## Profiles (D165, D169)

A terminal belongs to the profile that opened it and only that profile sees, attaches to or closes it (another profile's terminal is 404, as if it did not exist). The start folder must be the home folder or inside one of the profile's **visible** saved folders, so a folder bound to another profile (D169) is refused. With profiles off (or the all-profiles scope) everything is visible. The cap (16) counts every profile's terminals.

## Processes (D127 idle stop)

The process tracker (`docs/processes.md`) never touches a terminal's processes: they carry no `SWITCHBOARD_SESSION` marker (it is scrubbed even if Switchboard itself inherited one) and they are not in any session CLI's tree (their parent is Switchboard's pseudo-terminal host). So a long build or a dev server in a terminal is never idle-stopped and never shows under an agent's processes. A `claude` you start yourself in a terminal is a hooked session like one in any other terminal (`docs/processes.md` → *Hooked sessions*). An agent's **CLI mode** terminal (D171) is the exception: it carries its agent's `SWITCHBOARD_SESSION` marker, so what that `claude` starts is the agent's, as in chat mode.

**Close** kills the pseudo-terminal: on Windows the console closes and every process attached to it ends; on macOS / Linux the shell's session gets SIGHUP. A program that detached itself on purpose (`nohup`, `setsid`, `Start-Process`) keeps running, as after closing any terminal window.

## Where it runs

| From | Path |
|---|---|
| This computer's browser | `/api/terminals…` and the WebSocket `/api/terminals/<id>/socket` on the loopback UI (token cookie, Host / Origin guard) |
| A paired phone (D73) | the same routes through the device listener (`tailscale serve`, HTTPS): the device credential, the devices' Host / Origin; listed in `DEVICE_ALLOWED` (`docs/devices.md`) |
| A paired computer's Switchboard (D48) | REST through the paired-machine proxy (`/api/machines/<id>/api/terminals…`, on `PEER_API_ALLOW`); the socket through `/api/machines/<id>/api/terminals/<tid>/socket`, which this Switchboard pipes to the peer listener's `/peer/v1/terminals/<tid>/socket` with the peer's bearer token and the requester's profile (`docs/peers.md`) |

## The socket

`GET /api/terminals/{id}/socket` (WebSocket, JSON text frames, `src/core/terminals.ts`):

- **Client → server:** `{ "t": "in", "d": "<text>" }` (typed / pasted), `{ "t": "resize", "cols": n, "rows": n }`.
- **Server → client:** `{ "t": "hello", "info": TerminalInfo, "scrollback": "<text>" }` first, then `{ "t": "out", "d": "<text>" }`, `{ "t": "exit", "code": n | null, "signal": n | null }` when the program ended (the terminal stays listed until closed), `{ "t": "closed", "reason": "closed" | "idle" | "stopping" }` before the socket closes.
- **Close codes:** 1000 the terminal was closed; 4404 no such terminal (or another profile's); 4502 the paired computer could not be reached.

Malformed frames are ignored. A refused upgrade (no token, a foreign Origin, a phone without a credential) is answered with its HTTP status and the connection is dropped.

## CLI mode (D171)

A Claude Code agent's page has a **CLI** tab next to Chat. Opening it switches the agent to **CLI mode**: the same conversation runs as the interactive `claude` (its own terminal screen, the native TUI) in a terminal of the agent's computer, and the tab shows that terminal. **Back to chat mode** returns it to Switchboard.

- **Entering** (`POST /api/sessions/{id}/cli-mode { cols?, rows?, stopTurn? }`): an idle agent switches when the tab opens. While a turn runs the tab offers **Wait** (it switches when the turn ends) or **Stop the turn and switch** (D7's interrupt, then the switch); the route answers 409 `turn-running` without `stopTurn`. Switchboard ends its own headless process (the chat records it, as a detach) and starts `claude --resume <claudeSessionId>` in a pseudo-terminal in the agent's folder.
- **The same launch** as the headless process: the account's config folder and environment (D60), the team member's access (D100), the model and effort, the permission mode (the one the CLI last reported; `default` or none → Switchboard's default), the extra folders (`--add-dir`), the `switchboard` MCP server, the standing instruction (`--append-system-prompt`) and the session's name. Not `-p`, not stream-json and no permission-prompt tool: the TUI asks in the terminal itself. `buildInteractiveClaudeArgs` in `src/server/supervisor/argv.ts`.
- **Followed through its hooks.** The D48 hook plan (`docs/peers.md` → *Hooked terminal sessions*) is injected into **this process only**, through `--settings` (nothing is written to the developer's `~/.claude`), and the agent is marked hooked while in CLI mode. So the Chat tab keeps following the conversation (the transcript), its questions and permission requests still reach **Needs you**, and the composer still works: a message goes to the hook mailbox and the waiter hook delivers it when the CLI stops (D48).
- **Going back** (`DELETE /api/sessions/{id}/cli-mode`, the CLI tab's and the chat's **Back to chat mode**): Switchboard sends Ctrl+C twice to the TUI (its own clean exit), waits up to 5 s, then closes the terminal, and continues the conversation through **D72's continue** (`docs/peers.md` → *Continuing a hooked session in Switchboard (D72)*): the same record becomes a Switchboard-run session again with `--resume`, its mailbox and held waiters handled as D72 does. If the CLI ends by itself (`/exit`, a crash, Close on the Terminals page, the idle limit), the agent goes back to chat mode the same way.
- **Restart:** the terminals end when Switchboard stops (above), so an agent in CLI mode is back in **chat mode** after a restart, with the chat line *Back in chat mode: its CLI terminal ended with the Switchboard restart*.
- **Where:** the routes are on `PEER_API_ALLOW` (an agent of a paired computer, through `/api/machines/{id}/api/sessions/{sid}/cli-mode`) and `DEVICE_ALLOWED` (a paired phone); the terminal's socket is D170's (*Where it runs*). The terminal belongs to the agent's profile and is listed on the Terminals page as *claude · <title>*; it counts toward the 16.
- **Who gets the tab:** Claude Code agents, team members and plan runs. Not Codex or OpenCode agents (*not available yet*), not chats (D106), not hooked terminal sessions started outside Switchboard (they already are a CLI), not archived or moved agents, not a paired computer that is offline. Another profile's agent is 404.
- **ASSUMED (the developer may change them):** back in chat mode after a restart; Codex / OpenCode not yet; chats excluded; the composer's message waits for the CLI's next stop (the D48 mailbox); an idle-closed or closed CLI terminal returns the agent to chat mode; the switch records the "Continued in a terminal" line (the detach stop is reused) and going back D72's divider.

Engineering: `src/server/cli-mode/service.ts` (`CliModeService`: enter, back, the terminal's end, restart recovery), `src/server/api/cli-mode.ts`, `Supervisor.cliModeRefusal` / `cliModeLaunch` / `enterCliMode` / `restoreChatMode`, `HookService.adopted`, `TerminalService`'s `onEnd` / `write` / `closeAny`, migration `0058_session_cli_mode.sql` (`sessions.cli_terminal_id`; `Session.cliMode`). UI: `src/web/v2/agent/CliTab.tsx`, `cli-tab-model.ts`, the header's *In CLI mode* note. Tests: `tests/server/cli-mode/cli-mode.test.ts` (a fake pseudo-terminal: the argv and hooks, the hook calls and mailbox, back, a running turn, the CLI exiting by itself, a restart, the refusals, the allow-lists), `tests/web/v2-cli-tab.test.ts`.

## Engineering

`src/core/terminals.ts` (limits, frames, `terminalEnv`, `shellLabel`), `src/server/terminals/service.ts` (`TerminalService`, `resolveShell`, `availableShells`), `src/server/terminals/socket.ts` (`serveTerminalSocket`, `pipeToPeer`), `src/server/api/terminals.ts` (routes; `@fastify/websocket`), `PeerService.openTerminalSocket` / `terminalSocket`, `PeerConnection.openSocket`, the peer listener's socket route, the device listener's upgrade forwarding. UI: `src/web/v2/terminals/*` (`TerminalsPage`, `TerminalPage`, `TerminalView`, `NewTerminalDialog`, `terminal-keys.ts`). Tests: `tests/core/terminals.test.ts`, `tests/server/terminals/terminals.test.ts` (a real pseudo-terminal running a Node echo program: round trip, scrollback, resize, close, profiles, start folders, guards, a phone), `tests/server/terminals/service.test.ts` (idle limit, cap, scrollback cap, env scrub, stop), `tests/server/peers/terminals.test.ts` (two servers on loopback), `tests/web/v2-terminals.test.ts`, `tests/e2e/v2-terminals.spec.ts`. Tests never start a real shell: `SWITCHBOARD_TEST_TERMINAL_ARGV` (a JSON argv) replaces it.

## Dependency

`@lydell/node-pty` 1.1.0: the same code as Microsoft's `node-pty` 1.1.0, published with a **prebuilt binary per platform** as optional packages (`@lydell/node-pty-win32-x64`, `-win32-arm64`, `-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64`) and **no install script**, so `npm ci` needs no compiler on any of the platforms Switchboard ships for. `node-pty` 1.1.0 itself ships no Linux prebuild and falls back to `node-gyp`. It is loaded lazily: a computer where the binary cannot load still starts; opening a terminal then says why (503).
