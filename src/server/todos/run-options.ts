import { type LaunchSettings, type ModelRule, type RoutableItem, type RuleLabels, applyModelRouting, routingExplanation } from '../../core/model-routing.ts';

/**
 * D76: the launch settings of a session that matter for a todo's run session: its CLI,
 * model, effort and account profile (`null` = the CLI's default / the Accounts rule).
 * The same type as D82's {@link LaunchSettings} (one definition).
 */
export type TodoLaunchSettings = LaunchSettings;

/** What {@link todoRunOptions} answers: the run's launch settings and, when a rule routed it, that rule and its line. */
export interface TodoRunLaunch {
  readonly settings: TodoLaunchSettings;
  /** The D82 rule that changed the source's settings, `null` = none matched (or no rules). */
  readonly rule: ModelRule | null;
  /** The rule's explanation (`Routed by rule: low ≤30 min → Sonnet`), `null` with {@link rule}. */
  readonly explanation: string | null;
}

/**
 * D76 (`docs/todos.md` → *Run in a new session*) + D82 (`docs/model-routing.md`): the launch
 * settings of a todo's run session. They start from the source session's own settings (same
 * CLI, model, effort and account); the first *Model by task* rule (`rules`, from
 * `modelRulesOf(store.settings)`) that matches the item's priority and estimate changes the
 * fields it sets ({@link applyModelRouting}); no rules / no match = the source's settings.
 * Pure: the caller reads the rules (and the labels for the explanation).
 */
export function todoRunOptions(input: {
  readonly source: TodoLaunchSettings;
  readonly todo: RoutableItem;
  readonly rules?: readonly ModelRule[];
  /** How the explanation names the targets on the routed CLI (its model list, the profile names); absent = the raw values. */
  readonly labels?: (provider: TodoLaunchSettings['provider']) => RuleLabels;
}): TodoRunLaunch {
  const { provider, model, effort, profileId } = input.source;
  const routed = applyModelRouting<TodoLaunchSettings>({ provider, model, effort, profileId }, { priority: input.todo.priority, estimateMinutes: input.todo.estimateMinutes }, input.rules ?? []);
  return { settings: routed.settings, rule: routed.rule, explanation: routed.rule ? routingExplanation(routed.rule, input.labels?.(routed.settings.provider)) : null };
}
