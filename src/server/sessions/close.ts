import type { SessionRecord } from '../db/repos/sessions.ts';
import type { ApiContext } from '../routes.ts';

/**
 * D33 / D137: closes (archives) a session the way `POST /api/sessions/{id}/close` does: the
 * supervisor's close (`confirm` is needed for a live process or a session that runs or
 * waits; the stop is Pause's), its waiting questions and permission requests close
 * ("session closed") before the update is published, and a hooked terminal session is
 * unhooked (D48 P4). Shared by the close route and D141's folder delete with archiving.
 * Throws the supervisor's refusals (`SupervisorError`).
 */
export async function closeSession(context: Pick<ApiContext, 'supervisor' | 'questions' | 'hooks'>, sessionId: string, confirm: boolean): Promise<SessionRecord> {
  const record = await context.supervisor.close(sessionId, { confirm, beforePublish: (id) => context.questions.closeSession(id) });
  if (record.hooked) await context.hooks.unhooked(record.id);
  return record;
}
