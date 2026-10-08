import { useEffect, useState } from 'react';
import type { ModelSettings, Settings } from '../../../core/api.ts';
import type { AccountProfile } from '../../../core/accounts.ts';
import { CLI_PROVIDERS, type CliProviderId } from '../../../core/cli-providers.ts';
import { ESTIMATE_MATCH_KINDS, type ModelRule, ROUTING_PRIORITIES, type RoutingPriority } from '../../../core/model-routing.ts';
import type { KnownSettings } from '../../../core/settings.ts';
import { ApiError, accountsApi, api } from '../../api/client.ts';
import { Row } from './rows.tsx';
import {
  ESTIMATE_LABELS,
  KEEP,
  MODEL_RULES_DESCRIPTION,
  MODEL_RULES_EMPTY,
  MODEL_RULES_LABEL,
  PRIORITY_LABELS,
  cliOptions,
  estimateFor,
  moveRule,
  newRule,
  ruleEfforts,
  ruleErrors,
  ruleModelOptions,
  rulePreview,
  ruleProfiles,
  rulesDirty,
  withModel,
  withProvider,
  withTarget,
} from './model-rules.ts';
import './model-rules.css';

function ruleId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Each CLI's model list (`GET /api/models?provider=`) and the account profiles, loaded once for the editor. */
function useRuleSources(): { readonly models: Partial<Record<CliProviderId, ModelSettings | null>>; readonly profiles: readonly AccountProfile[] } {
  const [models, setModels] = useState<Partial<Record<CliProviderId, ModelSettings | null>>>({});
  const [profiles, setProfiles] = useState<readonly AccountProfile[]>([]);
  useEffect(() => {
    let alive = true;
    for (const provider of CLI_PROVIDERS) {
      api
        .models(provider)
        .then((settings) => alive && setModels((current) => ({ ...current, [provider]: settings })))
        .catch(() => alive && setModels((current) => ({ ...current, [provider]: null })));
    }
    accountsApi(null)
      .overview()
      .then((overview) => alive && setProfiles(overview.profiles))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return { models, profiles };
}

/**
 * D82 · Settings → Sessions → *Model by task* (`docs/model-routing.md`): the ordered
 * rules, each "priority · estimate → CLI · model · effort · account" with ↑ ↓ ×
 * and the line a routed run shows; + Add rule, Save (`PUT /api/settings` with
 * `sessions.modelRules`; a refused rule shows the server's reason under it).
 */
export function ModelRulesRow({ settings, onSaved }: { readonly settings: KnownSettings; readonly onSaved: (body: Settings) => void }) {
  const stored = settings['sessions.modelRules'];
  const [draft, setDraft] = useState<readonly ModelRule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Map<number, string[]>>(new Map());
  const { models, profiles } = useRuleSources();
  const rules = draft ?? stored;
  const dirty = rulesDirty(stored, rules);

  const edit = (next: readonly ModelRule[]): void => {
    setDraft(next);
    setErrors(new Map());
  };
  const update = (id: string, change: (rule: ModelRule) => ModelRule): void => edit(rules.map((rule) => (rule.id === id ? change(rule) : rule)));

  const save = (): void => {
    setBusy(true);
    api
      .saveSettings({ 'sessions.modelRules': rules })
      .then((body) => {
        onSaved(body);
        setDraft(null);
        setErrors(new Map());
      })
      .catch((error: unknown) => setErrors(error instanceof ApiError ? ruleErrors(error.body) : new Map([[-1, ['The rules could not be saved.']]])))
      .finally(() => setBusy(false));
  };

  return (
    <Row id="model-rules" label={MODEL_RULES_LABEL} description={MODEL_RULES_DESCRIPTION}>
      <div className="sb-rules" data-testid="model-rules">
        {rules.length === 0 ? (
          <div className="sb-rules-empty" data-testid="model-rules-empty">
            {MODEL_RULES_EMPTY}
          </div>
        ) : (
          <ol className="sb-rules-list">
            {rules.map((rule, index) => {
              const provider = rule.provider;
              const modelList = provider ? ruleModelOptions(provider, models[provider]) : [];
              const efforts = ruleEfforts(rule, provider ? models[provider] : null);
              const accounts = ruleProfiles(provider, profiles);
              const problems = errors.get(index) ?? [];
              return (
                <li key={rule.id} className="sb-rule" data-testid="model-rule" data-rule-id={rule.id} data-invalid={problems.length > 0 || undefined}>
                  <div className="sb-rule-line">
                    <span className="sb-rule-index">{index + 1}.</span>
                    <select
                      className="sb-set-select sb-rule-select"
                      data-testid="rule-priority"
                      aria-label={`Rule ${index + 1}: priority`}
                      value={rule.priority}
                      disabled={busy}
                      onChange={(event) => update(rule.id, (r) => ({ ...r, priority: event.target.value as RoutingPriority }))}
                    >
                      {ROUTING_PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {PRIORITY_LABELS[priority]}
                        </option>
                      ))}
                    </select>
                    <select
                      className="sb-set-select sb-rule-select"
                      data-testid="rule-estimate"
                      aria-label={`Rule ${index + 1}: estimate`}
                      value={rule.estimate.kind}
                      disabled={busy}
                      onChange={(event) => update(rule.id, (r) => ({ ...r, estimate: estimateFor(event.target.value as ModelRule['estimate']['kind'], r.estimate) }))}
                    >
                      {ESTIMATE_MATCH_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {ESTIMATE_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                    {rule.estimate.kind === 'at-most' || rule.estimate.kind === 'more-than' ? (
                      <label className="sb-rule-minutes">
                        <input
                          type="number"
                          min={1}
                          step={1}
                          inputMode="numeric"
                          className="sb-rule-minutes-input"
                          data-testid="rule-minutes"
                          aria-label={`Rule ${index + 1}: minutes`}
                          value={rule.estimate.minutes}
                          disabled={busy}
                          onChange={(event) => {
                            const minutes = Math.round(Number(event.target.value));
                            update(rule.id, (r) => (r.estimate.kind === 'at-most' || r.estimate.kind === 'more-than' ? { ...r, estimate: { kind: r.estimate.kind, minutes } } : r));
                          }}
                        />
                        <span>min</span>
                      </label>
                    ) : null}
                    <span className="sb-rule-arrow" aria-hidden="true">
                      →
                    </span>
                    <select
                      className="sb-set-select sb-rule-select"
                      data-testid="rule-cli"
                      aria-label={`Rule ${index + 1}: CLI`}
                      value={provider ?? KEEP}
                      disabled={busy}
                      onChange={(event) => update(rule.id, (r) => withProvider(r, event.target.value))}
                    >
                      {cliOptions().map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="sb-set-select sb-rule-select"
                      data-testid="rule-model"
                      aria-label={`Rule ${index + 1}: model`}
                      value={rule.model ?? KEEP}
                      disabled={busy || !provider}
                      title={provider ? undefined : 'Pick a CLI first: each CLI has its own models'}
                      onChange={(event) => update(rule.id, (r) => withModel(r, event.target.value))}
                    >
                      <option value={KEEP}>keep model</option>
                      {modelList.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      {rule.model && !modelList.some((option) => option.value === rule.model) ? <option value={rule.model}>{rule.model}</option> : null}
                    </select>
                    <select
                      className="sb-set-select sb-rule-select"
                      data-testid="rule-effort"
                      aria-label={`Rule ${index + 1}: effort`}
                      value={rule.effort ?? KEEP}
                      disabled={busy || !provider || (efforts.length === 0 && !rule.effort)}
                      onChange={(event) => update(rule.id, (r) => withTarget(r, 'effort', event.target.value))}
                    >
                      <option value={KEEP}>keep effort</option>
                      {efforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                      {rule.effort && !efforts.includes(rule.effort) ? <option value={rule.effort}>{rule.effort}</option> : null}
                    </select>
                    <select
                      className="sb-set-select sb-rule-select"
                      data-testid="rule-account"
                      aria-label={`Rule ${index + 1}: account`}
                      value={rule.profileId ?? KEEP}
                      disabled={busy || !provider}
                      onChange={(event) => update(rule.id, (r) => withTarget(r, 'profileId', event.target.value))}
                    >
                      <option value={KEEP}>keep account</option>
                      {accounts.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                      {rule.profileId && !accounts.some((profile) => profile.id === rule.profileId) ? <option value={rule.profileId}>{rule.profileId}</option> : null}
                    </select>
                    <span className="sb-rule-buttons">
                      <button type="button" className="sb-set-action sb-rule-button" data-testid="rule-up" aria-label={`Move rule ${index + 1} up`} disabled={busy || index === 0} onClick={() => edit(moveRule(rules, rule.id, -1))}>
                        ↑
                      </button>
                      <button
                        type="button"
                        className="sb-set-action sb-rule-button"
                        data-testid="rule-down"
                        aria-label={`Move rule ${index + 1} down`}
                        disabled={busy || index === rules.length - 1}
                        onClick={() => edit(moveRule(rules, rule.id, 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="sb-set-action sb-rule-button"
                        data-testid="rule-remove"
                        aria-label={`Remove rule ${index + 1}`}
                        disabled={busy}
                        onClick={() => edit(rules.filter((r) => r.id !== rule.id))}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                  <div className="sb-rule-preview" data-testid="rule-preview">
                    {rulePreview(rule, models, profiles)}
                  </div>
                  {problems.map((problem) => (
                    <div key={problem} className="sb-rule-error" role="alert" data-testid="rule-error">
                      {problem}
                    </div>
                  ))}
                </li>
              );
            })}
          </ol>
        )}
        {(errors.get(-1) ?? []).map((problem) => (
          <div key={problem} className="sb-rule-error" role="alert" data-testid="rule-error">
            {problem}
          </div>
        ))}
        <div className="sb-rules-buttons">
          <button type="button" className="sb-set-action" data-testid="model-rules-add" disabled={busy} onClick={() => edit([...rules, newRule(ruleId())])}>
            + Add rule
          </button>
          <button type="button" className="sb-set-action" data-testid="model-rules-save" disabled={busy || !dirty} onClick={save}>
            Save
          </button>
          {dirty ? (
            <button type="button" className="sb-set-action" data-testid="model-rules-discard" disabled={busy} onClick={() => edit(stored)}>
              Discard
            </button>
          ) : null}
        </div>
      </div>
    </Row>
  );
}
