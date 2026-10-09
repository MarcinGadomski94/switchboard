/**
 * D88 · drafts follow you (`docs/chat.md` → *Drafts*, contract → *Drafts (D88)*).
 * The unsent text of a session's fields is kept on the machine that runs the
 * session, so it survives switching sessions, a reload, and moving to another
 * device (a paired phone, D73) or to a paired machine's UI (D48, proxied there).
 *
 * One draft per session and **field key**:
 * - `composer`: the message field's text and the attachments already uploaded to the session.
 * - `question:<batchId>`: a question card's picks not yet sent (options, D39 own answers).
 * - `review:<reviewId>`: a review card's Send-back comment (D79).
 * - `todo-add`: the todo strip's + Add form (D69–D70).
 * - `todo-edit:<todoId>`: an item's open Edit form.
 * - `commit:<reviewId>`: a review card's Commit message as edited (ruling 2026-10-09).
 *
 * D88 ruling (2026-10-09): the **New-session** form (Simple and Full share one form
 * state) is no session's: it is kept **per machine** (`new-session`, this machine's
 * drafts, `GET /api/drafts`), restored when the dialog opens again.
 *
 * Ids in a key are always the session's machine's own ids (a paired machine's
 * `r~<machine>~<id>` is made raw with {@link rawDraftId}), so every device of
 * every machine names a draft the same way. This module is shared by the server
 * (validation) and the UI (keys, emptiness); it has no I/O.
 */
import type { AttachmentKind } from './attachments.ts';
import { parseRemoteId } from './peers.ts';
import { TODO_DESCRIPTION_MAX, TODO_NO_PLAN, TODO_PLAN_MAX, TODO_PRIORITIES, TODO_TITLE_MAX, DEFAULT_TODO_PRIORITY } from './todos.ts';

/** A stored value's JSON may be at most this many bytes (UTF-8): 413 `too-large` beyond it. */
export const DRAFT_VALUE_MAX = 64 * 1024;

/** At most this many drafts per session (409 `too-many` for one more). */
export const DRAFTS_PER_SESSION_MAX = 200;

/** The UI saves a changed draft this long after the last change (and at once on blur, hiding or leaving the page). */
export const DRAFT_SAVE_MS = 400;

/** The composer's text may be at most this long (well under {@link DRAFT_VALUE_MAX} with its attachments). */
export const DRAFT_TEXT_MAX = 50_000;

/** The field kinds; the ones with `:` take an id. */
export type DraftKind = 'composer' | 'question' | 'review' | 'todo-add' | 'todo-edit' | 'commit' | 'new-session';

/** A session's field key: `composer`, `todo-add`, or `<kind>:<raw id>` (see the module comment). */
const FIELD_PATTERN = /^(?:composer|todo-add|(?:question|review|todo-edit|commit):[A-Za-z0-9._-]{1,128})$/;

/** A machine's field key (no session): `new-session`. */
const MACHINE_FIELD_PATTERN = /^new-session$/;

/** `true` for a valid field key of a session's draft. */
export function isDraftField(value: unknown): value is string {
  return typeof value === 'string' && FIELD_PATTERN.test(value);
}

/** `true` for a valid field key of this machine's own drafts (`GET /api/drafts`). */
export function isMachineDraftField(value: unknown): value is string {
  return typeof value === 'string' && MACHINE_FIELD_PATTERN.test(value);
}

/** At most this many machine drafts (409 `too-many` for one more). */
export const MACHINE_DRAFTS_MAX = 20;

/** The kind of a valid field key. */
export function draftKind(field: string): DraftKind {
  const cut = field.indexOf(':');
  return (cut < 0 ? field : field.slice(0, cut)) as DraftKind;
}

/** The id inside a key as the session's own machine names it (`r~<machine>~<id>` → `<id>`). */
export function rawDraftId(id: string): string {
  return parseRemoteId(id)?.id ?? id;
}

/** The field keys, built from the ids the UI holds (remote ids made raw). */
export const draftField = {
  composer: 'composer',
  todoAdd: 'todo-add',
  question: (batchId: string): string => `question:${rawDraftId(batchId)}`,
  review: (reviewId: string): string => `review:${rawDraftId(reviewId)}`,
  todoEdit: (todoId: string): string => `todo-edit:${rawDraftId(todoId)}`,
  commit: (reviewId: string): string => `commit:${rawDraftId(reviewId)}`,
  /** A machine draft (no session): the New-session form. */
  newSession: 'new-session',
} as const;

/** An attachment chip kept with the composer's draft (the upload exists on the session's machine). */
export interface DraftAttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  /** The served type (the server fills it in from the upload when it answers; the UI may send `''`). */
  readonly mediaType: string;
}

/** `composer`. */
export interface ComposerDraft {
  readonly text: string;
  /** Uploaded chips; the server drops the ones whose upload is gone when it answers. */
  readonly attachments: readonly DraftAttachmentRef[];
}

/** One question's pick: an option index, or an own answer (D39) with whether its field was open. */
export type QuestionDraftPick = number | { readonly text: string; readonly editing: boolean };

/** `question:<batchId>`: picks by the question's raw id. */
export interface QuestionDraft {
  readonly picks: Readonly<Record<string, QuestionDraftPick>>;
}

/** `review:<reviewId>`: the Send-back comment. */
export interface ReviewDraft {
  readonly comment: string;
}

/** `todo-add` / `todo-edit:<todoId>`: the form's fields as typed (the estimate as text, e.g. `1h 30m`). */
export interface TodoFormDraft {
  readonly title: string;
  readonly description: string;
  readonly plan: string;
  readonly priority: string;
  readonly estimate: string;
}

/** `commit:<reviewId>`: the Commit message as edited (the card sends `''` while it is the drafted one). */
export interface CommitDraft {
  readonly message: string;
}

/**
 * `new-session` (a machine draft): the New-session form's fields as typed (the web's
 * `NewSessionForm`, unknown keys dropped; the dialog checks each value again when it
 * restores them) and the Simple form's edited branch.
 */
export interface NewSessionDraft {
  readonly form: Readonly<Record<string, unknown>>;
  readonly simpleBranch: string | null;
}

/** What a field's value is, by kind. */
export interface DraftValues {
  readonly composer: ComposerDraft;
  readonly question: QuestionDraft;
  readonly review: ReviewDraft;
  readonly 'todo-add': TodoFormDraft;
  readonly 'todo-edit': TodoFormDraft;
  readonly commit: CommitDraft;
  readonly 'new-session': NewSessionDraft;
}

/** One stored draft (`GET /api/sessions/{id}/drafts` lists them). */
export interface SessionDraft {
  readonly field: string;
  readonly value: unknown;
  readonly updatedAt: string;
  /** Who wrote it last: `local`, `device:<id>` or `peer`, then `/` and the page's id when it sent one. */
  readonly updatedBy: string;
}

/** `PUT /api/sessions/{id}/drafts/{field}` body. */
export interface DraftPutInput {
  readonly value: unknown;
  /** The writing page's id (`pageClientId`), echoed in `draftChanged` so that page can skip its own change. */
  readonly client?: string;
}

/** The `/hub` `draftChanged` payload: a session's draft (or a machine draft) was saved or cleared (any device, or the server's clean-up). */
export interface DraftChanged {
  /** The session; `null` for this machine's own drafts (`new-session`; never forwarded to peers). */
  readonly sessionId: string | null;
  readonly field: string;
  /** The writing page's id, `null` when it sent none. */
  readonly client: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(['image', 'pdf', 'file']);

function attachmentRef(value: unknown): DraftAttachmentRef | null {
  if (!isRecord(value)) return null;
  const { id, name, size, kind, mediaType } = value;
  if (typeof id !== 'string' || id === '' || id.length > 128) return null;
  if (typeof name !== 'string' || name.length > 512) return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  if (typeof kind !== 'string' || !ATTACHMENT_KINDS.has(kind)) return null;
  if (mediaType !== undefined && (typeof mediaType !== 'string' || mediaType.length > 200)) return null;
  return { id, name, size, kind: kind as AttachmentKind, mediaType: typeof mediaType === 'string' ? mediaType : '' };
}

/** The New-session form's keys and what each may hold (`NewSessionForm` in `src/web/modals/new-session.ts`). */
const NEW_SESSION_TEXT: Readonly<Record<string, number>> = { name: 200, task: DRAFT_TEXT_MAX, confluenceUrl: 2000, figmaUrls: 4000 };
const NEW_SESSION_NULLABLE: Readonly<Record<string, number>> = { branch: 200, folder: 128, stack: 32, provider: 32, profileId: 128 };
const NEW_SESSION_PICKS: Readonly<Record<string, number>> = { workType: 32, mode: 32, phase: 32, coordination: 32 };
const NEW_SESSION_FLAGS: readonly string[] = ['worktrees', 'ultracode'];

function newSessionForm(value: Record<string, unknown>): Record<string, unknown> | null {
  const form: Record<string, unknown> = {};
  for (const [key, max] of Object.entries(NEW_SESSION_TEXT)) {
    if (value[key] === undefined) continue;
    const body = text(value[key], max);
    if (body === null) return null;
    form[key] = body;
  }
  for (const [key, max] of Object.entries(NEW_SESSION_NULLABLE)) {
    if (value[key] === undefined) continue;
    if (value[key] !== null && text(value[key], max) === null) return null;
    form[key] = value[key];
  }
  for (const [key, max] of Object.entries(NEW_SESSION_PICKS)) {
    if (value[key] === undefined) continue;
    if (text(value[key], max) === null) return null;
    form[key] = value[key];
  }
  for (const key of NEW_SESSION_FLAGS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') return null;
    form[key] = value[key];
  }
  if (value['solutions'] !== undefined) {
    const list = value['solutions'];
    if (!Array.isArray(list) || list.length > 200 || list.some((item) => text(item, 200) === null)) return null;
    form['solutions'] = [...(list as string[])];
  }
  if (value['model'] !== undefined) {
    const model = value['model'];
    if (model !== null) {
      if (!isRecord(model)) return null;
      const name = model['model'] ?? null;
      const effort = model['effort'] ?? null;
      if ((name !== null && text(name, 128) === null) || (effort !== null && text(effort, 64) === null)) return null;
      form['model'] = { model: name, effort };
    } else {
      form['model'] = null;
    }
  }
  return form;
}

function todoForm(value: Record<string, unknown>): TodoFormDraft | null {
  const title = text(value['title'] ?? '', TODO_TITLE_MAX);
  const description = text(value['description'] ?? '', TODO_DESCRIPTION_MAX);
  const plan = text(value['plan'] ?? '', TODO_PLAN_MAX);
  const priority = text(value['priority'] ?? DEFAULT_TODO_PRIORITY, 16);
  const estimate = text(value['estimate'] ?? '', 16);
  if (title === null || description === null || plan === null || priority === null || estimate === null) return null;
  return { title, description, plan, priority: (TODO_PRIORITIES as readonly string[]).includes(priority) ? priority : DEFAULT_TODO_PRIORITY, estimate };
}

/**
 * The value of `field` in its normalized shape (unknown keys dropped), or `null`
 * when it is not one (422 `invalid`). Shared by the server's PUT and the UI's restore.
 */
export function parseDraftValue<K extends DraftKind>(field: string, value: unknown): DraftValues[K] | null;
export function parseDraftValue(field: string, value: unknown): DraftValues[DraftKind] | null {
  if (!(isDraftField(field) || isMachineDraftField(field)) || !isRecord(value)) return null;
  switch (draftKind(field)) {
    case 'composer': {
      const body = text(value['text'] ?? '', DRAFT_TEXT_MAX);
      const raw = value['attachments'] ?? [];
      if (body === null || !Array.isArray(raw) || raw.length > 20) return null;
      const attachments: DraftAttachmentRef[] = [];
      for (const item of raw) {
        const ref = attachmentRef(item);
        if (!ref) return null;
        attachments.push(ref);
      }
      return { text: body, attachments };
    }
    case 'question': {
      const raw = value['picks'];
      if (!isRecord(raw)) return null;
      const picks: Record<string, QuestionDraftPick> = {};
      for (const [id, pick] of Object.entries(raw)) {
        if (id.length > 128) return null;
        if (typeof pick === 'number' && Number.isInteger(pick) && pick >= 0 && pick < 100) picks[id] = pick;
        else if (isRecord(pick) && typeof pick['text'] === 'string' && pick['text'].length <= 2000) picks[id] = { text: pick['text'], editing: pick['editing'] === true };
        else return null;
      }
      return { picks };
    }
    case 'review': {
      const comment = text(value['comment'] ?? '', 4000);
      return comment === null ? null : { comment };
    }
    case 'todo-add':
    case 'todo-edit':
      return todoForm(value);
    case 'commit': {
      const message = text(value['message'] ?? '', 4000);
      return message === null ? null : { message };
    }
    case 'new-session': {
      const raw = value['form'] ?? {};
      const branch = value['simpleBranch'] ?? null;
      if (!isRecord(raw) || (branch !== null && text(branch, 200) === null)) return null;
      const form = newSessionForm(raw);
      return form === null ? null : { form, simpleBranch: branch as string | null };
    }
  }
}

/**
 * `true` when the value holds nothing worth keeping: an empty composer (no text,
 * no chips), no picks, an empty comment or commit message, a + Add form as it opens
 * (D70: plan `No plan`, medium), a New-session form without typed text. Saving an empty value clears the draft. An Edit form is
 * kept while it is open, so it is never empty here (Save or Cancel clears it).
 */
export function draftIsEmpty(field: string, value: unknown): boolean {
  const parsed = parseDraftValue(field, value);
  if (parsed === null) return true;
  switch (draftKind(field)) {
    case 'composer': {
      const composer = parsed as ComposerDraft;
      return composer.text.trim() === '' && composer.attachments.length === 0;
    }
    case 'question':
      return Object.keys((parsed as QuestionDraft).picks).length === 0;
    case 'review':
      return (parsed as ReviewDraft).comment.trim() === '';
    case 'todo-add': {
      const form = parsed as TodoFormDraft;
      return form.title.trim() === '' && form.description.trim() === '' && (form.plan.trim() === '' || form.plan === TODO_NO_PLAN) && form.priority === DEFAULT_TODO_PRIORITY && form.estimate.trim() === '';
    }
    case 'todo-edit':
      return false;
    case 'commit':
      return (parsed as CommitDraft).message.trim() === '';
    case 'new-session': {
      // Only typed text is worth keeping (the picks alone are not: they reopen as they were set).
      const draft = parsed as NewSessionDraft;
      const typed = (key: string): boolean => typeof draft.form[key] === 'string' && (draft.form[key] as string).trim() !== '';
      return !['name', 'task', 'confluenceUrl', 'figmaUrls', 'branch'].some(typed) && (draft.simpleBranch ?? '').trim() === '';
    }
  }
}

/** The UTF-8 size of a value's JSON (what {@link DRAFT_VALUE_MAX} limits). */
export function draftSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
