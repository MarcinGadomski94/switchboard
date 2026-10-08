import type { ReactNode } from 'react';

/**
 * Building blocks of the Settings sections (M8.2), in the prototype's markup
 * shape: a row is `label + description` on the left and the value or control on
 * the right, with a 1px #1f2024 divider (SPEC → Settings).
 */

/** The section title (20px/600). `lede` = the tools section's explanation under it. */
export function SectionTitle({ children, withLede = false }: { readonly children: ReactNode; readonly withLede?: boolean }) {
  return (
    <div className="sb-set-title" data-testid="settings-title" {...(withLede ? { 'data-with-lede': '' } : {})}>
      {children}
    </div>
  );
}

/** One settings row. `mono` renders the description in Geist Mono (the workspace root path). */
export function Row({
  label,
  description,
  mono = false,
  children,
  id,
  tour,
}: {
  readonly label: string;
  readonly description: ReactNode;
  readonly mono?: boolean;
  readonly children?: ReactNode;
  /** `data-row` (tests address rows by it). */
  readonly id: string;
  /** D85: `data-tour`, the tutorial's anchor (`src/core/tutorial.ts`). */
  readonly tour?: string;
}) {
  return (
    <div className="sb-set-row" data-row={id} data-tour={tour}>
      <div className="sb-set-row-text">
        <div className="sb-set-row-label">{label}</div>
        <div className="sb-set-row-desc" {...(mono ? { 'data-mono': '' } : {})}>
          {description}
        </div>
      </div>
      {children}
    </div>
  );
}

/** A read-only value (Geist Mono 12px, #c9c8c3). */
export function Value({ children, color }: { readonly children: ReactNode; readonly color?: string }) {
  return (
    <span className="sb-set-value" data-testid="setting-value" style={color ? { color } : undefined}>
      {children}
    </span>
  );
}

/** An on/off setting shown like a value; a click flips it. */
export function ToggleValue({
  value,
  onToggle,
  label,
  disabled = false,
}: {
  readonly value: boolean;
  readonly onToggle: () => void;
  readonly label: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="sb-set-value-button"
      data-testid="setting-value"
      role="switch"
      aria-checked={value}
      aria-label={label}
      title="Click to change"
      disabled={disabled}
      onClick={onToggle}
    >
      {value ? 'on' : 'off'}
    </button>
  );
}

/** A small outlined action (Rescan, Send test, Allow). */
export function Action({ children, onClick, testId }: { readonly children: ReactNode; readonly onClick: () => void; readonly testId: string }) {
  return (
    <button type="button" className="sb-set-action" data-testid={testId} onClick={onClick}>
      {children}
    </button>
  );
}
