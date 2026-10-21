import { useEffect, useState } from 'react';
import { POWER_ESTIMATE_MAX_W, type PowerEstimateSettings, parsePowerEstimateSettings } from '../../../core/power.ts';
import { readKnownSettings } from '../../../core/settings.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';

type Field = keyof PowerEstimateSettings;

const FIELDS: ReadonlyArray<{ readonly key: Field; readonly label: string }> = [
  { key: 'cpuIdleW', label: 'CPU idle' },
  { key: 'cpuMaxW', label: 'CPU max' },
  { key: 'baseW', label: 'Rest of the system' },
];

type Draft = Record<Field, string>;

function draftOf(settings: PowerEstimateSettings): Draft {
  const text = (value: number | null): string => (value === null ? '' : String(value));
  return { cpuIdleW: text(settings.cpuIdleW), cpuMaxW: text(settings.cpuMaxW), baseW: text(settings.baseW) };
}

/**
 * D125 · Settings → Machines → **Power estimate** (`docs/power.md`): this
 * machine's CPU idle and max watts and the rest of the system, used only while
 * it has no battery (a desktop's "~210 W (estimated)"). An empty field is this
 * machine's default (shown as the placeholder). Stored as the `power.estimate`
 * setting; the next sample (within 30 s) uses it.
 */
export function PowerEstimateRow() {
  const settings = useApi(api.settings);
  const known = settings.data ? readKnownSettings(settings.data) : null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly error: boolean; readonly text: string } | null>(null);
  useEffect(() => {
    if (known && draft === null) setDraft(draftOf(known['power.estimate']));
  }, [settings.data, draft]);
  if (!known || !draft) return null;
  const defaults = known['power.estimateDefaults'];

  const save = async (value: Draft): Promise<void> => {
    const number = (text: string): number | null => (text.trim() === '' ? null : Number(text));
    const patch = { cpuIdleW: number(value.cpuIdleW), cpuMaxW: number(value.cpuMaxW), baseW: number(value.baseW) };
    const parsed = parsePowerEstimateSettings(patch);
    if (!parsed.ok) {
      const idleAboveMax = patch.cpuIdleW !== null && patch.cpuMaxW !== null && patch.cpuIdleW > patch.cpuMaxW;
      setNote({ error: true, text: idleAboveMax ? 'CPU idle must not be above CPU max.' : `Use watts from 0 to ${POWER_ESTIMATE_MAX_W}, or leave a field empty for the default.` });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const answer = readKnownSettings(await api.saveSettings({ 'power.estimate': parsed.settings }));
      setDraft(draftOf(answer['power.estimate']));
      setNote({ error: false, text: 'Saved: the next reading (within 30 s) uses it.' });
      settings.reload();
    } catch (caught) {
      const message = caught instanceof ApiError && typeof (caught.body as { message?: unknown } | null)?.message === 'string' ? (caught.body as { message: string }).message : null;
      setNote({ error: true, text: message ?? 'The power estimate could not be saved.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-set-row sb-mach-power" data-row="power-estimate" data-tour="power-estimate">
      <div className="sb-set-row-text">
        <div className="sb-set-row-label">Power estimate</div>
        <div className="sb-set-row-desc">
          Used only while this machine has no battery: its draw is estimated as the GPU (measured where possible) + CPU idle + CPU use × (max − idle) + the rest of the system. Empty = this machine's default. Never shown as measured.
        </div>
        <form
          className="sb-mach-power-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          {FIELDS.map(({ key, label }) => (
            <label key={key} className="sb-mach-power-field">
              <span>{label}</span>
              <input
                className="sb-set-input"
                data-testid={`power-estimate-${key}`}
                type="number"
                inputMode="decimal"
                min={0}
                max={POWER_ESTIMATE_MAX_W}
                step="any"
                placeholder={defaults[key] > 0 ? String(defaults[key]) : ''}
                value={draft[key]}
                aria-label={`${label}, watts`}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
              />
              <span className="sb-mach-power-unit">W</span>
            </label>
          ))}
          <button type="submit" className="sb-set-action" data-testid="power-estimate-save" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="sb-set-action"
            data-testid="power-estimate-reset"
            disabled={busy || (draft.cpuIdleW === '' && draft.cpuMaxW === '' && draft.baseW === '')}
            onClick={() => void save({ cpuIdleW: '', cpuMaxW: '', baseW: '' })}
          >
            Use defaults
          </button>
        </form>
        {note ? (
          <div className={note.error ? 'sb-set-note sb-set-error' : 'sb-set-note'} role={note.error ? 'alert' : 'status'} data-testid="power-estimate-note">
            {note.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
