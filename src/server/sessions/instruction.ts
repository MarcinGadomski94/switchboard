import { chatInstruction } from '../../core/chats.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { standingInstructionFor } from '../settings/settings.ts';
import { withTeamCharter } from '../team/hooks.ts';

/**
 * The instruction a session's process runs with (`--append-system-prompt` and its
 * equivalents), read at every spawn and compared by D91's reload and
 * `instructionOutdated`: D64's standing instruction with D100's charter for a
 * session; D106: a chat's own instruction (the developer's standing instruction
 * does not apply to chats; `chatInstruction` names the folders it may read).
 */
export async function sessionInstruction(store: Store, session: Pick<SessionRecord, 'id' | 'kind' | 'lookAt'>): Promise<string | null> {
  if (session.kind === 'chat') return chatInstruction(session.lookAt);
  return withTeamCharter(store, session.id, await standingInstructionFor(store.settings));
}
