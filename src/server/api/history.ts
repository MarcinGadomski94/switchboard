import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { HistoryItem } from '../../core/api.ts';
import { CLI_LABELS } from '../../core/cli-providers.ts';
import { solutionOfPath } from '../../core/history.ts';
import { TITLE_MAX, checkTitle, shortNameFromTitle } from '../../core/session-title.ts';
import { kebabName, uniqueName } from '../../core/terminal-move.ts';
import { CliHistory } from '../history/cli-history.ts';
import { ConversationMover } from '../history/continue.ts';
import { TranscriptHistory, claudeConfigDir } from '../history/transcripts.ts';
import { repoSolutionName } from '../folders/ref.ts';
import type { ApiContext } from '../routes.ts';
import { SESSION_NAME } from '../sessions/validate.ts';
import { toSession } from '../sessions/wire.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import type { PendingRoute } from './not-implemented.ts';

/** History routes (contract → REST) not implemented yet: none since M7.4. */
export const HISTORY_ROUTES_PENDING: readonly PendingRoute[] = [];

interface HistoryQueryString {
  readonly q?: string | string[];
  readonly cli?: string;
}

interface ContinueParams {
  readonly claudeSessionId: string;
}

interface CliContinueParams {
  readonly provider: string;
  readonly nativeId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Registers the History routes (M7.4, `docs/derivations.md` → *History*):
 * `GET /api/history?q=` → {@link HistoryItem}[], newest first. `q` is a
 * case-insensitive substring (the last value when repeated) matched against the
 * row, the task, the prompts, the last reply, the folders and the session id.
 * The rows come from `providers.history` (the demo's when `SWITCHBOARD_DEMO=1`),
 * else from the stored sessions + the transcripts under `$CLAUDE_CONFIG_DIR` or
 * `~/.claude` for every saved folder and every session's folder (D14,
 * {@link TranscriptHistory}); each row carries its folder. D62 P7: with
 * `?cli=1` the Codex CLI and OpenCode terminal conversations not in Switchboard
 * yet are added ({@link CliHistory}; opt-in, since listing them reads those
 * CLIs' records and runs `opencode session list`).
 *
 * D16 (additive): `POST /api/history/{claudeSessionId}/continue` `{ name?,
 * title? (D22), addFolder?, confirm? }` moves a terminal conversation into Switchboard as the
 * same conversation ({@link ConversationMover}): `201 Session`, or 404 / 409
 * (`already-in-switchboard`, `folder-not-saved`, `terminal-open`,
 * `folder-missing`) / 422 (`not-in-a-folder`, `not-a-terminal-conversation`,
 * `invalid`) / 503 (`closing`).
 *
 * D62 P7 (additive): `POST /api/history/cli/{provider}/{nativeId}/continue`
 * `{ name?, title?, confirm? }` does the same for a Codex / OpenCode
 * conversation: 201 Session; 404 (unknown CLI or conversation); 409
 * `already-in-switchboard`, `terminal-open` (always without `confirm`: no CLI but
 * Claude Code can say whether a terminal holds it); 422 `not-in-a-folder` (no
 * saved folder holds its folder), `invalid` (name / title).
 */
export async function registerHistoryRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const provider =
    context.providers.history ??
    new TranscriptHistory({ store: context.store, configDir: claudeConfigDir() });
  const cliHistory = new CliHistory(provider, { store: context.store, registry: context.supervisor.cliRegistry, cwd: context.config.dataDir, env: context.supervisor.environment });

  app.get<{ Querystring: HistoryQueryString }>('/api/history', async (request): Promise<HistoryItem[]> => {
    const rawQ = request.query.q;
    const q = Array.isArray(rawQ) ? (rawQ.at(-1) ?? '') : (rawQ ?? '');
    // The demo's History is its own (nothing runs).
    if (request.query.cli === '1' && !context.providers.history) return cliHistory.history(q);
    return provider.history(q);
  });

  const mover = new ConversationMover({ store: context.store, supervisor: context.supervisor, folders: context.folders });
  app.post<{ Params: ContinueParams }>('/api/history/:claudeSessionId/continue', async (request, reply) => {
    const outcome = await mover.continue(request.params.claudeSessionId, request.body);
    if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
    return reply.code(201).send(await toSession(context.store, outcome.record, context.supervisor.activity(outcome.record.id)));
  });

  app.post<{ Params: CliContinueParams }>('/api/history/cli/:provider/:nativeId/continue', async (request, reply) => {
    const cli = request.params.provider;
    if (cli !== 'codex' && cli !== 'opencode') return reply.code(404).send({ error: 'not-found', message: `no CLI ${cli}` });
    const nativeId = request.params.nativeId;
    const existing = await context.store.providers.sessionByNative(cli, nativeId);
    if (existing) return reply.code(409).send({ error: 'already-in-switchboard', message: `this ${CLI_LABELS[cli]} conversation is already in Switchboard`, sessionId: existing });
    const conversation = await cliHistory.find(cli, nativeId);
    if (!conversation) return reply.code(404).send({ error: 'not-found', message: `no ${CLI_LABELS[cli]} conversation ${nativeId}` });
    const body = isRecord(request.body) ? request.body : {};
    // The folder: the saved folder that holds where it started (the most specific).
    const cwd = conversation.cwd;
    const folders = await context.store.folders.list();
    const saved = cwd ? folders.filter((entry) => cwd === entry.canonicalPath || cwd.startsWith(`${entry.canonicalPath}${path.sep}`)).sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0] : undefined;
    if (!cwd || !saved) {
      return reply.code(422).send({ error: 'not-in-a-folder', message: `no saved folder holds ${cwd ?? 'its folder'}: add the folder in Settings → Folders first`, cwd: cwd ?? '' });
    }
    // The name and the title (D22).
    const taken = new Set((await context.store.sessions.list()).map((session) => session.name));
    const typedName = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (typedName !== '' && (!SESSION_NAME.test(typedName) || typedName.length > 64 || taken.has(typedName))) {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'name', message: taken.has(typedName) ? `a session named "${typedName}" already exists` : 'the name must be kebab-case (a-z, 0-9, single dashes), at most 64 characters' }] });
    }
    let title: string | null = conversation.title ? conversation.title.slice(0, TITLE_MAX) : null;
    if (body['title'] !== undefined && body['title'] !== null) {
      const checked = checkTitle(body['title']);
      if (!checked.ok) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'title', message: checked.message }] });
      title = checked.title;
    }
    const name = typedName !== '' ? typedName : title ? shortNameFromTitle(title, taken) : uniqueName(kebabName(conversation.firstPrompt ?? `${cli}-conversation`), taken);
    if (body['confirm'] !== true) {
      return reply.code(409).send({
        error: 'terminal-open',
        message: `${CLI_LABELS[cli]} may still have this conversation open in a terminal, and Switchboard can't tell: moving it while it is open splits it. Close it there first, then confirm.`,
        reasons: [{ kind: 'liveness-unknown' }],
      });
    }
    try {
      const folder = await context.folders.resolveForSession(saved.id);
      const solution = folder.kind === 'repo' ? repoSolutionName(folder) : folder.kind === 'workspace' ? solutionOfPath(path.relative(folder.root, cwd)) : null;
      const messages = await cliHistory.messages(conversation);
      const record = await context.supervisor.adoptCli(
        { provider: cli, nativeId, name, title, task: conversation.firstPrompt ?? '', solutions: solution ? [solution] : [], messages },
        { folder, cwd },
      );
      return reply.code(201).send(await toSession(context.store, record, context.supervisor.activity(record.id)));
    } catch (error) {
      if (error instanceof SupervisorError) return reply.code(error.code === 'closing' ? 503 : 409).send({ error: error.code, message: error.message });
      throw error;
    }
  });
}
