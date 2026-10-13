import { useEffect, useRef, useState } from 'react';
import type { Plan, PlanItem } from '../../core/plans.ts';
import { GRAPH, STATE_LOOK, criticalEdgeKeys, edgePath, finalNodeText, graphLayout, repoLine, statusLine } from './model.ts';

/**
 * D99 · the plan's Graph view (`docs/plans-ui.md` → *Graph*): a left-to-right DAG, layers by the
 * longest path (`graphLayout`), ~190 px cards with a coloured left border by state (icon, key,
 * title, status line, mono "repo · ~estimate"), SVG curves with arrowheads, the critical path
 * in amber (2 px edges, dashed card outlines) when shown, a final dashed ◇ node
 * "epic → dev · yours", and the legend under it. A click selects a card; in the dependency
 * editor a click picks it and a click on an edge removes it.
 */
export function PlanGraph({
  plan,
  selectedId,
  critical,
  editing,
  editFirst,
  onCard,
  onEdge,
}: {
  readonly plan: Plan;
  readonly selectedId: string | null;
  readonly critical: boolean;
  readonly editing: boolean;
  readonly editFirst: string | null;
  readonly onCard: (item: PlanItem) => void;
  readonly onEdge: (from: string, to: string) => void;
}) {
  const layout = graphLayout(plan.items, plan.edges);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState<{ readonly left: boolean; readonly right: boolean }>({ left: false, right: false });
  // A DAG wider than the panel scrolls sideways; a soft fade marks the side that has more.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const measure = (): void => {
      const left = element.scrollLeft > 1;
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setFade((current) => (current.left === left && current.right === right ? current : { left, right }));
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [layout.width, plan.items.length]);
  const at = new Map(layout.nodes.map((node) => [node.id, node]));
  const criticalKeys = critical ? criticalEdgeKeys(plan) : new Set<string>();
  const onPath = new Set(critical ? plan.criticalPath.itemIds : []);
  if (plan.items.length === 0) {
    return (
      <div className="sb-plan-graph-empty" data-testid="plan-graph-empty">
        No items yet. {plan.state === 'draft' ? 'Add items from todos with ✎ Edit dependencies → ＋ Add items.' : ''}
      </div>
    );
  }
  return (
    <div className="sb-plan-graph-frame" data-fade-left={fade.left || undefined} data-fade-right={fade.right || undefined}>
      <div className="sb-plan-graph-scroll" data-testid="plan-graph" ref={scroller}>
        <div className="sb-plan-graph" style={{ width: layout.width, height: layout.height }} data-editing={editing || undefined}>
          <svg className="sb-plan-graph__edges" width={layout.width} height={layout.height} aria-hidden={editing ? undefined : true}>
            <defs>
              <marker id="sb-plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--border-control)" />
              </marker>
              <marker id="sb-plan-arrow-critical" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--status-need)" />
              </marker>
            </defs>
            {plan.edges.map((edge) => {
              const from = at.get(edge.from);
              const to = at.get(edge.to);
              if (!from || !to) return null;
              const d = edgePath(from, to);
              const isCritical = criticalKeys.has(`${edge.from}>${edge.to}`);
              return (
                <g key={`${edge.from}>${edge.to}`} data-testid="plan-edge" data-from={edge.from} data-to={edge.to} data-critical={isCritical || undefined}>
                  <path d={d} className="sb-plan-edge" data-critical={isCritical || undefined} markerEnd={`url(#${isCritical ? 'sb-plan-arrow-critical' : 'sb-plan-arrow'})`} />
                  {editing ? (
                    <path
                      d={d}
                      className="sb-plan-edge-hit"
                      data-testid="plan-edge-hit"
                      data-from={edge.from}
                      data-to={edge.to}
                      role="button"
                      aria-label="Remove this dependency"
                      onClick={() => onEdge(edge.from, edge.to)}
                    >
                      <title>Remove this dependency</title>
                    </path>
                  ) : null}
                </g>
              );
            })}
            {layout.sinks.map((id) => {
              const from = at.get(id);
              if (!from) return null;
              return <path key={`final:${id}`} d={edgePath(from, layout.final)} className="sb-plan-edge sb-plan-edge--final" markerEnd="url(#sb-plan-arrow)" />;
            })}
          </svg>
          {plan.items.map((item) => {
            const node = at.get(item.id);
            if (!node) return null;
            const look = STATE_LOOK[item.state];
            return (
              <button
                type="button"
                key={item.id}
                className="sb-button sb-plan-card"
                data-testid="plan-card"
                data-item-id={item.id}
                data-state={item.state}
                data-key={item.key ?? undefined}
                data-critical={onPath.has(item.id) || undefined}
                data-picked={editFirst === item.id || undefined}
                aria-pressed={selectedId === item.id}
                style={{ left: node.x, top: node.y, width: GRAPH.cardWidth, height: GRAPH.cardHeight, borderLeftColor: look.color }}
                title={item.title}
                onClick={() => onCard(item)}
              >
                <span className="sb-plan-card__head">
                  <span className="sb-plan-card__icon" style={{ color: look.color }} aria-hidden="true">
                    {look.icon}
                  </span>
                  {item.key ? <span className="sb-plan-card__key">{item.key}</span> : null}
                  {item.hold ? (
                    <span className="sb-plan-card__hold" data-testid="plan-card-hold" title="You merge this one">
                      ⚑ you
                    </span>
                  ) : null}
                </span>
                <span className="sb-plan-card__title">{item.title}</span>
                <span className="sb-plan-card__status" data-testid="plan-card-status" style={{ color: item.state === 'waiting' || item.state === 'ready' ? undefined : look.color }}>
                  {statusLine(item, plan.items)}
                </span>
                <span className="sb-plan-card__meta">{repoLine(item, plan)}</span>
              </button>
            );
          })}
          <div className="sb-plan-final" data-testid="plan-final" style={{ left: layout.final.x, top: layout.final.y, width: GRAPH.cardWidth, height: GRAPH.cardHeight }}>
            <span aria-hidden="true">◇</span> {finalNodeText(plan)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The legend under the graph: every state's icon and word, and the critical path's mark. */
export function GraphLegend({ critical }: { readonly critical: boolean }) {
  return (
    <div className="sb-plan-legend" data-testid="plan-legend">
      {(Object.keys(STATE_LOOK) as (keyof typeof STATE_LOOK)[]).map((state) => (
        <span key={state} className="sb-plan-legend__item">
          <span style={{ color: STATE_LOOK[state].color }} aria-hidden="true">
            {STATE_LOOK[state].icon}
          </span>{' '}
          {STATE_LOOK[state].word}
        </span>
      ))}
      <span className="sb-plan-legend__item">
        <span className="sb-plan-legend__hold">⚑ you</span> you merge it
      </span>
      {critical ? (
        <span className="sb-plan-legend__item">
          <span className="sb-plan-legend__critical" aria-hidden="true" /> critical path
        </span>
      ) : null}
    </div>
  );
}
