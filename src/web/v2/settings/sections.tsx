import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Settings } from '../../../core/api.ts';
import { type KnownSettings, DEFAULT_STANDING_INSTRUCTION, readKnownSettings } from '../../../core/settings.ts';
import { staleInstructionCount } from '../../../core/standing-instruction.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { standingDraftState } from '../../views/settings/standing-instruction.ts';
import { Button, Card, EmptyState, Icon, Segmented, Skeleton, Switch, useToast } from '../components/index.ts';
import { SETTINGS_LABELS, SETTINGS_WORDS as W } from '../glossary.ts';
import { type Density, DENSITIES, readDensity, writeDensity } from './density.ts';
import { SchemeRow, ThemeRow } from './ThemeRow.tsx';

/** The classic Settings body (`GET /api/settings`) and its save, as classic Settings uses it. */
export interface KnownSettingsState {
  readonly settings: KnownSettings | null;
  readonly error: boolean;
  readonly saveError: string | null;
  readonly save: (patch: Partial<KnownSettings>) => Promise<void>;
  readonly onSaved: (body: Settings) => void;
}

/** D131 · lane R · `GET / PUT /api/settings` for the v2 Settings pages (classic Settings' own read and save). */
export function useKnownSettings(): KnownSettingsState {
  const loaded = useApi(api.settings);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const body = saved ?? loaded.data;
  const save = async (patch: Partial<KnownSettings>): Promise<void> => {
    try {
      setSaved(await api.saveSettings(patch));
      setSaveError(null);
    } catch {
      setSaveError(W.saveError);
    }
  };
  return { settings: body ? readKnownSettings(body) : null, error: !body && loaded.error !== null, saveError, save, onSaved: setSaved };
}

/**
 * D131 · lane R · Settings › Rules for every agent (D64's standing instruction):
 * the text, on / off, Save rules, Reset to default and **Apply to open agents**
 * (D91) with how many still use the older rules.
 */
export function RulesSection() {
  const { settings, error, saveError, save } = useKnownSettings();
  const sessions = useSessionListOf();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!settings) return error ? <EmptyState icon="alert" tone="grey" title={W.loadError} /> : <Skeleton lines={4} />;
  const stored = settings['agents.standingInstruction'];
  const text = draft ?? stored;
  const state = standingDraftState(stored, text);
  const stale = staleInstructionCount(sessions.data ?? []);
  const run = (patch: Partial<KnownSettings>, done: string): void => {
    setBusy(true);
    void save(patch)
      .then(() => {
        setDraft(null);
        toast({ text: done });
      })
      .finally(() => setBusy(false));
  };
  const apply = (): void => {
    setBusy(true);
    api
      .applyInstruction()
      .then(
        (result) => toast({ text: `Applied to ${result.restarted.length + result.notRunning} agent${result.restarted.length + result.notRunning === 1 ? '' : 's'}${result.pending.length ? `, ${result.pending.length} after their current step` : ''}${result.failed.length ? ` · ${result.failed.length} failed` : ''}.` }),
        (caught: unknown) => toast({ text: caught instanceof ApiError ? caught.message : String(caught), tone: 'error' }),
      )
      .finally(() => {
        setBusy(false);
        sessions.reload();
      });
  };
  return (
    <div className="v2-set-stack" data-testid="v2-set-rules">
      <Card pad className="v2-set-card">
        <div className="v2-set-card-h">
          <h3 className="v2-grow">{SETTINGS_LABELS.rules}</h3>
          <Switch checked={settings['agents.standingInstruction.enabled']} label={W.rulesOn} testId="v2-rules-enabled" disabled={busy} onChange={(on) => run({ 'agents.standingInstruction.enabled': on }, on ? 'Agents get the rules again.' : 'Agents no longer get the rules.')} />
        </div>
        <p className="v2-muted v2-set-p">{W.rulesSub}</p>
        <textarea className="v2-field v2-rules-text" rows={8} aria-label={SETTINGS_LABELS.rules} data-testid="v2-rules-text" value={text} disabled={busy} onChange={(event) => setDraft(event.currentTarget.value)} />
        {state.tooLong ? <p className="v2-set-error">Too long: at most 4,000 characters.</p> : null}
        <div className="v2-set-actions">
          <span className="v2-muted v2-set-small v2-grow">{W.rulesApplies}</span>
          <Button variant="ghost" disabled={busy || !state.canReset} onClick={() => run({ 'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION }, 'Rules reset to the default.')} data-testid="v2-rules-reset">
            {W.resetRules}
          </Button>
          <Button variant="primary" disabled={busy || !state.canSave} onClick={() => run({ 'agents.standingInstruction': text }, 'Rules saved. Agents follow them from their next step.')} data-testid="v2-rules-save">
            {W.saveRules}
          </Button>
        </div>
        <div className="v2-set-row">
          <span className="v2-grow" data-testid="v2-rules-stale">
            {stale > 0 ? `${stale} open agent${stale === 1 ? ' uses' : 's use'} older rules.` : 'Every open agent uses these rules.'}
          </span>
          <Button disabled={busy || stale === 0} onClick={apply} data-testid="v2-rules-apply">
            {W.applyOpen}
          </Button>
        </div>
        {saveError ? (
          <p className="v2-set-error" role="alert">
            {saveError}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

// ── Density (per browser) ─────────────────────────────────────────────

const densityListeners = new Set<() => void>();
const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
let density: Density = typeof window === 'undefined' ? 'comfortable' : readDensity(storage());

/** Sets this browser's default density (and `<html data-density>`). */
export function setDensity(next: Density): void {
  density = next;
  writeDensity(storage(), next);
  document.documentElement.dataset['density'] = next;
  for (const listener of densityListeners) listener();
}

/** This browser's default density, live. */
export function useDensity(): Density {
  return useSyncExternalStore(
    (listener) => {
      densityListeners.add(listener);
      return () => densityListeners.delete(listener);
    },
    () => density,
    () => density,
  );
}

/** D131 · lane R · Settings › Appearance: the theme (v2 / Classic), light / dark, the default text density, reduced motion. */
export function AppearanceSection() {
  const current = useDensity();
  useEffect(() => {
    document.documentElement.dataset['density'] = current;
  }, [current]);
  return (
    <div className="v2-set-stack" data-testid="v2-set-appearance">
      <Card pad className="v2-set-card">
        <h3>{SETTINGS_LABELS.appearance}</h3>
        <ThemeRow />
        <SchemeRow />
        <div className="v2-set-row" data-row="ui-density">
          <div className="v2-grow">
            <b>{W.density}</b>
            <div className="v2-muted v2-set-small">{W.densitySub}</div>
          </div>
          <Segmented
            label={W.density}
            testId="v2-density-switch"
            value={current}
            onChange={setDensity}
            options={DENSITIES.map((value) => ({ value, label: value === 'compact' ? W.compact : W.comfortable }))}
          />
        </div>
        <div className="v2-set-row" data-row="reduced-motion">
          <Icon name="sparkle" size="s" />
          <div className="v2-grow">
            <b>{W.motionTitle}</b>
            <div className="v2-muted v2-set-small">{W.motionNote}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
