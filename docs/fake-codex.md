# tools/fake-codex (D62)

A stand-in for the OpenAI Codex CLI (`codex-cli 0.159.3`) with the surface Switchboard uses, modelled on the source read at `rust-v0.159.3` (`docs/providers.md` → *Evidence*). Tests never run the real `codex`; they start this through the same command the registry uses (`fakeCodexCommand()` / `fakeCodexBinEnv()` in `tools/fake-codex/command.ts`, as `SWITCHBOARD_CODEX_BIN`).

## Commands
- `--version` → `codex-cli 0.159.3`.
- `login status` → exit 0, `Logged in using ChatGPT` on stderr; with `FAKE_CODEX_SIGNED_OUT=1` exit 1, `Not logged in`.
- `mcp list --json` / `get <name>` / `add <name> [--env K=V …] (-- <command> <args…> | --url <url>)` / `remove <name>`: kept in `$CODEX_HOME/fake-mcp.json` (the real CLI keeps them in `config.toml`).
- `app-server`: newline-delimited JSON-RPC on stdio, **no** `jsonrpc` field. Requests before `initialize` → `-32002 Not initialized`; unknown methods → `-32601`. Handled: `initialize` (+ the `initialized` notification), `model/list` (two models with reasoning efforts; `FAKE_CODEX_MODELS=none` → none), `account/read`, `account/rateLimits/read` (`FAKE_CODEX_RATE_LIMITS=<primary>,<secondary>` used percent, default `12,40`), `thread/start` (writes a rollout file under `$CODEX_HOME/sessions/YYYY/MM/DD/`), `thread/resume` (refused when its rollout is gone), `thread/list`, `thread/read`, `turn/start`, `turn/interrupt`. EOF: a running turn finishes, then it exits 0.
- `resume` → refused (interactive).

## A turn
Every turn sends `turn/started`, the user item, a reasoning item, an `agentMessage` (`OK`, in two deltas), `thread/tokenUsage/updated` (21 000 tokens of a 272 000 window), `account/rateLimits/updated` and `turn/completed`. At 100 % in either limit window every turn fails with "You've hit your usage limit…" (`codexErrorInfo: usageLimitExceeded`). Tokens in the message:
- `[fake:say "<json string>"]` the reply; images in the input → `[fake-codex: N image(s)]`;
- `[fake:hold <s>]` waits (an interrupt ends the turn `interrupted`);
- `[fake:cmd <command>]` a `commandExecution` item (`fake-codex: ran <command>`);
- `[fake:write <path>]` a `fileChange` item and the file really written (inside the cwd only);
- `[fake:approve-cmd <command>]` / `[fake:approve-file <path>]` an approval request; `accept` / `acceptForSession` run it, `decline` declines, `cancel` interrupts (the decision is logged);
- `[fake:ask]` an `item/tool/requestUserInput` with one question (`color`: Red / Blue); the reply is `You chose <answer>`;
- `[fake:subagent <prompt>]` a `collabAgentToolCall` `spawnAgent`;
- `[fake:compact]` a `contextCompaction` item; `[fake:usage <tokens> [<window>]]`;
- `[fake:fail <message>]` an `error` and `turn/completed` `failed`;
- `[fake:handover]` a canned handover reply.

## Environment
`CODEX_HOME` (unset: nothing is kept and `thread/resume` fails), `FAKE_CODEX_LOG` (one JSON line per argv, stdin line and decision / answer), `FAKE_CODEX_SIGNED_OUT`, `FAKE_CODEX_RATE_LIMITS`, `FAKE_CODEX_MODELS`.
