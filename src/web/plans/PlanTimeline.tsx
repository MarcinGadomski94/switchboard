import type { Plan } from '../../core/plans.ts';
import { STATE_LOOK, type SegmentKind, axisTicks, timeline, timelineSummary } from './model.ts';

/** The words of the segment kinds (the legend and the tooltips). */
const SEGMENT_WORDS: Readonly<Record<SegmentKind, string>> = {
  working: 'agent working',
  you: 'waiting on you',
  dependency: 'waiting on a dependency',
  usage: 'paused for usage',
  projected: 'projected',
};

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * D99 · the plan's Timeline view (`docs/plans.md` → *Timeline*): one bar per item, grouped by
 * repository, on a time axis from the plan's start to its projected end; segments for the
 * agent working (run blue), waiting on you (amber), waiting on a dependency (hatched grey),
 * paused for usage (red, 60 %) and projected (dashed outline); the "now" line; the summary
 * line above. Positions are percentages of the track, so it fits any width.
 */
export function PlanTimeline({ plan, now, selectedId, onSelect }: { readonly plan: Plan; readonly now: number; readonly selectedId: string | null; readonly onSelect: (itemId: string) => void }) {
  const view = timeline(plan, now);
  const span = Math.max(1, view.end - view.start);
  const pct = (at: number): string => `${(Math.max(0, Math.min(1, (at - view.start) / span)) * 100).toFixed(3)}%`;
  const width = (from: number, to: number): string => `${(Math.max(0, Math.min(1, (to - view.start) / span) - Math.max(0, Math.min(1, (from - view.start) / span))) * 100).toFixed(3)}%`;
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  return (
    <div className="sb-plan-timeline" data-testid="plan-timeline">
      <div className="sb-plan-timeline__summary" data-testid="plan-timeline-summary">
        {timelineSummary(view, plan)}
      </div>
      <div className="sb-plan-timeline__grid">
        <div className="sb-plan-timeline__axis-row">
          <div className="sb-plan-timeline__label" />
          <div className="sb-plan-timeline__axis">
            {axisTicks(view).map((tick) => (
              <span key={tick} className="sb-plan-timeline__tick" style={{ left: pct(tick) }}>
                {clock(tick)}
              </span>
            ))}
          </div>
        </div>
        {view.groups.map((group) => (
          <div key={group.repo} className="sb-plan-timeline__group" data-testid="plan-timeline-group" data-repo={group.repo}>
            <div className="sb-plan-timeline__repo">{group.repo}</div>
            {group.rows.map((row) => {
              const item = byId.get(row.itemId);
              if (!item) return null;
              const look = STATE_LOOK[item.state];
              return (
                <button
                  type="button"
                  key={row.itemId}
                  className="sb-plan-timeline__row"
                  data-testid="plan-timeline-row"
                  data-item-id={row.itemId}
                  aria-pressed={selectedId === row.itemId}
                  onClick={() => onSelect(row.itemId)}
                >
                  <span className="sb-plan-timeline__label">
                    <span style={{ color: look.color }} aria-hidden="true">
                      {look.icon}
                    </span>{' '}
                    <span className="sb-plan-timeline__key">{item.key ?? ''}</span> <span className="sb-plan-timeline__title">{item.title}</span>
                  </span>
                  <span className="sb-plan-timeline__track">
                    {row.segments.map((segment, index) => (
                      <span
                        key={index}
                        className="sb-plan-seg"
                        data-testid="plan-segment"
                        data-kind={segment.kind}
                        style={{ left: pct(segment.from), width: width(segment.from, segment.to) }}
                        title={`${SEGMENT_WORDS[segment.kind]}${segment.on ? ` (${segment.on})` : ''} · ${clock(segment.from)}–${clock(segment.to)}`}
                      />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        <span
          className="sb-plan-timeline__now"
          data-testid="plan-timeline-now"
          aria-hidden="true"
          style={{ left: `calc(var(--plan-tl-label) + (100% - var(--plan-tl-label)) * ${Math.max(0, Math.min(1, (view.now - view.start) / span)).toFixed(4)})` }}
        />
      </div>
      <div className="sb-plan-legend" data-testid="plan-timeline-legend">
        {(Object.keys(SEGMENT_WORDS) as SegmentKind[]).map((kind) => (
          <span key={kind} className="sb-plan-legend__item">
            <span className="sb-plan-seg sb-plan-seg--swatch" data-kind={kind} aria-hidden="true" /> {SEGMENT_WORDS[kind]}
          </span>
        ))}
        <span className="sb-plan-legend__item">
          <span className="sb-plan-legend__now" aria-hidden="true" /> now
        </span>
      </div>
    </div>
  );
}
