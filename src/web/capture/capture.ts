import type { CaptureTodoInput, SessionTodoList } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';

/**
 * D81 (`docs/todos.md` → *Quick capture (D81)*): captures a todo into a session
 * (`POST /api/sessions/{id}/todos/capture`). A paired machine still on 1.12 or earlier has no
 * such route (its peer API refuses it, 403, or answers an unknown route, 404 without
 * `not-found`): the item is then added the plain way (title and note as its description),
 * bare and without the agent's fill-in.
 */
export async function captureTodo(sessionId: string, input: CaptureTodoInput): Promise<SessionTodoList> {
  try {
    return await api.captureTodo(sessionId, input);
  } catch (error) {
    const code = error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : undefined;
    const olderPeer = error instanceof ApiError && sessionId.startsWith('r~') && (error.status === 403 || (error.status === 404 && code !== 'not-found'));
    if (!olderPeer) throw error;
    return api.addTodo(sessionId, { title: input.title, description: input.note ?? null, plan: 'No plan', priority: 'medium', estimateMinutes: null });
  }
}
