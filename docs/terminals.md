# Terminals (D170)

A real terminal (PowerShell, cmd, bash, zsh…) on this computer or on a paired one, in the browser: on this computer's own page, from a paired computer's Switchboard, and on a paired phone. No extra password per terminal: whoever can use this Switchboard (and its profile) can open one. That makes it **the most powerful thing Switchboard exposes**; see *Security* below and `docs/security.md` → *Terminals (D170)*.

Phase 1 (this) is terminals only. Phase 2 (an agent's CLI tab: the session's own interactive `claude --resume <id>` with a switch back to the chat) is designed for but not built: the service runs any **program** (argv, folder, environment, owner), not only a shell.

## Using it

- **Open:** the Terminals page (`/terminals`; the palette's *Terminals*, *More → Terminals* on a phone) → **New terminal**, or *+ New → New terminal* in the palette. Pick the computer (this one, or a paired one that is online), the shell, and the start folder (your home folder or one of the profile's saved folders). The terminal's page opens.
- **The page** (`/terminals/<machine>/<id>`, `local` = this computer): xterm.js fitted to the window, the Switchboard mono font, clickable links (opened in a new tab), **copy / paste** with Ctrl+Shift+C / Ctrl+Shift+V (⌘C / ⌘V on a Mac; plain Ctrl+C goes to the program as an interrupt). A dropped connection reconnects by itself (the scrollback is replayed); a paired computer that went away shows *unreachable* and keeps trying.
- **It keeps running** when you leave the page or close the browser: open it again from the list. Several tabs (or the phone and the PC) can show the same terminal at once; the last one to resize sets its size.
- **Close** (on the page or in the list) ends the shell and what runs under it, and every tab showing it.
- **On a phone** a key bar under the terminal: Esc, Tab, a sticky **Ctrl** (the next letter typed becomes its control character: Ctrl, then `c` = ^C), the four arrows, and ^C.

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

The process tracker (`docs/processes.md`) never touches a terminal's processes: they carry no `SWITCHBOARD_SESSION` marker (it is scrubbed even if Switchboard itself inherited one) and they are not in any session CLI's tree (their parent is Switchboard's pseudo-terminal host). So a long build or a dev server in a terminal is never idle-stopped and never shows under an agent's processes. A `claude` you start yourself in a terminal is a hooked session like one in any other terminal (`docs/processes.md` → *Hooked sessions*). Phase 2 must decide whether an agent's CLI tab carries its session's marker.

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

## Engineering

`src/core/terminals.ts` (limits, frames, `terminalEnv`, `shellLabel`), `src/server/terminals/service.ts` (`TerminalService`, `resolveShell`, `availableShells`), `src/server/terminals/socket.ts` (`serveTerminalSocket`, `pipeToPeer`), `src/server/api/terminals.ts` (routes; `@fastify/websocket`), `PeerService.openTerminalSocket` / `terminalSocket`, `PeerConnection.openSocket`, the peer listener's socket route, the device listener's upgrade forwarding. UI: `src/web/v2/terminals/*` (`TerminalsPage`, `TerminalPage`, `TerminalView`, `NewTerminalDialog`, `terminal-keys.ts`). Tests: `tests/core/terminals.test.ts`, `tests/server/terminals/terminals.test.ts` (a real pseudo-terminal running a Node echo program: round trip, scrollback, resize, close, profiles, start folders, guards, a phone), `tests/server/terminals/service.test.ts` (idle limit, cap, scrollback cap, env scrub, stop), `tests/server/peers/terminals.test.ts` (two servers on loopback), `tests/web/v2-terminals.test.ts`, `tests/e2e/v2-terminals.spec.ts`. Tests never start a real shell: `SWITCHBOARD_TEST_TERMINAL_ARGV` (a JSON argv) replaces it.

## Dependency

`@lydell/node-pty` 1.1.0: the same code as Microsoft's `node-pty` 1.1.0, published with a **prebuilt binary per platform** as optional packages (`@lydell/node-pty-win32-x64`, `-win32-arm64`, `-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64`) and **no install script**, so `npm ci` needs no compiler on any of the platforms Switchboard ships for. `node-pty` 1.1.0 itself ships no Linux prebuild and falls back to `node-gyp`. It is loaded lazily: a computer where the binary cannot load still starts; opening a terminal then says why (503).
