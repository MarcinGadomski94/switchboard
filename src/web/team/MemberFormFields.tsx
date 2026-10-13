import { useId } from 'react';
import type { Folder, OwnedLoop, SessionModelOption } from '../../core/api.ts';
import { ALWAYS_ON_GATE, GATE_KINDS } from '../../core/team.ts';
import { MemberModelField } from './MemberModel.tsx';
import { type MemberForm, gateCheckboxLabel, toggleGate } from './model.ts';

/** Which parts of the form show (the dialogs show all; Settings shows all but the folder). */
export interface FormParts {
  /** Create: the folder the new session starts in. */
  readonly folder?: readonly Folder[] | null;
  /** Adopt / Settings: the session's live Switchboard loops (the rhythm picks among them). */
  readonly sessionLoops?: readonly OwnedLoop[] | null;
  /** D100 follow-up 2026-10-14: the models the member's CLI offers (`null` while loading). */
  readonly models?: readonly SessionModelOption[] | null;
}

/**
 * D100 · the member form's fields (`docs/team.md` → *The Team page*): role name,
 * charter (owns / produces / how it works (D105) / never does), rhythm (the session's loops, or a
 * template's suggested loops to create, and "on hand-off"), model / effort, budget
 * and "needs you for" (Anything outward-facing is always on). Errors come from
 * `formBody` (model.ts).
 */
export function MemberFormFields({
  form,
  onChange,
  errors,
  parts,
  disabled = false,
}: {
  readonly form: MemberForm;
  readonly onChange: (next: MemberForm) => void;
  readonly errors: Readonly<Record<string, string>>;
  readonly parts: FormParts;
  readonly disabled?: boolean;
}) {
  const id = useId();
  const set = <K extends keyof MemberForm>(key: K, value: MemberForm[K]): void => onChange({ ...form, [key]: value });
  return (
    <div className="sb-team-form" data-testid="team-form">
      <label className="sb-team-field" data-section="name">
        <span className="sb-team-field__label">Role name</span>
        <input className="sb-team-input" data-testid="team-form-name" maxLength={40} value={form.name} disabled={disabled} placeholder="Tracker" onChange={(event) => set('name', event.target.value)} />
        {errors['name'] ? <span className="sb-team-error">{errors['name']}</span> : null}
      </label>
      <fieldset className="sb-team-fieldset" data-section="charter" data-tour="team-charter">
        <legend className="sb-team-field__label">Charter</legend>
        <label className="sb-team-field">
          <span className="sb-team-field__sub">Owns</span>
          <textarea className="sb-team-input" data-testid="team-form-owns" rows={2} value={form.owns} disabled={disabled} onChange={(event) => set('owns', event.target.value)} />
        </label>
        <label className="sb-team-field">
          <span className="sb-team-field__sub">Produces</span>
          <textarea className="sb-team-input" data-testid="team-form-produces" rows={2} value={form.produces} disabled={disabled} onChange={(event) => set('produces', event.target.value)} />
        </label>
        <label className="sb-team-field">
          <span className="sb-team-field__sub">How it works</span>
          <textarea className="sb-team-input" data-testid="team-form-how" rows={2} value={form.howItWorks} disabled={disabled} placeholder="e.g. runs feedback rounds on input from you and your team, then adjusts the feature" onChange={(event) => set('howItWorks', event.target.value)} />
        </label>
        <label className="sb-team-field">
          <span className="sb-team-field__sub">Never does</span>
          <textarea className="sb-team-input" data-testid="team-form-never" rows={2} value={form.neverDoes} disabled={disabled} onChange={(event) => set('neverDoes', event.target.value)} />
        </label>
      </fieldset>
      <fieldset className="sb-team-fieldset" data-section="rhythm">
        <legend className="sb-team-field__label">Rhythm</legend>
        {(parts.sessionLoops ?? []).map((loop) => (
          <label key={loop.id} className="sb-team-check">
            <input
              type="checkbox"
              data-testid="team-form-loop"
              checked={form.loopIds.includes(loop.id)}
              disabled={disabled}
              onChange={(event) => set('loopIds', event.target.checked ? [...form.loopIds, loop.id] : form.loopIds.filter((loopId) => loopId !== loop.id))}
            />
            <span>
              {loop.label ?? loop.prompt} <span className="sb-team-muted">· {loop.scheduleText}</span>
            </span>
          </label>
        ))}
        {form.templateLoops.map((loop) => (
          <label key={loop.key} className="sb-team-check">
            <input
              type="checkbox"
              data-testid="team-form-template-loop"
              checked={loop.kept}
              disabled={disabled}
              onChange={(event) => set('templateLoops', form.templateLoops.map((l) => (l.key === loop.key ? { ...l, kept: event.target.checked } : l)))}
            />
            <span>
              {loop.label} <span className="sb-team-muted">· {loop.cron ? `cron ${loop.cron}` : `every ${loop.everyMinutes} min`} · created as a Switchboard loop</span>
            </span>
          </label>
        ))}
        <label className="sb-team-check">
          <input type="checkbox" data-testid="team-form-on-handoff" checked={form.onHandoff} disabled={disabled} onChange={(event) => set('onHandoff', event.target.checked)} />
          <span>On hand-off (a new hand-off wakes it)</span>
        </label>
      </fieldset>
      <div className="sb-team-form__row">
        {/* D100 follow-up 2026-10-14: the session header's model and effort picker over the CLI's models (MemberModel.tsx). */}
        <MemberModelField form={form} options={parts.models ?? null} onChange={onChange} disabled={disabled} />
        <label className="sb-team-field" data-section="budget">
          <span className="sb-team-field__label">Budget (% of daily usage)</span>
          <input className="sb-team-input" data-testid="team-form-budget" inputMode="numeric" placeholder="none" value={form.budget} disabled={disabled} onChange={(event) => set('budget', event.target.value)} />
          {errors['budget'] ? <span className="sb-team-error">{errors['budget']}</span> : null}
        </label>
      </div>
      <fieldset className="sb-team-fieldset" data-section="gates" aria-labelledby={`${id}-gates`}>
        <legend className="sb-team-field__label" id={`${id}-gates`}>
          Needs you for
        </legend>
        {GATE_KINDS.map((gate) => (
          <label key={gate} className="sb-team-check">
            <input
              type="checkbox"
              data-testid="team-form-gate"
              data-gate={gate}
              checked={gate === ALWAYS_ON_GATE || form.gates.includes(gate)}
              disabled={disabled || gate === ALWAYS_ON_GATE}
              onChange={() => set('gates', toggleGate(form.gates, gate))}
            />
            <span>{gateCheckboxLabel(gate)}</span>
          </label>
        ))}
      </fieldset>
      {parts.folder ? (
        <label className="sb-team-field" data-section="folder">
          <span className="sb-team-field__label">Folder (the new session starts here)</span>
          <select className="sb-team-input" data-testid="team-form-folder" value={form.folder} disabled={disabled} onChange={(event) => set('folder', event.target.value)}>
            <option value="">the default folder</option>
            {parts.folder.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
