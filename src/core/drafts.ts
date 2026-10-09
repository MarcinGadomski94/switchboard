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
export type DraftKind = 'composer' | 'question' | 'review' | 'todo-add' | 'todo-edit';

/** A field key: `composer`, `todo-add`, or `<kind>:<raw id>` (see the module comment). */
const FIELD_PATTERN = /^(?:composer|todo-add|(?:question|review|todo-edit):[A-Za-z0-9._-]{1,128})$/;

/** `true` for a valid field key. */
export function isDraftField(value: unknown): value is string {
  return typeof value === 'string' && FIELD_PATTERN.test(value);
}

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

/** What a field's value is, by kind. */
export interface DraftValues {
  readonly composer: ComposerDraft;
  readonly question: QuestionDraft;
  readonly review: ReviewDraft;
  readonly 'todo-add': TodoFormDraft;
  readonly 'todo-edit': TodoFormDraft;
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

/** The `/hub` `draftChanged` payload: a session's draft was saved or cleared (any device). */
export interface DraftChanged {
  readonly sessionId: string;
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
  if (!isDraftField(field) || !isRecord(value)) return null;
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
  }
}

/**
 * `true` when the value holds nothing worth keeping: an empty composer (no text,
 * no chips), no picks, an empty comment, a + Add form as it opens (D70: plan
 * `No plan`, medium). Saving an empty value clears the draft. An Edit form is
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
  }
}

/** The UTF-8 size of a value's JSON (what {@link DRAFT_VALUE_MAX} limits). */
export function draftSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
