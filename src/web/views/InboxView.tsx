import { type KeyboardEvent, useEffect, useState } from 'react';
import type { AnswerBatch, InboxAction, InboxItem, Session } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { QuestionCard } from '../components/QuestionCard.tsx';
import { FolderTag } from '../folders/FolderTag.tsx';
import { MachineTag } from '../components/MachineTag.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { Link } from '../router.tsx';
import { formatAge, statusColor } from '../shell/format.ts';
import {
  ALL_CLEAR,
  INBOX_ZERO,
  INBOX_ZERO_HINT,
  OPEN_SESSION,
  detailBody,
  formatToolInput,
  linksSession,
  newSessionAfter,
  refusalText,
  selectedItem,
  visibleItems,
  waitingLine,
} from './inbox.ts';
import './inbox.css';

/** Re-renders every `ms` so relative ages stay current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function refusal(error: unknown): string {
  return error instanceof ApiError ? refusalText(error.status, error.body) : refusalText(0, null);
}

/** Enter / Space on a `role="button"` element acts like a click. */
function onKeyActivate(action: () => void) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  };
}

function ListCard({ item, selected, now, onPick }: { readonly item: InboxItem; readonly selected: boolean; readonly now: number; readonly onPick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="sb-inbox__card"
      data-testid="inbox-item"
      data-item-id={item.id}
      data-kind={item.kind}
      data-selected={selected ? 'true' : 'false'}
      aria-pressed={selected}
      onClick={onPick}
      onKeyDown={onKeyActivate(onPick)}
    >
      <div className="sb-inbox__card-head">
        <span className="sb-inbox__dot" style={{ background: statusColor(item.status) }} />
        {/* D48: a peer's item names its machine. */}
        <MachineTag machine={item.machine} />
        <span className="sb-inbox__card-source">{item.sourceTitle ?? item.source}</span>
        <span className="sb-inbox__card-age">{formatAge(item.createdAt, now)}</span>
      </div>
      <div className="sb-inbox__card-title">{item.title}</div>
      <div className="sb-inbox__card-kind">{item.label}</div>
    </div>
  );
}

function Actions({
  item,
  busy,
  onAction,
}: {
  readonly item: InboxItem;
  readonly busy: boolean;
  readonly onAction: (action: InboxAction) => void;
}) {
  return (
    <div className="sb-inbox__actions" data-testid="inbox-actions">
      {(item.actions ?? []).map((action, index) => (
        <button
          key={action.id}
          type="button"
          className="sb-button sb-inbox__action"
          data-testid="inbox-action"
          data-action={action.id}
          data-primary={index === 0 ? 'true' : 'false'}
          disabled={busy}
          onClick={() => onAction(action)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

interface DetailProps {
  readonly item: InboxItem;
  /** D14: the item's session's folder tag (`null` for the default folder or no session). */
  readonly folderTag: string | null;
  readonly folderPath: string | null;
  readonly now: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onAnswers: (body: AnswerBatch) => void;
  /** D48 P4: `message` = a hooked session's Deny message (empty = the fixed text). */
  readonly onAction: (action: InboxAction, message?: string) => void;
}

function Detail({ item, folderTag, folderPath, now, busy, error, onAnswers, onAction }: DetailProps) {
  const body = detailBody(item);
  // D48 P4: a hooked terminal session's Deny can tell Claude why.
  const [denyText, setDenyText] = useState('');
  useEffect(() => setDenyText(''), [item.id]);
  const denyMessage = item.permission?.hook?.denyMessage === true;
  return (
    <>
      <div className="sb-inbox__meta" data-testid="inbox-meta">
        <span className="sb-inbox__dot sb-inbox__dot--lg" style={{ background: statusColor(item.status) }} />
        <span className="sb-inbox__meta-source">{item.sourceTitle ?? item.source}</span>
        <span>·</span>
        <span>{item.label}</span>
        <span>·</span>
        <span>{formatAge(item.createdAt, now)}</span>
        {folderTag ? <FolderTag name={folderTag} title={folderPath} /> : null}
        <MachineTag machine={item.machine} testId="inbox-machine" />
        {linksSession(item) ? (
          <Link to={{ view: 'session', id: item.sessionId, tab: 'chat' }} className="sb-inbox__open" data-testid="inbox-open-session">
            {OPEN_SESSION}
          </Link>
        ) : null}
      </div>
      <div className="sb-inbox__title" data-testid="inbox-title">
        {item.title}
      </div>
      <div className="sb-inbox__branches" data-testid="inbox-branches">
        {item.branches.map((ref) => (
          <span key={`${ref.solution}\u0000${ref.branch}`} className="sb-inbox__branch" data-testid="inbox-branch">
            <span>{ref.solution}</span>
            <span className="sb-inbox__branch-name">⎇ {ref.branch}</span>
          </span>
        ))}
      </div>
      {item.detail ? (
        <div className="sb-inbox__text" data-testid="inbox-text">
          {item.detail}
        </div>
      ) : null}
      {body === 'questions' ? (
        <QuestionCard key={item.id} questions={item.questions ?? []} variant="inbox" busy={busy} error={error} onSend={onAnswers} />
      ) : null}
      {body === 'permission' && item.permission ? (
        <div className="sb-inbox__request" data-testid="permission-request">
          <div className="sb-inbox__request-head">
            {item.permission.agent ? <span className="sb-inbox__request-agent">{item.permission.agent}</span> : null}
            <span className="sb-inbox__request-tool">{item.permission.toolName}</span>
          </div>
          <pre className="sb-inbox__request-input" data-testid="permission-input">
            {formatToolInput(item.permission.input)}
          </pre>
        </div>
      ) : null}
      {body === 'permission' && denyMessage ? (
        <textarea
          className="sb-inbox__deny-message"
          data-testid="permission-deny-message"
          aria-label="Message with Deny"
          placeholder="Tell Claude why, with Deny (optional)"
          rows={2}
          maxLength={2000}
          value={denyText}
          disabled={busy}
          onChange={(event) => setDenyText(event.target.value)}
        />
      ) : null}
      {body !== 'questions' ? (
        <Actions item={item} busy={busy} onAction={(action) => onAction(action, action.id === 'deny' && denyMessage && denyText.trim() !== '' ? denyText.trim() : undefined)} />
      ) : null}
      {body !== 'questions' && error ? (
        <div className="sb-inbox__error" data-testid="inbox-error">
          {error}
        </div>
      ) : null}
    </>
  );
}

/**
 * Inbox (SPEC → Inbox, M3.2): two columns `340px | 1fr`. The list shows every item
 * `GET /api/inbox` returns (question batches, permission requests, system items)
 * as cards with a status dot, source, age, title and kind label; the detail shows
 * the selected item (the first by default): meta line, 24px title, branch chips,
 * detail text, then the shared question card (Send stays disabled at 45% opacity
 * until every question is answered), a permission request with Allow once / Deny,
 * or the system actions (first primary, the rest outlined). Nothing waiting →
 * "Inbox zero". The list reloads on `/hub` `inboxChanged`. `docs/inbox.md`. D14:
 * the meta line tags an item whose session belongs to a folder other than the
 * default one with that folder's name.
 */
export function InboxView() {
  const inbox = useApi(api.inbox);
  const { tagOf } = useFolderTags();
  const modals = useModals();
  const now = useNow(30_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  // Items answered / acted on from this page, hidden until the list reloads.
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());

  useHubEvent('inboxChanged', () => inbox.reload());
  useEffect(() => setDone(new Set()), [inbox.data]);

  const loaded = inbox.data !== null;
  const items = visibleItems(inbox.data ?? [], done);
  const current = selectedItem(items, selectedId);
  // D14: the selected item's session (for its folder tag), read when the selection names another session.
  const currentSessionId = current?.sessionId ?? null;
  // D33: a system item may belong to a closed session; its folder tag is found all the same.
  const sessions = useApi((): Promise<Session[]> => (currentSessionId ? api.listSessions({ closed: 'include' }) : Promise.resolve([])), [currentSessionId]);
  const currentSession = currentSessionId ? ((sessions.data ?? []).find((session) => session.id === currentSessionId) ?? null) : null;

  const run = async (item: InboxItem, call: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusyId(item.id);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    try {
      await call();
      setDone((prev) => new Set([...prev, item.id]));
      after?.();
    } catch (error) {
      setErrors((prev) => ({ ...prev, [item.id]: refusal(error) }));
    } finally {
      setBusyId(null);
      inbox.reload();
    }
  };

  return (
    <section className="sb-view sb-inbox" data-view="inbox" data-testid="view-inbox">
      <div className="sb-inbox__column">
        <div className="sb-inbox__head">
          <div className="sb-inbox__heading">Inbox</div>
          <div className="sb-inbox__count" data-testid="inbox-count">
            {loaded ? waitingLine(items.length) : ''}
          </div>
        </div>
        <div className="sb-inbox__list" data-testid="inbox-list">
          {items.map((item) => (
            <ListCard key={item.id} item={item} selected={item.id === current?.id} now={now} onPick={() => setSelectedId(item.id)} />
          ))}
          {loaded && items.length === 0 ? (
            <div className="sb-inbox__all-clear" data-testid="inbox-all-clear">
              {ALL_CLEAR}
            </div>
          ) : null}
        </div>
      </div>
      <div className="sb-inbox__detail" data-testid="inbox-detail" data-item-id={current?.id}>
        {current ? (
          <Detail
            item={current}
            folderTag={currentSession ? tagOf(currentSession) : null}
            folderPath={currentSession?.folderPath ?? null}
            now={now}
            busy={busyId === current.id}
            error={errors[current.id] ?? null}
            onAnswers={(body) => void run(current, () => api.answerBatch(current.id, body))}
            onAction={(action, message) => {
              // "Open fix session" (M3.3): once the item is closed, the New-session modal opens with its prefill.
              // D52: a peer's failed run opens the form on that machine (the prefill's folder is its folder).
              const prefill = newSessionAfter(current, action.id);
              const machine = current.machine?.id ?? null;
              void run(current, () => api.inboxAction(current.id, action.id, message ? { message } : undefined), prefill ? () => modals.open('new-session', { prefill, machine }) : undefined);
            }}
          />
        ) : null}
        {loaded && items.length === 0 ? (
          <div className="sb-inbox__zero" data-testid="inbox-zero">
            <div className="sb-inbox__zero-title">{INBOX_ZERO}</div>
            <div className="sb-inbox__zero-hint">{INBOX_ZERO_HINT}</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
