import { useEffect, useRef, useState } from 'react';
import type { Session, SessionModelInput } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { EFFORT_SECTION, MODEL_SECTION, actionErrorText, effortPickBody, modelPickBody, modelPicker } from './session-header.ts';

/** Props of {@link ModelPicker}. */
export interface ModelPickerProps {
  readonly sessionId: string;
  readonly session: Session;
  /** A change went through (or failed after the CLI took part of it): reload the session. */
  readonly onChanged: () => void;
}

/**
 * The session header's model and effort picker (D31, `docs/model-effort.md` →
 * *UI*): a header action showing `Opus 5.5 · high ▾` that opens a popover with the
 * **model** picker (the models the session's claude process reported) and the
 * **effort** picker (the chosen model's levels after Default; hidden when the model
 * has none). A pick calls `PUT /api/sessions/{id}/model` at once (a model pick
 * keeps the effort when the new model has it, else goes back to Default); a
 * refusal shows the server's text (the CLI's, verbatim) in the popover. Disabled,
 * with the reason as its tooltip, while no process has reported the models.
 * Sessions without model information (`model: null`, the demo's) show nothing.
 * Esc, a click outside or Close closes the popover.
 */
export function ModelPicker({ sessionId, session, onChanged }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  // A switch to another session never leaves the old popover (or its error) open.
  useEffect(() => {
    setOpen(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target && box.current && !box.current.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const picker = modelPicker(session);
  const model = session.model;
  if (!picker || !model) return null;

  const change = async (body: SessionModelInput | null): Promise<void> => {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.setModel(sessionId, body);
    } catch (caught) {
      setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <div className="sb-sv-model" data-testid="session-model" ref={box}>
      <button
        type="button"
        className="sb-button sb-sv-action sb-sv-model-button"
        data-testid="session-model-button"
        data-reason={picker.reason ?? undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={picker.disabled}
        title={picker.title}
        onClick={() => {
          setError(null);
          setOpen((was) => !was);
        }}
      >
        {picker.label}
        <span className="sb-sv-model-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && !picker.disabled ? (
        <div className="sb-sv-model-pop" role="dialog" aria-label="Model and effort" data-testid="model-popover">
          <div className="sb-sv-model-pop-head">
            <span className="sb-sv-model-pop-label">{MODEL_SECTION}</span>
            <button type="button" className="sb-button sb-sv-model-pop-close" data-testid="model-close" aria-label="Close" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <div className="sb-sv-model-list" role="radiogroup" aria-label={MODEL_SECTION}>
            {picker.models.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={item.selected}
                className="sb-button sb-sv-model-option"
                data-testid="model-option"
                data-value={item.value}
                disabled={busy}
                title={item.description ?? item.label}
                onClick={() => void change(modelPickBody(model, item.value))}
              >
                <span className="sb-sv-model-check" aria-hidden="true">
                  {item.selected ? '✓' : ''}
                </span>
                <span className="sb-sv-model-name">{item.label}</span>
                {item.description ? <span className="sb-sv-model-desc">{item.description}</span> : null}
              </button>
            ))}
          </div>
          {picker.efforts ? (
            <>
              <span className="sb-sv-model-pop-label">{EFFORT_SECTION}</span>
              <div className="sb-sv-effort-list" role="radiogroup" aria-label={EFFORT_SECTION} data-testid="effort-list">
                {picker.efforts.map((item) => (
                  <button
                    key={item.value ?? ''}
                    type="button"
                    role="radio"
                    aria-checked={item.selected}
                    className="sb-button sb-sv-effort-option"
                    data-testid="effort-option"
                    data-value={item.value ?? 'default'}
                    disabled={busy}
                    onClick={() => void change(effortPickBody(model, item.value))}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {error ? (
            <div className="sb-sv-error" role="alert" data-testid="model-error">
              {error}
            </div>
          ) : null}
          <div className="sb-sv-model-pop-note" data-testid="model-note">
            {picker.note}
          </div>
        </div>
      ) : null}
    </div>
  );
}
