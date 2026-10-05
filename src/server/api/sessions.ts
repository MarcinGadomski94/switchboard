import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AttachRequest, AttachWarning, FileDiff, FullEventAnswer, InterruptResult, StopBackgroundResult, ResumeCommand, Session, SessionCloseInput, SessionDetail, SessionEvent, SessionModelInput, WorkflowAgentChat } from '../../core/api.ts';
import { MODEL_VALUE_MAX } from '../../core/model-choice.ts';
import { CLOSED_FILTERS, parseClosedFilter } from '../../core/session-close.ts';
import { checkTitle } from '../../core/session-title.ts';
import type { ApiContext } from '../routes.ts';
import { isPeerRequest } from './machines.ts';
import { HookError } from '../hooks/service.ts';
import { HookedContinuer } from '../hooks/continue.ts';
import { AttachmentError, NO_ATTACHMENTS, parseAttachmentIds } from '../attachments/service.ts';
import { toEvent, toSession, toSessionDetail } from '../sessions/wire.ts';
import { restoreFullEvent } from '../sessions/full-event.ts';
import { startNewSession } from '../sessions/start.ts';
import { isCliProviderId, supports } from '../../core/cli-providers.ts';
import { outgoingCapacity } from '../cli/capacity.ts';
import path from 'node:path';
import { SessionTeleporter } from '../sessions/teleport.ts';
import { rememberModelChoice } from '../settings/models.ts';
import { AttachWarningError, ModelChoiceError, SupervisorError, type SupervisorErrorCode } from '../supervisor/supervisor.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Session routes (contract → REST, `/api/sessions*`) not implemented yet. */
export const SESSION_ROUTES_PENDING: readonly PendingRoute[] = [];

/** HTTP status of each supervisor refusal. */
const ERROR_STATUS: Record<SupervisorErrorCode, number> = {
  'not-found': 404,
  'folder-missing': 409,
  detached: 409,
  'already-running': 409,
  'request-not-open': 409,
  closing: 503,
  'attach-warning': 409,
  'not-live': 409,
  'remote-unavailable': 409,
  // D24: the CLI refused or failed the `remote_control` request; `message` is its text, verbatim.
  'remote-failed': 502,
  // D25 (POST /api/sessions/teleport): the CLI refused the teleport, or never reported the local copy.
  'teleport-failed': 502,
  'teleport-timeout': 504,
  // D31 (PUT /api/sessions/{id}/model): a model / effort not on offer (sent as 422 `invalid` with its field); the CLI refused the change.
  'invalid-model': 422,
  'model-failed': 502,
  // D62
  'cli-unavailable': 409,
  'not-available': 409,
  switching: 409,
  'switch-failed': 502,
  // D33: closing a live / running / waiting session needs `{ confirm: true }`; a closed session takes no message, Resume or Attach.
  'close-needs-confirm': 409,
  closed: 409,
};

interface IdParams {
  readonly id: string;
}

/** Sends a supervisor refusal as `{ error: <code>, message }` (+ `reasons` for an attach warning), rethrows anything else. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ModelChoiceError) {
    return reply.code(422).send({ error: 'invalid', errors: [{ field: error.field, message: error.message }] });
  }
  if (error instanceof AttachWarningError) {
    const body: AttachWarning = { error: 'attach-warning', message: error.message, reasons: error.reasons };
    return reply.code(ERROR_STATUS[error.code]).send(body);
  }
  if (error instanceof SupervisorError) {
    return reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
  }
  throw error;
}

function notFound(reply: FastifyReply, id: string): FastifyReply {
  return reply.code(404).send({ error: 'not-found', message: `no session ${id}` });
}

/** D48 P4: what a hooked terminal session cannot do from Switchboard, and why (shown as the refusal's message). */
export const HOOKED_UNAVAILABLE: Readonly<Record<string, string>> = {
  pause: 'Pause and interrupt stay in the terminal: Switchboard never runs this session\'s process, it only follows it through its hooks.',
  resume: 'Resume stays in the terminal: Switchboard never runs this session\'s process.',
  // D50: hooks cannot interrupt a turn (Esc or Ctrl+C in the terminal can), nor stop its background tasks.
  interrupt: 'Stop stays in the terminal (Esc there): hooks cannot interrupt a turn of a process Switchboard does not run.',
  background: 'Background tasks are stopped in the terminal: hooks cannot stop them.',
  model: 'Model and effort changes stay in the terminal (/model there): hooks cannot change them.',
  remote: 'Remote Control is the terminal\'s own (/remote-control there): hooks cannot switch it.',
  detach: 'The session already runs in its terminal.',
  attach: 'Attaching would start a second process on the same conversation while the terminal holds it.',
};

/** D48 P4: 409 `hooked-unavailable` for an action a hooked session does not take. */
function hookedRefusal(reply: FastifyReply, action: keyof typeof HOOKED_UNAVAILABLE): FastifyReply {
  return reply.code(409).send({ error: 'hooked-unavailable', message: HOOKED_UNAVAILABLE[action] });
}

/** D50 background: the body's `taskIds` (`undefined` = all), or `null` when the body is not `{ taskIds?: string[] }`. */
export function parseStopBackground(body: unknown): readonly string[] | undefined | null {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const taskIds = (body as { taskIds?: unknown }).taskIds;
  if (taskIds === undefined) return undefined;
  if (!Array.isArray(taskIds) || !taskIds.every((id) => typeof id === 'string' && id !== '' && id.length <= 200)) return null;
  return taskIds as string[];
}

/** `true` when the session is a hooked terminal session (D48 P4). */
async function isHooked(context: ApiContext, id: string): Promise<boolean> {
  return (await context.store.sessions.get(id))?.hooked === true;
}

/**
 * Registers the session routes (M2.1: the supervisor's layer; M4.x / M5.x add to
 * the UI side, M4.5 the diff; D22 the additive rename, `PUT /api/sessions/{id}/title`,
 * which publishes `sessionUpdated`; D24 the additive Remote toggle, `PUT
 * /api/sessions/{id}/remote`; D25 the additive `POST /api/sessions/teleport`,
 * a local copy of a remote session, {@link SessionTeleporter}; D31 the additive
 * `PUT /api/sessions/{id}/model`, the model and effort; D33 the additive
 * `POST /api/sessions/{id}/close` and `/reopen`, and `GET /api/sessions` leaving
 * closed sessions out unless `?closed=include`; D42 the additive `model` /
 * `effort` of NewSession, remembered as the last choice). Every route sits
 * behind the security guard.
 */
export async function registerSessionRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, supervisor, providers } = context;

  // D33: closed sessions are left out unless `?closed=include` (History and the New-session name check list them).
  app.get<{ Querystring: { closed?: unknown } }>('/api/sessions', async (request, reply): Promise<Session[] | FastifyReply> => {
    const closed = parseClosedFilter(request.query.closed);
    if (closed === null) {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'closed', message: `closed must be one of ${CLOSED_FILTERS.join(', ')}` }] });
    }
    // D25: a teleport that has not reported its local session yet is not listed (a refusal deletes it again).
    const records = (await store.sessions.list(closed === 'include' ? {} : { closed: false })).filter((record) => !supervisor.isStarting(record.id));
    const local = await Promise.all(records.map((record) => toSession(store, record, supervisor.activity(record.id))));
    // D48: the paired machines' open sessions follow (tagged, namespaced); a peer asking gets this machine's only.
    return isPeerRequest(request) ? local : [...local, ...context.peers.remoteSessions()];
  });

  app.post('/api/sessions', async (request, reply) => {
    try {
      // Validation, worktrees (M2.2), the first-turn payload (M5.2) and the start: sessions/start.ts (shared with the M7.1 scheduler).
      const outcome = await startNewSession(context, request.body);
      if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
      // D42: a start that names a model or effort is the developer's last choice (the form's next default).
      // Scheduled runs start through `startNewSession` too, but not here: they never change it.
      const { model, effort } = outcome.session;
      // D62: the last choice of the session's CLI (each CLI names its models differently).
      if (model !== undefined || effort !== undefined) await rememberModelChoice(store.settings, { model: model ?? null, effort: effort ?? null }, outcome.record.provider);
      return reply.code(201).send(await toSession(store, outcome.record, supervisor.activity(outcome.record.id)));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D25 (additive): continue a remote session locally: `{ remote, folder, title?, task? }` → 201 Session,
  // 422 `invalid`, 409 (folder / worktree refusals), 502 `teleport-failed` / 504 `teleport-timeout` with the CLI's text.
  const teleporter = new SessionTeleporter({ store, supervisor, worktrees: context.worktrees, folders: context.folders });
  app.post('/api/sessions/teleport', async (request, reply) => {
    const outcome = await teleporter.teleport(request.body);
    if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
    return reply.code(201).send(await toSession(store, outcome.record, supervisor.activity(outcome.record.id)));
  });

  app.get<{ Params: IdParams }>('/api/sessions/:id', async (request, reply): Promise<SessionDetail | FastifyReply> => {
    const record = await store.sessions.get(request.params.id);
    if (!record) return notFound(reply, request.params.id);
    // D49 ruling D49-backfill: a session from before D49 reads its meter from its transcript once, in the background.
    if (record.context === null) void supervisor.backfillContext(record.id).catch((error: unknown) => request.log.error(error));
    return toSessionDetail(store, providers, record, supervisor.activity(record.id));
  });

  // D22 (additive): rename. Only the title changes (the name, branch and worktree stay); the next spawn passes it as `--name`.
  app.put<{ Params: IdParams }>('/api/sessions/:id/title', async (request, reply): Promise<Session | FastifyReply> => {
    const record = await store.sessions.get(request.params.id);
    if (!record) return notFound(reply, request.params.id);
    const parsed = parseTitleInput(request.body);
    if (!parsed.ok) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'title', message: parsed.message }] });
    const updated = (await store.sessions.update(record.id, { title: parsed.title })) ?? record;
    const session = await toSession(store, updated);
    context.bus.publish('sessionUpdated', session);
    return session;
  });

  // D24 (additive): Remote Control on the session's live process. The supervisor publishes `sessionUpdated`.
  app.put<{ Params: IdParams }>('/api/sessions/:id/remote', async (request, reply): Promise<Session | FastifyReply> => {
    const record = await store.sessions.get(request.params.id);
    if (!record) return notFound(reply, request.params.id);
    if (record.hooked) return hookedRefusal(reply, 'remote');
    const enabled = parseRemoteInput(request.body);
    if (enabled === null) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'enabled', message: 'the body must be { enabled: true | false }' }] });
    try {
      const updated = await supervisor.setRemote(record.id, enabled);
      return await toSession(store, updated, supervisor.activity(updated.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D62 P5 (additive): switch the session to another CLI with a handover (`{ provider }` → 202 `{ session, switchId }`
  // once the switch started; its progress is `Session.providerSwitch` on `sessionUpdated`). 422 for an unknown CLI or
  // one that cannot be chosen now (the reason); 409 `switching` / `detached` / `closed` / `not-available` (hooked).
  app.post<{ Params: IdParams }>('/api/sessions/:id/provider', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null | undefined;
    const provider = body && typeof body === 'object' ? body['provider'] : undefined;
    if (!isCliProviderId(provider)) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'provider', message: 'provider must be claude, codex or opencode' }] });
    const session = await store.sessions.get(request.params.id);
    if (!session) return notFound(reply, request.params.id);
    const refusal = await context.clis.refusal(provider);
    if (refusal) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'provider', message: refusal }] });
    try {
      const capacity = await outgoingCapacity({
        provider: session.provider,
        clis: context.clis,
        supported: supervisor.cliRegistry.hasAdapter(session.provider),
        claudeUsage: await store.usage.latest(),
        providerUsage: supervisor.providerUsage(session.provider),
      });
      const started = await supervisor.switchProvider(session.id, provider, { capacity, handoverDir: path.join(context.config.dataDir, 'handovers') });
      return reply.code(202).send({ session: await toSession(store, started.record, supervisor.activity(started.record.id)), switchId: started.switchRecord.id });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D31 (additive): the model and / or effort. Live: sent to the process (`set_model`, `apply_flag_settings`); else only stored.
  // Every later spawn passes `--model` / `--effort`. The supervisor publishes `sessionUpdated`.
  app.put<{ Params: IdParams }>('/api/sessions/:id/model', async (request, reply): Promise<Session | FastifyReply> => {
    const record = await store.sessions.get(request.params.id);
    if (!record) return notFound(reply, request.params.id);
    if (record.hooked) return hookedRefusal(reply, 'model');
    const parsed = parseModelInput(request.body);
    if (!parsed.ok) return reply.code(422).send({ error: 'invalid', errors: parsed.errors });
    try {
      const updated = await supervisor.setModel(record.id, parsed.input);
      return await toSession(store, updated, supervisor.activity(updated.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/messages', async (request, reply) => {
    const body = request.body as { text?: unknown; attachments?: unknown } | undefined;
    const text = body?.text;
    // D57: the ids of attachments uploaded to this session (`POST …/attachments`); with some, the text may be empty.
    const ids = parseAttachmentIds(body?.attachments);
    if (ids === null) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'attachments', message: 'attachments must be a list of distinct attachment ids' }] });
    if (typeof text !== 'string' || (text.trim() === '' && ids.length === 0)) {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'text', message: 'the message must be non-empty text' }] });
    }
    try {
      const hooked = await isHooked(context, request.params.id);
      let prepared = NO_ATTACHMENTS;
      if (ids.length > 0) {
        const target = await store.sessions.get(request.params.id);
        if (!target) return notFound(reply, request.params.id);
        // D57 ruling: images and PDFs inline, other files as paths; a hooked session (hooks carry text) gets only paths.
        // D62: a CLI that takes no PDFs (Codex) gets them as paths.
        prepared = await context.attachments.prepare(await context.attachments.resolve(request.params.id, ids), { inline: !hooked, pdfs: supports(target.provider, 'pdfs') });
      }
      // D48 P4: a hooked terminal session's message waits in its mailbox for its next idle waiter.
      if (hooked) await context.hooks.sendMessage(request.params.id, text, prepared);
      else await supervisor.sendMessage(request.params.id, text.trim() === '' ? '' : text, 'user', prepared);
      return reply.code(202).send();
    } catch (error) {
      if (error instanceof AttachmentError) return reply.code(error.status).send(error.body());
      if (error instanceof HookError) return reply.code(error.status).send({ error: error.code, message: error.message });
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/pause', async (request, reply) => {
    if (await isHooked(context, request.params.id)) return hookedRefusal(reply, 'pause');
    try {
      const record = await supervisor.pause(request.params.id);
      return await toSession(store, record, supervisor.activity(record.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D50 (additive): Stop the current turn (the process stays alive; the session becomes idle). The reply carries the
  // outcome (`stopped` / `idle` / `timeout`) and the texts of the messages the Stop took back, for the composer.
  app.post<{ Params: IdParams }>('/api/sessions/:id/interrupt', async (request, reply): Promise<InterruptResult | FastifyReply> => {
    // D50 + D48 P4: a hooked terminal session's turn is stopped in its terminal.
    if (await isHooked(context, request.params.id)) return hookedRefusal(reply, 'interrupt');
    try {
      const result = await supervisor.interrupt(request.params.id);
      return {
        session: await toSession(store, result.record, supervisor.activity(result.record.id)),
        outcome: result.outcome,
        withdrawn: result.withdrawn,
        // D57: the withdrawn messages' attachments go back into the composer as chips.
        withdrawnAttachments: result.withdrawnAttachments,
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D50 ruling (additive): stop the session's background tasks (`stop_task` per task). Body: optional `{ taskIds }`.
  app.post<{ Params: IdParams }>('/api/sessions/:id/background/stop', async (request, reply): Promise<StopBackgroundResult | FastifyReply> => {
    const taskIds = parseStopBackground(request.body);
    if (taskIds === null) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'taskIds', message: 'taskIds must be a list of task ids' }] });
    if (await isHooked(context, request.params.id)) return hookedRefusal(reply, 'background');
    try {
      const result = await supervisor.stopBackground(request.params.id, taskIds);
      return { session: await toSession(store, result.record, supervisor.activity(result.record.id)), stopped: result.stopped, failed: result.failed };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/resume', async (request, reply) => {
    if (await isHooked(context, request.params.id)) return hookedRefusal(reply, 'resume');
    try {
      const record = await supervisor.resume(request.params.id);
      return await toSession(store, record, supervisor.activity(record.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D33 (additive): close. `{ confirm: true }` is needed when the process is live or the session runs or waits (else 409
  // `close-needs-confirm`); the stop is Pause's, then its waiting questions and permission requests close ("session closed").
  app.post<{ Params: IdParams }>('/api/sessions/:id/close', async (request, reply): Promise<Session | FastifyReply> => {
    const confirm = parseCloseInput(request.body);
    if (confirm === null) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'confirm', message: 'the body must be empty or { confirm: true | false }' }] });
    try {
      const record = await supervisor.close(request.params.id, { confirm, beforePublish: (id) => context.questions.closeSession(id) });
      // D48 P4: closing a hooked terminal session unhooks it (the terminal keeps running; its held hook calls get no decision).
      if (record.hooked) await context.hooks.unhooked(record.id);
      return await toSession(store, record, supervisor.activity(record.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D33 (additive): reopen. Only `closedAt` is cleared: no process starts; the next message resumes the session.
  app.post<{ Params: IdParams }>('/api/sessions/:id/reopen', async (request, reply): Promise<Session | FastifyReply> => {
    try {
      const record = await supervisor.reopen(request.params.id);
      return await toSession(store, record, supervisor.activity(record.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D72 (additive): Continue in Switchboard: a hooked terminal session becomes a Switchboard-run session in place
  // (`{ confirmStopTerminal? }` → the Session; 409 `not-hooked` / `closed` / `folder-missing` / `terminal-unknown`,
  // 409 `terminal-running` with its pid until the stop is confirmed; 502 `stop-failed` / `agents-unavailable`).
  const continuer = new HookedContinuer({ store, bus: context.bus, hooks: context.hooks, supervisor });
  app.post<{ Params: IdParams }>('/api/sessions/:id/continue-in-switchboard', async (request, reply): Promise<Session | FastifyReply> => {
    const outcome = await continuer.continue(request.params.id, request.body);
    if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
    return outcome.session;
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/detach', async (request, reply): Promise<ResumeCommand | FastifyReply> => {
    if (await isHooked(context, request.params.id)) return hookedRefusal(reply, 'detach');
    try {
      return await supervisor.detach(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // M4.1: `{ confirm: true }` (optional body) attaches despite the terminal warning; without it a warning is a 409 `attach-warning`.
  app.post<{ Params: IdParams }>('/api/sessions/:id/attach', async (request, reply): Promise<ResumeCommand | FastifyReply> => {
    const body = request.body as AttachRequest | null | undefined;
    const confirm = typeof body === 'object' && body !== null && body.confirm === true;
    if (await isHooked(context, request.params.id)) return hookedRefusal(reply, 'attach');
    try {
      return await supervisor.attach(request.params.id, { confirm });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams; Querystring: { since?: string } }>(
    '/api/sessions/:id/events',
    async (request, reply): Promise<SessionEvent[] | FastifyReply> => {
      const record = await store.sessions.get(request.params.id);
      if (!record) return notFound(reply, request.params.id);
      const since = request.query.since;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        return reply.code(422).send({ error: 'invalid', errors: [{ field: 'since', message: 'since must be an ISO timestamp' }] });
      }
      const events = await store.events.list(record.id, since === undefined ? {} : { sinceTs: new Date(since).toISOString() });
      return events.map(toEvent);
    },
  );

  // Fix · long messages: a cut event with its whole text from the session's CLI transcript (message text is written back).
  app.get<{ Params: IdParams & { eventId: string } }>(
    '/api/sessions/:id/events/:eventId/full',
    async (request, reply): Promise<FullEventAnswer | FastifyReply> => {
      const eventId = /^[1-9][0-9]{0,15}$/.test(request.params.eventId) ? Number(request.params.eventId) : Number.NaN;
      const answer = await restoreFullEvent(
        {
          store,
          findTranscript: (claudeSessionId) => supervisor.findTranscript(claudeSessionId),
          publish: (event) => context.bus.publish('event', { sessionId: event.sessionId, event: toEvent(event) }),
        },
        request.params.id,
        eventId,
      );
      if ('status' in answer) return reply.code(answer.status).send({ error: answer.error, message: answer.message });
      return answer;
    },
  );

  // D51: a Workflow agent's conversation, read from its transcript under the CLI's folder of this session.
  app.get<{ Params: IdParams & { agentId: string } }>(
    '/api/sessions/:id/workflow-agents/:agentId/chat',
    async (request, reply): Promise<WorkflowAgentChat | FastifyReply> => {
      const record = await store.sessions.get(request.params.id);
      if (!record) return notFound(reply, request.params.id);
      const chat = await supervisor.workflowChat(record, request.params.agentId);
      if (!chat) return reply.code(404).send({ error: 'not-found', message: `no workflow agent ${request.params.agentId} with a transcript in session ${request.params.id}` });
      return chat;
    },
  );

  // M4.5 · gap #10: the session's changed files (`providers.diff`: the WorktreeManager, or the demo's), `?file=` narrows to one path.
  app.get<{ Params: IdParams; Querystring: { file?: unknown } }>(
    '/api/sessions/:id/diff',
    async (request, reply): Promise<FileDiff[] | FastifyReply> => {
      const record = await store.sessions.get(request.params.id);
      if (!record) return notFound(reply, request.params.id);
      const file = request.query.file;
      if (file !== undefined && !isDiffFilePath(file)) {
        return reply.code(422).send({ error: 'invalid', errors: [{ field: 'file', message: 'file must be one relative path inside a solution' }] });
      }
      if (!providers.diff) return [];
      return providers.diff.diff(record.id, file);
    },
  );

  registerPending(app, SESSION_ROUTES_PENDING);
}

/**
 * The body of `PUT /api/sessions/{id}/title` (D22, `SessionTitleInput`):
 * `{ title }` where a `null`, empty or blank title clears it (`title: null`: the
 * name is shown again) and any other text must be 1–80 characters once trimmed
 * (the create path's rule, `checkTitle`). A body without a `title` field is refused.
 */
export function parseTitleInput(body: unknown): { readonly ok: true; readonly title: string | null } | { readonly ok: false; readonly message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('title' in body)) {
    return { ok: false, message: 'the body must be { title }: text, or null to clear it' };
  }
  const raw = (body as { title?: unknown }).title;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, title: null };
  const check = checkTitle(raw);
  return check.ok ? { ok: true, title: check.title } : { ok: false, message: check.message };
}

/**
 * The body of `POST /api/sessions/{id}/close` (D33, `SessionCloseInput`): none (or
 * `null`) or `{}` = no confirm, `{ confirm: boolean }` = that; anything else `null`.
 */
export function parseCloseInput(body: unknown): boolean | null {
  if (body === undefined || body === null) return false;
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const confirm = (body as SessionCloseInput & Record<string, unknown>).confirm;
  if (confirm === undefined) return false;
  return typeof confirm === 'boolean' ? confirm : null;
}

/** The body of `PUT /api/sessions/{id}/remote` (D24, `SessionRemoteInput`): `{ enabled: boolean }`, else `null`. */
export function parseRemoteInput(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const enabled = (body as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

/** A field of a refused body (`422 { error: "invalid", errors }`). */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/**
 * The body of `PUT /api/sessions/{id}/model` (D31, `SessionModelInput`): an object
 * with `model` and / or `effort`, each text (at most {@link MODEL_VALUE_MAX}
 * characters) or `null`. A field left out keeps its stored value; a body with
 * neither is refused. Whether the values are on offer is the supervisor's check
 * (`checkModelChoice`).
 */
export function parseModelInput(body: unknown): { readonly ok: true; readonly input: SessionModelInput } | { readonly ok: false; readonly errors: FieldError[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || (!('model' in body) && !('effort' in body))) {
    return { ok: false, errors: [{ field: 'model', message: 'the body must be { model?, effort? }: text, or null for the CLI default' }] };
  }
  const errors: FieldError[] = [];
  const input: { model?: string | null; effort?: string | null } = {};
  for (const field of ['model', 'effort'] as const) {
    if (!(field in body)) continue;
    const value = (body as Record<string, unknown>)[field];
    if (value === null || (typeof value === 'string' && value.length <= MODEL_VALUE_MAX)) input[field] = value;
    else errors.push({ field, message: `${field} must be text of at most ${MODEL_VALUE_MAX} characters, or null for the CLI default` });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, input };
}

/**
 * `?file=` of the diff route: one non-empty, solution-relative path (no absolute
 * path, drive letter, `..` segment or NUL), as `FileDiff.path` names it.
 */
export function isDiffFilePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}
