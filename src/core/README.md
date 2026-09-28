# src/core

Domain code with no HTTP: domain types, the stream-json parser, derivations, the workspace scanner, cron and worktree logic (`docs/handoff/ARCHITECTURE.md` → layout). Runs under Node type stripping like `src/server`, so erasable TypeScript only.

`api.ts` holds the local API's wire types (contract), shared by the server and the UI (`docs/lanes.md`).

M2.1: `stream-json.ts` (typed view of the CLI's stdout), `stdin.ts` (the lines Switchboard writes), `event-payload.ts` (`SessionEvent.payload` shapes) and `derive/` (event kinds gap #7, agents gap #8, artifacts gap #9, session status), documented in `docs/derivations.md`.

M8.2: `settings.ts` (the keys of `GET/PUT /api/settings`, defaults, which are editable; `docs/settings.md`) and `cron-label.ts` (readable cron labels in the prototype's wording).

M7.3: `artifacts-view.ts` (the global Artifacts view: type filters, `type=` parsing, the "Solution · branch" label and the search match, shared by `GET /api/artifacts` and the UI; `docs/derivations.md` → *Artifacts view*).

M7.4: `transcript.ts` (streaming parser of a Claude Code transcript into the facts History needs: prompts, commands, titles, the newest leaf's last text, slugs) and `history.ts` (which sessions History lists and what each row shows, the search match, the date format; shared by `GET /api/history` and the UI; `docs/derivations.md` → *History*).
