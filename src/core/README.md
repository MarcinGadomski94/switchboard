# src/core

Domain code with no HTTP: domain types, the stream-json parser, derivations, the workspace scanner, cron and worktree logic (`docs/handoff/ARCHITECTURE.md` → layout). Runs under Node type stripping like `src/server`, so erasable TypeScript only.

`api.ts` holds the local API's wire types (contract), shared by the server and the UI (`docs/lanes.md`).

M2.1: `stream-json.ts` (typed view of the CLI's stdout), `stdin.ts` (the lines Switchboard writes), `event-payload.ts` (`SessionEvent.payload` shapes) and `derive/` (event kinds gap #7, agents gap #8, artifacts gap #9, session status), documented in `docs/derivations.md`.

M8.2: `settings.ts` (the keys of `GET/PUT /api/settings`, defaults, which are editable; `docs/settings.md`) and `cron-label.ts` (readable cron labels in the prototype's wording).
