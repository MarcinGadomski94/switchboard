import type { BatchAnswer, NewSessionPrefill, Question } from '../../../core/api.ts';
import type { TeamCharter } from '../../../core/team.ts';
import { ANSWER, type AnsweredWhere, actionLabel } from '../glossary.ts';
import type { NeedsItem } from './needs-you-model.ts';

/**
 * D131 · what answering a "needs you" item means, kept free of React
 * (`docs/v2.md` → *AnswerCard*): the buttons each kind offers, the answer each
 * button sends, the multi-select draft, and the one-line summary the compact
 * (answered) card shows. Unit-tested; `AnswerCard.tsx` renders it and
 * `needs-you.ts` sends it.
 */

/** An answer the store sends (after the Undo window). */
export type AnswerAction =
  /** A question batch's answers (`POST /api/questions/batch/{id}/answers`). */
  | { readonly type: 'questions'; readonly answers: readonly BatchAnswer[] }
  /** A permission request's decision (`POST /api/inbox/{id}/actions/{decision}`). */
  | { readonly type: 'permission'; readonly decision: 'allow-once' | 'always-allow' | 'deny' }
  /** A system item's action (`POST /api/inbox/{id}/actions/{actionId}`). */
  | { readonly type: 'server'; readonly actionId: string }
  /** A reply to an agent's ask (`POST /api/sessions/{id}/messages`); the ask is then closed. */
  | { readonly type: 'reply'; readonly text: string }
  /** "Not waiting" on an ask: the agent carries on (its "Waiting for you" item is dismissed, D124). */
  | { readonly type: 'not-waiting' }
  /** Try a stopped step again: a message to its agent, then the item is dismissed. */
  | { readonly type: 'retry'; readonly text: string }
  /** Send a ready step back with a note (a plan item: `send-back`; else a message to its agent). */
  | { readonly type: 'send-back'; readonly comment: string }
  /** A crew request's decision (`POST /api/team/requests/{id}/{decision}`). */
  | { readonly type: 'team'; readonly decision: 'approve' | 'decline' | 'dismiss'; readonly charter?: TeamCharter }
  /** A proposed note (`POST /api/memory/entries/{id}/approve|reject`), optionally edited first. */
  | { readonly type: 'note'; readonly decision: 'approve' | 'reject'; readonly text?: string }
  /** Hide an alert on this browser only (usage alerts have no server item). */
  | { readonly type: 'dismiss-local' };

/** Where a button goes instead of answering (nothing is sent). */
export type OpenTarget =
  | { readonly type: 'agent'; readonly sessionId: string; readonly tab?: 'changes' }
  | { readonly type: 'path'; readonly path: string }
  | { readonly type: 'url'; readonly url: string };

/** What a button does. */
export type ButtonIntent =
  | { readonly type: 'answer'; readonly action: AnswerAction }
  | { readonly type: 'open'; readonly target: OpenTarget }
  /** Opens a text box first (Send back, Edit first, Edit); the box's text completes the answer. */
  | { readonly type: 'input'; readonly mode: 'send-back' | 'note-edit' | 'jd-edit' };

/** One button of an answer card. */
export interface CardButton {
  readonly id: string;
  readonly label: string;
  readonly variant: 'primary' | 'default' | 'danger' | 'ghost';
  readonly icon?: string;
  readonly intent: ButtonIntent;
}

/** The server action ids that only open something (the item stays open). */
const LINK_ACTIONS = new Set(['open-session', 'open-plan', 'open-pr', 'open-memory']);

/** `true` for an action id that only opens something. */
export function isLinkAction(id: string): boolean {
  return LINK_ACTIONS.has(id);
}

/** The v2 path an "open" server action goes to (`null` when it cannot be followed here). */
export function openTargetOf(item: NeedsItem, actionId: string): OpenTarget | null {
  if (actionId === 'open-session') return item.agent?.sessionId ? { type: 'agent', sessionId: item.agent.sessionId } : null;
  if (actionId === 'open-pr') return item.url && /^https:\/\//.test(item.url) ? { type: 'url', url: item.url } : null;
  if (actionId === 'open-plan' || actionId === 'open-memory') return item.route ? { type: 'path', path: item.route } : null;
  return null;
}

/** A system item's server actions as buttons (v2 words; the first one primary; links ghost). */
function serverButtons(item: NeedsItem, skip: ReadonlySet<string> = new Set()): CardButton[] {
  const out: CardButton[] = [];
  item.actions.forEach((action, index) => {
    if (skip.has(action.id)) return;
    const label = actionLabel(action.id, action.label);
    if (isLinkAction(action.id)) {
      const target = openTargetOf(item, action.id);
      if (target) out.push({ id: action.id, label, variant: 'ghost', intent: { type: 'open', target } });
      return;
    }
    const icon = action.id === 'plan-merge' || action.id === 'merge-pr' ? 'merge' : action.id === 'retry-run' ? 'play' : action.id === 'try-again' ? 'refresh' : undefined;
    out.push({ id: action.id, label, variant: index === 0 ? 'primary' : action.id === 'dismiss' ? 'ghost' : 'default', ...(icon ? { icon } : {}), intent: { type: 'answer', action: { type: 'server', actionId: action.id } } });
  });
  return out;
}

/** The text a Try again sends a stopped agent. */
export const RETRY_TEXT = 'Please try again and finish the task.';
/** The text "Go ahead" sends an agent that waits for a yes. */
export const GO_AHEAD_TEXT = 'Go ahead.';

/**
 * The buttons of a card (questions excepted: their options are the buttons,
 * `questionButtons`). Kinds follow the prototype's `cardHTML`.
 */
export function cardButtons(item: NeedsItem): CardButton[] {
  const sessionId = item.agent?.sessionId ?? null;
  switch (item.kind) {
    case 'approval': {
      if (item.request) {
        return [
          { id: 'approve', label: ANSWER.approve, variant: 'primary', icon: 'check', intent: { type: 'answer', action: { type: 'team', decision: 'approve' } } },
          { id: 'decline', label: ANSWER.deny, variant: 'danger', icon: 'x', intent: { type: 'answer', action: { type: 'team', decision: 'decline' } } },
        ];
      }
      const ids = new Set(item.actions.map((action) => action.id));
      const buttons: CardButton[] = [{ id: 'allow-once', label: ANSWER.allowOnce, variant: 'primary', icon: 'check', intent: { type: 'answer', action: { type: 'permission', decision: 'allow-once' } } }];
      if (ids.has('always-allow')) buttons.push({ id: 'always-allow', label: ANSWER.alwaysAllow, variant: 'default', intent: { type: 'answer', action: { type: 'permission', decision: 'always-allow' } } });
      buttons.push({ id: 'deny', label: ANSWER.deny, variant: 'danger', icon: 'x', intent: { type: 'answer', action: { type: 'permission', decision: 'deny' } } });
      return buttons;
    }
    case 'ready': {
      const buttons = serverButtons(item);
      // Send back after Combine (a note goes back to the step's agent), then View changes.
      if (sessionId) {
        const at = buttons.findIndex((b) => b.variant === 'primary') + 1;
        buttons.splice(at, 0, { id: 'send-back', label: ANSWER.sendBack, variant: 'default', icon: 'send-back', intent: { type: 'input', mode: 'send-back' } });
        buttons.push({ id: 'changes', label: ANSWER.viewChanges, variant: 'ghost', intent: { type: 'open', target: { type: 'agent', sessionId, tab: 'changes' } } });
      }
      return buttons;
    }
    case 'ask':
      return [
        { id: 'go-ahead', label: ANSWER.goAhead, variant: 'default', icon: 'check', intent: { type: 'answer', action: { type: 'reply', text: GO_AHEAD_TEXT } } },
        { id: 'not-waiting', label: ANSWER.notWaiting, variant: 'ghost', intent: { type: 'answer', action: { type: 'not-waiting' } } },
      ];
    case 'stopped': {
      const own = new Set(item.actions.map((action) => action.id));
      const buttons: CardButton[] = [];
      if (!own.has('try-again') && sessionId && item.source === 'inbox') buttons.push({ id: 'retry', label: ANSWER.tryAgain, variant: 'primary', icon: 'refresh', intent: { type: 'answer', action: { type: 'retry', text: RETRY_TEXT } } });
      for (const button of serverButtons(item)) buttons.push(buttons.length === 0 || button.variant !== 'primary' ? button : { ...button, variant: 'default' });
      return buttons;
    }
    case 'routine': {
      const buttons = serverButtons(item);
      buttons.splice(Math.min(1, buttons.length), 0, { id: 'open-routine', label: ANSWER.openRoutine, variant: 'default', intent: { type: 'open', target: { type: 'path', path: '/routines' } } });
      return buttons;
    }
    case 'note':
      if (item.memory) {
        return [
          { id: 'note-approve', label: ANSWER.approve, variant: 'primary', icon: 'check', intent: { type: 'answer', action: { type: 'note', decision: 'approve' } } },
          { id: 'note-edit', label: ANSWER.editFirst, variant: 'default', icon: 'edit', intent: { type: 'input', mode: 'note-edit' } },
          { id: 'note-reject', label: ANSWER.reject, variant: 'ghost', intent: { type: 'answer', action: { type: 'note', decision: 'reject' } } },
        ];
      }
      return serverButtons(item);
    case 'access': {
      const crewId = item.crew?.id;
      const path = crewId ? `/crews/${encodeURIComponent(crewId)}?member=${encodeURIComponent(item.crew?.memberId ?? '')}&tab=access` : '/crews';
      return [
        { id: 'add-key', label: ANSWER.addKey, variant: 'primary', icon: 'shield', intent: { type: 'open', target: { type: 'path', path } } },
        { id: 'not-now', label: ANSWER.notNow, variant: 'ghost', intent: { type: 'answer', action: { type: 'team', decision: 'decline' } } },
      ];
    }
    case 'jd':
      return [
        { id: 'jd-accept', label: ANSWER.accept, variant: 'primary', icon: 'check', intent: { type: 'answer', action: { type: 'team', decision: 'approve', ...(item.charter ? { charter: item.charter.after } : {}) } } },
        { id: 'jd-edit', label: ANSWER.edit, variant: 'default', icon: 'edit', intent: { type: 'input', mode: 'jd-edit' } },
        { id: 'jd-dismiss', label: ANSWER.dismiss, variant: 'ghost', intent: { type: 'answer', action: { type: 'team', decision: 'dismiss' } } },
      ];
    case 'alert':
      if (item.source === 'usage') {
        return [
          { id: 'ok', label: ANSWER.ok, variant: 'default', intent: { type: 'answer', action: { type: 'dismiss-local' } } },
          { id: 'manage', label: ANSWER.manageUsage, variant: 'ghost', intent: { type: 'open', target: { type: 'path', path: '/settings/usage' } } },
        ];
      }
      return serverButtons(item);
    default:
      // `pick` and anything else the server offers actions for.
      return serverButtons(item);
  }
}

/**
 * Lane H · what the page does right after an answer, besides sending it (the
 * classic Inbox's `newSessionAfter` / `routeAfter`): a failed routine's "Fix it in
 * a new agent" opens + New with the item's prefill (on its computer); this
 * computer's update item's "What's new" goes to the updates settings. `null` for
 * every other answer.
 */
export type AnswerFollowUp =
  | { readonly type: 'new-agent'; readonly prefill: NewSessionPrefill; readonly machine: string | null }
  | { readonly type: 'path'; readonly path: string };

/** The {@link AnswerFollowUp} of answering `item` with `action`. */
export function followUpOf(item: Pick<NeedsItem, 'inbox' | 'computer'>, action: AnswerAction): AnswerFollowUp | null {
  if (action.type !== 'server' || item.inbox?.kind !== 'system') return null;
  if (action.actionId === 'open-fix-session') return { type: 'new-agent', prefill: item.inbox.prefill ?? {}, machine: item.computer?.id ?? null };
  if (action.actionId === 'whats-new' && !item.computer) return { type: 'path', path: '/settings/updates' };
  return null;
}

// ── Questions ─────────────────────────────────────────────────────────

/** The draft of one question (kept while the card is re-rendered or shown elsewhere). */
export interface QuestionDraft {
  /** Single-select: the picked option. */
  readonly index?: number;
  /** Multi-select: the picked options, ascending. */
  readonly picks?: readonly number[];
  /** "Other…": the developer's own words. */
  readonly text?: string;
  /** "Other…" is ticked (multi-select) or opened (single-select). */
  readonly other?: boolean;
}

/** A batch's drafts by question id. */
export type BatchDraft = Readonly<Record<string, QuestionDraft>>;

/** Picks or unpicks option `index` of a multi-select draft. */
export function togglePick(draft: QuestionDraft | undefined, index: number): QuestionDraft {
  const picks = new Set(draft?.picks ?? []);
  if (picks.has(index)) picks.delete(index);
  else picks.add(index);
  return { ...draft, picks: [...picks].sort((a, b) => a - b) };
}

/** `true` when a question's draft can be sent (an option, or own words of 1–2000 characters). */
export function questionReady(question: Pick<Question, 'multiSelect'>, draft: QuestionDraft | undefined): boolean {
  const text = draft?.other ? (draft.text ?? '').trim() : '';
  if (text.length > 2000) return false;
  if (question.multiSelect) return (draft?.picks?.length ?? 0) > 0 || text.length > 0;
  return draft?.index !== undefined || text.length > 0;
}

/** The answer of one question from its draft, `null` while not ready. */
export function questionAnswer(question: Pick<Question, 'id' | 'multiSelect'>, draft: QuestionDraft | undefined): BatchAnswer | null {
  if (!questionReady(question, draft)) return null;
  const text = draft?.other ? (draft.text ?? '').trim() : '';
  if (question.multiSelect) return { questionId: question.id, answerIndexes: [...(draft?.picks ?? [])], ...(text ? { text } : {}) };
  if (text) return { questionId: question.id, text };
  return { questionId: question.id, answerIndex: draft?.index as number };
}

/** Every question's answer, or `null` while one is missing (a batch is sent whole). */
export function batchAnswers(questions: readonly Question[], draft: BatchDraft): BatchAnswer[] | null {
  const out: BatchAnswer[] = [];
  for (const question of questions) {
    const answer = questionAnswer(question, draft[question.id]);
    if (!answer) return null;
    out.push(answer);
  }
  return out;
}

/** The words of a question's answer ("Q3", "Checkout, Payments, my own"). */
export function answerWords(question: Pick<Question, 'options'>, answer: BatchAnswer): string[] {
  const words: string[] = [];
  if (answer.answerIndex !== undefined) words.push(question.options[answer.answerIndex]?.label ?? `option ${answer.answerIndex + 1}`);
  for (const index of answer.answerIndexes ?? []) words.push(question.options[index]?.label ?? `option ${index + 1}`);
  if (answer.text) words.push(answer.text);
  return words;
}

// ── Summaries (the compact card) ─────────────────────────────────────────

/** What the compact card says after an answer (the prototype's `pill`). */
export function summaryOf(item: NeedsItem, action: AnswerAction): string {
  switch (action.type) {
    case 'questions': {
      const words = action.answers.flatMap((answer) => {
        const question = item.questions?.find((q) => q.id === answer.questionId);
        return question ? answerWords(question, answer) : [];
      });
      if (item.kind === 'multi' || words.length > 1) return ANSWER.youChose(words);
      return ANSWER.youAnswered(words[0] ?? '');
    }
    case 'permission':
      return action.decision === 'allow-once' ? ANSWER.youAllowed : action.decision === 'always-allow' ? ANSWER.youAlwaysAllowed : ANSWER.youDenied;
    case 'reply':
      return ANSWER.youReplied(action.text);
    case 'not-waiting':
      return ANSWER.youMarkedNotWaiting;
    case 'retry':
      return ANSWER.youRetried;
    case 'send-back':
      return ANSWER.youSentBack;
    case 'team':
      if (item.kind === 'jd') return action.decision === 'approve' ? ANSWER.youAccepted : ANSWER.youDismissed;
      return action.decision === 'approve' ? 'You approved it' : action.decision === 'decline' ? (item.kind === 'access' ? 'You said not now' : ANSWER.youDenied) : ANSWER.youDismissed;
    case 'note':
      return action.decision === 'approve' ? ANSWER.youApprovedNote : ANSWER.youRejectedNote;
    case 'dismiss-local':
      return ANSWER.gotIt;
    case 'server': {
      if (action.actionId === 'dismiss') return ANSWER.youDismissed;
      if (action.actionId === 'plan-merge' || action.actionId === 'merge-pr') return ANSWER.youCombined;
      const label = item.actions.find((a) => a.id === action.actionId)?.label ?? action.actionId;
      return `You chose “${actionLabel(action.actionId, label)}”`;
    }
  }
}

/** The answered state a card shows compactly ("You answered … · 13:44 · on Home"). */
export interface AnsweredInfo {
  readonly key: string;
  readonly summary: string;
  /** When (ISO). */
  readonly at: string;
  readonly where: AnsweredWhere;
  /** The item's kind label and title, for the line under it. */
  readonly kind: NeedsItem['kind'];
  readonly title: string;
}

/**
 * The compact line of a question answered elsewhere (the server's record: another
 * browser, a phone, claude.ai): what was answered, from the batch's questions;
 * `null` while any question is still open.
 */
export function answeredFromServer(questions: readonly Question[]): string | null {
  if (questions.length === 0 || questions.some((q) => q.state !== 'answered')) return null;
  const words = questions.flatMap((q) => {
    const picks = q.answerIndexes ?? (q.answerIndex !== null ? [q.answerIndex] : []);
    return [...picks.map((i) => q.options[i]?.label ?? `option ${i + 1}`), ...(q.answerText ? [q.answerText] : [])];
  });
  if (words.length === 0) return questions[0]?.answeredOn === 'claude.ai' ? 'Answered on claude.ai' : 'Answered';
  return questions.some((q) => q.multiSelect) || words.length > 1 ? ANSWER.youChose(words) : ANSWER.youAnswered(words[0] ?? '');
}
