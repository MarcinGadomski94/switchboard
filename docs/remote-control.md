# Remote Control on Switchboard's own sessions (D24)

Developer ruling D24 (`docs/decisions.md`, design A of `docs/spike-remote.md`): a session Switchboard supervises can be made **reachable from the phone** (claude.ai/code and the Claude app) through the CLI's Remote Control, while Switchboard stays the primary host. Nobody has run the real `remote_control` request yet (the spike read it in the CLI's code; P1–P3 were not run), so the code builds to the spike's documented shapes, reads every reply defensively, shows every CLI error verbatim and never retries by itself. Tests use fake-claude only.

## How it works
| Step | What Switchboard does | Where |
|---|---|---|
| Spawn | Writes `{"type":"control_request","request_id":"sb-init-…","request":{"subtype":"initialize","hooks":null}}` **first**, before any user message, on every process (new, resume, attach, restart recovery, D16 move). Its reply's `remote_control_available` (exactly `true`, else not available) is stored as `sessions.remote_available` (reset to 0 at every spawn). No reply within 20 s = not available. | `LiveRemote.handshake` (`src/server/supervisor/remote.ts`), `SessionSupervisor.#spawn` |
| Turn on | `PUT /api/sessions/{id}/remote { "enabled": true }` → `{"subtype":"remote_control","enabled":true,"name":<display title>,"keep_session_on_exit":true}` (+ `"reattach_session_id":<cse_…>` when an earlier bridge left its id) and waits up to 60 s for the `control_response`. A success needs a `session_url` string that is an `https://` URL; `bridge_session_id` is kept when it is a string. Stored: `remote_enabled = 1`, `remote_session_url`, `remote_bridge_id`. | `LiveRemote.set`, `parseRemoteControlReply` (`src/core/remote-control.ts`) |
| Turn off | `{"subtype":"remote_control","enabled":false}`; `remote_enabled = 0`; the link and the `cse_…` id stay (the next "on" reattaches them). | same |
| New process | After `initialize`, a session with `remote_enabled` sends the "on" request again with `reattach_session_id` (pause/resume, D7 restart recovery, Attach here), so the claude.ai entry stays the same. | `LiveRemote.handshake` |
| Phone answers first | The CLI resolves the request with claude.ai's answer and writes `control_cancel_request`. When the bridge is on (or being started) and Switchboard is not stopping the process, the question batch closes as **answered on claude.ai** (`question_batches.answered_on`, state `answered`, no answers) and the request's event gets `answeredOn: "claude.ai"`. A stop's interrupt withdraws open requests as before (stale, M0.2). | supervisor `#onLine`, `StreamRecorder`, `QuestionPipeline.cancelled` |

Every step of one process runs one at a time (the handshake and its reattach, then the toggles in the order they came), so a toggle never overlaps a reattach. Already in the asked state = nothing is sent.

## Failures (never retried)
- **409 `not-live`**: no live process, or it is being stopped. The toggle is disabled then.
- **409 `remote-unavailable`**: the process's `initialize` did not report `remote_control_available: true` (not signed in with a claude.ai subscription, API key, Bedrock/Vertex, `disableRemoteControl`, …; R.9). Nothing is sent.
- **502 `remote-failed`**, `message` = the CLI's error text **verbatim** (or `claude's remote_control reply has no session_url: {…}`, `… not an https URL: …`, `claude did not answer the remote_control request within 60 s`, `the claude process ended before it answered …`). Remote stays off after a failed "on"; a failed "off" leaves it on. Each failure is also a chat step line (`remote` event, kind `error`).
- A failed **"on" that tried to reattach** drops the stored id and link, so the next click starts a new claude.ai entry (the old one may be archived). Nothing is sent again by itself.
- A failed **reattach after a new process** turns Remote off (`remote_enabled = 0`), records `Remote Control could not reconnect: <CLI text>` in the chat, and publishes the session; the stored id stays. A stop that cuts the reattach short changes nothing (the next process tries).
- An "off" whose process ends before it answers counts as off (the bridge ended with the process).

## API (additive; `docs/handoff/contracts/local-api.md` → *Remote Control (D24)*)
- `PUT /api/sessions/{id}/remote` `{ enabled: boolean }` → 200 Session · 404 · 422 `invalid` (field `enabled`) · 409 `not-live` / `remote-unavailable` · 502 `remote-failed`. `sessionUpdated` is published.
- `Session.remote`: `{ available, enabled, url } | null`. `available` = a live process whose `initialize` said `true`; `enabled` = the stored flag (on across a pause); `url` = the last bridge's link (kept after "off"). `null` for a session Switchboard never ran a process for (`remote_available` NULL: the demo's seeded sessions), so the demo header has no toggle.
- `Question.answeredOn: "claude.ai" | null`; answering such a batch is 409 `already-answered` ("… is already answered on claude.ai").
- `HistoryItem.remoteControl: true` on a terminal conversation whose transcript has a `{type:"bridge-session", …}` line (transcript facts v2); the row shows a **Remote Control** badge. Stored sessions get no badge (D24 badges terminal conversations).
- Events: `RemotePayload { type: "remote", action: "on" | "off" | "failed", reattach?, url?, enabled?, error? }` (chat step lines `✓ Remote Control on · <url>`, `✓ Remote Control on again · <url>`, `✓ Remote Control off`, `✕ Remote Control could not … : <CLI text>`); `RequestPayload` / `ToolPayload` gain `answeredOn`.

## UI
- **Session header**: a **Remote** toggle (a `role="switch"` button with a phone glyph) before Pause, in the header actions' style; green (`--status-done`) while on. The Remote buttons keep one line, and a long root path now wraps anywhere, so the actions never slide under the right panel. It is enabled only while the process is live and Remote Control is available; otherwise disabled with the reason as its tooltip (`title`, also `data-reason`): no live process ("resume the session first", or "reconnects when the session resumes" while on), not available (the `initialize` reason), or detached. A refused toggle shows the server's text (the CLI's, verbatim) in the header's error line.
- **Popover** (opens by itself once Remote is turned on; **Link & QR** reopens it; Esc, Close or a click outside closes it): the claude.ai link (new tab, `rel="noopener noreferrer"`), **Open**, **Copy link**, the link's **QR code** (SVG, dark modules on the light primary token, a 4-module quiet zone, error correction M) and the note "While Remote is on, the transcript is stored on Anthropic's servers."
- **Sidebar**: a small phone glyph (green) after the name of a running session with Remote on.
- **Chat**: a batch answered on the phone shows the answers bubble **Answered on claude.ai**; a permission request answered there reads `✓ Permission · … · answered on claude.ai` (chat and terminal tail).
- **History**: the **Remote Control** badge after the mode line of a terminal conversation that had it on.

### QR library
`uqr` **0.1.3** (exact pin), MIT (Project Nayuki's generator, ported by Anthony Fu / unjs), **no dependencies**, ESM, 27.5 kB `dist/index.mjs` (79 kB unpacked with the CJS build and types). Only `encode(text, { ecc: 'M', border: 4 })` is used; the modules are turned into one SVG path and drawn with React elements (`src/web/components/qr.ts`, `QrCode.tsx`), so no HTML string is injected.

## Not done (conservative choices, `.loop/questions.md` → *D24*)
- No `--remote-control-session-name-prefix switchboard` on the spawns (the spike's *Notes for A*): every enable names the entry explicitly, and D24 adds no CLI flag.
- No Settings → "Reachable from phone by default".
- Messages typed on the phone show in the chat however the CLI streams them (unverified: P2).
- fake-claude writes no `bridge-session` transcript line and models no phone-typed messages.

## Tests
`tests/core/remote-control.test.ts` (lines, reply parsing, History badge), `tests/server/supervisor/remote.test.ts` (`LiveRemote` against a stub host: failed off, a process ending mid-request, a dropped reattach id, one step at a time), `tests/server/api/remote-control.test.ts` (the real path with fake-claude: on/off, 404/422/409/502, persisted fields, reattach on resume and restart recovery, a failed reattach, answered on claude.ai), `tests/tools/fake-claude-remote.test.ts`, `tests/web/remote-control.test.ts` (toggle state and reason, QR, popover markup, chat), `tests/e2e/remote-control.spec.ts` (the UI on the real path).

## Trying it live (P1–P3)
1. **P1, on/off.** Start (or resume) a session and wait until it is idle. The **Remote** toggle turns clickable within a second or two (its tooltip says why if not). Click it: the popover opens with a `https://claude.ai/code/session_…` link and its QR code; the sidebar row shows the phone glyph; the chat gets `✓ Remote Control on · <link>`. Open the link (or scan the QR code with the phone): the session and its conversation so far appear in claude.ai / the Claude app under the session's title. Turn it off: the glyph goes, the chat gets `✓ Remote Control off`; check on claude.ai whether the entry was archived or kept.
2. **P2, the phone.** With Remote on, type "reply ok" on the phone: the turn runs in Switchboard's process (how the phone's message shows in Switchboard's chat is what P2 finds out). Then make the session ask a question or a permission (e.g. ask it to run `node -e 1`) and answer it **on the phone**: Switchboard's card turns into **Answered on claude.ai** (a permission's step line ends in `· answered on claude.ai`) and the Inbox item goes away. Answer the next one in Switchboard instead: it should disappear on the phone.
3. **P3, pause/resume.** With Remote on, Pause (the toggle stays on, disabled, "reconnects when the session resumes"), then Resume: the chat gets `✓ Remote Control on again · <link>` with the **same** link, and the phone keeps the same entry. Restarting Switchboard with a running Remote session does the same (D7).

### Troubleshooting
- **The toggle stays disabled on a running session**: its tooltip names the reason. "not available" means the process's `initialize` reply did not say `remote_control_available: true`: check `claude auth status` (a claude.ai subscription login) and that no `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_OAUTH_TOKEN` reaches the service's environment (R.9).
- **Turning it on fails**: the header shows the CLI's own words (e.g. workspace trust, version floor, eligibility, "cannot be enabled from inside a remote session"), and the same text is a red step line in the chat (`✕ Remote Control could not be turned on: …`). `… has no session_url: {…}` quotes the whole reply when the CLI answered success in a shape the spike did not expect. `… did not answer … within 60 s` means no reply came.
- **Remote turned itself off after a resume**: the chat has `✕ Remote Control could not reconnect: <CLI text>`; turning it on again reattaches the stored entry once more, and if that fails too, the stored entry is dropped so the next click starts a new one.
- **Logs.** Switchboard's own log (the terminal running `npm start`, or the service's log) only carries internal errors (`switchboard supervisor: …`); every CLI reply that matters is in the chat's `remote` step lines, the 502 text and `GET /api/sessions/{id}` (`remote`, the events). For the CLI's side, restart Switchboard for one test with `SWITCHBOARD_CLAUDE_EXTRA_ARGS='["--debug-file","/tmp/claude-remote-debug.log"]'` (dev only; the flag is in the CLI's help per the spike, not tried in `-p`) and look for the bridge / `remote_control` lines.
