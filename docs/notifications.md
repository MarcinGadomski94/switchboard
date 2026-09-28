# Notifications (M3.4)

A new question batch reaches the developer three ways at once (SPEC → Modals → Toast; contract: `/hub` `questionBatch` → "UI plays the sound, shows a toast and sends an OS notification"): the in-app toast, a two-tone chime and an OS notification.

## Files
| File | What |
|---|---|
| `src/web/toast/notify.ts` | No React: `questionNotice` (toast + OS notification content), `playChime` (Web Audio), `notifyOs` (Web Notifications API). Browser APIs are passed in, so `tests/web/notify.test.ts` covers them with doubles. |
| `src/web/toast/useQuestionNotifications.ts` | The `/hub` `questionBatch` handler, mounted by `ToastHost`. |
| `src/web/toast/ToastHost.tsx` | Toast state + rendering (M1.4); mounts the handler; the branch line only when there is one. |

## Trigger
Only `questionBatch` (one event per new batch, published by `QuestionPipeline.canUseTool`, `docs/questions.md`). Permission requests and system items reach the Inbox (`inboxChanged`) without a toast; the hub has no event of their own and the item names `questionBatch` as the trigger.

Per page and per batch, once: the handler reads the batch's Inbox item (`GET /api/inbox`, id = batch id) for the session name and branch chips, falls back to the session list (`GET /api/sessions`) for the name, and to the session id. Then the toast, the chime and the OS notification go out together. Every open tab does this; the OS notification's `tag` (`switchboard-batch-<batchId>`) lets the OS show it once.

## Toast
Prototype layout and copy (`arrive()`), with real data (D13):
- **title** = the session name (D22: its title, else its name: the Inbox item's `sourceTitle`, else the session list's display title); **sub** = `question · now`, or `n questions · now`;
- **branch line** = the Inbox item's branch chips as `<solution> ⎇ <branch>`, joined with ` · `; no line when the session has none;
- **text** = the first question, verbatim (SPEC → Copy rules). The prototype shows a hand-written summary of its mock question; a real batch has no summary to show.
- **Jump to session** → `/sessions/<id>` (chat tab) and the toast closes; **Later** and ✕ close it and the view stays. A newer toast shows over older ones; closing it shows the previous one (M1.4 behavior). No auto-dismiss (the prototype has none).

The toast sits top-right like the prototype, so it can cover what is there (e.g. the Inbox detail's "Open session →") until it is put away.

## Chime
The prototype's `beep()`: on a fresh `AudioContext`, 784 Hz at 0 s and 1046 Hz at 0.14 s; each tone's gain goes 0.0001 → 0.12 in 0.02 s → 0.0001 at 0.22 s and stops at 0.25 s. The context is closed 0.6 s later.

Browsers only let a page play sound after the developer has interacted with it (autoplay policy). A new context that starts `suspended` gets one `resume()`; if it is not running within 200 ms, nothing is scheduled and the context is closed, so a chime never plays late. Without Web Audio nothing plays and nothing fails.

## OS notification
Sent only when `Notification.permission === 'granted'` (prototype `notifyOS`): title `<session> needs you`, body = the same verbatim question, `tag` as above. Switchboard never asks for the permission on its own: Settings → Notifications & usage (M8.2) and the setup wizard (M5.3) do, on a click. A click on the notification focuses the page, closes the toast, jumps to the session and closes the notification.

## For later lanes
- **M8.2 Settings:** "Send test" can reuse `playChime()` + `notifyOs()`; "In-app toast + sound" / "OS notifications" preferences, if they become switchable, gate the calls in `useQuestionNotifications` (today every batch notifies).
- **M5.3 / M8.2:** "Allow notifications" calls `Notification.requestPermission()` on the click.

## Tests
- `tests/web/notify.test.ts`: toast / OS copy, the chime's schedule and envelope, suspended / rejected / pending `resume()`, no Web Audio, the permission states, the click handler.
- `tests/e2e/notifications.spec.ts` (the M3.4 oracle, real path, no demo seed): `tests/e2e/question-world.ts` starts the server with fake-claude, fake gh and a temp `acme-app-front` git repo; `Notification` and `AudioContext` are replaced with recording doubles before the app loads. Granted → toast (title, sub, branch line from the session's worktree, the question verbatim) + chime + one OS notification, Jump to session; `default` → toast + chime, no notification and no permission prompt, Later and ✕; a click on the OS notification → focus + jump.
- `tests/e2e/visual/toast.spec.ts`: the visual oracle against the prototype's `arrive()` toast (`docs/visual/toast.md`).

## When a notification goes away (developer request 2026-09-28)
A question toast and its OS notification go away:
- when the developer opens their session, however they do it: Jump to session, the sidebar, the Inbox, the palette, a link, or coming back to the page while on it;
- when their batch leaves the Inbox, i.e. is answered, withdrawn or stale (`/hub` `inboxChanged` → `GET /api/inbox`).

A batch of the session the page already shows raises no toast; the chime still plays, and the OS notification is sent only while the page is hidden. Code: `noticesToClear` (`src/web/toast/notify.ts`) and `useQuestionNotifications`. Oracle: `tests/e2e/notifications.spec.ts` (the last test) and `tests/web/notify.test.ts`.
