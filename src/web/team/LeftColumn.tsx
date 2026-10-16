import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react';
import type { TeamActivityRecord, TeamNeedsYouItem } from '../../core/team.ts';
import { newSince } from './activity.ts';
import { knownNeeds, leftColumnSeenAt } from './local.ts';
import { LEFT_COLUMN_KEY, leftStripLabel, needsToPulse } from './model.ts';

/** How long the badge's one pulse lasts (the CSS animation's length). */
export const PULSE_MS = 1_200;

/** Where the focus goes once the column has folded / unfolded (`null`: it stays where it is). */
export type LeftFocus = 'strip' | 'collapse' | 'needs' | null;

/**
 * D100 follow-up 2026-10-16 · the Team page's left column (Needs you + Activity) on
 * desktop and tablet. Expanded, it is the column as before plus a small **‹** at its
 * top-right corner (positioned over the column, so the layout is unchanged); folded,
 * a slim strip (`docs/team.md` → *The Team page*) with the needs-you count as an amber
 * badge, a dot when activity arrived since it was folded, and **›**. A click on the
 * strip unfolds it; a click on the badge unfolds it and brings Needs you into view.
 * A new Needs-you item never unfolds it: the badge pulses once instead.
 */
export function LeftColumn({
  collapsed,
  items,
  activity,
  focus,
  onFold,
  children,
}: {
  readonly collapsed: boolean;
  readonly items: readonly TeamNeedsYouItem[];
  readonly activity: readonly TeamActivityRecord[];
  /** Read (and cleared) once the state's element mounted. */
  readonly focus: { current: LeftFocus };
  /** Folds (`true`) or unfolds (`false`) the column; `focus` says where the focus goes then. */
  readonly onFold: (collapsed: boolean, focus: LeftFocus) => void;
  /** Needs you + Activity. */
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const target = focus.current;
    focus.current = null;
    const root = ref.current;
    if (!target || !root) return;
    if (target === 'strip') root.querySelector<HTMLElement>('[data-testid="team-left-expand"]')?.focus();
    else if (target === 'collapse') root.querySelector<HTMLElement>('[data-testid="team-left-collapse"]')?.focus();
    else {
      const needs = root.querySelector<HTMLElement>('[data-testid="team-needs-you"]');
      root.scrollTop = 0;
      needs?.scrollIntoView({ block: 'start' });
      needs?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    }
  }, [collapsed, focus]);

  if (!collapsed) {
    return (
      <div className="sb-team-left" data-testid="team-left" ref={ref}>
        <button
          type="button"
          className="sb-team-left-fold"
          data-testid="team-left-collapse"
          data-tour="team-left-column"
          aria-expanded="true"
          aria-label={`Hide Needs you and Activity (${LEFT_COLUMN_KEY})`}
          title={`Hide Needs you and Activity (${LEFT_COLUMN_KEY})`}
          onClick={() => onFold(true, 'strip')}
        >
          ‹
        </button>
        {children}
      </div>
    );
  }
  return <LeftStrip ref={ref} items={items} activity={activity} onFold={onFold} />;
}

function LeftStrip({
  ref,
  items,
  activity,
  onFold,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly items: readonly TeamNeedsYouItem[];
  readonly activity: readonly TeamActivityRecord[];
  readonly onFold: (collapsed: boolean, focus: LeftFocus) => void;
}) {
  const pulsed = useRef<Set<string>>(new Set());
  const [pulses, setPulses] = useState(0);
  const [pulsing, setPulsing] = useState(false);
  const keys = items.map((item) => `${item.source}:${item.id}`).join('\n');
  useEffect(() => {
    if (keys === '') return;
    const fresh = needsToPulse(keys.split('\n'), knownNeeds(), pulsed.current);
    if (fresh.length === 0) return;
    for (const key of fresh) pulsed.current.add(key);
    setPulses((was) => was + 1);
  }, [keys]);
  useEffect(() => {
    if (pulses === 0) return undefined;
    setPulsing(true);
    const timer = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => clearTimeout(timer);
  }, [pulses]);
  const fresh = newSince(activity, leftColumnSeenAt()) > 0;
  const label = leftStripLabel(items.length, fresh);
  return (
    <div className="sb-team-left sb-team-left--strip" data-testid="team-left-strip" data-tour="team-left-column" ref={ref} title={label} onClick={() => onFold(false, 'collapse')}>
      <button
        type="button"
        className="sb-team-left-fold"
        data-testid="team-left-expand"
        aria-expanded="false"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onFold(false, 'collapse');
        }}
      >
        ›
      </button>
      {items.length > 0 ? (
        <button
          // A new key restarts the one-time pulse.
          key={pulses}
          type="button"
          className="sb-team-left-badge"
          data-testid="team-left-badge"
          data-pulse={pulsing ? 'true' : undefined}
          data-pulses={pulses}
          aria-label={`${items.length} need${items.length === 1 ? 's' : ''} you: show Needs you`}
          title={`${items.length} need${items.length === 1 ? 's' : ''} you`}
          onClick={(event) => {
            event.stopPropagation();
            onFold(false, 'needs');
          }}
        >
          {items.length}
        </button>
      ) : null}
      {fresh ? <span className="sb-team-left-dot" data-testid="team-left-dot" role="img" aria-label="New activity" /> : null}
    </div>
  );
}
