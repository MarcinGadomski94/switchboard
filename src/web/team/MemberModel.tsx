import { useEffect, useRef, useState } from 'react';
import type { SessionModel, SessionModelOption } from '../../core/api.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import { api } from '../api/client.ts';
import { MODELS_LOADING, formModelOptions } from '../modals/new-session.ts';
import { ModelChoicePicker } from '../views/session/ModelPicker.tsx';
import { type ModelPicker, modelChoicePicker } from '../views/session/session-header.ts';
import { MEMBER_MODEL_NOTE, type MemberForm, fitMemberModel, memberModelChoice, pickMemberEffort, pickMemberModel } from './model.ts';

/**
 * D100 follow-up 2026-10-14 · the member's model dropdown (`docs/team.md` → *Model
 * and effort*): the session header's model and effort picker (D31's
 * `ModelChoicePicker`, the one D42's New-session form shares) over the models the
 * member's CLI reports: its session's list (`Session.model.available`), else the
 * list for its CLI (`GET /api/models?provider=`, the New-session form's, with its
 * fallback aliases). Never a hard-coded list.
 */

/** The models on offer and the choice to start from (`null` while loading). */
export interface MemberModels {
  readonly options: readonly SessionModelOption[] | null;
  /** The session's model and effort; a new member: the New-session form's last choice (`null` = the CLI's default). */
  readonly current: { readonly model: string | null; readonly effort: string | null } | null;
}

/** The models for a member's session (`session`: its `Session.model`; `null` = a new member) on `provider`. */
export function useMemberModels(session: SessionModel | null | undefined, provider: CliProviderId | null | undefined): MemberModels {
  const [loaded, setLoaded] = useState<MemberModels>({ options: null, current: null });
  const reported = session?.available ?? null;
  useEffect(() => {
    if (reported) return undefined;
    let live = true;
    api
      .models(provider ?? undefined)
      .then((models) => live && setLoaded({ options: formModelOptions(models, provider ?? 'claude'), current: models.last ?? { model: null, effort: null } }))
      .catch(() => live && setLoaded({ options: formModelOptions(null, provider ?? 'claude'), current: { model: null, effort: null } }));
    return () => {
      live = false;
    };
  }, [reported, provider]);
  if (reported) return { options: reported, current: { model: session?.current ?? null, effort: session?.effort ?? null } };
  if (session && loaded.options) return { options: loaded.options, current: { model: session.current, effort: session.effort } };
  return loaded;
}

/**
 * Fits the form's model to the list once it is known (`fitMemberModel`): the form's
 * own choice (a template's suggestion) when listed, else the session's current one.
 * `fromSession`: start from what the session runs on whatever the form held (the
 * Settings tab).
 */
export function useFitMemberModel(models: MemberModels, setForm: (update: (form: MemberForm) => MemberForm) => void, fromSession: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !models.options || !models.current) return;
    done.current = true;
    const options = models.options;
    const current = models.current;
    setForm((form) => fitMemberModel(fromSession ? { ...form, model: '', effort: '' } : form, options, current));
  }, [models, setForm, fromSession]);
}

/** The picker the form shows (disabled while the list loads). */
export function memberModelPicker(form: Pick<MemberForm, 'model' | 'effort'>, options: readonly SessionModelOption[] | null): ModelPicker {
  const choice = memberModelChoice(form);
  const picker = modelChoicePicker({ current: choice.model, effort: choice.effort, available: options }, MEMBER_MODEL_NOTE);
  return options === null || form.model === '' ? { ...picker, label: options === null ? 'Loading…' : picker.label, disabled: options === null, reason: options === null ? MODELS_LOADING : null, title: options === null ? MODELS_LOADING : MEMBER_MODEL_NOTE } : picker;
}

/** The form's Model · effort field. */
export function MemberModelField({ form, options, onChange, disabled }: { readonly form: MemberForm; readonly options: readonly SessionModelOption[] | null; readonly onChange: (next: MemberForm) => void; readonly disabled: boolean }) {
  const picker = memberModelPicker(form, options);
  return (
    <div className="sb-team-field" data-section="model" data-tour="team-model">
      <span className="sb-team-field__label">Model · effort</span>
      <ModelChoicePicker
        testId="team-form-model"
        picker={disabled ? { ...picker, disabled: true } : picker}
        keepEscape
        onPickModel={(value) => options && onChange(pickMemberModel(form, options, value))}
        onPickEffort={(value) => onChange(pickMemberEffort(form, value))}
      />
    </div>
  );
}
