import type { SessionActivity, SessionListItem } from '../../core/api.ts';
import { continuedAsLabel } from '../../core/chats.ts';
import { displayTitle } from '../../core/session-title.ts';
import { SessionActivityOr } from '../activity/ActivityViews.tsx';
import type { CloseSessionControl } from '../components/CloseSession.tsx';
import { MachineTag } from '../components/MachineTag.tsx';
import { Link } from '../router.tsx';
import { formatAge, statusColor } from './format.ts';
import { SessionCloseButton } from './SidebarSessions.tsx';

/** Props of {@link SidebarChats}. */
export interface SidebarChatsProps {
  /** The open chats (this machine's and the paired machines'), newest first. */
  readonly chats: readonly SessionListItem[];
  readonly activityOf: (id: string) => SessionActivity | null;
  readonly closer: CloseSessionControl;
  readonly isCurrent: (id: string) => boolean;
  readonly now: number;
  /** "+ New chat". */
  readonly onNew: () => void;
}

/** The chat's second line: "continued as <session>" once it was continued, else what it does now or "plan mode". */
function chatLine(chat: SessionListItem): string {
  if (chat.continuedTo?.title) return continuedAsLabel(chat.continuedTo.title).replace(/^Continued/, 'continued');
  return chat.lookAt && chat.lookAt.length > 0 ? `plan mode · ${chat.lookAt.length} folder${chat.lookAt.length === 1 ? '' : 's'}` : 'plan mode';
}

/**
 * D106 · the CHATS section (`docs/chats.md` → *Sidebar*): its own label with the count
 * and "+ New chat", then one row per open chat (dot, title, age, "plan mode" or
 * "continued as <session>"; the × closes it like a session's). Above SESSIONS, which
 * never lists chats. With no chats it renders nothing, so the sidebar is exactly as
 * before (the visual oracle's shell is unchanged); the way in is then the SESSIONS
 * label's chat button and ⌘K → New chat.
 */
export function SidebarChats({ chats, activityOf, closer, isCurrent, now, onNew }: SidebarChatsProps) {
  if (chats.length === 0) return null;
  return (
    <div className="sb-chats" data-testid="sidebar-chats" data-tour="chats">
      <div className="sb-section-label sb-chats-head" data-testid="sidebar-chats-head" tabIndex={-1}>
        Chats
        <span className="sb-section-count">{String(chats.length)}</span>
        <button type="button" className="sb-section-action sb-chats-new" data-testid="sidebar-new-chat" onClick={onNew}>
          + New chat
        </button>
      </div>
      <div className="sb-chats-list">
        {chats.map((chat) => {
          const activity = activityOf(chat.id);
          return (
            <Link key={chat.id} to={{ view: 'session', id: chat.id, tab: 'chat' }} className="sb-session sb-chat-row" data-testid="sidebar-chat" data-session-id={chat.id} aria-current={isCurrent(chat.id) ? 'page' : undefined}>
              <span className="sb-session-dot" data-activity={activity?.state} style={{ background: statusColor(activity?.state === 'background' ? 'run' : chat.status) }} />
              <div className="sb-session-body">
                <div className="sb-session-head">
                  <span className="sb-session-name">{displayTitle(chat)}</span>
                  <span className="sb-session-age">{formatAge(chat.lastActivityAt ?? chat.createdAt, now)}</span>
                </div>
                <div className="sb-session-mode">
                  <MachineTag machine={chat.machine} />
                  <SessionActivityOr activity={activity}>
                    <span data-testid="sidebar-chat-line" data-continued={chat.continuedTo ? 'true' : undefined}>
                      {chatLine(chat)}
                    </span>
                  </SessionActivityOr>
                </div>
              </div>
              <SessionCloseButton session={chat} busy={closer.busyId === chat.id} onClose={() => closer.request({ ...chat, activity: activity ?? chat.activity })} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
