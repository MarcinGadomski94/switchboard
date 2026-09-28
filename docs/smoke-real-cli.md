# Real-CLI smoke (D13 check 2)

`npm run build && node tools/smoke/real-cli.ts`. A manual tool, never part of `npm test` (tests never call the real `claude`). Within D11: the real `claude` on **Haiku**, `--max-turns 3` (through `SWITCHBOARD_CLAUDE_EXTRA_ARGS`), a fixture workspace under `.spike/sandbox/real-cli-smoke/` (gitignored, one git repo `microfrontends/smoke-front`), fake gh, a temp data dir. It drives the built app through the UI and prints a JSON report; the chat screenshot stays in the sandbox (it shows the local path).

## Run 2026-09-28 (CLI 2.1.283, Haiku)
| Step | Result |
|---|---|
| New session from the modal (`smoke-front`, edits in place) | started; the first message = the task + the session-start answers block (M5.2); the agent confirmed the answers in one line instead of asking again |
| D6 permission mode | requested `auto`; Haiku has no auto mode, the CLI reported `default`, Switchboard switched the session to `acceptEdits` and showed "⚠ Auto mode is not available for this model: permissions use acceptEdits" |
| AskUserQuestion | reached the Inbox verbatim: “Which color do you prefer?” · Red · Blue (source `smoke-front`) |
| Answer in the Inbox | "Blue" sent; the answered bubble and "Answers written into the briefs…" in the chat |
| Reply | `Blue`; status `done`; 7 events; 10 s end to end |
| Footer | the Max meter showed a real reading from the CLI (M9.2) |

Verdict: **pass**. The supervisor, the stdio question pipeline, the Inbox, the first-turn payload and the D6 fallback all work against the real CLI.
