# `/hub`: live events (M2.3)

`GET /hub` is a Server-Sent Events stream (D5). Event names and payloads are the locked ones from `docs/handoff/contracts/local-api.md` → *Event hub*; all client → server traffic stays REST. Code: `src/server/hub/` (bus, SSE fan-out, service wiring) and `src/server/api/hub.ts` (the route). The browser side is `src/web/api/useHub.ts` (M1.4).

## Wire format
```
event: <name>
data: <payload as one line of camelCase JSON>

```
- `JSON.stringify` escapes line breaks inside strings, so every event has exactly one `data:` line.
- Response head: `200`, `Content-Type: text/event-stream` (exactly as the contract names it), `Cache-Control: no-store`, `Connection: keep-alive`, chunked. The head is flushed at once, so `EventSource.onopen` fires before the first event.
- A `: keepalive` comment every **10 s** (the contract's bound is 15 s). One timer for all clients, running only while at least one is connected.
- No `id:` and no `retry:` fields, and no replay: an event published while a client is disconnected is not kept for it. A client that reconnects refetches what it shows over REST (the views load through `useApi` and reload on the events). The browser's own reconnect handles dropped streams; `useHub.ts` backs off 2 s → 60 s while the server refuses the stream.

## Auth
The route is behind the same guard as every API call (`docs/security.md`): a foreign `Host` or `Origin` → 403, no valid `sb_token` cookie → 401 (JSON bodies). The stream sets no cookie. Only `GET` is served: no `HEAD` route (a HEAD request would hold a stream open that can carry no body), other methods → 404.

## The bus
`HubBus` (`src/server/hub/bus.ts`) is an in-process, typed publish/subscribe: `bus.publish(name, payload)` with the contract's `HubEvents` types from `src/core/api.ts`. Publishing is synchronous and never throws (a failing listener is reported). `main.ts` creates the bus and passes it to `buildApp`; services that `main.ts` builds later take the same bus. Route modules reach it as `ApiContext.bus`.

| Event | Payload | Published by | Since |
|---|---|---|---|
| `sessionUpdated` | `Session` | `SessionSupervisor.on('sessionUpdated')` (every status / attachment change), forwarded by `forwardServiceEvents` | M2.1 → wired in M2.3 |
| `event` | `{ sessionId, event: Event }` | `SessionSupervisor.on('event')` (every event insert or update: a merged assistant text or a closed tool call is sent again with the same `id`) | M2.1 → wired in M2.3 |
| `worktreeRemovable` | `Worktree` | `WorktreeManager.on('worktreeRemovable')` (once, when a worktree's PR is merged and removal is allowed) | M2.2 → wired in M2.3 |
| `questionBatch` | `{ sessionId, batchId, questions }` | the question pipeline (`QuestionPipeline.canUseTool`, once per new batch; `docs/questions.md`); the UI raises the toast, chime and OS notification (M3.4, `docs/notifications.md`) | M3.1 |
| `inboxChanged` | `{ count }` | whatever changes the Inbox, `bus.publish`: the question pipeline on every batch / permission item change, the `SystemItemService` when a system item is raised or closed (count = `inboxCount`) | M3.1 / M3.2 / M3.3 |
| `scheduleRun` | `{ scheduleId, result }` | the scheduler, `bus.publish` | M7.1 |
| `system` | `GET /api/system` shape | the hub itself: `providers.system.system()` every **5 s** while a client is connected | real provider M5.3 / M9.2; demo provider when `SWITCHBOARD_DEMO=1` |

`buildApp` wires the forwarding (`forwardServiceEvents`) for the supervisor and the worktree manager it is given, and stops it when the app closes.

**`system`.** Sent only when a `SystemProvider` exists; normal runs have none until M5.3, so they send no `system` event (nothing is invented, D13) and the footer reads "—". In demo mode the demo provider feeds it. No `system` event is sent on connect: the page loads `/api/system` itself. A provider call still running when the next tick comes is not doubled; a failing call is reported and that tick is skipped.

## Disconnects and shutdown
- A client that goes away (socket closed) is dropped at once. With no client left, the hub leaves the bus and stops its keepalive and `system` timers, so nothing runs for nobody.
- A client that stops reading is dropped once more than **8 MiB** is waiting for it (it reconnects and refetches), so a stuck tab cannot make the service buffer without bound.
- On `app.close()` (SIGINT / SIGTERM), a `preClose` hook ends every stream cleanly (the chunked terminator; the browser sees a normal end and reconnects later). Without it an open stream would keep `server.close()` waiting. A client arriving after that gets a 503 (Fastify's own while it closes, or the hub's `{"error":"closing"}`).

## Tests
- `tests/server/hub/hub.test.ts` — the contract oracle over a real socket on a 4871–4879 port: the guard, the head, keepalive timing, and every event name with its payload checked field by field against the `src/core/api.ts` types (compile-time exhaustive key lists): `sessionUpdated` / `event` from a fake-claude session started through `POST /api/sessions` compared with the REST responses, `worktreeRemovable` from a real worktree in a temp git repo with the fake gh, `questionBatch` / `inboxChanged` / `scheduleRun` published on the bus, `system` on the timer; disconnect cleanup and a clean end on close.
- `tests/server/hub/sse-hub.test.ts` — the bus, the forwarding, the framing, 503 after close, the slow-client cap, a failing or slow system provider.
- `tests/e2e/hub.spec.ts` — the page's `useHub` against the real route (fake-claude, no demo): a session started from the page appears in the sidebar without a reload.
- Hub timings are `buildApp({ hub: { keepaliveMs, systemIntervalMs, maxBufferedBytes } })`; the defaults are the production values above.
