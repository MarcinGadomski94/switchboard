# Loop questions & assumptions

Format: `- [ASSUMED|BLOCKED|QUESTION] <item> · <decision or question> · why · how to revert`

- ASSUMED M0.1 · D6 default permission mode = `acceptEdits`, not `auto` · auto mode is gated by model (debug log: "model claude-haiku-4-5-20251001 does not support auto mode") and D11 only allows Haiku, so M0 could not prove auto works headless; the CLI silently downgrades an unsupported `auto` to `default` (which denies edits headless) · revert: once verified with a supported model, switch the default to `auto` and keep the `init.permissionMode` mismatch check (docs/spike-m0.md → Permission modes)
- ASSUMED M0.1 · Switchboard does not use `claude --bg` / `claude attach`; the live --bg round trip was not probed · the sandbox is untrusted and accepting the trust prompt writes ~/.claude.json (outside D12); --bg sessions are TUI-driven, so no stream-json/answers · revert: probe `claude --bg` in an already-trusted folder if bg/attach integration is wanted
- ASSUMED M0.1 · fixtures are byte-identical captures except the home dir (`/Users/<name>` → `/Users/dev`, `-Users-<name>` → `-Users-dev`) · keeps the developer's username out of committed files; NDJSON validity unaffected · revert: re-capture with `.spike/probe.mjs` and skip the scrub in `.spike/export.mjs`
