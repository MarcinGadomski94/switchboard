import type { SessionTodo } from '../../core/api.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';

/**
 * D76: the launch settings of a session that matter for a todo's run session: its CLI,
 * model, effort and account profile (`null` = the CLI's default / the Accounts rule).
 */
export interface TodoLaunchSettings {
  readonly provider: CliProviderId;
  readonly model: string | null;
  readonly effort: string | null;
  readonly profileId: string | null;
}

/**
 * D76 (`docs/todos.md` → *Run in a new session*): the launch settings of a todo's run
 * session, from the source session's and the item. For now the run session starts on the
 * source session's own settings (same CLI, model, effort and account). Kept a single small
 * pure function: model routing rules (by priority, estimate, …) go in here.
 */
export function todoRunOptions(input: { readonly source: TodoLaunchSettings; readonly todo: SessionTodo }): TodoLaunchSettings {
  const { provider, model, effort, profileId } = input.source;
  return { provider, model, effort, profileId };
}
