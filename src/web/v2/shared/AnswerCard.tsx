import { type KeyboardEvent, type ReactNode, useState, useSyncExternalStore } from 'react';
import type { Question } from '../../../core/api.ts';
import { useLayout } from '../../shell/useLayout.ts';
import { Button, Checkbox, Chip, ComputerTag, Icon, useToast } from '../components/index.ts';
import { AGENT_WORDS, ANSWER, ANSWERED_WHERE, type AnsweredWhere, NEEDS_KIND_LOOK, STATUS, WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { toV2Path } from '../routes.ts';
import { openNew } from '../new/index.tsx';
import { type AnswerAction, type AnsweredInfo, type BatchDraft, type CardButton, type OpenTarget, type QuestionDraft, batchAnswers, cardButtons, followUpOf, questionAnswer, questionReady, summaryOf, togglePick } from './answer-model.ts';
import { defaultWhere, needsYouStore, useNeedsYou } from './needs-you.ts';
import type { NeedsItem } from './needs-you-model.ts';
import { markRecent } from './recent.ts';
import { displayNameById, useTeamMembers } from './teammates.ts';
import { clock, timeAgo } from './time.ts';
import './shared.css';

/**
 * D131 · the answer card (`docs/v2.md` → *AnswerCard*; the prototype's `cardHTML`),
 * one renderer for every place an item can be answered: the Needs-you queue and
 * Home (`queue`), an agent's chat (`chat`, with its "Needs you · …" header), the
 * Board's quick-answer popover (`popover`) and the phone (`phone`).
 *
 * - Kinds: single-choice questions (a tap sends), multi-select ("Choose any",
 *   Other…), whole batches, approvals (Allow once / Always allow / Deny), asks
 *   (the agent's ask, a reply box, Not waiting: what classic offers), ready for approval (Combine / Send back / View
 *   changes), stopped (Try again / Open / Dismiss), Combine, notes, access
 *   requests, job descriptions, failed routines, pick code projects, alerts.
 * - Keys: with focus on the card, 1–9 press its numbered answers (the prototype's).
 * - Answering goes through `needsYouStore`: the item leaves every list at once,
 *   a toast offers Undo, and every card of it turns into the compact line
 *   ("You answered “Q3” · 13:44 · on Home").
 * - A paired computer that is offline or reconnecting disables the answers, with
 *   the reason.
 */

/** Drafts survive re-renders and other views of the same item (the prototype keeps "your choices so far"). */
const drafts = new Map<string, BatchDraft>();
const draftListeners = new Set<() => void>();
let draftVersion = 0;

function setDraft(key: string, draft: BatchDraft): void {
  drafts.set(key, draft);
  draftVersion += 1;
  for (const listener of draftListeners) listener();
}

function useDraft(key: string): [BatchDraft, (next: BatchDraft) => void] {
  useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    () => draftVersion,
    () => draftVersion,
  );
  return [drafts.get(key) ?? {}, (next) => setDraft(key, next)];
}

/** Where a card is shown. */
export type AnswerCardVariant = 'queue' | 'chat' | 'popover' | 'phone';

/** Activates the card's n-th numbered answer (1–9) when the focus is on the card (not in a text box). */
function onCardKey(event: KeyboardEvent<HTMLElement>): void {
  if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
  const target = event.target as HTMLElement;
  if (target.matches('textarea, input:not([type="checkbox"]):not([type="radio"]), select')) return;
  // `:disabled` also covers the controls of a disabled fieldset (an offline computer's card).
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-num]')).filter((el) => !el.matches(':disabled'));
  const hit = items[Number(event.key) - 1];
  if (!hit) return;
  event.preventDefault();
  hit.click();
}

/** The compact card of an answered item ("✓ You answered “Q3” · 13:44 · on Home"). */
export function AnsweredLine({ info, testId = 'v2-answered' }: { readonly info: Pick<AnsweredInfo, 'summary' | 'at' | 'where' | 'kind' | 'title'>; readonly testId?: string }) {
  return (
    <div className="v2-answered" data-testid={testId} role="status">
      <span className="v2-answered-ok">
        <Icon name="check" size="s" />
      </span>
      <b className="v2-grow">{info.summary}</b>
      <span className="v2-muted" style={{ fontSize: 13 }}>
        {clock(info.at)} · {ANSWERED_WHERE[info.where]}
      </span>
      <span className="v2-answered-q">
        {NEEDS_KIND_LOOK[info.kind].label}: {info.title}
      </span>
    </div>
  );
}

/** One question's options (single-select: buttons; multi-select: checkboxes), with Other…. */
function QuestionBlock({ question, draft, onDraft, keys, immediate, onSend }: { readonly question: Question; readonly draft: QuestionDraft | undefined; readonly onDraft: (next: QuestionDraft) => void; readonly keys: boolean; readonly immediate: boolean; readonly onSend: (draft: QuestionDraft) => void }) {
  const [otherOpen, setOtherOpen] = useState(draft?.other ?? false);
  const num = (index: number): number | undefined => (keys ? index + 1 : undefined);
  if (question.multiSelect) {
    const picks = new Set(draft?.picks ?? []);
    const count = picks.size + (draft?.other && (draft.text ?? '').trim() ? 1 : 0);
    return (
      <div className="v2-qi-q" data-question={question.id}>
        {question.header ? <div className="v2-qi-hint">{question.header}</div> : null}
        <p className="v2-qi-hint">
          {ANSWER.chooseAny}
          {count > 0 ? <b> {ANSWER.choicesKept}</b> : null}
        </p>
        <div className="v2-chk-grid">
          {question.options.map((option, index) => (
            <Checkbox key={option.label} num={num(index)} label={option.label} title={option.description} checked={picks.has(index)} onChange={() => onDraft(togglePick(draft, index))} />
          ))}
          <Checkbox num={num(question.options.length)} label={ANSWER.other} checked={draft?.other ?? false} onChange={(event) => onDraft({ ...draft, other: event.currentTarget.checked })} />
        </div>
        {draft?.other ? (
          <div className="v2-reply">
            <input className="v2-field" aria-label={ANSWER.other} placeholder={ANSWER.otherPlaceholder} value={draft.text ?? ''} onChange={(event) => onDraft({ ...draft, text: event.currentTarget.value })} />
          </div>
        ) : null}
        <div className="v2-muted" style={{ fontSize: 13, marginTop: 8 }} data-testid="v2-answer-count">
          {count > 0 ? ANSWER.chosen(count) : ANSWER.nothingChosen}
        </div>
      </div>
    );
  }
  return (
    <div className="v2-qi-q" data-question={question.id}>
      {question.header && question.header !== question.text ? <div className="v2-qi-hint">{question.header}</div> : null}
      {immediate ? <p className="v2-qi-hint">{ANSWER.tapToSend}</p> : null}
      <div className="v2-qi-actions" style={{ marginTop: 6 }}>
        {question.options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            className="v2-opt"
            data-option={index}
            {...(keys ? { 'data-num': index + 1 } : {})}
            aria-pressed={immediate ? undefined : draft?.index === index}
            title={option.description}
            onClick={() => {
              const next = { index, other: false };
              if (immediate) onSend(next);
              else onDraft(next);
            }}
          >
            {keys ? (
              <span className="v2-num" aria-hidden="true">
                {index + 1}
              </span>
            ) : null}
            {option.label}
          </button>
        ))}
        <button type="button" className="v2-opt" data-option="other" {...(keys ? { 'data-num': question.options.length + 1 } : {})} aria-expanded={otherOpen} onClick={() => setOtherOpen(true)}>
          {keys ? (
            <span className="v2-num" aria-hidden="true">
              {question.options.length + 1}
            </span>
          ) : null}
          {ANSWER.other}
        </button>
        {otherOpen ? (
          <form
            className="v2-reply"
            onSubmit={(event) => {
              event.preventDefault();
              const next = { ...draft, other: true, text: draft?.text ?? '' };
              if (immediate && questionReady(question, next)) onSend(next);
            }}
          >
            <input className="v2-field" aria-label={ANSWER.other} placeholder={ANSWER.otherPlaceholder} autoFocus value={draft?.text ?? ''} onChange={(event) => onDraft({ other: true, text: event.currentTarget.value })} />
            {immediate ? (
              <Button type="submit" variant="primary" disabled={!(draft?.text ?? '').trim()}>
                {ANSWER.send}
              </Button>
            ) : null}
          </form>
        ) : null}
      </div>
    </div>
  );
}

/**
 * D131 · an answer card for `item`. `where` is the place it is shown (the compact
 * line says it: "on Home"). `onAnswered` runs after the answer is taken (before
 * it is sent: the Undo window).
 */
export function AnswerCard({ item, variant = 'queue', where = 'needs', onAnswered, openAgent = false, testId = 'v2-answer-card' }: { readonly item: NeedsItem; readonly variant?: AnswerCardVariant; readonly where?: AnsweredWhere; readonly onAnswered?: (item: NeedsItem) => void; /** Lane H: an "Open agent" link in the head (the Needs-you page). */ readonly openAgent?: boolean; readonly testId?: string }) {
  const { navigate } = useV2Router();
  const layout = useLayout();
  const toast = useToast();
  const { errors } = useNeedsYou();
  const [draft, setDraftFor] = useDraft(item.key);
  const [input, setInput] = useState<{ readonly mode: 'send-back' | 'note-edit' | 'jd-edit'; readonly text: string } | null>(null);
  const [reply, setReply] = useState('');
  // No number keys on a phone (the variant, or a phone-sized window).
  const keys = variant !== 'phone' && layout !== 'phone';
  const look = NEEDS_KIND_LOOK[item.kind];
  const off = item.computer !== null && item.computer.state !== 'online';
  const error = errors.get(item.key) ?? null;
  const members = useTeamMembers();
  const source = item.agent ? displayNameById(item.agent.sessionId, item.agent.name, members) : '';
  const place = defaultWhere(where);

  const answer = (action: AnswerAction): void => {
    needsYouStore.answer(item, action, place);
    // Fix after 2.0: answering from an agent's chat counts as talking to it (the rail's Recent).
    if (place === 'chat') markRecent(item.agent?.sessionId);
    onAnswered?.(item);
    // Lane H: what the classic Inbox does after these actions (open + New with the fix prefill; the updates page).
    const follow = followUpOf(item, action);
    if (follow?.type === 'new-agent') openNew({ kind: 'agent', prefill: follow.prefill, machine: follow.machine });
    else if (follow?.type === 'path') navigate(toV2Path(follow.path));
    toast({ text: `${summaryOf(item, action)}${source ? ` · sent to ${source}` : ''}`, undo: () => {
        needsYouStore.undo(item.key);
      },
    });
  };
  const open = (target: OpenTarget): void => {
    if (target.type === 'url') window.open(target.url, '_blank', 'noopener');
    else if (target.type === 'agent') navigate(`/agents/${encodeURIComponent(target.sessionId)}${target.tab ? `/${target.tab}` : ''}`);
    else navigate(toV2Path(target.path));
  };
  const press = (button: CardButton): void => {
    if (button.intent.type === 'answer') answer(button.intent.action);
    else if (button.intent.type === 'open') open(button.intent.target);
    else setInput({ mode: button.intent.mode, text: button.intent.mode === 'send-back' ? '' : button.intent.mode === 'note-edit' ? (item.quote ?? '') : (item.charter?.after.howItWorks ?? item.quote ?? '') });
  };

  let numbered = 0;
  const nextNum = (): number | undefined => (keys ? ++numbered : undefined);

  // ── Body and actions per kind ──
  let body: ReactNode = null;
  let actions: ReactNode = null;
  const questions = item.questions ?? [];
  if ((item.kind === 'question' || item.kind === 'multi') && questions.length > 0) {
    const single = questions.length === 1 && !questions[0]?.multiSelect;
    body = (
      <>
        {item.text ? <p className="v2-qi-text">{item.text}</p> : null}
        {questions.map((question) => (
          <div key={question.id}>
            {questions.length > 1 ? <p className="v2-qi-title" style={{ fontSize: 15 }}>{question.text}</p> : null}
            <QuestionBlock
              question={question}
              draft={draft[question.id]}
              keys={keys && questions.length === 1}
              immediate={single}
              onDraft={(next) => setDraftFor({ ...draft, [question.id]: next })}
              onSend={(next) => {
                const one = questionAnswer(question, next);
                if (one) answer({ type: 'questions', answers: [one] });
              }}
            />
          </div>
        ))}
      </>
    );
    if (!single) {
      const ready = batchAnswers(questions, draft);
      actions = (
        <Button variant="primary" disabled={!ready} title={ready ? undefined : ANSWER.answerEveryQuestion} data-testid="v2-answer-send" onClick={() => ready && answer({ type: 'questions', answers: ready })}>
          {ANSWER.sendAnswer}
        </Button>
      );
    }
  } else {
    const buttons = cardButtons(item);
    if (item.kind === 'approval') {
      body = (
        <>
          {item.command ? <code className="v2-code">{item.command}</code> : null}
          {item.quote ? <div className="v2-quote">{item.quote}</div> : null}
          {item.text ? <p className="v2-qi-text" style={{ fontSize: 14 }}>{item.text}</p> : null}
        </>
      );
    } else if (item.kind === 'ask') {
      body = (
        <>
          {item.quote ? <div className="v2-quote" data-testid="v2-answer-ask">{item.quote}</div> : null}
          <span className="v2-waiting">
            <Icon name="hourglass" size="s" />
            {WORDS.waitingForYou}
            {/* Fix after 2.0: as the classic session header, a text-checked ask says so. */}
            {item.detected ? (
              <span className="v2-muted" data-testid="v2-answer-detected" title={AGENT_WORDS.detectedHint}>
                · {AGENT_WORDS.detected}
              </span>
            ) : null}
          </span>
        </>
      );
    } else if (item.kind === 'note') {
      body = (
        <>
          {item.text && item.memory ? <p className="v2-qi-text">{item.text}</p> : null}
          {item.quote ? <div className="v2-quote">{item.quote}</div> : !item.memory && item.text ? <p className="v2-qi-text">{item.text}</p> : null}
          {item.context ? (
            <p className="v2-qi-hint">
              <Icon name="book" size="s" /> Scope: <b>{item.context}</b> · every agent working there will know this.
            </p>
          ) : null}
        </>
      );
    } else if (item.kind === 'jd') {
      body = item.quote ? <div className="v2-quote">{item.quote}</div> : null;
    } else if (item.kind === 'pick') {
      body = (
        <>
          <p className="v2-qi-hint">{ANSWER.pickHint}</p>
          {item.text ? <p className="v2-qi-text">{item.text}</p> : null}
        </>
      );
    } else {
      body = item.text ? <p className="v2-qi-text">{item.text}</p> : null;
    }
    actions = (
      <>
        {item.kind === 'ask' ? (
          <form
            className="v2-reply"
            style={{ marginTop: 0 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (reply.trim()) answer({ type: 'reply', text: reply.trim() });
            }}
          >
            <input className="v2-field" aria-label={ANSWER.replyTo(source)} placeholder={ANSWER.replyTo(source)} value={reply} onChange={(event) => setReply(event.currentTarget.value)} />
            <Button type="submit" variant="primary" icon="send" disabled={!reply.trim()}>
              {ANSWER.send}
            </Button>
          </form>
        ) : null}
        {buttons.map((button) => (
          <Button key={button.id} variant={button.variant} size={item.kind === 'ask' ? 'sm' : 'm'} icon={button.icon} num={nextNum()} data-action={button.id} onClick={() => press(button)}>
            {button.label}
          </Button>
        ))}
      </>
    );
  }

  const inputBox = input ? (
    <form
      className="v2-reply"
      onSubmit={(event) => {
        event.preventDefault();
        const text = input.text.trim();
        if (input.mode === 'send-back') {
          if (text) answer({ type: 'send-back', comment: text });
        } else if (input.mode === 'note-edit') answer({ type: 'note', decision: 'approve', text: text || item.quote || '' });
        else if (item.charter) answer({ type: 'team', decision: 'approve', charter: { ...item.charter.after, howItWorks: text } });
        setInput(null);
      }}
    >
      <textarea className="v2-field" aria-label={input.mode === 'send-back' ? ANSWER.sendBackPlaceholder : 'Edit'} placeholder={input.mode === 'send-back' ? ANSWER.sendBackPlaceholder : undefined} value={input.text} onChange={(event) => setInput({ ...input, text: event.currentTarget.value })} style={{ minHeight: 70 }} data-autofocus="" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Button type="submit" variant="primary" disabled={input.mode === 'send-back' && !input.text.trim()}>
          {input.mode === 'send-back' ? ANSWER.sendBack : input.mode === 'note-edit' ? ANSWER.approve : ANSWER.accept}
        </Button>
        <Button variant="ghost" onClick={() => setInput(null)}>
          Cancel
        </Button>
      </div>
    </form>
  ) : null;

  const hint = keys && numbered > 1 && variant === 'chat' ? (
    <span className="v2-keyhint">
      <Icon name="cmd" size="s" />
      {ANSWER.keys(Math.min(numbered, 9))}
    </span>
  ) : null;

  const card = (
    <article className="v2-qi" data-kind={item.kind} data-key={item.key} data-source={item.source} data-testid={testId} tabIndex={0} aria-label={`${look.label} from ${source || 'Switchboard'}: ${item.title}`} onKeyDown={onCardKey}>
      {variant !== 'chat' ? (
        <div className="v2-qi-head">
          <Chip tone={STATUS[look.status].tone} icon={look.icon} size="s">
            {look.label}
          </Chip>
          {source ? (
            item.agent?.sessionId ? (
              <button type="button" className="v2-qi-src" onClick={() => open({ type: 'agent', sessionId: item.agent?.sessionId as string })}>
                {source}
              </button>
            ) : (
              <span className="v2-qi-src">{source}</span>
            )
          ) : null}
          {item.context && variant !== 'phone' && item.kind !== 'note' ? <span>· {item.context}</span> : null}
          {item.crew ? (
            <Chip tone="outline" icon="crew">
              {item.crew.teammate}
              {item.crew.name ? ` · ${item.crew.name}` : ''}
            </Chip>
          ) : null}
          {item.computer ? <ComputerTag name={item.computer.name} state={item.computer.state} short={variant === 'phone'} /> : null}
          <span className="v2-qi-time">{timeAgo(item.createdAt)}</span>
          {openAgent && item.agent?.sessionId ? (
            <button type="button" className="v2-qi-open" data-testid="v2-answer-open-agent" onClick={() => open({ type: 'agent', sessionId: item.agent?.sessionId as string })}>
              {ANSWER.openAgent}
              <Icon name="arrow-r" size="s" />
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="v2-qi-title">{item.title}</p>
      {/* Lane H: a fieldset, so an offline computer's card disables every answer (the options too), not only the action row. */}
      <fieldset className="v2-qi-body" disabled={off || undefined}>
        {body}
        {inputBox ?? (
          <div className="v2-qi-actions" aria-disabled={off || undefined}>
            {actions}
            {hint}
          </div>
        )}
      </fieldset>
      {off ? (
        <div className="v2-offline-note" data-testid="v2-answer-offline">
          <Icon name="offline" size="s" />
          {item.computer?.state === 'reconnecting' ? `Reconnecting to ${item.computer.name}… You can answer when it is back.` : ANSWER.offline(item.computer?.name ?? '')}
        </div>
      ) : null}
      {error ? (
        <div className="v2-qi-error" role="alert" data-testid="v2-answer-error">
          <Icon name="alert" size="s" />
          Not sent: {error}
        </div>
      ) : null}
    </article>
  );

  if (variant !== 'chat') return card;
  return (
    <div className="v2-acard" data-kind={item.kind} data-key={item.key}>
      <div className="v2-acard-h">
        <Icon name={look.icon} size="s" />
        Needs you · {look.label}
        <span className="v2-acard-tm">{clock(item.createdAt)}</span>
      </div>
      {card}
    </div>
  );
}

/**
 * D131 · an item's card wherever it is shown: the live card while it waits, the
 * compact line once it was answered on this page (from any view). `item` may be
 * gone from the list already; pass its `key` so the compact line is found.
 */
export function AnswerSlot({ itemKey, item, variant = 'chat', where = 'chat' }: { readonly itemKey: string; readonly item: NeedsItem | null; readonly variant?: AnswerCardVariant; readonly where?: AnsweredWhere }) {
  const { answered } = useNeedsYou();
  const info = answered.get(itemKey);
  if (info) return <AnsweredLine info={info} />;
  return item ? <AnswerCard item={item} variant={variant} where={where} /> : null;
}
