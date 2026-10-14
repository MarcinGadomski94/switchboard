import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { LOOK_AT_MAX, chatName, chatSupport, chatTitleFromMessage } from '../../core/chats.ts';
import { supports } from '../../core/cli-providers.ts';
import type { RefusalBody } from '../api/worktree-errors.ts';
import { AttachmentError, NO_ATTACHMENTS, type PreparedAttachments, parseAttachmentIds } from '../attachments/service.ts';
import type { AttachmentRecord } from '../db/repos/attachments.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { readModelOptionsSetting } from '../settings/models.ts';
import { type SessionStartContext, resolveSessionProfile, resolveSessionProvider } from '../sessions/start.ts';
import { modelOf } from '../sessions/validate.ts';

/** D106: the chats' scratch folders, under the data folder. */
export const CHATS_DIR = 'chats';

/** A chat's own empty working folder: `<dataDir>/chats/<id>/` (no AGENTS.md, no repository). */
export function chatScratchDir(dataDir: string, chatId: string): string {
  return path.join(dataDir, CHATS_DIR, chatId);
}

/** Deletes a chat's scratch folder (only ever one under `<dataDir>/chats/`). */
export async function removeChatScratch(dataDir: string, chatId: string): Promise<void> {
  const root = path.join(dataDir, CHATS_DIR);
  const folder = chatScratchDir(dataDir, chatId);
  if (path.dirname(folder) !== root || chatId === '' || chatId.includes('/') || chatId.includes('\\') || chatId.startsWith('.')) return;
  await rm(folder, { recursive: true, force: true });
}

/**
 * D106: deletes a closed chat: its record (its events, agents, todos… cascade), its
 * scratch folder, its attachments and its exports (`handovers/<id>`).
 */
export async function deleteChat(store: Store, dataDir: string, chatId: string): Promise<void> {
  await store.sessions.delete(chatId);
  await removeChatScratch(dataDir, chatId);
  for (const dir of ['attachments', 'handovers']) await rm(path.join(dataDir, dir, chatId), { recursive: true, force: true });
}

/** What the chat routes need. */
export type ChatContext = SessionStartContext & { readonly dataDir: string };

type Refusal = { readonly ok: false; readonly status: number; readonly body: RefusalBody };

function invalid(field: string, message: string): Refusal {
  return { ok: false, status: 422, body: { error: 'invalid', errors: [{ field, message }] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * D106: the folders a chat may look at, from a body's `lookAt`: absent / `null` = none;
 * else a list of at most {@link LOOK_AT_MAX} absolute paths of existing folders,
 * canonicalized (realpath) and deduplicated in order. 422 on field `lookAt` otherwise.
 */
export async function resolveLookAt(raw: unknown, field = 'lookAt'): Promise<{ readonly ok: true; readonly paths: string[] } | Refusal> {
  if (raw === undefined || raw === null) return { ok: true, paths: [] };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string' || entry.trim() === '')) return invalid(field, 'lookAt must be a list of folder paths');
  if (raw.length > LOOK_AT_MAX) return invalid(field, `a chat looks at ${LOOK_AT_MAX} folders at most`);
  const paths: string[] = [];
  for (const entry of raw as string[]) {
    const given = entry.trim();
    if (!path.isAbsolute(given)) return invalid(field, `${given} is not an absolute path`);
    let canonical: string;
    try {
      canonical = await realpath(given);
      if (!(await stat(canonical)).isDirectory()) return invalid(field, `${given} is not a folder`);
    } catch {
      return invalid(field, `${given} does not exist`);
    }
    if (!paths.includes(canonical)) paths.push(canonical);
  }
  return { ok: true, paths };
}

/** Result of {@link startChat}. */
export type StartChatOutcome = { readonly ok: true; readonly record: SessionRecord; readonly model: string | null; readonly effort: string | null; readonly named: boolean } | Refusal;

/**
 * `POST /api/chats` (D106, contract → *Chats (D106)*): `{ message, attachments?, provider?,
 * profileId?, model?, effort?, lookAt? }`. Checks the message (required), the CLI (the
 * default when omitted; one without a read-only mode is refused), the account, the model /
 * effort (against the CLI's reported list), the folders to look at and the attachments;
 * then creates the scratch folder and starts the chat. A start that fails removes it again.
 */
export async function startChat(context: ChatContext, body: unknown): Promise<StartChatOutcome> {
  if (!isRecord(body)) return invalid('message', 'the body must be an object');
  const message = body['message'];
  if (typeof message !== 'string' || message.trim() === '') return invalid('message', 'write the first message of the chat');
  const cli = await resolveSessionProvider(context, body);
  if (!cli.ok) return cli;
  const support = chatSupport(cli.provider);
  if (!support.ok) return invalid('provider', support.reason);
  const account = await resolveSessionProfile(context, body, cli.provider);
  if (!account.ok) return account;
  const errors: Array<{ field: string; message: string }> = [];
  const choice = modelOf(body, { modelOptions: await readModelOptionsSetting(context.store.settings, cli.provider) }, (field, text) => errors.push({ field, message: text }));
  if (errors.length > 0) return { ok: false, status: 422, body: { error: 'invalid', errors } };
  const lookAt = await resolveLookAt(body['lookAt']);
  if (!lookAt.ok) return lookAt;
  const attachmentIds = parseAttachmentIds(body['attachments']);
  if (attachmentIds === null) return invalid('attachments', 'attachments must be a list of distinct attachment ids');
  if (attachmentIds.length > 0 && !context.attachments) return invalid('attachments', 'this start takes no attachments');
  let staged: AttachmentRecord[] = [];
  try {
    if (context.attachments) staged = await context.attachments.resolve(null, attachmentIds);
  } catch (error) {
    if (error instanceof AttachmentError) return { ok: false, status: error.status, body: error.body() as unknown as RefusalBody };
    throw error;
  }
  const id = randomUUID();
  const cwd = chatScratchDir(context.dataDir, id);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  let prepared: PreparedAttachments = NO_ATTACHMENTS;
  try {
    const record = await context.supervisor.startChat(
      {
        id,
        name: chatName(id),
        title: chatTitleFromMessage(message),
        message,
        cwd,
        provider: cli.provider,
        profileId: account.profileId,
        model: choice?.model ?? null,
        effort: choice?.effort ?? null,
        lookAt: lookAt.paths,
      },
      {
        beforeSpawn: async (session) => {
          // D57: the staged uploads become the chat's, then go with its first message.
          if (context.attachments && staged.length > 0) prepared = await context.attachments.prepare(await context.attachments.bind(staged, session.id), { inline: true, pdfs: supports(cli.provider, 'pdfs') });
        },
        attachments: () => prepared,
      },
    );
    return { ok: true, record, model: choice?.model ?? null, effort: choice?.effort ?? null, named: choice !== null };
  } catch (error) {
    if ((await context.store.sessions.get(id)) === null) await removeChatScratch(context.dataDir, id);
    throw error;
  }
}
