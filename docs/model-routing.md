# Model by task (D82)

Settings → Sessions → **Model by task** is an ordered list of rules that picks the CLI, model, effort and account profile a todo (D68 / D70) is run with, from the todo's **priority** and **estimate**. It is **off until the developer adds a rule**: with no rules, or when no rule matches, the normal choice applies unchanged.

## Rules

Each rule matches on:

- **priority**: `any`, `urgent`, `high`, `medium` or `low`;
- **estimate**: `any estimate`, `≤ N min`, `> N min`, or `no estimate` (the todo has none). A `≤` / `>` rule never matches a todo without an estimate, and `no estimate` never one with an estimate. N is whole minutes, 1–10 080 (the todo estimate's own range).

and sets any of:

- **CLI** (Claude Code, Codex CLI, OpenCode);
- **model** of that CLI;
- **effort** of that model;
- **account profile** of that CLI (D63).

A target left on *keep …* leaves that part of the normal choice alone. A model, an effort or an account is always given **with its CLI**: each CLI has its own models and accounts, so the editor enables those selects only once a CLI is picked, and the server refuses a model / effort / account without a CLI (`.loop/questions.md` → *D82-cli-required*).

**The first rule that matches wins** (top to bottom; ↑ ↓ reorder, × removes). Each rule shows the line a routed run will show, e.g. `Routed by rule: low ≤30 min → Sonnet`.

## Applying a rule (`src/core/model-routing.ts`)

```ts
export interface LaunchSettings {
  readonly provider: CliProviderId;
  readonly model: string | null;     // null = the CLI's default (no --model)
  readonly effort: string | null;    // null = the CLI's default (no --effort)
  readonly profileId: string | null; // null = the rule of Settings → Accounts
}

export function applyModelRouting<T extends LaunchSettings>(
  defaults: T,
  item: { priority: TodoPriority; estimateMinutes: number | null },
  rules: readonly ModelRule[],
): { settings: T; rule: ModelRule | null };
```

- No match: `{ settings: defaults, rule: null }` (the same object).
- A rule that moves to **another CLI** starts from that CLI's defaults: model, effort and profile become `null` (the defaults' values belong to the first CLI) before the rule's own targets apply.
- A rule that changes the **model** without an effort drops the effort to the CLI's default (`null`): the default effort may not exist for the new model. The same model keeps the effort.
- `default` as a model is the CLI's default (`null`).
- Every other field of `defaults` (anything the caller's launch type carries) is kept.

`routingExplanation(rule, labels?)` makes the line the UI shows (`Routed by rule: <match> → <targets>`); `labels.models` names models by their labels (`Sonnet`), `labels.profileName` names accounts. A Claude Code rule that sets a model names only the model.

The server reads the stored rules with `modelRulesOf(store.settings)` (`src/server/settings/settings.ts`). **Wired into D76's runs (integration 1.13):** `todoRunOptions` (`src/server/todos/run-options.ts`, pure) takes the source session's settings, the item and the rules, calls `applyModelRouting`, and answers `{ settings, rule, explanation }`; `TodoLaunchSettings` is `LaunchSettings` (one type). `runTodo` reads the rules with `modelRulesOf` and names the routed CLI's models (its reported list, `routingModelOptions`) and profiles in the line. The run's answer carries it as `TodoRunResult.routing` and the **Run toast** shows it after the item's title (`Fix the login flake · Routed by rule: low ≤30 min → Sonnet`). No rules / no match: the source's settings, `routing: null`, nothing shown. Tests: `tests/server/todos/run.test.ts` (pure), `tests/server/todos/run-integration.test.ts` (the real route: model and `--model` routed; no match = the source's).

## Storage and validation

The rules are the editable setting **`sessions.modelRules`** (`GET` / `PUT /api/settings`, default `[]`), a JSON list in the `settings` table; no migration. `PUT` checks:

1. the shape (`parseModelRules`): at most 50 rules; each with a unique `id` (1–64 characters), a `priority`, an `estimate`, at least one target, and the CLI when it sets a model, effort or account;
2. the targets (`checkRuleTargets`): the **model must exist for that CLI** — the list the CLI reported last (`models.options[.<cli>]`, D42 / D62), else the New-session form's fallback (Claude Code's aliases `default` / `opus` / `sonnet` / `haiku`; Codex CLI and OpenCode their default only); the **effort** must be one of the model's levels while the CLI's list says which (a rule without a model: any listed model's levels), else one of the CLI's effort levels; the **account must be one of that CLI's enabled profiles**.

A refusal is `422 { error: "invalid", errors: [{ field: "sessions.modelRules[<i>].<part>", message }] }`, and nothing is stored. A stored list that no longer reads (an older or broken write) reads as `[]` (routing off). A profile disabled or a model gone **after** saving is not re-checked when a rule applies: the start then fails or falls back as any start with that choice would (`.loop/questions.md` → *D82-stale-targets*).

## UI (`src/web/views/settings/ModelRulesRow.tsx`, `model-rules.ts`, `model-rules.css`)

Under the standing instruction in Settings → Sessions: the empty state *No rules: todos run with the normal choice.*, then one card per rule (`1. low ≤ 30 min → Claude Code Sonnet keep effort keep account ↑ ↓ ×` and its preview line), **+ Add rule** (a new rule is low, ≤ 30 min, Claude Code), **Save** (enabled when the list changed) and **Discard**. A refusal shows the server's message under its rule (outlined red). The models come from `GET /api/models?provider=` for each CLI, the accounts from `GET /api/accounts` (enabled ones of the rule's CLI). On a phone the card's line wraps; nothing scrolls sideways (D74).

## Tests

- `tests/core/model-routing.test.ts`: matching, first match wins, applying (CLI change, model change, effort), explanation, shape and target checks.
- `tests/server/api/settings.test.ts` → *D82*: stored in order, the model / effort / profile checks, shape refusals, nothing stored on a refusal.
- `tests/web/model-rules.test.ts`: the editor's edits, offered options, preview, 422 mapping.
- `tests/e2e/model-routing.spec.ts`: add, edit, reorder, save, reload, a refusal under its rule, the phone layout.
