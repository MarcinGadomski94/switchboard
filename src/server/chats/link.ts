import { continuedAsLabel, continuedFromChatLabel } from '../../core/chats.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';

/**
 * D106: links a session continued from a chat both ways, before the session's
 * process starts: the session's `continuedFrom` and its first divider "Continued
 * from the chat <title>", the chat's `continuedTo` and its divider "Continued as
 * <session>" (both links, D83's dividers). The chat stays open in CHATS.
 */
export async function linkChatContinuation(store: Store, supervisor: Pick<SessionSupervisor, 'recordServiceEvent' | 'announce'>, chat: SessionRecord, session: SessionRecord): Promise<void> {
  const chatTitle = chat.title ?? chat.name;
  const sessionTitle = session.title ?? session.name;
  await store.sessions.update(session.id, { continuedFrom: chat.id });
  await store.sessions.update(chat.id, { continuedTo: session.id });
  await supervisor.recordServiceEvent(session.id, 'text', continuedFromChatLabel(chatTitle), { type: 'lifecycle', action: 'continued-from', linkedSessionId: chat.id, linkedTitle: chatTitle });
  await supervisor.recordServiceEvent(chat.id, 'text', continuedAsLabel(sessionTitle), { type: 'lifecycle', action: 'continued-in', linkedSessionId: session.id, linkedTitle: sessionTitle });
  await supervisor.announce(chat.id);
}
