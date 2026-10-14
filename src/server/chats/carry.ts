import path from 'node:path';
import { chatCarryOver } from '../../core/chats.ts';
import { chatMarkdown, writeExport } from '../cli/handover.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';

/**
 * D106 · Continue as session (`docs/chats.md` → *Continue as session*): the block a
 * session continued from `chat` starts its first message with. It reuses D62 P5's
 * history export: the chat as Switchboard recorded it (the developer's messages, the
 * agent's replies, one line per tool step) as Markdown, written to
 * `<dataDir>/handovers/<chat id>/<stamp>-continued-as-session.md` (when a data folder
 * is given) and carried inline (the newest part when it is long). No turn of the
 * chat's agent is needed, so it works the same for every CLI and at once.
 */
export async function chatCarryOverBlock(store: Store, chat: SessionRecord, dataDir: string | null, at: Date = new Date()): Promise<string> {
  const title = chat.title ?? chat.name;
  const events = await store.events.list(chat.id);
  const mainAgentId = (await store.agents.listBySession(chat.id)).find((agent) => agent.kind === 'main')?.id ?? null;
  const markdown = chatMarkdown({ title, cwd: chat.cwd ?? '', from: chat.provider, to: chat.provider, at, events, mainAgentId, purpose: 'to continue the chat as a session' });
  const exportPath = dataDir ? await writeExport(path.join(dataDir, 'handovers'), chat.id, chat.provider, chat.provider, at, markdown, 'continued-as-session') : null;
  // The export's heading lines are left out inline (the block names the chat itself).
  const body = markdown.split('\n').slice(4).join('\n');
  return chatCarryOver({ title, markdown: body, exportPath });
}
