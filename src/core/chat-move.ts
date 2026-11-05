import type { CliProviderId } from './cli-providers.ts';
import type { ConversationFileInfo, ConversationKind, SourceInspect, TakeoverRun, TakeoverStepId } from './takeover.ts';

/**
 * D155 (`docs/chats.md` → *Moving a chat to another computer*, `docs/peers.md` →
 * *Moving a chat (D155)*): the wire types and the pure parts of moving a chat
 * (D106) to a paired computer. A chat has no repos, no git and no worktrees: what
 * travels is its conversation (the CLI's own record, exactly as a session's take-over
 * copies it), its record (title, CLI, model, effort, the folders it looks at,
 * mapped), its todos, its attachments, its scratch folder's files and its saved
 * artifacts (copied). Shared by the server (`src/server/chats/move*.ts`) and the
 * v2 dialog (`src/web/v2/agent/ChatMoveDialog.tsx`). No I/O here.
 */

/** The steps of a chat move, in order (a subset of the take-over's: no capture, no apply). */
export const CHAT_MOVE_STEPS = ['checks', 'stop', 'transfer', 'resume', 'finish'] as const satisfies readonly TakeoverStepId[];

/** One of {@link CHAT_MOVE_STEPS}. */
export type ChatMoveStepId = (typeof CHAT_MOVE_STEPS)[number];

/** The dialog's label of each step. */
export const CHAT_MOVE_STEP_LABELS: Readonly<Record<ChatMoveStepId, string>> = {
  checks: 'Checking both computers',
  stop: 'Stopping the chat where it runs',
  transfer: 'Copying the conversation, attachments, scratch files and artifacts',
  resume: 'Continuing the chat there',
  finish: 'Closing the old chat',
};

/** The menu entry (v2 chat ⋯). */
export const MOVE_CHAT_LABEL = 'Move to computer…';

/** Most bytes one attachment may have on the move (the D57 upload cap). */
export const CHAT_MOVE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Most bytes one artifact version (an image, a PDF, a long text) may have on the move. */
export const CHAT_MOVE_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;

/** Most bytes a chat move copies besides its conversation (attachments, scratch files, artifacts). */
export const CHAT_MOVE_DATA_MAX_BYTES = 200 * 1024 * 1024;

/** Most attachments / artifact versions one move copies (the description stays far below the peer API's 1 MiB body limit). */
export const CHAT_MOVE_ATTACHMENTS_MAX = 500;
export const CHAT_MOVE_ARTIFACT_VERSIONS_MAX = 500;

/** Settings key of the remembered look-at choices (on the initiating machine; the newest {@link CHAT_LOOK_AT_REMEMBER_MAX}). */
export const CHAT_LOOK_AT_SETTING = 'takeover.chatLookAt';
export const CHAT_LOOK_AT_REMEMBER_MAX = 200;

/** Why an older Switchboard on the other computer cannot take part. */
export function chatMoveUnsupportedText(machineName: string): string {
  return `${machineName} runs an older Switchboard that cannot move chats: update Switchboard there, then try again`;
}

/** A folder the chat looks at, as the source describes it. */
export interface ChatLookAtSource {
  /** Its path on the source. */
  readonly path: string;
  /** Its last path segment. */
  readonly name: string;
  /**
   * When it is inside a git checkout: the checkout's remotes' normalised keys
   * (`normalizeRemoteUrl`) and its path relative to the checkout's top (`''` = the
   * top itself, `/`-separated). `null` = not in a checkout (or no remote).
   */
  readonly repo: { readonly keys: readonly string[]; readonly relative: string } | null;
  /** It no longer exists on the source (it is still offered: the target may have it). */
  readonly missing: boolean;
}

/** One attachment of the chat. */
export interface ChatAttachmentInfo {
  /** Kept on the target (a UUID: the chat's messages name attachments by id). */
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly kind: string;
  readonly size: number;
  readonly pages: number | null;
  readonly createdAt: string;
  /** Not copied, and why (over the cap, the file is gone); `null` = copied. */
  readonly refused: string | null;
}

/** One file of the chat's scratch folder (D152's workspace-file rules: caps, binary, secret marks). */
export interface ChatScratchFileInfo {
  /** Relative to the scratch folder, `/`-separated. */
  readonly name: string;
  readonly size: number;
  /** Not copied, and why (over a cap, looks like it holds secrets); `null` = copied. */
  readonly refused: string | null;
}

/** One saved artifact of the chat (D89), with its versions. */
export interface ChatArtifactInfo {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly language: string | null;
  readonly createdBy: 'agent' | 'developer';
  readonly versions: ReadonlyArray<{ readonly n: number; readonly text: boolean; readonly mediaType: string | null; readonly size: number; readonly createdBy: 'agent' | 'developer' }>;
}

/** What the source reports about a chat it could move (`POST /api/takeover/chat/source/inspect`, read-only). */
export interface ChatMoveInspect {
  readonly machine: { readonly id: string; readonly name: string };
  readonly platform: string;
  readonly chatId: string;
  readonly name: string;
  readonly title: string | null;
  readonly task: string;
  readonly provider: CliProviderId;
  readonly claudeSessionId: string;
  readonly nativeId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly live: boolean;
  readonly busy: boolean;
  /** Its scratch folder on the source. */
  readonly scratch: string | null;
  /** Its attachments' folder on the source (`null` without attachments): the transcript names files there. */
  readonly attachmentsDir: string | null;
  readonly lookAt: readonly ChatLookAtSource[];
  readonly conversation: { readonly kind: ConversationKind; readonly files: readonly ConversationFileInfo[]; readonly note: string | null };
  readonly attachments: readonly ChatAttachmentInfo[];
  readonly scratchFiles: { readonly files: readonly ChatScratchFileInfo[]; readonly truncated: boolean };
  readonly artifacts: readonly ChatArtifactInfo[];
  /** D68: its todo list (the take-over's shape). */
  readonly todos: NonNullable<SourceInspect['todos']>;
  readonly blockers: readonly string[];
}

/** The developer's choice for each looked-at folder: its path on the target, or `null` = leave it out. Keyed by the source path. */
export type ChatLookAtChoice = Readonly<Record<string, string | null>>;

/** Why a suggestion was made. */
export type ChatLookAtMatch = 'remote' | 'path' | 'name';

/** One looked-at folder as the target plans it. */
export interface ChatLookAtPlan {
  readonly source: string;
  readonly name: string;
  /** The target's suggestion (a checkout with the same remote, the same path, a saved folder with the same name), `null` = none. */
  readonly suggestion: string | null;
  readonly match: ChatLookAtMatch | null;
  /** What it will be on the target: the chosen (checked) folder, else `null` = left out. */
  readonly target: string | null;
  /** Why the chosen folder cannot be used (the chat would not move until it is changed or left out). */
  readonly problem: string | null;
}

/** What the target says about taking the chat (`POST /api/takeover/chat/target/plan`, read-only). */
export interface ChatMovePlan {
  readonly machine: { readonly id: string; readonly name: string };
  readonly platform: string;
  readonly cli: { readonly provider: CliProviderId; readonly label: string; readonly available: boolean; readonly reason: string | null };
  readonly account: { readonly profileId: string | null; readonly name: string };
  readonly lookAt: readonly ChatLookAtPlan[];
  readonly blockers: readonly string[];
}

/** The dialog's preview: both computers' view, nothing changed. */
export interface ChatMovePreview {
  readonly source: ChatMoveInspect;
  readonly target: ChatMovePlan;
  /** The look-at choice the plan was made with (the request's, else the remembered one, else the target's suggestions). */
  readonly lookAt: ChatLookAtChoice;
  /** The choice came (at least partly) from the last move of these folders to that computer. */
  readonly remembered: boolean;
  readonly ok: boolean;
  readonly blockers: readonly string[];
}

/** A chat move's run as the dialog polls it: a take-over run (the same view) marked `kind: 'chat'`. */
export interface ChatMoveRun extends TakeoverRun {
  readonly kind: 'chat';
}

/** A file of the chat's data on the wire: `attachment` (name = its id), `scratch` (a relative name), `artifact` (`<artifact id>/<n>`). */
export type ChatDataPart = 'attachment' | 'scratch' | 'artifact';

/** One data file the source sends. */
export interface ChatDataFile {
  readonly part: ChatDataPart;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACT_VERSION = /^[A-Za-z0-9_-]{1,64}\/[1-9][0-9]{0,5}$/;

/** An attachment id the target accepts as a name (a UUID, the D57 ids). */
export function isSafeAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** `<artifact id>/<n>`: the name of an artifact version on the wire. */
export function isSafeArtifactVersionName(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_VERSION.test(value);
}

/** The last path segment of a path of either OS. */
export function lastSegment(value: string): string {
  const parts = value.split(/[\\/]+/).filter((part) => part !== '');
  return parts.at(-1) ?? value;
}

/** The key a remembered look-at choice is kept under: the source machine, the folder there, the target machine. */
export function chatLookAtKey(sourceMachineId: string, sourcePath: string, targetMachineId: string): string {
  return `${sourceMachineId}\n${sourcePath.replace(/[\\/]+$/, '')}\n${targetMachineId}`;
}

/**
 * The choice the target plans with: the request's entries win, then the
 * remembered ones (the last move of that folder to that computer); a folder in
 * neither is left to the target's suggestion (absent from the result). Only the
 * chat's own folders are kept.
 */
export function effectiveLookAt(sources: readonly string[], requested: ChatLookAtChoice | null, remembered: ChatLookAtChoice): { readonly choice: Record<string, string | null>; readonly remembered: boolean } {
  const choice: Record<string, string | null> = {};
  let fromMemory = false;
  for (const source of sources) {
    if (requested && Object.hasOwn(requested, source)) choice[source] = requested[source] ?? null;
    else if (Object.hasOwn(remembered, source)) {
      choice[source] = remembered[source] ?? null;
      fromMemory = true;
    }
  }
  return { choice, remembered: fromMemory };
}

/** The chat's look-at on the target: the chosen folders, in the source's order, without the left-out ones and duplicates. */
export function mappedLookAt(plan: readonly ChatLookAtPlan[]): string[] {
  const out: string[] = [];
  for (const row of plan) if (row.target !== null && row.problem === null && !out.includes(row.target)) out.push(row.target);
  return out;
}

/** The blockers of a plan's look-at rows (each chosen folder that cannot be used). */
export function lookAtBlockers(plan: readonly ChatLookAtPlan[]): string[] {
  return plan.filter((row) => row.problem !== null).map((row) => `${row.name}: ${row.problem as string} (choose another folder or leave it out)`);
}

/**
 * The service message the moved chat's agent gets on the target (it reads it in
 * plan mode, as every chat message): where it came from, which folders it looks
 * at now, which were left out, where the attachments and scratch files are now.
 */
export function chatMovedMessage(input: {
  readonly fromMachine: string;
  readonly toMachine: string;
  readonly lookAt: ReadonlyArray<{ readonly from: string; readonly to: string | null }>;
  readonly scratch: { readonly from: string | null; readonly to: string };
  readonly attachments: { readonly from: string | null; readonly to: string; readonly count: number };
}): string {
  const lines = [`This chat moved from ${input.fromMachine} to ${input.toMachine}. It is still a chat: plan mode, read-only.`];
  const mapped = input.lookAt.filter((entry) => entry.to !== null);
  const left = input.lookAt.filter((entry) => entry.to === null);
  if (mapped.length > 0) lines.push(`Folders you look at now: ${mapped.map((entry) => (entry.from === entry.to ? (entry.to as string) : `${entry.from} → ${entry.to as string}`)).join('; ')}.`);
  if (left.length > 0) lines.push(`Left out on ${input.toMachine} (you cannot read them here): ${left.map((entry) => entry.from).join('; ')}.`);
  if (input.lookAt.length === 0) lines.push('You look at no folders.');
  if (input.scratch.from && input.scratch.from !== input.scratch.to) lines.push(`Your scratch folder is now ${input.scratch.to} (was ${input.scratch.from}).`);
  if (input.attachments.count > 0) lines.push(`The files the developer attached are now in ${input.attachments.to}${input.attachments.from ? ` (were in ${input.attachments.from})` : ''}.`);
  lines.push('Nothing else changed: continue the conversation.');
  return lines.join('\n');
}

/** The new chat's divider: "Moved here from <machine>". */
export function chatMovedFromLabel(fromMachine: string): string {
  return `Moved here from ${fromMachine}`;
}

/** Why the source refuses to move a chat (empty = it can move). */
export function chatSourceBlockers(chat: { readonly display: string; readonly kind: string; readonly closed: boolean; readonly movedTo: string | null; readonly busy: boolean; readonly switching: boolean; readonly moving: boolean }): string[] {
  const out: string[] = [];
  if (chat.kind !== 'chat') out.push(`${chat.display} is not a chat: move it with Move to computer… of the agent`);
  if (chat.closed) out.push(`${chat.display} is closed: reopen it first`);
  if (chat.movedTo !== null) out.push(`${chat.display} was already moved to ${chat.movedTo}`);
  if (chat.busy) out.push(`${chat.display} is answering: wait for its turn to end (or stop it), then move it`);
  if (chat.switching) out.push(`${chat.display} is switching CLI or account: wait for it to finish`);
  if (chat.moving) out.push(`${chat.display} is being moved already`);
  return out;
}

/** A short line of what the move copies besides the conversation ("2 attachments · 1 scratch file · 3 artifacts"). */
export function chatDataLine(source: Pick<ChatMoveInspect, 'attachments' | 'scratchFiles' | 'artifacts'>): string {
  const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
  const attachments = source.attachments.filter((entry) => entry.refused === null).length;
  const scratch = source.scratchFiles.files.filter((entry) => entry.refused === null).length;
  return [count(attachments, 'attachment'), count(scratch, 'scratch file'), count(source.artifacts.length, 'artifact')].join(' · ');
}
