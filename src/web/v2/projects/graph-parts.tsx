import { type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, memo, useRef } from 'react';
import type { Plan, PlanItem } from '../../../core/plans.ts';
import { durationShort } from '../../plans/model.ts';
import { Icon, MenuButton, type MenuItem } from '../components/index.ts';
import { GRAPH_WORDS, PROJECT_WORDS } from '../glossary.ts';
import { type GraphTone, type GraphView, MINIMAP, type MinimapFrame, PROJECT_GRAPH, type ProjectGraphEdge, type ProjectGraphLane, type ProjectGraphLayout, minimapViewport } from './graph-layout.ts';
import type { StepLook } from './project-model.ts';

/**
 * The v2 Project graph's renderers (Fixes after 2.0 → *The Project graph, redrawn*): the card, the
 * edges, the lanes, the final node, the ring, the minimap and the tooltip. They only draw what
 * `GraphView.tsx` gives them; the layout is `graph-layout.ts`, the canvas (pan, zoom, pinch) is
 * `GraphView.tsx`. Colours are v2 tokens (`projects.css`, `data-tone` / `--lane`).
 */

/** The lane colours (v2 tokens), by a lane's place among the plan's repositories; the neutral lane is grey. */
const LANE_HUES = ['--v2-violet', '--v2-amber-dot', '--v2-blue', '--v2-green', '--v2-red', '--v2-accent'] as const;

/** The CSS colour of lane hue `hue` (`-1` = the neutral lane). */
export function laneColour(hue: number): string {
  return hue < 0 ? 'var(--v2-muted)' : `var(${LANE_HUES[hue % LANE_HUES.length] ?? '--v2-muted'})`;
}

/** The icon in a step's ring per tone (working shows the spinning ring alone). */
const TONE_ICON: Readonly<Record<GraphTone, string | null>> = {
  working: null,
  ready: 'play',
  waiting: 'clock',
  needs: 'alert',
  approval: 'half',
  failed: 'x',
  done: 'check',
};

/** A progress ring (`value` 0…1) of `size` px; its colour is the surrounding `--c`. */
export function Ring({ value, size = 42, stroke = 4, children, className }: { readonly value: number; readonly size?: number; readonly stroke?: number; readonly children?: ReactNode; readonly className?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className={className ? `v2-p-ring ${className}` : 'v2-p-ring'} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle className="v2-p-ring-trk" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle className="v2-p-ring-val" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))} />
      </svg>
      {children ? <span className="v2-p-ring-ico">{children}</span> : null}
    </span>
  );
}

/** What a card shows (computed once per step by `GraphView.tsx`). */
export interface CardModel {
  readonly item: PlanItem;
  readonly look: StepLook;
  readonly tone: GraphTone;
  readonly name: string;
  readonly title: string;
  readonly chip: { readonly text: string; readonly hue: number } | null;
  readonly meta: string;
  /** The run session's model ("Opus 5.5"), when known. */
  readonly model: string | null;
  /** Ring value 0…1. */
  readonly progress: number;
  /** The estimate bar (working steps with an estimate): time so far against it, 0…1. */
  readonly eta: number | null;
  readonly critical: boolean;
  readonly menu: readonly MenuItem[];
  readonly x: number;
  readonly y: number;
}

/** The node's handlers (shared by every card). */
export interface CardHandlers {
  readonly activate: (item: PlanItem) => void;
  readonly focus: (id: string | null, at?: { readonly x: number; readonly y: number } | HTMLElement) => void;
  readonly move: (event: MouseEvent) => void;
}

/** Opens the step ⋯ menu inside `node` (a right-click, a long press, the context-menu key). */
export function openNodeMenu(node: Element | null): boolean {
  const button = node?.querySelector<HTMLButtonElement>('[data-testid="v2-step-menu"]');
  if (!button) return false;
  button.click();
  return true;
}

/** How long a touch must rest on a card to open its ⋯ menu (ms), and how far it may wander (px). */
export const LONG_PRESS = { ms: 550, slop: 10 } as const;

/**
 * One step's card. `hot`: `true` lit (on the hover path), `false` dimmed, `undefined` no hover;
 * `pop`: it just became done; `enter`: it just appeared.
 */
export const GraphCard = memo(function GraphCard({ model, hot, pop, enter, on }: { readonly model: CardModel; readonly hot: boolean | undefined; readonly pop: boolean; readonly enter: boolean; readonly on: CardHandlers }) {
  const { item, look, tone, chip } = model;
  // A long press (touch or pen) opens the step menu, like a right-click; the click that follows is dropped.
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number; fired: boolean }>({ timer: null, x: 0, y: 0, fired: false });
  const cancelPress = (): void => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  const icon = TONE_ICON[tone];
  const style = { transform: `translate(${model.x}px, ${model.y}px)`, ...(chip ? { '--lane': laneColour(chip.hue) } : {}) } as CSSProperties;
  return (
    <div
      className="v2-p-gnode"
      style={style}
      data-testid="v2-graph-node"
      data-graph-node=""
      data-key={item.key ?? item.id}
      data-id={item.id}
      data-kind={look.kind}
      data-tone={tone}
      data-crit={model.critical || undefined}
      data-hot={hot === undefined ? undefined : String(hot)}
      data-pop={pop || undefined}
      data-enter={enter || undefined}
      data-hold={item.hold || undefined}
      role="button"
      tabIndex={0}
      aria-label={`${model.name} · ${look.label}${item.hold ? ` · ${PROJECT_WORDS.onHold}` : ''}${model.critical ? ` · ${GRAPH_WORDS.onCriticalPath}` : ''}`}
      onClick={() => {
        if (press.current.fired) {
          press.current.fired = false;
          return;
        }
        on.activate(item);
      }}
      onContextMenu={(event) => {
        // D139: a right-click opens the node's step menu (a long press already did: once is enough).
        event.preventDefault();
        if (press.current.fired) return;
        openNodeMenu(event.currentTarget);
      }}
      onPointerDown={(event) => {
        press.current.fired = false;
        if (event.pointerType === 'mouse' || !event.isPrimary) return;
        cancelPress();
        const node = event.currentTarget;
        press.current.x = event.clientX;
        press.current.y = event.clientY;
        press.current.timer = setTimeout(() => {
          press.current.timer = null;
          press.current.fired = true;
          openNodeMenu(node);
        }, LONG_PRESS.ms);
      }}
      onPointerMove={(event) => {
        if (press.current.timer && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > LONG_PRESS.slop) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          on.activate(item);
        } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault();
          openNodeMenu(event.currentTarget);
        }
      }}
      onMouseEnter={(event) => on.focus(item.id, { x: event.clientX, y: event.clientY })}
      onMouseMove={on.move}
      onMouseLeave={() => on.focus(null)}
      onFocus={(event) => {
        if (event.target === event.currentTarget) on.focus(item.id, event.currentTarget);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) on.focus(null);
      }}
    >
      <Ring value={model.progress} className="v2-p-gnode-ring">
        {icon ? <Icon name={icon} size="s" /> : null}
      </Ring>
      <div className="v2-p-gnode-top">
        {item.key ? <span className="v2-p-gnode-key">{item.key}</span> : null}
        {chip ? (
          <span className="v2-p-gnode-chip" data-neutral={chip.hue < 0 || undefined}>
            {chip.text}
          </span>
        ) : null}
        {item.hold ? <Icon name="pause" size="s" className="v2-p-gnode-hold" /> : null}
        {/* The same step menu as the Steps list (D139); its clicks and keys stay its own. */}
        <span className="v2-p-gnode-more" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <MenuButton items={model.menu} label={`Step actions for ${model.name}`} testId="v2-step-menu" />
        </span>
      </div>
      <div className="v2-p-gnode-title">{model.title}</div>
      <div className="v2-p-gnode-meta" data-testid="v2-graph-meta">
        <span className="v2-p-gnode-state">{model.meta}</span>
        {model.model ? (
          <span className="v2-p-gnode-who" data-testid="v2-graph-model">
            <Icon name="sparkle" size="s" />
            {model.model}
          </span>
        ) : null}
      </div>
      {model.eta !== null ? (
        <span className="v2-p-gnode-eta" aria-hidden="true">
          <b style={{ width: `${Math.round(model.eta * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
});

/** The final node: a ring with the project's % done and where the work ends ("All done", "epic → dev · yours"). */
export function GraphFinal({ layout, percent, text, hot }: { readonly layout: ProjectGraphLayout; readonly percent: number; readonly text: string; readonly hot: boolean | undefined }) {
  const { x, y, width, height } = layout.final;
  return (
    <div className="v2-p-gfinal" style={{ transform: `translate(${x}px, ${y}px)`, width, height }} data-testid="v2-graph-final" data-hot={hot === undefined ? undefined : String(hot)} title={text}>
      <Ring value={percent / 100}>
        <span className="v2-p-gfinal-pct">{percent}%</span>
      </Ring>
      <span className="v2-p-gfinal-text">{text}</span>
    </div>
  );
}

/** The lanes: a tinted band per repository with its badge, name and progress. */
export function GraphLanes({ layout, progress }: { readonly layout: ProjectGraphLayout; readonly progress: ReadonlyMap<string, { readonly done: number; readonly total: number }> }) {
  const G = PROJECT_GRAPH;
  return (
    <>
      {layout.lanes.map((lane: ProjectGraphLane) => {
        const count = progress.get(lane.key) ?? { done: 0, total: 0 };
        return (
          <div
            key={lane.key || '(several)'}
            className="v2-p-glane"
            data-testid="v2-graph-lane"
            data-lane={lane.label}
            data-neutral={lane.hue < 0 || undefined}
            style={{ top: lane.top, height: lane.height, left: G.pad / 2, width: layout.width - G.pad, '--lane': laneColour(lane.hue) } as CSSProperties}
          >
            <div className="v2-p-glane-h">
              <span className="v2-p-glane-ic" aria-hidden="true">
                <Icon name={lane.hue < 0 ? 'grid' : 'folder'} size="s" />
              </span>
              <span className="v2-p-glane-name">{lane.label}</span>
              <span className="v2-p-glane-bar" role="img" aria-label={GRAPH_WORDS.laneDone(count.done, count.total)}>
                <b style={{ width: `${count.total === 0 ? 0 : Math.round((count.done / count.total) * 100)}%` }} />
              </span>
              <span className="v2-p-glane-n">
                {count.done}/{count.total}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** How an edge looks: into a working step (live, particles), between done steps, waiting, into the final node. */
export type EdgeKind = 'live' | 'done' | 'wait' | 'final';

/** One edge as drawn. */
export interface EdgeModel {
  readonly edge: ProjectGraphEdge;
  readonly kind: EdgeKind;
  readonly fromKey: string;
  readonly toKey: string;
  /** The gradient's ends (live and done edges): the source's tone, the target's tone. */
  readonly fromTone: GraphTone;
  readonly toTone: GraphTone;
  readonly critical: boolean;
}

/** The token colour of a tone (gradients need a colour, not a class). */
export function toneColour(tone: GraphTone): string {
  switch (tone) {
    case 'working':
      return 'var(--v2-accent)';
    case 'ready':
      return 'color-mix(in srgb, var(--v2-blue) 45%, var(--v2-green))';
    case 'waiting':
      return 'var(--v2-muted)';
    case 'needs':
      return 'var(--v2-amber-dot)';
    case 'approval':
      return 'var(--v2-violet)';
    case 'failed':
      return 'var(--v2-red)';
    case 'done':
      return 'var(--v2-green)';
  }
}

/**
 * The edges: cubic curves with an arrowhead; live and done ones with a gradient along them (in user
 * space, so a straight edge keeps it); three travelling dots on each live edge (SVG
 * `animateMotion`, left out entirely under reduced motion); dashed into the final node.
 */
export const GraphEdges = memo(function GraphEdges({ layout, edges, hot, enter, particles, idPrefix }: { readonly layout: ProjectGraphLayout; readonly edges: readonly EdgeModel[]; readonly hot: ReadonlySet<string> | null; readonly enter: ReadonlySet<string>; readonly particles: boolean; readonly idPrefix: string }) {
  const live = edges.filter((model) => model.kind === 'live');
  return (
    <svg className="v2-p-gedges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
      <defs>
        <marker id={`${idPrefix}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 10 5 0 10z" className="v2-p-garrow" />
        </marker>
        {edges.map((model, index) =>
          model.kind === 'live' || model.kind === 'done' ? (
            <linearGradient key={model.edge.key} id={`${idPrefix}-g${index}`} gradientUnits="userSpaceOnUse" x1={model.edge.start.x} y1={0} x2={model.edge.end.x} y2={0}>
              <stop offset="0" stopColor={toneColour(model.fromTone)} stopOpacity={model.kind === 'done' ? 0.55 : 1} />
              <stop offset="1" stopColor={toneColour(model.toTone)} stopOpacity={model.kind === 'done' ? 0.85 : 1} />
            </linearGradient>
          ) : null,
        )}
      </defs>
      <g fill="none">
        {edges.map((model, index) => (
          <path
            key={model.edge.key}
            id={`${idPrefix}-e${index}`}
            className="v2-p-gedge"
            data-testid={model.kind === 'final' ? 'v2-graph-final-edge' : 'v2-graph-edge'}
            data-from={model.fromKey}
            data-to={model.toKey}
            data-kind={model.kind}
            data-crit={model.critical || undefined}
            data-hot={hot === null ? undefined : String(hot.has(model.edge.key))}
            data-enter={enter.has(model.edge.key) || undefined}
            d={model.edge.path}
            stroke={model.kind === 'live' || model.kind === 'done' ? `url(#${idPrefix}-g${index})` : undefined}
            markerEnd={`url(#${idPrefix}-arrow)`}
          />
        ))}
      </g>
      {particles ? (
        <g className="v2-p-gparticles">
          {live.map((model) => {
            const index = edges.indexOf(model);
            return [0, 1, 2].map((n) => (
              <circle key={`${model.edge.key}-${n}`} r={3.2} opacity={0} className="v2-p-gdot" data-hot={hot === null ? undefined : String(hot.has(model.edge.key))}>
                <animateMotion dur="2.1s" begin={`${n * 0.7}s`} repeatCount="indefinite" rotate="auto">
                  <mpath href={`#${idPrefix}-e${index}`} />
                </animateMotion>
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.1s" begin={`${n * 0.7}s`} repeatCount="indefinite" />
              </circle>
            ));
          })}
        </g>
      ) : null}
    </svg>
  );
});

/** The minimap: the lanes, a rectangle per step in its tone, the frame's view; a click or a drag moves the view there. */
export function GraphMinimap({
  layout,
  tones,
  view,
  frame,
  mini,
  size,
  onPoint,
}: {
  readonly layout: ProjectGraphLayout;
  readonly tones: ReadonlyMap<string, GraphTone>;
  readonly view: GraphView;
  readonly frame: { readonly width: number; readonly height: number };
  readonly mini: MinimapFrame;
  readonly size: { readonly width: number; readonly height: number };
  readonly onPoint: (x: number, y: number) => void;
}) {
  const G = PROJECT_GRAPH;
  const rect = minimapViewport(view, frame, mini);
  const point = (event: { readonly clientX: number; readonly clientY: number; readonly currentTarget: Element }): void => {
    const box = event.currentTarget.getBoundingClientRect();
    onPoint(event.clientX - box.left, event.clientY - box.top);
  };
  return (
    <div
      className="v2-p-gmini"
      data-testid="v2-graph-minimap"
      role="img"
      aria-label={GRAPH_WORDS.minimap}
      title={GRAPH_WORDS.minimap}
      style={{ width: size.width, height: size.height }}
      onPointerDown={(event) => {
        event.stopPropagation();
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // Not an active pointer: a click still moves the view.
        }
        point(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) point(event);
      }}
    >
      <svg width={size.width} height={size.height} aria-hidden="true">
        <g transform={`translate(${mini.ox} ${mini.oy}) scale(${mini.s})`}>
          {layout.lanes.map((lane) => (
            <rect key={lane.key || '(several)'} className="v2-p-gmini-lane" x={G.pad / 2} y={lane.top} width={layout.width - G.pad} height={lane.height} rx={12} style={{ '--lane': laneColour(lane.hue) } as CSSProperties} />
          ))}
          {layout.nodes.map((node) => (
            <rect key={node.id} className="v2-p-gmini-node" data-tone={tones.get(node.id)} x={node.x} y={node.y} width={G.cardWidth} height={G.cardHeight} rx={10} />
          ))}
        </g>
        <rect className="v2-p-gmini-view" data-testid="v2-graph-minimap-view" x={rect.x} y={rect.y} width={Math.max(2, rect.width)} height={Math.max(2, rect.height)} rx={3} />
      </svg>
    </div>
  );
}

/** The hover tooltip (decorative: the card's aria-label says the same). */
export function GraphTooltip({ tip }: { readonly tip: { readonly x: number; readonly y: number; readonly title: string; readonly lines: readonly string[] } | null }) {
  if (!tip) return null;
  return (
    <div className="v2-p-gtip" style={{ left: tip.x, top: tip.y }} data-testid="v2-graph-tip" aria-hidden="true">
      <b>{tip.title}</b>
      <span>{tip.lines.join(' · ')}</span>
    </div>
  );
}

/** The minutes as the graph says them ("12m", "1.5h"). */
export function minutesText(minutes: number): string {
  return durationShort(minutes);
}

/** The plan as the renderers need it (the final node's words). */
export type GraphPlan = Pick<Plan, 'title' | 'items' | 'edges' | 'repos' | 'targetBranch' | 'baseBranch' | 'mergeMode' | 'progress'>;
