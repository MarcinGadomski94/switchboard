import { type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Plan, PlanItem } from '../../../core/plans.ts';
import { axisTicks, shortLabel, timeline, timelineSummary } from '../../plans/model.ts';
import { Button, Chip, Icon, IconButton, MenuButton, type MenuItem, Segmented } from '../components/index.ts';
import { AGENTS_WORDS, GRAPH_WORDS, PROJECT_VIEW_WORDS, PROJECT_WORDS, STATUS } from '../glossary.ts';
import { BOARD_COLUMN_ICON } from '../shared/board-model.ts';
import { clock } from '../shared/time.ts';
import { type GraphTone, graphTone, relatedPath, stepProgress } from './graph-layout.ts';
import { Ring, laneColour, openNodeMenu, toneColour } from './graph-parts.tsx';
import { BOARD_COLUMNS, type BoardColumn, type StepLook, axisPercent, boardColumns, earlyStart, estimateLine, projectCounts, reopenedNotice, stepActions, stepLook, stepName, stepOpens } from './project-model.ts';
import type { StepActions } from './useStepActions.ts';
import { EtaBar, LaneHead, ModelChip, ProjectProgress, RepoChipView, StepRing, useCriticalChoice, useFlip, useFresh, useNow, useReducedMotion, useStepModels } from './views-look.tsx';
import { COLUMN_TONE, type RepoChip, SECTION_TONE, type StepsGrouping, TIMELINE, barSpan, columnOrder, criticalMarks, estimateBar, readStepsGrouping, repoChips, repoLanes, stepMeta, stepSections, timelineArrows, timelineLanes } from './views-model.ts';

/**
 * D131 · lane P · a project's views (Steps, Board, Timeline here; Graph in `GraphView.tsx`): the same steps, their
 * v2 states (icon + word + colour), and the same actions everywhere (a click opens the step's
 * agent, or its details when it stopped or failed (D139); ⓘ its details; ⋯ the step menu; Combine /
 * Send back on a step ready for approval; Restart on a step whose agent failed).
 *
 * Fixes after 2.0 → *Steps, Board and Timeline in the Graph's look*: all three open with the Graph's
 * header (the project ring, the bar by state, Critical path) and draw a step as the Graph does: its
 * ring with the state's icon, key and tinted repository chip, a two-line title, the meta line (time
 * so far, the model, the estimate bar) and the critical-path accent. Motion (rows and cards gliding
 * to their new place, the check popping, the working ring spinning) is off under reduced motion.
 */

/** What every view gets. */
export interface ViewProps {
  readonly plan: Plan;
  readonly actions: StepActions;
  readonly onDetails: (item: PlanItem) => void;
  readonly onSendBack: (item: PlanItem) => void;
}

/** The step's ⋯ menu entries (also the Graph's, `GraphView.tsx`). */
export function stepMenu(plan: Plan, item: PlanItem, actions: StepActions): MenuItem[] {
  return stepActions(plan, item).map((action) => ({ id: action.id, label: action.label, ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}), danger: action.id === 'remove', onSelect: () => void actions.run(item, action.id) }));
}

/** How one step shows in Steps, Board and Timeline (the Graph card's model, without its place). */
interface StepModel {
  readonly item: PlanItem;
  readonly look: StepLook;
  readonly tone: GraphTone;
  readonly name: string;
  /** The title without its key. */
  readonly title: string;
  readonly chip: RepoChip;
  readonly meta: string;
  readonly model: string | null;
  readonly progress: number;
  readonly eta: number | null;
  readonly critical: boolean;
}

/** The steps' models, the header and the Critical path choice (shared by the three views). */
function useStepModelsOf(plan: Plan) {
  const now = useNow();
  const reduced = useReducedMotion();
  const [critical, toggleCritical] = useCriticalChoice();
  const modelOf = useStepModels();
  const tones = useMemo(() => new Map(plan.items.map((item) => [item.id, graphTone(item)])), [plan.items]);
  const marks = useMemo(() => criticalMarks(critical, plan.items, plan.edges, now), [critical, plan.items, plan.edges, now]);
  const chipOf = useMemo(() => repoChips(plan.items, plan.repos), [plan.items, plan.repos]);
  const models = useMemo(() => {
    const out = new Map<string, StepModel>();
    for (const item of plan.items) {
      const look = stepLook(item, plan.items);
      const tone = tones.get(item.id) ?? 'waiting';
      out.set(item.id, {
        item,
        look,
        tone,
        name: stepName(item),
        title: item.title.replace(item.key ?? '\u0000', '').trim() || item.title,
        chip: chipOf(item),
        meta: stepMeta(item, look, tone, now),
        model: modelOf(item, tone),
        progress: stepProgress(item, now),
        eta: estimateBar(item, tone, now),
        critical: marks.ids.has(item.id),
      });
    }
    return out;
  }, [plan.items, tones, chipOf, now, modelOf, marks]);
  const doneIds = useMemo(() => plan.items.filter((item) => item.state === 'done').map((item) => item.id), [plan.items]);
  const pops = useFresh(doneIds);
  const counts = projectCounts(plan);
  const header = <ProjectProgress plan={plan} tones={tones} working={counts.running} needs={counts.needsYou} critical={critical} onCritical={toggleCritical} />;
  return { now, reduced, tones, marks, models, pops, header };
}

/** The buttons a step shows inline (ready for approval: Send back + Combine; stopped by its agent: Restart; needs you: Answer / Decide). */
function InlineButtons({ plan, item, actions, onSendBack, compact = false }: { readonly plan: Plan; readonly item: PlanItem; readonly actions: StepActions; readonly onSendBack: (item: PlanItem) => void; readonly compact?: boolean }) {
  const look = stepLook(item, plan.items);
  if (item.hold && (look.kind === 'waiting' || look.kind === 'ready' || look.kind === 'pick')) {
    return (
      <Chip tone="grey" icon="pause" size="s">
        {PROJECT_WORDS.onHold}
      </Chip>
    );
  }
  if (look.kind === 'approval' || look.kind === 'confirm') {
    return (
      <span className="v2-p-step-btns">
        <Button size="sm" icon="send-back" onClick={() => onSendBack(item)} data-testid="v2-step-sendback">
          {PROJECT_WORDS.sendBack}
        </Button>
        <Button size="sm" variant="primary" icon="merge" onClick={() => void actions.combine(item)} data-testid="v2-step-combine">
          {look.kind === 'confirm' ? PROJECT_WORDS.confirmDone : PROJECT_WORDS.combine}
        </Button>
      </span>
    );
  }
  // D139: a step whose agent failed: Restart (the same agent goes on).
  if (look.kind === 'stopped' && item.stoppedBy !== undefined && (plan.state === 'running' || plan.state === 'paused')) {
    return (
      <Button size="sm" variant="primary" icon="refresh" onClick={() => void actions.run(item, 'restart')} data-testid="v2-step-restart">
        {PROJECT_WORDS.restart}
      </Button>
    );
  }
  if ((look.kind === 'question' || look.kind === 'needs' || look.kind === 'stopped') && item.runSessionId && !compact) {
    return (
      <Button size="sm" icon="hand" onClick={() => actions.openAgent(item)} data-testid="v2-step-answer">
        {look.kind === 'stopped' ? 'Decide' : 'Answer'}
      </Button>
    );
  }
  return null;
}

/** The line under the meta line: the stopped agent's last message, the ask, what an approval needs, why it is blocked. */
function StepDetail({ look, className }: { readonly look: StepLook; readonly className: string }) {
  let text: string | null = null;
  if (look.kind === 'needs' || look.kind === 'question') text = look.detail ? `“${look.detail}”` : null;
  else if (look.kind === 'stopped' || look.kind === 'approval' || look.kind === 'confirm' || look.kind === 'blocked') text = look.detail;
  if (!text) return null;
  return (
    <span className={className} data-testid="v2-step-detail" data-kind={look.kind}>
      {text}
    </span>
  );
}

/** The meta line: the state in its colour (what a waiting step waits on), the model, the estimate words, the D121 notes. */
function StepMetaLine({ model, extra = true }: { readonly model: StepModel; readonly extra?: boolean }) {
  const { item, look, tone } = model;
  const estimate = extra && tone !== 'done' ? estimateLine(item) : null;
  const early = extra ? earlyStart(item) : null;
  const reopened = extra ? reopenedNotice(item) : null;
  return (
    <span className="v2-pv-meta" data-testid="v2-step-meta">
      <span className="v2-pv-state" data-testid="v2-step-state">
        {look.kind === 'waiting' ? <span data-testid="v2-step-detail">{model.meta}</span> : model.meta}
      </span>
      <ModelChip model={model.model} />
      {estimate ? (
        <span className="v2-pv-est" data-testid="v2-step-estimate">
          {estimate}
        </span>
      ) : null}
      {early ? (
        <span className="v2-p-step-warn" title={early} data-testid="v2-step-early">
          <Icon name="alert" size="s" />
          {PROJECT_WORDS.earlyStart}: {early}
        </span>
      ) : null}
      {reopened ? (
        <span className="v2-p-step-note" data-testid="v2-step-reopened">
          <Icon name="refresh" size="s" />
          {reopened}
        </span>
      ) : null}
    </span>
  );
}

/** The aria-label of a step (its name, state, hold, the critical path, what a click does). */
function stepLabel(model: StepModel): string {
  const { item, look } = model;
  return `${model.name} · ${look.label}${item.hold ? ` · ${PROJECT_WORDS.onHold}` : ''}${model.critical ? ` · ${GRAPH_WORDS.onCriticalPath}` : ''}${'agent' in stepOpens(item) ? ' · open its agent' : ''}`;
}

/** The step's key, chip and critical-path mark (a row's and a card's first line). */
function StepTop({ model, children }: { readonly model: StepModel; readonly children?: ReactNode }) {
  return (
    <span className="v2-pv-top">
      {model.item.key ? <span className="v2-pv-key">{model.item.key}</span> : null}
      <RepoChipView chip={model.chip} />
      {model.critical ? (
        <span className="v2-pv-crit" title={GRAPH_WORDS.onCriticalPath} data-testid="v2-step-critical">
          <Icon name="diagram" size="s" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** One row of the Steps view. */
export function StepRow({ plan, actions, onDetails, onSendBack, model, pop }: ViewProps & { readonly model: StepModel; readonly pop: boolean }) {
  const { item, look, tone } = model;
  return (
    <div
      className="v2-pv-row"
      data-testid="v2-step"
      data-key={item.key ?? item.id}
      data-kind={look.kind}
      data-tone={STATUS[look.status].tone}
      data-gtone={tone}
      data-crit={model.critical || undefined}
      data-pop={pop || undefined}
      data-hold={item.hold || undefined}
      data-flip={item.id}
      style={model.chip ? ({ '--lane': laneColour(model.chip.hue) } as CSSProperties) : undefined}
    >
      <StepRing tone={tone} value={model.progress} className="v2-pv-row-ring" />
      <button type="button" className="v2-pv-row-main" onClick={() => (actions.open(item) ? undefined : onDetails(item))} aria-label={stepLabel(model)} data-testid="v2-step-open">
        <StepTop model={model} />
        <b className="v2-pv-title v2-p-step-title">{model.title}</b>
        <StepMetaLine model={model} />
        <StepDetail look={look} className="v2-pv-detail" />
        <EtaBar value={model.eta} className="v2-pv-row-eta" />
      </button>
      <span className="v2-pv-row-btns">
        {item.hold && !(look.kind === 'waiting' || look.kind === 'ready' || look.kind === 'pick') ? (
          <Chip tone="grey" icon="pause" size="s">
            {PROJECT_WORDS.onHold}
          </Chip>
        ) : null}
        <InlineButtons plan={plan} item={item} actions={actions} onSendBack={onSendBack} />
      </span>
      <span className="v2-pv-row-tools">
        <IconButton icon="eye" label={`Details of ${model.name}`} onClick={() => onDetails(item)} data-testid="v2-step-details" />
        <MenuButton items={stepMenu(plan, item, actions)} label={`Step actions for ${model.name}`} testId="v2-step-menu" />
      </span>
    </div>
  );
}

const GROUP_KEY = 'switchboard.v2.projectSteps.group';

function storedGrouping(): StepsGrouping {
  try {
    return readStepsGrouping(window.localStorage.getItem(GROUP_KEY));
  } catch {
    return 'state';
  }
}

/**
 * Steps: the Graph's header, then the steps by state (Needs you · Working · Ready to start ·
 * Waiting · Done, folded while others are open) or by repository lane (the Graph's lanes, tinted).
 * A step that changes section glides there; a step that becomes done pops its check.
 */
export function StepsView(props: ViewProps) {
  const { plan } = props;
  const { reduced, models, pops, header, tones } = useStepModelsOf(plan);
  const [grouping, setGroupingState] = useState<StepsGrouping>(storedGrouping);
  const listRef = useRef<HTMLDivElement | null>(null);
  const setGrouping = (next: StepsGrouping): void => {
    setGroupingState(next);
    try {
      window.localStorage.setItem(GROUP_KEY, next);
    } catch {
      // No storage: the choice lasts for this page.
    }
  };
  const sections = useMemo(() => stepSections(plan.items, (item) => tones.get(item.id) ?? 'waiting'), [plan.items, tones]);
  const lanes = useMemo(() => repoLanes(plan.items, plan.repos), [plan.items, plan.repos]);
  const flipKey = `${grouping}|${grouping === 'state' ? sections.map((group) => `${group.section}:${group.items.map((item) => item.id).join(',')}`).join(';') : lanes.map((lane) => lane.items.map((item) => item.id).join(',')).join(';')}`;
  useFlip(listRef, flipKey);

  if (plan.items.length === 0) {
    return (
      <div className="v2-card v2-p-steps-empty" data-testid="v2-steps-empty">
        No steps yet. Add tasks of the project’s agent as steps, or import them from Jira.
      </div>
    );
  }
  const row = (item: PlanItem): ReactNode => {
    const model = models.get(item.id);
    return model ? <StepRow key={item.id} {...props} model={model} pop={pops.has(item.id)} /> : null;
  };
  const open = sections.filter((group) => group.section !== 'done');
  const done = sections.find((group) => group.section === 'done');
  return (
    <div className="v2-card v2-pv v2-pv-steps" data-testid="v2-steps" data-group={grouping} data-motion={reduced ? 'reduced' : undefined}>
      {header}
      <div className="v2-pv-toolbar">
        <Segmented<StepsGrouping>
          label={PROJECT_VIEW_WORDS.groupBy}
          size="s"
          value={grouping}
          onChange={setGrouping}
          testId="v2-steps-group"
          options={[
            { value: 'state', label: PROJECT_VIEW_WORDS.byState, icon: 'list' },
            { value: 'repo', label: PROJECT_VIEW_WORDS.byRepo, icon: 'folder' },
          ]}
        />
      </div>
      <div className="v2-pv-list" ref={listRef}>
        {grouping === 'state' ? (
          <>
            {(open.length > 0 ? open : sections).map((group) => (
              <section key={group.section} className="v2-pv-sec" data-section={group.section} data-testid="v2-steps-section" aria-label={PROJECT_VIEW_WORDS.sections[group.section]}>
                <h3 className="v2-pv-sec-h" data-tone={SECTION_TONE[group.section]}>
                  <span className="v2-pv-sec-dot" aria-hidden="true" />
                  {PROJECT_VIEW_WORDS.sections[group.section]}
                  <span className="v2-pv-sec-n">{group.items.length}</span>
                </h3>
                {group.items.map(row)}
              </section>
            ))}
            {open.length > 0 && done ? (
              <details className="v2-pv-sec v2-p-steps-done" data-section="done" data-testid="v2-steps-done">
                <summary className="v2-pv-sec-h" data-tone="done">
                  <Icon name="chev" size="s" />
                  {PROJECT_WORDS.earlierDone(done.items.length)}
                </summary>
                {done.items.map(row)}
              </details>
            ) : null}
          </>
        ) : (
          lanes.map((lane) => (
            <section key={lane.key || '(several)'} className="v2-pv-lane" data-testid="v2-steps-lane" data-lane={lane.label} data-neutral={lane.hue < 0 || undefined} style={{ '--lane': laneColour(lane.hue) } as CSSProperties} aria-label={lane.label}>
              <LaneHead label={lane.label} hue={lane.hue} done={lane.done} total={lane.items.length} />
              {lane.items.map(row)}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

// ── Board ────────────────────────────────────────────────────────────────

/** One board card in the Graph card's look, with the step's inline buttons. */
function BoardStepCard({ plan, actions, onDetails, onSendBack, model, column, pop }: ViewProps & { readonly model: StepModel; readonly column: BoardColumn; readonly pop: boolean }) {
  const { item, look, tone } = model;
  const activate = (): void => {
    if (!actions.open(item)) onDetails(item);
  };
  const click = (event: MouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    activate();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      openNodeMenu(event.currentTarget);
    }
  };
  const buttons = InlineButtons({ plan, item, actions, onSendBack });
  return (
    <div
      className="v2-pv-card"
      role="button"
      tabIndex={0}
      aria-label={stepLabel(model)}
      data-testid="v2-board-card"
      data-key={item.key ?? item.id}
      data-kind={look.kind}
      data-gtone={tone}
      data-col={column}
      data-crit={model.critical || undefined}
      data-pop={pop || undefined}
      data-hold={item.hold || undefined}
      data-flip={item.id}
      style={model.chip ? ({ '--lane': laneColour(model.chip.hue) } as CSSProperties) : undefined}
      onClick={click}
      onKeyDown={keyDown}
      onContextMenu={(event) => {
        // D139: a right-click opens the step menu, as on the Graph.
        if ((event.target as HTMLElement).closest('button, a')) return;
        event.preventDefault();
        openNodeMenu(event.currentTarget);
      }}
    >
      <StepRing tone={tone} value={model.progress} size={38} className="v2-pv-card-ring" />
      <StepTop model={model}>
        {item.hold ? <Icon name="pause" size="s" className="v2-pv-hold" /> : null}
        <span className="v2-pv-more">
          <MenuButton items={stepMenu(plan, item, actions)} label={`Step actions for ${model.name}`} testId="v2-step-menu" />
        </span>
      </StepTop>
      <b className="v2-pv-title">{model.title}</b>
      <StepMetaLine model={model} extra={false} />
      <StepDetail look={look} className="v2-pv-detail v2-pv-card-detail" />
      {buttons ? <span className="v2-pv-card-btns">{buttons}</span> : null}
      <EtaBar value={model.eta} className="v2-pv-card-eta" />
    </div>
  );
}

/**
 * Board: the Graph's header, then the shared board's four columns (Needs you · Working · Ready for
 * approval · Done; `boardColumns`), each headed by a mini ring of its share, its icon, name and
 * count. Cards are the Graph's (ring, chips, meta, estimate bar, the working border breathing, a
 * needs-you nudge) with the lane's tint on their left edge; a card whose step changes column
 * glides there. A click opens the step's agent (or its details, D139); ⋯ or a right-click its menu.
 */
export function BoardView(props: ViewProps) {
  const { plan } = props;
  const { reduced, models, pops, header, tones } = useStepModelsOf(plan);
  const columns = boardColumns(plan.items);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toneOf = (item: PlanItem): GraphTone => tones.get(item.id) ?? 'waiting';
  const ordered = BOARD_COLUMNS.map((column) => ({ column, items: columnOrder(columns[column], toneOf) }));
  useFlip(rootRef, ordered.map((entry) => `${entry.column}:${entry.items.map((item) => item.id).join(',')}`).join('|'));
  const total = plan.items.length;
  return (
    <div className="v2-card v2-pv v2-pv-board" data-testid="v2-project-board" data-motion={reduced ? 'reduced' : undefined}>
      {header}
      <div className="v2-pv-cols" ref={rootRef}>
        {ordered.map(({ column, items }) => (
          <section key={column} className="v2-pv-col" data-col={column} data-testid="v2-board-col" aria-label={AGENTS_WORDS.columns[column]}>
            <header className="v2-pv-col-h" data-tone={COLUMN_TONE[column]}>
              <Ring value={total === 0 ? 0 : items.length / total} size={28} stroke={3} className="v2-pv-col-ring">
                <Icon name={BOARD_COLUMN_ICON[column]} size="s" />
              </Ring>
              <span className="v2-pv-col-name">{AGENTS_WORDS.columns[column]}</span>
              <span className="v2-pv-col-n" data-testid="v2-board-count" title={PROJECT_VIEW_WORDS.columnOf(items.length, total)}>
                {items.length}
              </span>
            </header>
            <div className="v2-pv-col-body">
              {items.length > 0 ? (
                items.map((item) => {
                  const model = models.get(item.id);
                  return model ? <BoardStepCard key={item.id} {...props} model={model} column={column} pop={pops.has(item.id)} /> : null;
                })
              ) : (
                <div className="v2-pv-col-empty" data-testid="v2-board-empty">
                  <Icon name={BOARD_COLUMN_ICON[column]} size="s" />
                  {PROJECT_VIEW_WORDS.emptyColumn[column]}
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────

const SEGMENT_TITLE: Readonly<Record<string, string>> = {
  working: 'Agent working',
  you: 'Waiting on you',
  dependency: 'Waiting on an earlier step',
  usage: 'Paused for usage',
  paused: 'Project on hold',
  projected: 'Projected',
};

/** The arrow's look: into a working step (live), between done steps, else waiting (the Graph's edge kinds). */
function arrowKind(from: GraphTone, to: GraphTone): 'live' | 'done' | 'wait' {
  return to === 'working' ? 'live' : from === 'done' && to === 'done' ? 'done' : 'wait';
}

/**
 * Timeline: the Graph's header, then one row per step in the Graph's repository lanes (tinted, with
 * the lane's icon and progress). A step's bar takes its state's colour with its ring at the start;
 * the lighter part is projected, a working bar shows its time so far against its estimate. The
 * dependency arrows are the Graph's edges (a gradient into a working step), the critical path
 * glows, and hovering or focusing a step lights up what it waits on and what waits on it.
 */
export function TimelineView({ plan, actions, onDetails }: ViewProps) {
  const { now, reduced, models, header, tones, marks } = useStepModelsOf(plan);
  const view = useMemo(() => timeline(plan, now), [plan, now]);
  const ticks = axisTicks(view);
  const pct = (time: number): string => `${axisPercent(time, view.start, view.end).toFixed(2)}%`;
  const { lanes, rowY, height } = useMemo(() => timelineLanes(view, plan.items, plan.repos), [view, plan.items, plan.repos]);
  const spans = useMemo(() => {
    const out = new Map<string, { from: number; to: number; waitFrom: number | null }>();
    for (const lane of lanes) {
      for (const row of lane.rows) {
        const span = barSpan(row.segments);
        if (span) out.set(row.itemId, span);
      }
    }
    return out;
  }, [lanes]);
  const overRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = overRef.current;
    if (!el) return;
    const read = (): void => setWidth(el.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const arrows = useMemo(() => (width > 0 ? timelineArrows(plan.edges, spans, rowY, view, width) : []), [plan.edges, spans, rowY, view, width]);
  const [focus, setFocus] = useState<string | null>(null);
  const hot = useMemo(() => (focus ? relatedPath(focus, plan.edges) : null), [focus, plan.edges]);
  const idPrefix = `v2t${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const activate = (item: PlanItem): void => {
    if (!actions.open(item)) onDetails(item);
  };
  const hotOf = (id: string): string | undefined => (hot === null ? undefined : String(hot.nodes.has(id)));

  return (
    <div className="v2-card v2-pv v2-pv-tl" data-testid="v2-project-timeline" data-motion={reduced ? 'reduced' : undefined} data-dim={hot !== null || undefined}>
      {header}
      <div className="v2-pv-tl-grid" role="group" aria-label={PROJECT_VIEW_WORDS.timelineOf(plan.title)}>
        <div className="v2-pv-tl-axis" aria-hidden="true">
          <span className="v2-pv-tl-axis-pad" />
          <span className="v2-pv-tl-axis-track">
            {ticks
              .filter((tick) => Math.abs(axisPercent(tick, view.start, view.end) - axisPercent(view.now, view.start, view.end)) > 6)
              .map((tick) => (
                <span key={tick} style={{ left: pct(tick) }}>
                  {clock(new Date(tick).toISOString())}
                </span>
              ))}
            <b className="v2-pv-tl-now-tag" style={{ left: pct(view.now) }}>
              {PROJECT_VIEW_WORDS.now}
            </b>
          </span>
        </div>
        <div className="v2-pv-tl-body" style={{ height }}>
          {lanes.map((lane) => (
            <section
              key={lane.key || '(several)'}
              className="v2-pv-tl-lane"
              role="group"
              aria-label={lane.label}
              data-testid="v2-timeline-lane"
              data-neutral={lane.hue < 0 || undefined}
              style={{ top: lane.top, height: TIMELINE.laneHead + lane.rows.length * TIMELINE.row, '--lane': laneColour(lane.hue) } as CSSProperties}
            >
              <LaneHead label={lane.label} hue={lane.hue} done={lane.done} total={lane.rows.length} />
              {lane.rows.map((row) => {
                const model = models.get(row.itemId);
                if (!model) return null;
                const { item, look, tone } = model;
                const span = spans.get(row.itemId);
                const range = span ? Math.max(1, span.to - span.from) : 1;
                return (
                  <div
                    key={row.itemId}
                    className="v2-pv-tl-row"
                    data-testid="v2-timeline-row"
                    data-key={item.key ?? item.id}
                    data-gtone={tone}
                    data-crit={model.critical || undefined}
                    data-hot={hotOf(item.id)}
                    onMouseEnter={() => setFocus(item.id)}
                    onMouseLeave={() => setFocus(null)}
                    onFocus={() => setFocus(item.id)}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(null);
                    }}
                  >
                    <div className="v2-pv-tl-name">
                      <button type="button" className="v2-pv-tl-n" onClick={() => activate(item)} aria-label={stepLabel(model)} title={`${model.name} · ${model.meta}`}>
                        <StepRing tone={tone} value={model.progress} size={22} stroke={2.5} />
                        {item.key ? <span className="v2-pv-key">{shortLabel(item, plan.items)}</span> : null}
                        <span className="v2-pv-tl-title">{model.title}</span>
                      </button>
                      {/* D139: the same step menu as the Steps list. */}
                      <MenuButton items={stepMenu(plan, item, actions)} label={`Step actions for ${model.name}`} testId="v2-step-menu" />
                    </div>
                    <div className="v2-pv-tl-track">
                      {span && span.waitFrom !== null ? <span className="v2-pv-tl-wait" style={{ left: pct(span.waitFrom), width: `calc(${pct(span.from)} - ${pct(span.waitFrom)})` }} title={SEGMENT_TITLE['dependency']} /> : null}
                      {span ? (
                        <span className="v2-pv-tl-bar" data-testid="v2-timeline-bar" style={{ left: pct(span.from), width: `max(8px, calc(${pct(span.to)} - ${pct(span.from)}))` }} title={`${model.name} · ${model.meta}`}>
                          {row.segments
                            .filter((segment) => segment.kind !== 'dependency' && segment.to > span.from)
                            .map((segment, index) => {
                              const from = Math.max(segment.from, span.from);
                              const style: CSSProperties = { left: `${(((from - span.from) / range) * 100).toFixed(2)}%`, width: `${(((segment.to - from) / range) * 100).toFixed(2)}%` };
                              return <span key={index} className="v2-pv-tl-seg" data-seg={segment.kind} style={style} title={`${SEGMENT_TITLE[segment.kind] ?? segment.kind}${segment.note ? ` · ${segment.note}` : ''}`} />;
                            })}
                          {tone === 'working' && !reduced ? <span className="v2-pv-tl-shine" aria-hidden="true" /> : null}
                        </span>
                      ) : null}
                      {span ? (
                        <span className="v2-pv-tl-mark" style={{ left: pct(span.from) }} aria-hidden="true">
                          <StepRing tone={tone} value={model.progress} size={20} stroke={2.5} />
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
          <div className="v2-pv-tl-over" ref={overRef}>
            <svg className="v2-pv-tl-arrows" width={width} height={height} viewBox={`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`} aria-hidden="true">
              <defs>
                <marker id={`${idPrefix}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0 0 10 5 0 10z" className="v2-pv-tl-arrowhead" />
                </marker>
                {arrows.map((arrow, index) => {
                  const kind = arrowKind(tones.get(arrow.from) ?? 'waiting', tones.get(arrow.to) ?? 'waiting');
                  return kind === 'wait' ? null : (
                    <linearGradient key={arrow.key} id={`${idPrefix}-g${index}`} gradientUnits="userSpaceOnUse" x1={Math.min(arrow.x1, arrow.x2)} y1={0} x2={Math.max(arrow.x1, arrow.x2) + 1} y2={0}>
                      <stop offset="0" stopColor={toneColour(tones.get(arrow.from) ?? 'waiting')} stopOpacity={kind === 'done' ? 0.55 : 1} />
                      <stop offset="1" stopColor={toneColour(tones.get(arrow.to) ?? 'waiting')} stopOpacity={kind === 'done' ? 0.85 : 1} />
                    </linearGradient>
                  );
                })}
              </defs>
              <g fill="none">
                {arrows.map((arrow, index) => {
                  const kind = arrowKind(tones.get(arrow.from) ?? 'waiting', tones.get(arrow.to) ?? 'waiting');
                  return (
                    <path
                      key={arrow.key}
                      className="v2-pv-tl-arrow"
                      data-testid="v2-timeline-arrow"
                      data-from={models.get(arrow.from)?.item.key ?? arrow.from}
                      data-to={models.get(arrow.to)?.item.key ?? arrow.to}
                      data-kind={kind}
                      data-crit={marks.edges.has(arrow.key) || undefined}
                      data-hot={hot === null ? undefined : String(hot.edges.has(arrow.key))}
                      d={arrow.path}
                      stroke={kind === 'wait' ? undefined : `url(#${idPrefix}-g${index})`}
                      markerEnd={`url(#${idPrefix}-arrow)`}
                    />
                  );
                })}
              </g>
            </svg>
            <span className="v2-pv-tl-now" style={{ left: pct(view.now) }} aria-hidden="true" />
          </div>
        </div>
      </div>
      <div className="v2-pv-tl-legend" aria-label="Legend">
        {(['working', 'you', 'paused', 'projected', 'dependency'] as const).map((kind) => (
          <span key={kind}>
            <i className="v2-pv-tl-key" data-seg={kind} />
            {PROJECT_VIEW_WORDS.legend[kind]}
          </span>
        ))}
      </div>
      <p className="v2-muted v2-pv-tl-sum" data-testid="v2-timeline-summary">
        {timelineSummary(view, plan)}. Red line = now ({clock(new Date(view.now).toISOString())}).
      </p>
      <p className="v2-muted v2-pv-legend-note">{PROJECT_VIEW_WORDS.timelineLegend}</p>
    </div>
  );
}
