import type { HTMLAttributes, ReactNode } from 'react';
import type { SessionActivity, SessionListItem } from '../../../core/api.ts';
import type { SessionMachine } from '../../../core/peers.ts';
import { useLiveMachine } from '../../api/useMachines.ts';
import { Avatar, Card, ComputerTag, Icon, StatusBadge } from '../components/index.ts';
import { STATUS, TERMS, computerStateToV2 } from '../glossary.ts';
import { type AgentLine, type AgentRowExtras, agentLine, agentName, agentStatusOf } from './agent-line.ts';
import { timeAgo } from './time.ts';

export { type AgentLine, type AgentRowExtras, agentLine, agentName, agentStatusOf } from './agent-line.ts';
import './shared.css';

/**
 * D131 · the agent row and card building blocks (`docs/v2.md` → *Shared modules*):
 * the status, the live activity line, the ask preview, the computer tag and the
 * unread / draft markers, as Home (Working now), Agents (List / Chats / Board) and
 * Crews show an agent. Lanes compose them; the derivations are pure
 * ({@link agentStatusOf}, {@link agentLine}).
 */

/** D131 · the activity line (`.activity`): "● Running tests 0:42". */
export function ActivityLine({ line }: { readonly line: AgentLine }) {
  return (
    <div className="v2-activity" data-tone={line.tone} data-testid="v2-activity" aria-live="off">
      {line.tone === 'blue' ? <span className="v2-pulse" aria-hidden="true" /> : <Icon name={line.tone === 'amber' ? 'hand' : line.tone === 'red' ? 'octagon' : line.tone === 'green' ? 'check' : 'moon'} size="s" />}
      <span className="v2-activity-what">{line.text}</span>
      {line.time ? <span className="v2-activity-t">{line.time}</span> : null}
    </div>
  );
}

/** D131 · an agent's waiting ask, previewed in amber (`.cprev.ask`). */
export function AskPreview({ text, tone = 'amber' }: { readonly text: string; readonly tone?: 'amber' | 'red' }) {
  return (
    <div className="v2-cprev" data-tone={tone} data-testid="v2-ask-preview">
      <Icon name={tone === 'red' ? 'octagon' : 'hand'} size="s" />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
    </div>
  );
}

/** D131 · the computer an agent runs on, live (offline / reconnecting as soon as known); nothing for this computer. */
export function AgentComputerTag({ machine, short = false }: { readonly machine: SessionMachine | null | undefined; readonly short?: boolean }) {
  const live = useLiveMachine(machine ?? null);
  if (!live) return null;
  return <ComputerTag name={live.name} state={computerStateToV2(live.state)} short={short} />;
}

/** D131 · the unread dot (an accent dot with a word for screen readers). */
export function UnreadDot() {
  return (
    <span className="v2-udot" role="img" aria-label="New replies" title="New replies" data-testid="v2-unread" />
  );
}

/** D131 · the draft marker ("Draft" in red: an unsent message waits in the composer). */
export function DraftMark() {
  return (
    <span className="v2-draft-tag" data-testid="v2-draft">
      Draft
    </span>
  );
}

/**
 * D131 · the chat-style agent row (`.crow`): avatar with its status badge, name,
 * time, the activity or ask line, then the computer tag and markers. A button: a
 * click (or Enter) opens it; `trailing` = the row's own buttons (peek, ⋯).
 *
 * Lane A (additive): `variant="list"` is the List view's row (`.lrow`): the
 * status as a badge on the right instead of under the line; `lead` goes before
 * the avatar (the drag grip), `tags` after the name (kind, Draft), `rowProps`
 * onto the row itself (draggable, data attributes, key handling), `line` replaces
 * the activity line (an offline computer's reason).
 */
export function AgentRow({ session, activity, extras = {}, onOpen, trailing, now, variant = 'chat', lead, tags, rowProps, line: lineOverride }: { readonly session: SessionListItem; readonly activity: SessionActivity | null; readonly extras?: AgentRowExtras; readonly onOpen: () => void; readonly trailing?: ReactNode; readonly now?: number; readonly variant?: 'chat' | 'list'; readonly lead?: ReactNode; readonly tags?: ReactNode; readonly rowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>; readonly line?: ReactNode }) {
  const status = agentStatusOf(session, extras);
  const line = agentLine(session, activity, extras, now);
  const name = agentName(session);
  const off = session.machine ? computerStateToV2(session.machine.state) !== 'online' : false;
  const preview =
    lineOverride ?? (line.tone === 'amber' || line.tone === 'red' ? (
      <AskPreview text={line.text} tone={line.tone === 'red' ? 'red' : 'amber'} />
    ) : (
      <span className="v2-cprev">
        {line.text}
        {line.time ? ` · ${line.time}` : ''}
      </span>
    ));
  if (variant === 'list') {
    return (
      <div {...rowProps} className={rowProps?.className ? `v2-crow v2-lrow ${rowProps.className}` : 'v2-crow v2-lrow'} data-status={status} data-session={session.id} {...(off ? { 'data-off': '' } : {})} data-testid="v2-agent-row" data-variant="list">
        {lead}
        <button type="button" className="v2-row v2-grow" style={{ border: 0, background: 'none', padding: 0, textAlign: 'left', gap: 14, minWidth: 0 }} onClick={onOpen} aria-label={`${name} · ${STATUS[status].label}`}>
          <Avatar name={name} icon={session.kind === 'chat' ? 'chat' : undefined} status={status} />
          <span className="v2-cbody">
            <span className="v2-ctop">
              <b>{name}</b>
              {tags}
              {extras.kindLabel ?? (session.kind === 'chat' ? <span className="v2-chip" data-tone="outline">{TERMS.conversation.one}</span> : null)}
              {extras.draft ? <DraftMark /> : null}
              {extras.unread ? <UnreadDot /> : null}
            </span>
            {preview}
          </span>
        </button>
        <AgentComputerTag machine={session.machine} />
        <StatusBadge status={status} />
        {trailing}
      </div>
    );
  }
  return (
    <div {...rowProps} className={rowProps?.className ? `v2-crow ${rowProps.className}` : 'v2-crow'} data-status={status} data-session={session.id} {...(off ? { 'data-off': '' } : {})} data-testid="v2-agent-row">
      <button type="button" className="v2-row v2-grow" style={{ border: 0, background: 'none', padding: 0, textAlign: 'left', gap: 14, minWidth: 0 }} onClick={onOpen} aria-label={`${name} · ${STATUS[status].label}`}>
        <Avatar name={name} icon={session.kind === 'chat' ? 'chat' : undefined} status={status} />
        <span className="v2-cbody">
          <span className="v2-ctop">
            <b>{name}</b>
            {tags}
            <span className="v2-ctime" {...(extras.unread ? { 'data-unread': '' } : {})}>
              {timeAgo(session.lastActivityAt, now)}
            </span>
          </span>
          {preview}
          <span className="v2-cmeta">
            <StatusBadge status={status} size="s" />
            {extras.kindLabel ?? (session.kind === 'chat' ? <span className="v2-chip" data-tone="outline">{TERMS.conversation.one}</span> : null)}
            <AgentComputerTag machine={session.machine} short />
            {extras.draft ? <DraftMark /> : null}
            {extras.unread ? <UnreadDot /> : null}
          </span>
        </span>
      </button>
      {trailing}
    </div>
  );
}

/**
 * D131 · the "Working now" card (`.wcard`): name, status, the live activity line
 * and the computer; a click opens (or peeks) it.
 */
export function AgentCard({ session, activity, extras = {}, onOpen, footer, now }: { readonly session: SessionListItem; readonly activity: SessionActivity | null; readonly extras?: AgentRowExtras; readonly onOpen: () => void; readonly footer?: ReactNode; readonly now?: number }) {
  const status = agentStatusOf(session, extras);
  const name = agentName(session);
  return (
    <Card interactive className="v2-wcard" onClick={onOpen} aria-label={`${name} · ${STATUS[status].label}`} data-testid="v2-agent-card" data-session={session.id}>
      <div className="v2-row">
        <h3 className="v2-grow">{name}</h3>
        <StatusBadge status={status} />
      </div>
      <ActivityLine line={agentLine(session, activity, extras, now)} />
      <div className="v2-meta">
        <AgentComputerTag machine={session.machine} />
        {extras.draft ? <DraftMark /> : null}
        {extras.unread ? <UnreadDot /> : null}
        {footer}
      </div>
    </Card>
  );
}
