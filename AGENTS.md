# AGENTS.md — switchboard

Location: `~/RiderProjects/Personal/switchboard` (a standalone repo; it began in the Acme workspace's `other/` folder). This is a non-product company tool: the product per-type rules don't apply. These rules do, and so does the workspace router's universal canon where relevant (no inference, reuse-first, no unsolicited refactors, blocked-task behavior, living document).

## Scope
- Work only inside this repo. Never edit other workspace folders, even though the app reads them.
- The handoff in `docs/handoff/` is the spec. `SPEC.md` + the prototype define the UI; `contracts/local-api.md` defines the service/UI contract. `docs/decisions.md` records the developer's rulings on top of the handoff and **wins over the handoff where they differ**. If something is still ambiguous → follow the loop's escalation policy in `docs/handoff/LOOP.md`.

## Engineering
- **One Node.js project** (single `package.json`, one process). No microservices, no second runtime, no code outside this repo.
- Node ≥ 24, TypeScript `strict`. The server runs TypeScript directly via Node's type stripping (erasable syntax only: no `enum`, no `namespace`, no parameter properties). The UI is React + Vite, built into `dist/web` and served by the same process.
- Fastify for HTTP; Server-Sent Events for `/hub`; built-in `node:sqlite` for storage with plain SQL migrations.
- Async end-to-end: no `execSync` / `spawnSync` / `readFileSync` / other sync I/O on request or event paths (startup config reads are fine).
- Exact-pinned dependency versions in `package.json` + a committed `package-lock.json`. Add a dependency only when it earns its place.
- Child processes use `spawn(cmd, argsArray, { shell: false })` only. Never a shell string.
- The UI binds to loopback (127.0.0.1) only. Keep the Host/Origin checks and the token cookie. The optional **peer listener** (D48, off by default) binds only the machine's Tailscale address and serves only the peer API, authenticated by per-peer tokens (`docs/peers.md`, `docs/security.md`).
- Tests never call the real `claude`, `gh`, `tailscale` or network (beyond loopback). Use `tools/fake-claude`, `tools/fake-gh`, `tools/fake-tailscale` and temp git repos / temp data folders; peers are two test servers on loopback ports.
- TSDoc on exported surface; `docs/*.md` for non-obvious behavior.

## Loop
- Follow `docs/handoff/LOOP.md`: max 5 attempts per item, state in `.loop/progress.md`, questions and assumptions in `.loop/questions.md`.
- Local commits per green item. No push, PR or merge without approval.

## Definition of done (per item)
`npm run typecheck`, `npm run lint` (if configured), `npm test` green, the item's oracle green, the visual match noted (where it applies), and progress updated.
