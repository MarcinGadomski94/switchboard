import { type MouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Agent, SessionActivity, SessionDetail, SessionEvent, WorkflowAgentChat } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { AgentActivityText, SubagentActivityLine } from '../../activity/ActivityViews.tsx';
import { type Route, routePath, useRouter } from '../../router.tsx';
import { statusColor } from '../../shell/format.ts';
import { ChatItemView } from './ChatItems.tsx';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import { CutNote, useFullText } from './FullText.tsx';
import { ChatSkeleton } from './SessionSkeletons.tsx';
import { hasSubagentChat, subagentChat } from './chat.ts';
import { agentCards } from './right-panel.ts';
import {
  OVERLAY_SELECTOR,
  SUBAGENT_BACK,
  SUBAGENT_BRIEF_LABEL,
  SUBAGENT_NO_CHAT,
  SUBAGENT_NO_MESSAGES,
  SUBAGENT_QUESTION_LINK,
  SUBAGENT_QUESTION_NOTE,
  SUBAGENT_REPLY_IN_MAIN,
  SUBAGENT_RESULT_LABEL,
  escGoesBack,
  mainChatPlace,
  rememberMainChat,
  subagentTitle,
} from './subagent-chat.ts';
import { WORKFLOW_BRIEF_LABEL, WORKFLOW_NO_MESSAGES, agentActivity } from './workflow-agents.ts';

/** How close to the bottom (px) still counts as "at the bottom" (the main chat's rule). */
const STICK_PX = 32;

/** Props of {@link SubagentChatView}. */
export interface SubagentChatViewProps {
  readonly sessionId: string;
  /** `GET /api/sessions/{id}` (the agents, the questions); `null` while it loads. */
  readonly session: SessionDetail | null;
  /** Every event of the session (the chat tab loads them all and follows `/hub`); filtered here. */
  readonly events: readonly SessionEvent[];
  readonly activity: SessionActivity | null;
  /** The subagent's id from the address (`/sessions/{id}/agents/{agentId}`). */
  readonly agentId: string;
  /** D45: the session's data is late: bubble placeholders stand in for the conversation. */
  readonly placeholder?: boolean;
}

/** `true` while focus is in a text field, where Esc belongs to the field (D50: the composer's Esc reads it too). */
export function isEditing(el: Element | null): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * D36: Esc goes back (`escGoesBack`). Listened for in the window's capture phase,
 * so it reads the page before any popover's own Esc handler closes it: while a
 * modal or popover is open, Esc only closes that.
 */
function useEscBack(back: () => void): void {
  const latest = useRef(back);
  latest.current = back;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const context = { editing: isEditing(document.activeElement), overlayOpen: document.querySelector(OVERLAY_SELECTOR) !== null };
      if (!escGoesBack(event, context)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** A link to the main chat that goes back on a plain left click (a modifier click opens its address as usual). */
function BackLink({ href, onBack, className, testId, children }: { readonly href: string; readonly onBack: () => void; readonly className: string; readonly testId: string; readonly children: ReactNode }) {
  const click = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onBack();
  };
  return (
    <a href={href} className={className} data-testid={testId} onClick={click}>
      {children}
    </a>
  );
}

/** D51: a Workflow agent's conversation, read from its transcript (again whenever its `workflow.version` grows). */
interface WorkflowChatState {
  readonly key: string | null;
  readonly data: WorkflowAgentChat | null;
  readonly failed: boolean;
}

function useWorkflowChat(sessionId: string, agent: Agent | null): WorkflowChatState {
  const key = agent && agent.kind === 'workflow' ? agent.id : null;
  const version = agent?.workflow?.version ?? 0;
  const status = agent?.status ?? null;
  const [state, setState] = useState<WorkflowChatState>({ key: null, data: null, failed: false });
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    api.workflowAgentChat(sessionId, key).then(
      (data) => {
        if (!cancelled) setState({ key, data, failed: false });
      },
      () => {
        if (!cancelled) setState((current) => ({ key, data: current.key === key ? current.data : null, failed: true }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, key, version, status]);
  return state.key === key ? state : { key, data: null, failed: false };
}

/**
 * D36: a subagent's own chat in the chat tab (`docs/chat.md` → *Subagent chats*):
 * the top bar "← Main chat · <name>: <description>" with its status dot and live
 * action (D19) or status; the brief the main agent gave it as the first bubble;
 * its messages and tool steps as the main chat shows them (D20 Markdown, step
 * lines; its question cards read-only); its result as the last block; its live
 * activity line; and, in the composer's place, a note that subagents take no
 * messages. The bar's link, Esc and the browser's Back return to the main chat.
 */
export function SubagentChatView({ sessionId, session, events, activity, agentId, placeholder = false }: SubagentChatViewProps) {
  const { backTo } = useRouter();
  const main: Route = { view: 'session', id: sessionId, tab: 'chat' };
  const mainHref = routePath(main);
  const back = useCallback(() => backTo({ view: 'session', id: sessionId, tab: 'chat' }), [backTo, sessionId]);
  useEscBack(back);

  // Like the main chat: stays at the newest item while at the bottom.
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = (): void => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };
  // D51: a Workflow agent's chat comes from its transcript, not from the session's events.
  const workflowChat = useWorkflowChat(sessionId, session?.agents.find((candidate) => candidate.id === agentId) ?? null);
  // Fix · long messages: cut texts (the brief, messages, the result) restored from the transcript.
  const fullText = useFullText(sessionId, events);

  if (!session) {
    return (
      <div className="sb-chat" data-testid="subagent-chat" data-state="loading">
        {placeholder ? <ChatSkeleton /> : null}
      </div>
    );
  }
  const agent = session.agents.find((candidate) => candidate.id === agentId) ?? null;
  if (!agent || !hasSubagentChat(agent)) {
    return (
      <>
        <div className="sb-subchat-bar" data-testid="subagent-bar">
          <BackLink href={mainHref} onBack={back} className="sb-subchat-back" testId="subagent-back">
            {SUBAGENT_BACK}
          </BackLink>
        </div>
        <div className="sb-chat" data-testid="subagent-chat" data-state="missing">
          <div className="sb-subchat-missing" data-testid="subagent-missing">
            {SUBAGENT_NO_CHAT}
          </div>
        </div>
      </>
    );
  }

  const workflow = agent.kind === 'workflow';
  // Fix · long messages: a Workflow agent's chat is read whole from its files (nothing to restore).
  const chat = workflow
    ? subagentChat(workflowChat.data?.events ?? [], [], agent, session.agents, { restorable: false })
    : subagentChat(fullText.events, session.questions, agent, session.agents);
  const result = workflow ? (workflowChat.data?.result ?? null) : chat.result;
  const card = agentCards([agent], session)[0];
  const status = card?.status ?? agent.status;
  const color = statusColor(status);
  const entry = agentActivity(activity, agent);
  const title = subagentTitle(agent);
  const questionNote = (batchId: string): ReactNode => (
    <>
      {SUBAGENT_QUESTION_NOTE} ·{' '}
      <BackLink
        href={mainHref}
        className="sb-subchat-question-link"
        testId="subagent-question-link"
        onBack={() => {
          // Back in the main chat, its card comes into view (instead of the place it was left at).
          rememberMainChat(sessionId, { ...(mainChatPlace(sessionId) ?? { top: 0, stick: true }), reveal: batchId });
          back();
        }}
      >
        {SUBAGENT_QUESTION_LINK}
      </BackLink>
    </>
  );

  return (
    <>
      <div className="sb-subchat-bar" data-testid="subagent-bar" data-agent-id={agent.id} data-status={status}>
        <BackLink href={mainHref} onBack={back} className="sb-subchat-back" testId="subagent-back">
          {SUBAGENT_BACK}
        </BackLink>
        <span className="sb-subchat-sep" aria-hidden="true">
          ·
        </span>
        <span className="sb-agent-dot" data-testid="subagent-dot" style={{ background: color }} />
        <span className="sb-subchat-title" data-testid="subagent-title" title={title}>
          <span className="sb-subchat-name">{agent.name}</span>
          {agent.description ? `: ${agent.description}` : null}
        </span>
        <span className="sb-subchat-status" data-testid="subagent-status" style={{ color }}>
          {entry ? <AgentActivityText entry={entry} turnStartedAt={null} /> : card?.statusText}
        </span>
      </div>
      <div
        className="sb-chat"
        data-testid="subagent-chat"
        data-agent-id={agent.id}
        data-state={workflow && workflowChat.data === null ? (workflowChat.failed ? 'failed' : 'loading') : undefined}
        ref={scroller}
        onScroll={onScroll}
      >
        {placeholder ? <ChatSkeleton /> : null}
        {chat.brief !== null ? (
          <div className="sb-chat-message sb-subchat-brief" data-role="user" data-testid="subagent-brief">
            <div className="sb-subchat-label" data-testid="subagent-brief-label">
              {workflow ? WORKFLOW_BRIEF_LABEL : SUBAGENT_BRIEF_LABEL}
            </div>
            <div className="sb-chat-bubble" data-testid="chat-text">
              <ChatMarkdown text={chat.brief} />
            </div>
            {chat.briefCut ? <CutNote cut={chat.briefCut} control={fullText.control} /> : null}
          </div>
        ) : null}
        {chat.items.map((item) => (
          <ChatItemView
            key={item.key}
            sessionId={sessionId}
            item={item}
            answering={null}
            onAnswer={async () => undefined}
            readOnlyNote={questionNote}
            {...(workflow ? {} : { fullText: fullText.control })}
          />
        ))}
        {result ? (
          <div className="sb-chat-message sb-subchat-result" data-role="agent" data-testid="subagent-result" data-error={result.isError ? 'true' : 'false'}>
            <div className="sb-subchat-label" data-testid="subagent-result-label">
              {SUBAGENT_RESULT_LABEL}
            </div>
            <div className="sb-chat-bubble sb-subchat-result-body" data-testid="chat-text">
              <ChatMarkdown text={result.text} />
            </div>
            {!workflow && chat.resultCut ? <CutNote cut={chat.resultCut} control={fullText.control} /> : null}
          </div>
        ) : null}
      </div>
      <SubagentActivityLine entry={entry} />
      <div className="sb-subchat-note" data-testid="subagent-note">
        {workflow ? WORKFLOW_NO_MESSAGES : SUBAGENT_NO_MESSAGES} ·{' '}
        <BackLink href={mainHref} onBack={back} className="sb-subchat-note-link" testId="subagent-note-back">
          {SUBAGENT_REPLY_IN_MAIN}
        </BackLink>
      </div>
    </>
  );
}
