import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, forwardRef, useId } from 'react';

/** The label, hint and error around a control. */
interface FieldFrame {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
}

function Frame({ id, label, hint, error, children }: FieldFrame & { readonly id: string; readonly children: ReactNode }) {
  return (
    <div className="v2-field-wrap">
      {label ? (
        <label className="v2-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      {children}
      {hint ? (
        <div className="v2-field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="v2-field-error" id={`${id}-error`} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function described(id: string, frame: FieldFrame): string | undefined {
  const ids = [frame.hint ? `${id}-hint` : null, frame.error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/** D131 · a text input with its label (`.field`). */
export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldFrame>(function Field({ label, hint, error, id, className, ...rest }, ref) {
  const own = useId();
  const fieldId = id ?? own;
  return (
    <Frame id={fieldId} label={label} hint={hint} error={error}>
      <input ref={ref} id={fieldId} className={className ? `v2-field ${className}` : 'v2-field'} aria-invalid={error ? true : undefined} aria-describedby={described(fieldId, { hint, error })} {...rest} />
    </Frame>
  );
});

/** D131 · a multi-line text field (`.ta`). */
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldFrame>(function TextArea({ label, hint, error, id, className, ...rest }, ref) {
  const own = useId();
  const fieldId = id ?? own;
  return (
    <Frame id={fieldId} label={label} hint={hint} error={error}>
      <textarea ref={ref} id={fieldId} className={className ? `v2-field ${className}` : 'v2-field'} aria-invalid={error ? true : undefined} aria-describedby={described(fieldId, { hint, error })} {...rest} />
    </Frame>
  );
});

/** One option of {@link Select}. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/** D131 · a native select with its label. */
export const Select = forwardRef<HTMLSelectElement, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & FieldFrame & { readonly options: readonly SelectOption[] }>(function Select({ label, hint, error, id, className, options, ...rest }, ref) {
  const own = useId();
  const fieldId = id ?? own;
  return (
    <Frame id={fieldId} label={label} hint={hint} error={error}>
      <select ref={ref} id={fieldId} className={className ? `v2-field ${className}` : 'v2-field'} aria-invalid={error ? true : undefined} aria-describedby={described(fieldId, { hint, error })} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Frame>
  );
});

/**
 * D131 · a checkbox row (`.chk`, 44 px high): the whole row is the label.
 * `plain` drops the outlined box. `num` shows the answer cards' number key.
 */
export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { readonly label: ReactNode; readonly plain?: boolean; readonly num?: number }>(function Checkbox({ label, plain = false, num, className, title, ...rest }, ref) {
  // The tooltip (an answer option's description) on the whole choice, not only its box.
  return (
    <label className={className ? `v2-chk ${className}` : 'v2-chk'} title={title} {...(plain ? { 'data-plain': '' } : {})}>
      <input ref={ref} type="checkbox" {...(num !== undefined ? { 'data-num': num } : {})} {...rest} />
      {num !== undefined ? (
        <span className="v2-num" aria-hidden="true">
          {num}
        </span>
      ) : null}
      <span>{label}</span>
    </label>
  );
});

/** D131 · an on / off switch (`.switch`, `role="switch"`). */
export function Switch({ checked, onChange, label, disabled = false, testId }: { readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly label: string; readonly disabled?: boolean; readonly testId?: string }) {
  return <button type="button" role="switch" className="v2-switch" aria-checked={checked} aria-label={label} disabled={disabled} data-testid={testId} onClick={() => onChange(!checked)} />;
}
