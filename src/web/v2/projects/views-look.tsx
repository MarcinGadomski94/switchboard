import { type CSSProperties, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Plan, PlanItem } from '../../../core/plans.ts';
import { modelLabel } from '../../../core/model-choice.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { Button, Icon } from '../components/index.ts';
import { GRAPH_WORDS } from '../glossary.ts';
import type { GraphTone } from './graph-layout.ts';
import { Ring, laneColour, toneColour } from './graph-parts.tsx';
import { PROGRESS_SEGMENTS, type RepoChip, TONE_ICON, toneCounts } from './views-model.ts';
import './project-views.css';

/**
 * Fixes after 2.0 → *Steps, Board and Timeline in the Graph's look*: the pieces the Steps, Board
 * and Timeline views share with the Graph. `Ring`, `laneColour` and `toneColour` are the Graph's
 * own (`graph-parts.tsx`); the rest re-implements what `GraphView.tsx` keeps private (the header,
 * the reduced-motion / clock / "just appeared" hooks, the critical-path choice, the model chip)
 * so the two lanes could be built side by side. Dedupe later: the Graph can import these.
 */

/** The Graph's remembered Critical path choice (`GraphView.tsx`): one choice for all four views. */
const CRITICAL_KEY = 'switchboard.v2.projectGraph.critical';

/** How often the working steps' time so far ticks (ms), as in the Graph. */
export const NOW_TICK_MS = 30_000;

/** `prefers-reduced-motion`, live. */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const on = (): void => setReduced(list.matches);
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** The clock, a tick every `ms`. */
export function useNow(ms: number = NOW_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Ids that just appeared in `ids` (empty on the first render), for `ms` milliseconds (a step that just became done pops). */
export function useFresh(ids: readonly string[], ms = 900): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const key = ids.join('\n');
  useEffect(() => {
    const before = known.current;
    known.current = new Set(ids);
    if (before === null) return;
    const added = ids.filter((id) => !before.has(id));
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return fresh;
}

function readCritical(): boolean {
  try {
    return window.localStorage.getItem(CRITICAL_KEY) !== '0';
  } catch {
    return true;
  }
}

/** The Critical path choice (on by default; remembered, shared with the Graph). */
export function useCriticalChoice(): readonly [boolean, () => void] {
  const [on, setOn] = useState(readCritical);
  const toggle = useCallback(() => {
    setOn((value) => {
      try {
        window.localStorage.setItem(CRITICAL_KEY, value ? '0' : '1');
      } catch {
        // No storage: the choice lasts for this page.
      }
      return !value;
    });
  }, []);
  return [on, toggle] as const;
}

/** The model a working step's agent runs ("Opus 5.5"), when its session is known (the Graph card's chip). */
export function useStepModels(): (item: PlanItem, tone: GraphTone) => string | null {
  const sessions = useSessionListOf();
  const byId = useMemo(() => new Map((sessions.data ?? []).map((session) => [session.id, session])), [sessions.data]);
  return useCallback(
    (item: PlanItem, tone: GraphTone): string | null => {
      if (tone !== 'working' || !item.runSessionId) return null;
      const session = byId.get(item.runSessionId);
      const current = session?.model?.current ?? null;
      if (!current) return null;
      return modelLabel(session?.model?.available ?? null, current).replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
    },
    [byId],
  );
}

/**
 * Moves the elements marked `data-flip="<id>"` inside `root` from where they were to where they
 * are now when `key` changes (FLIP; a step that changes section, lane or column glides there).
 * Places are measured from `root`'s corner, so scrolling the page in between moves nothing.
 * Never under reduced motion.
 */
export function useFlip(root: RefObject<HTMLElement | null>, key: unknown): void {
  const last = useRef(new Map<string, { readonly left: number; readonly top: number }>());
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const origin = el.getBoundingClientRect();
    const now = new Map<string, { left: number; top: number }>();
    for (const node of el.querySelectorAll<HTMLElement>('[data-flip]')) {
      const id = node.dataset['flip'] ?? '';
      const box = node.getBoundingClientRect();
      if (box.width === 0) continue;
      const at = { left: box.left - origin.left, top: box.top - origin.top };
      now.set(id, at);
      const before = last.current.get(id);
      if (reduce || !before || !node.animate) continue;
      const dx = before.left - at.left;
      const dy = before.top - at.top;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    last.current = now;
  }, [root, key]);
}

/** A step's ring with its state's icon (working: the ring spins, no icon). */
export function StepRing({ tone, value, size = 34, stroke = 3.5, className }: { readonly tone: GraphTone; readonly value: number; readonly size?: number; readonly stroke?: number; readonly className?: string }) {
  const icon = TONE_ICON[tone];
  return (
    <Ring value={value} size={size} stroke={stroke} className={className ? `v2-pv-ring ${className}` : 'v2-pv-ring'}>
      {icon ? <Icon name={icon} size="s" /> : null}
    </Ring>
  );
}

/** The repository chip, tinted like its lane. */
export function RepoChipView({ chip }: { readonly chip: RepoChip }) {
  if (!chip) return null;
  return (
    <span className="v2-pv-chip" data-neutral={chip.hue < 0 || undefined} style={{ '--lane': laneColour(chip.hue) } as CSSProperties}>
      {chip.text}
    </span>
  );
}

/** The model chip of a working step ("✦ Opus 5.5"). */
export function ModelChip({ model }: { readonly model: string | null }) {
  if (!model) return null;
  return (
    <span className="v2-pv-who" data-testid="v2-step-model">
      <Icon name="sparkle" size="s" />
      {model}
    </span>
  );
}

/** The estimate bar: the time so far against the estimate (a working step's). */
export function EtaBar({ value, className }: { readonly value: number | null; readonly className?: string }) {
  if (value === null) return null;
  return (
    <span className={className ? `v2-pv-eta ${className}` : 'v2-pv-eta'} data-testid="v2-step-eta" aria-hidden="true">
      <b style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  );
}

/** A repository lane's head: its badge, name, a mini progress bar and "done/total" (the Graph lane's head). */
export function LaneHead({ label, hue, done, total, children }: { readonly label: string; readonly hue: number; readonly done: number; readonly total: number; readonly children?: ReactNode }) {
  return (
    <div className="v2-pv-lane-h">
      <span className="v2-pv-lane-ic" aria-hidden="true">
        <Icon name={hue < 0 ? 'grid' : 'folder'} size="s" />
      </span>
      <span className="v2-pv-lane-name">{label}</span>
      <span className="v2-pv-lane-bar" role="img" aria-label={GRAPH_WORDS.laneDone(done, total)}>
        <b style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }} />
      </span>
      <span className="v2-pv-lane-n">
        {done}/{total}
      </span>
      {children}
    </div>
  );
}

/**
 * The project's progress, as the Graph's header shows it: the % done ring, "N of M done · K working
 * · J need you", the bar by state with its legend, and the Critical path toggle (one choice for
 * all four views). Same classes as the Graph's header (`projects.css` → `.v2-p-ghead`).
 */
export function ProjectProgress({ plan, tones, working, needs, critical, onCritical }: { readonly plan: Pick<Plan, 'progress'>; readonly tones: ReadonlyMap<string, GraphTone>; readonly working: number; readonly needs: number; readonly critical: boolean; readonly onCritical: () => void }) {
  const { done, total } = plan.progress;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const counts = toneCounts(tones.values());
  return (
    <div className="v2-p-ghead v2-pv-head" data-testid="v2-project-progress">
      <Ring value={percent / 100} size={56} stroke={6} className="v2-p-ghead-ring">
        <span className="v2-p-ghead-pct">{percent}%</span>
      </Ring>
      <div className="v2-p-ghead-main">
        <b className="v2-p-ghead-sum" data-testid="v2-progress-summary">
          {GRAPH_WORDS.summary(done, total, working, needs)}
        </b>
        <div className="v2-p-gbar" data-testid="v2-progress-bar" role="img" aria-label={GRAPH_WORDS.percentDone(percent)}>
          {PROGRESS_SEGMENTS.map((tone) => (counts[tone] > 0 ? <span key={tone} data-tone={tone} style={{ width: `${(counts[tone] / Math.max(1, total)) * 100}%` }} /> : null))}
        </div>
        <div className="v2-p-gbar-legend">
          {PROGRESS_SEGMENTS.map((tone) =>
            counts[tone] > 0 ? (
              <span key={tone} data-tone={tone}>
                <i style={{ background: toneColour(tone) }} />
                {counts[tone]} {GRAPH_WORDS.segments[tone]}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <Button size="sm" icon="diagram" aria-pressed={critical} title={GRAPH_WORDS.criticalPathHint} onClick={onCritical} data-testid="v2-progress-critical" className="v2-p-gcrit">
        {GRAPH_WORDS.criticalPath}
      </Button>
    </div>
  );
}
