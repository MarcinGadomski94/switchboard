# Probes for Codex CLI and OpenCode (D62)

D62 was built without either CLI installed (developer instruction). The protocols come from their source at **Codex `rust-v0.159.3`** and **OpenCode `v1.18.34`** (`docs/providers.md` → *Evidence*), and the tests drive fakes that model them (`tools/fake-codex`, `tools/fake-opencode`). Once a CLI is installed, these probes confirm the readings. Each one is read-only or sandboxed: run it in a throwaway folder (e.g. `.spike/sandbox/providers/`, gitignored), on the cheapest model, with at most 3 turns, and kill every process afterwards. Record each result in `.loop/questions.md` → *D62 · Codex CLI and OpenCode* as VERIFIED or as a finding (and fix the bridge / fake when one differs).

## Codex CLI
1. **Version and sign-in.** `codex --version` (expected `codex-cli <version>` on one line; Settings → CLIs shows the first line), `codex login status; echo $?` signed in (exit 0, "Logged in using …" on stderr) and with `CODEX_HOME` pointed at an empty temp folder (exit 1, "Not logged in").
2. **Handshake and models.** `codex app-server` in the sandbox; write `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"switchboard-probe","title":null,"version":"0"},"capabilities":{"experimentalApi":true}}}`, then `{"method":"initialized"}`, then `{"id":2,"method":"model/list","params":{}}`. Confirm: no `jsonrpc` field is needed; the `model/list` entries' field names (`model` vs `id` as the value to send back, `supportedReasoningEfforts[].reasoningEffort`, the wire casing of `xhigh`).
3. **A turn.** `thread/start {"cwd":"<sandbox>","approvalPolicy":"on-request","sandbox":"workspace-write"}` then `turn/start {"threadId":…, "input":[{"type":"text","text":"Reply with OK.","text_elements":[]}]}`. Record the order of `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, `thread/tokenUsage/updated`, `turn/completed`. Confirm `text_elements` casing (snake vs camel) and that `tokenUsage.last.inputTokens + cachedInputTokens` is the context size the CLI shows.
4. **Approval.** Ask for something that needs to leave the sandbox (e.g. `curl https://example.com` with network off). Confirm the `item/commandExecution/requestApproval` request's params, that `{"decision":"decline"}` lets the turn continue and `acceptForSession` stops later prompts.
5. **Question.** Ask the agent to ask you a multiple-choice question. Confirm whether `item/tool/requestUserInput` arrives with `experimentalApi: true` (and without it), and the reply shape `{answers: {<id>: {answers: [label]}}}`.
6. **Stop.** Start a long turn (`sleep 30` via a command), send `turn/interrupt {threadId, turnId}`. Confirm the interrupt's response comes before `turn/completed` with `status: "interrupted"`.
7. **Resume.** End the app-server (close stdin). Start a new one, `thread/resume {"threadId":…}`, then a turn asking for an earlier detail. Confirm the thread continues and the rollout file path (`thread.path`).
8. **Rate limits.** `account/rateLimits/read`: confirm `resetsAt` is unix **seconds** (Switchboard multiplies by 1000) and the window minutes (300 / 10080).
9. **Images.** A turn with `{"type":"localImage","path":"<abs png>"}`; confirm the reply describes it.
10. **MCP.** `codex mcp list --json` with no servers (expect `[]`) and after `codex mcp add probe -- node -e "…"` (confirm the `add` syntax, which Switchboard builds as `codex mcp add <name> [--env K=V …] -- <command> <args…>` / `codex mcp add <name> --url <url>`), then `codex mcp remove probe`.
11. **History.** List `$CODEX_HOME/sessions/**/rollout-*.jsonl`; confirm the first line is `{type: "session_meta", payload: {id, cwd, …}}` and user prompts are `response_item` `{type: "message", role: "user"}` lines.

## OpenCode
1. **Version and sign-in.** `opencode --version` (expected a bare `1.18.34`); `opencode auth list` with credentials and with `XDG_DATA_HOME` pointed at an empty temp folder (expected the line `0 credentials`; confirm the wording Switchboard looks for).
2. **Server start.** `OPENCODE_SERVER_PASSWORD=probe opencode serve --port 4999 --hostname 127.0.0.1` in the sandbox. Confirm the stdout line `opencode server listening on http://127.0.0.1:4999`, that requests without Basic auth get 401, and `GET /global/health`.
3. **Providers.** `GET /config/providers?directory=<sandbox>`: confirm `providers[].models{}` with `limit.context` and `variants`, and `default` (`{providerID: modelID}`).
4. **Events.** `GET /event?directory=<sandbox>` with `curl -N`: confirm `server.connected`, the `data:`-only framing and heartbeats.
5. **A turn.** `POST /session` then `POST /session/:id/prompt_async {"parts":[{"type":"text","text":"Reply with OK."}]}`. Record the order of `session.status busy`, `message.updated` (user, assistant), `message.part.updated` / `message.part.delta` (text), `step-finish`, `message.updated` with `time.completed` and `tokens`, `session.status idle`.
6. **Permission.** With `OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask"}}'`, ask it to run `ls`. Confirm `permission.asked` (`permission: "bash"`, `patterns`, `metadata`, `tool.callID`), the reply `POST /permission/:id/reply {"reply":"reject","message":"no"}`, and that `OPENCODE_CONFIG_CONTENT` merges with (and does not replace) the user's config.
7. **Question.** Ask it to ask a question; confirm `question.asked` and `POST /question/:id/reply {"answers":[["<label>"]]}`.
8. **Stop.** A long turn, then `POST /session/:id/abort`. Confirm `session.error` with `MessageAbortedError` and then `idle`.
9. **Subagent.** Ask it to use a subagent (the `task` tool). Confirm `session.created` with `parentID`, and where the tool part names the child session (`state.metadata.sessionId` is what Switchboard reads).
10. **Files.** A prompt with a `{"type":"file","mime":"image/png","url":"data:image/png;base64,…"}` part.
11. **Resume.** Stop the server, start it again, `GET /session/:id` and a new prompt in that session.
12. **History and MCP.** `opencode session list --format json` and `opencode export <id>` (shapes as in `docs/providers.md`); `opencode mcp list` with nothing configured ("No MCP servers configured").

## After the probes
- Every ASSUMED line under *D62* that a probe settles becomes VERIFIED (or a fix).
- Re-run the D62 tests (`tests/server/cli/*`, `tests/tools/fake-codex*.test.ts`, `tests/tools/fake-opencode*.test.ts`) after changing a fake.
