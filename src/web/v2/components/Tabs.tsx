import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { Icon, type IconName } from './Icon.tsx';

/** One tab of {@link Tabs}. */
export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: ReactNode;
  readonly icon?: IconName | string;
  /** A count after the label. */
  readonly count?: number;
}

/** Moves along a row of buttons with ←/→ (Home / End), as WAI-ARIA tabs and toolbars do. */
function rovingKey<T>(event: KeyboardEvent, items: readonly T[], index: number): number | null {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return (index + 1) % items.length;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return (index - 1 + items.length) % items.length;
  if (event.key === 'Home') return 0;
  if (event.key === 'End') return items.length - 1;
  return null;
}

/**
 * D131 · tabs (`.tabs`): a `tablist` with roving focus (←/→, Home, End); the panel
 * is the caller's (give it `id={panelId}` and `role="tabpanel"`).
 */
export function Tabs<T extends string>({ tabs, value, onChange, label, panelId, testId }: { readonly tabs: readonly TabItem<T>[]; readonly value: T; readonly onChange: (id: T) => void; readonly label: string; readonly panelId?: string; readonly testId?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="v2-tabs" role="tablist" aria-label={label} data-testid={testId}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="tab"
          className="v2-tab"
          id={`${panelId ?? 'v2-tab'}-${tab.id}`}
          aria-selected={tab.id === value}
          aria-controls={panelId}
          tabIndex={tab.id === value ? 0 : -1}
          data-tab={tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            const next = rovingKey(event, tabs, index);
            if (next === null) return;
            event.preventDefault();
            const target = tabs[next];
            if (!target) return;
            onChange(target.id);
            refs.current[next]?.focus();
          }}
        >
          {tab.icon ? <Icon name={tab.icon} size="s" /> : null}
          {tab.label}
          {tab.count !== undefined ? <span className="v2-tab-n">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** One option of {@link Segmented}. */
export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly icon?: IconName | string;
  /** A small hint after the label ("new"). */
  readonly hint?: string;
  readonly title?: string;
}

/**
 * D131 · a segmented control (`.vt` / `.segc`): a group of toggle buttons, one
 * pressed (`aria-pressed`); ←/→ move between them.
 */
export function Segmented<T extends string>({ options, value, onChange, label, size = 'm', testId }: { readonly options: readonly SegmentOption<T>[]; readonly value: T; readonly onChange: (value: T) => void; readonly label: string; readonly size?: 'm' | 's'; readonly testId?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="v2-seg" role="group" aria-label={label} data-size={size === 'm' ? undefined : size} data-testid={testId}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          aria-pressed={option.value === value}
          data-value={option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const next = rovingKey(event, options, index);
            if (next === null || event.key === 'ArrowUp' || event.key === 'ArrowDown') return;
            event.preventDefault();
            refs.current[next]?.focus();
          }}
        >
          {option.icon ? <Icon name={option.icon} size="s" /> : null}
          {option.label}
          {option.hint ? <span className="v2-seg-hint">{option.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
