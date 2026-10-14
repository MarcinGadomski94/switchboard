import type { SessionActivity, SessionListItem } from '../../core/api.ts';
import { continuedAsLabel } from '../../core/chats.ts';
import { displayTitle } from '../../core/session-title.ts';
import { SessionActivityOr } from '../activity/ActivityViews.tsx';
import type { CloseSessionControl } from '../components/CloseSession.tsx';
import { MachineTag } from '../components/MachineTag.tsx';
import { Link } from '../router.tsx';
import { formatAge, statusColor } from './format.ts';
import { SessionCloseButton } from './SidebarSessions.tsx';
import { useSectionCollapsed } from './useToolsCollapsed.ts';

/** The id of the CHATS list (its header's toggle controls it). */
const CHATS_LIST_ID = 'sb-chats-list';

/** Props of {@link SidebarChats}. */
export interface SidebarChatsProps {
  /** The open chats (this machine's and the paired machines'), newest first. */
  readonly chats: readonly SessionListItem[];
  /** `false` while the session list has not loaded (no count yet). */
  readonly loaded: boolean;
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
 * D106 · the CHATS section (`docs/chats.md` → *Sidebar*, `docs/sidebar.md` → *SESSIONS
 * and CHATS*): always shown, above SESSIONS. Its header is a ▾ / ▸ toggle with the
 * count (kept per install as `ui.chatsCollapsed`, like D101's TOOLS) and "+ New chat";
 * then one row per open chat (dot, title, age, "plan mode" or "continued as <session>";
 * the row's × closes it). SESSIONS never lists chats.
 */
export function SidebarChats({ chats, loaded, activityOf, closer, isCurrent, now, onNew }: SidebarChatsProps) {
  const [collapsed, toggle] = useSectionCollapsed('ui.chatsCollapsed');
  return (
    <div className="sb-chats" data-testid="sidebar-chats-section" data-collapsed={collapsed ? 'true' : undefined}>
      <div className="sb-section-label sb-chats-head" data-testid="sidebar-chats-head" tabIndex={-1}>
        <button type="button" className="sb-section-toggle" data-testid="chats-toggle" aria-expanded={!collapsed} aria-controls={CHATS_LIST_ID} onClick={toggle}>
          <span className="sb-section-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          Chats
        </button>
        <span className="sb-section-count" data-testid="chats-count">
          {loaded ? String(chats.length) : ''}
        </span>
        <button type="button" className="sb-section-action sb-chats-new" data-testid="sidebar-new-chat" data-tour="new-chat" onClick={onNew}>
          + New chat
        </button>
      </div>
      <div className="sb-chats-list" data-testid="sidebar-chats" id={CHATS_LIST_ID} hidden={collapsed}>
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
