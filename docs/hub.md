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
| `sessionUpdated` | `Session` | `SessionSupervisor.on('sessionUpdated')` (every status / attachment change; D33: a close or reopen, carrying `closedAt`, on which the sidebar reloads its list of open sessions), forwarded by `forwardServiceEvents` | M2.1 → wired in M2.3 |
| `event` | `{ sessionId, event: Event }` | `SessionSupervisor.on('event')` (every event insert or update: a merged assistant text or a closed tool call is sent again with the same `id`) | M2.1 → wired in M2.3 |
| `worktreeRemovable` | `Worktree` | `WorktreeManager.on('worktreeRemovable')` (once, when a worktree's PR is merged and removal is allowed) | M2.2 → wired in M2.3 |
| `questionBatch` | `{ sessionId, batchId, questions }` | the question pipeline (`QuestionPipeline.canUseTool`, once per new batch; `docs/questions.md`); the UI raises the toast, chime and OS notification (M3.4, `docs/notifications.md`) | M3.1 |
| `inboxChanged` | `{ count }` | whatever changes the Inbox, `bus.publish`: the question pipeline on every batch / permission item change, the `SystemItemService` when a system item is raised or closed (count = `inboxCount`) | M3.1 / M3.2 / M3.3 |
| `scheduleRun` | `{ scheduleId, result }` | the scheduler (`schedules/scheduler.ts`), `bus.publish`: a run starts (`running`), is skipped, or its result changes (`docs/schedules.md`) | M7.1 |
| `system` | `GET /api/system` shape | the hub itself: `providers.system.system()` every **5 s** while a client is connected | real provider M5.3 / M9.2; demo provider when `SWITCHBOARD_DEMO=1` |
| `activity` (additive, D19) | `{ sessionId, activity: SessionActivity \| null }` | `SessionSupervisor.on('activity')`, forwarded by `forwardServiceEvents`: the live activity of a session changed (`docs/derivations.md` → *Live activity*); `null` = no turn runs | D19 |
| `sidebarLayoutChanged` (additive, D54) | `SidebarLayout` | the sidebar routes (`src/server/api/sidebar.ts`), `bus.publish`, after every write (pin, place, folder create / rename / collapse / move / delete): the whole new layout; every tab replaces its own (`docs/sidebar.md`). Not on the peer event stream | D54 |
| `updateChanged` (additive, D55) | `UpdateStatus` | the updater (`src/server/updates/service.ts`), `bus.publish`, when a check starts or ends, at every step of an update, and when a banner is dismissed: the whole `GET /api/updates` answer (`docs/updates.md`). Not on the peer event stream | D55 |
| `machineState` (additive, fix · peer reconnects) | `Machine` (+ `removed: true`) | the peer service (`src/server/peers/service.ts`), `bus.publish`, on every change of a paired machine's connection (state, an attempt starting or failing, the next try scheduled), a pairing, a rename and a removal (`docs/peers.md` → *Connection states*). Not on the peer event stream (this machine's only). |
| `todosChanged` (additive, D68) | `{ sessionId, openCount, doneCount }` | the todo service (`src/server/todos/service.ts`), `bus.publish`, after every change of a session's todo list (the developer's routes, the agent's `/agent/v1/todos`, the hour's removal of done items), together with the session's `sessionUpdated` (its `openTodoCount`). Forwarded between peers (a peer's with its remote session id; this machine fetches that peer's todo groups first). `docs/todos.md`. |
| `reviewResolved` (additive, D79) | `{ sessionId, outcome }` (`merged` / `committed` / `discarded` / `sent-back` / `dismissed`; exactly this shape, `ReviewResolvedEvent`) | the review service (`src/server/reviews/service.ts`), once per resolution of a Review card (an action, or a pending card whose changes are gone → `dismissed`). The todo lane listens on the bus. This machine's only: never forwarded between peers. `docs/reviews.md`. |
| `reviewsChanged` (additive, D79) | `{ sessionId }` | the review service, when a session's card is raised, refreshed or acted on (with `inboxChanged`); the session header's badge reloads. Forwarded between peers (a peer's with its remote session id; this machine fetches that peer's reviews first). |
| `notice` (additive, D87) | `DeviceNotice` `{ id, kind, title, body, url, tag }` | the devices' push notifier (`src/server/devices/push/notifier.ts`), once per push-worthy happening (this machine's and the paired machines'), just before the web push goes to the devices not in front; a paired device's page shows it as a toast (`docs/devices.md`). This machine's only: never forwarded between peers. D87 also: `/hub?client=<id>` names the page for the devices' presence. |

`buildApp` wires the forwarding (`forwardServiceEvents`) for the supervisor and the worktree manager it is given, and stops it when the app closes.

**`activity` (D19, additive).** Thinking-token ticks can arrive many times a second, so each session sends **at most one `activity` per second** (`LatestThrottle` in `src/server/supervisor/activity-throttle.ts`, `SupervisorOptions.activityIntervalMs`, default 1 000 ms): the first change after a quiet second goes out at once, later changes fold into one trailing event with the newest value when the second is over (a trailing value equal to the last one sent is dropped). The throttle covers every change, the turn's end included, so the `null` of a short turn can come up to a second after its `sessionUpdated`; the payload itself is never stale, and `Session.activity` in REST and `sessionUpdated` is always the current value. A client that (re)connects reads it from `GET /api/sessions` / `GET /api/sessions/{id}`. The timestamps are the server's (ISO); clients tick the elapsed time themselves. D30: the payload also carries `background` (the pending background tasks) and is `background`, not `null`, while no turn runs but a task is pending; its `null` comes once the last task ended (its `system/task_notification`; D43: or a terminal `system/task_updated`) or the process ended. D43: a background workflow and every other background task the CLI reports count too (`docs/derivations.md` → *Background work*).

**`system`.** Sent only when a `SystemProvider` exists; normal runs have none until M5.3, so they send no `system` event (nothing is invented, D13) and the footer reads "—". M9.2 wraps the provider with the usage meter (`usagePct`, `usageResetsAt`, the additive `usageWarnings`; `docs/usage.md`), and the meter reads usage only while `clientCount` > 0. In demo mode the demo provider feeds it. No `system` event is sent on connect: the page loads `/api/system` itself. A provider call still running when the next tick comes is not doubled; a failing call is reported and that tick is skipped.

**D48 (`docs/peers.md`):** two more publishers, no new event names. The `PeerService` publishes each paired machine's `sessionUpdated`, `event`, `questionBatch` and `activity` with remote ids (`r~<machine>~<id>`), and an `inboxChanged` whose count adds the reachable peers' items; these are marked while published so the peer event streams of this machine never send them back out. The `HookService` (P4) publishes `sessionUpdated` and `event` of hooked terminal sessions (their status from the hooks, their chat from the transcript). The peer listener's own stream (`GET /peer/v1/events`) forwards this machine's `sessionUpdated`, `event`, `questionBatch`, `activity` and `inboxChanged` (its own count) to paired machines.

## Disconnects and shutdown
- A client that goes away (socket closed) is dropped at once. With no client left, the hub leaves the bus and stops its keepalive and `system` timers, so nothing runs for nobody.
- A client that stops reading is dropped once more than **8 MiB** is waiting for it (it reconnects and refetches), so a stuck tab cannot make the service buffer without bound.
- On `app.close()` (SIGINT / SIGTERM), a `preClose` hook ends every stream cleanly (the chunked terminator; the browser sees a normal end and reconnects later). Without it an open stream would keep `server.close()` waiting. A client arriving after that gets a 503 (Fastify's own while it closes, or the hub's `{"error":"closing"}`).

## Tests
- `tests/server/hub/hub.test.ts` — the contract oracle over a real socket on a 4871–4879 port: the guard, the head, keepalive timing, and every event name with its payload checked field by field against the `src/core/api.ts` types (compile-time exhaustive key lists): `sessionUpdated` / `event` from a fake-claude session started through `POST /api/sessions` compared with the REST responses, `worktreeRemovable` from a real worktree in a temp git repo with the fake gh, `questionBatch` / `inboxChanged` / `scheduleRun` published on the bus, `system` on the timer; disconnect cleanup and a clean end on close.
- `tests/server/hub/sse-hub.test.ts` — the bus, the forwarding, the framing, 503 after close, the slow-client cap, a failing or slow system provider.
- D30: `hub.test.ts` checks a background wait (`[fake:background-gh]`): `background` with its task field by field, REST agreeing while it waits (the status stays the turn's), `null` after the task's end and the CLI's own turn.
- D19: `hub.test.ts` also checks `activity` field by field from a real fake-claude turn (≥ 1 s apart, ending with `null`, agreeing with REST); `tests/server/supervisor/activity.test.ts` checks the derivation on the M0 recordings and the one-per-second throttle.
- `tests/e2e/hub.spec.ts` — the page's `useHub` against the real route (fake-claude, no demo): a session started from the page appears in the sidebar without a reload.
- Hub timings are `buildApp({ hub: { keepaliveMs, systemIntervalMs, maxBufferedBytes } })`; the defaults are the production values above.
