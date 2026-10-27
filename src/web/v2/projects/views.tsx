import { type CSSProperties, useMemo, useState } from 'react';
import type { Plan, PlanItem } from '../../../core/plans.ts';
import { axisTicks, shortLabel, timeline, timelineSummary } from '../../plans/model.ts';
import { Button, Chip, Icon, IconButton, MenuButton, type MenuItem, StatusBadge } from '../components/index.ts';
import { AGENTS_WORDS, PROJECT_WORDS, STATUS, type V2Status } from '../glossary.ts';
import { Board, BoardActivity, BoardButtons, BoardCard, BoardLane, BoardProgress, BoardQuote } from '../shared/Board.tsx';
import { boardFlipKey } from '../shared/board-model.ts';
import { clock } from '../shared/time.ts';
import { BOARD_COLUMNS, axisPercent, boardColumns, earlyStart, estimateLine, reopenedNotice, stepActions, stepLook, stepName } from './project-model.ts';
import type { StepActions } from './useStepActions.ts';

/**
 * D131 · lane P · a project's views (Steps, Board, Timeline here; Graph in `GraphView.tsx`): the same steps, their
 * v2 states (icon + word + colour), and the same actions everywhere (a click opens the step's
 * agent; ⓘ its details; ⋯ the step menu; Combine / Send back on a step ready for approval).
 */

/** What every view gets. */
export interface ViewProps {
  readonly plan: Plan;
  readonly actions: StepActions;
  readonly onDetails: (item: PlanItem) => void;
  readonly onSendBack: (item: PlanItem) => void;
}

/** The mark of a status (the live dot for working). */
function Mark({ status }: { readonly status: V2Status }) {
  const look = STATUS[status];
  return look.icon === 'pulse' ? <span className="v2-pulse" aria-hidden="true" /> : <Icon name={look.icon} size="s" />;
}

/** The step's ⋯ menu entries (also the Graph's, `GraphView.tsx`). */
export function stepMenu(plan: Plan, item: PlanItem, actions: StepActions): MenuItem[] {
  return stepActions(plan, item).map((action) => ({ id: action.id, label: action.label, ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}), danger: action.id === 'remove', onSelect: () => void actions.run(item, action.id) }));
}

/** The buttons a step shows inline (ready for approval: Send back + Combine; needs you: Answer / Decide). */
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

/** The line under a step's title: the stopped message, the ask, what it waits on. */
function StepSub({ plan, item, todoText }: { readonly plan: Plan; readonly item: PlanItem; readonly todoText?: string | null }) {
  const look = stepLook(item, plan.items);
  if (look.kind === 'stopped') {
    return (
      <span className="v2-p-step-sub" data-testid="v2-step-detail">
        <b className="v2-p-step-stopped">{look.label}.</b> {look.detail}
      </span>
    );
  }
  if (look.kind === 'needs') {
    return (
      <span className="v2-p-step-sub" data-testid="v2-step-detail">
        {look.detail ? `“${look.detail}”` : look.label}
      </span>
    );
  }
  if (look.kind === 'pick') {
    return (
      <span className="v2-p-step-sub" data-testid="v2-step-detail">
        {look.label}
      </span>
    );
  }
  const text = look.detail ?? (look.kind === 'running' ? (todoText ?? null) : null);
  return text ? (
    <span className="v2-p-step-sub" data-testid="v2-step-detail">
      {text}
    </span>
  ) : null;
}

/** One row of the Steps view. */
export function StepRow({ plan, item, actions, onDetails, onSendBack }: ViewProps & { readonly item: PlanItem }) {
  const look = stepLook(item, plan.items);
  const tone = STATUS[look.status].tone;
  const estimate = estimateLine(item);
  const early = earlyStart(item);
  const reopened = reopenedNotice(item);
  const name = stepName(item);
  return (
    <div className="v2-p-steprow" data-testid="v2-step" data-key={item.key ?? item.id} data-kind={look.kind} data-tone={tone} data-hold={item.hold || undefined}>
      <span className="v2-p-sicon" data-tone={tone} aria-hidden="true">
        <Mark status={look.status} />
      </span>
      <button type="button" className="v2-p-step-main" onClick={() => (actions.open(item) ? undefined : onDetails(item))} aria-label={`${name} · ${look.label}${item.runSessionId ? ' · open its agent' : ''}`} data-testid="v2-step-open">
        <b className="v2-p-step-title">{name}</b>
        <StepSub plan={plan} item={item} />
        <span className="v2-p-step-meta">
          {estimate ? <span data-testid="v2-step-estimate">{estimate}</span> : null}
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
      </button>
      {item.hold && !(look.kind === 'waiting' || look.kind === 'ready' || look.kind === 'pick') ? (
        <Chip tone="grey" icon="pause" size="s">
          {PROJECT_WORDS.onHold}
        </Chip>
      ) : null}
      <StatusBadge status={look.status} label={look.label} size="s" />
      <InlineButtons plan={plan} item={item} actions={actions} onSendBack={onSendBack} />
      <IconButton icon="eye" label={`Details of ${name}`} onClick={() => onDetails(item)} data-testid="v2-step-details" />
      <MenuButton items={stepMenu(plan, item, actions)} label={`Step actions for ${name}`} testId="v2-step-menu" />
    </div>
  );
}

/** Steps: the list, done steps folded under "N steps done" while others are open. */
export function StepsView(props: ViewProps) {
  const { plan } = props;
  const items = useMemo(() => [...plan.items].sort((a, b) => a.position - b.position), [plan.items]);
  const open = items.filter((item) => item.state !== 'done');
  const done = items.filter((item) => item.state === 'done');
  const fold = open.length > 0 && done.length > 0;
  if (items.length === 0) {
    return (
      <div className="v2-card v2-p-steps-empty" data-testid="v2-steps-empty">
        No steps yet. Add tasks of the project’s agent as steps, or import them from Jira.
      </div>
    );
  }
  return (
    <div className="v2-card v2-p-steps" data-testid="v2-steps">
      {(fold ? open : items).map((item) => (
        <StepRow key={item.id} {...props} item={item} />
      ))}
      {fold ? (
        <details className="v2-p-steps-done" data-testid="v2-steps-done">
          <summary>
            <Icon name="chev" size="s" />
            {PROJECT_WORDS.earlierDone(done.length)}
          </summary>
          {done.map((item) => (
            <StepRow key={item.id} {...props} item={item} />
          ))}
        </details>
      ) : null}
    </div>
  );
}

/** The words on a step's board card under its title: the ask (a quote) or what it is doing / waits on. */
function CardBody({ plan, item, todoText }: { readonly plan: Plan; readonly item: PlanItem; readonly todoText?: string | null }) {
  const look = stepLook(item, plan.items);
  if (look.kind === 'stopped') return <BoardQuote tone="red">{look.detail ? `${look.label}. ${look.detail}` : look.label}</BoardQuote>;
  // Without the ask's text the quote would only repeat the status badge above it.
  if (look.kind === 'needs' || look.kind === 'question') return look.detail ? <BoardQuote>{`“${look.detail}”`}</BoardQuote> : null;
  const text = look.kind === 'pick' ? look.label : (look.detail ?? (look.kind === 'running' ? (todoText ?? null) : null));
  return text ? (
    <BoardActivity live={look.kind === 'running'} testId="v2-step-detail">
      {text}
    </BoardActivity>
  ) : null;
}

/**
 * Board: the shared board (`../shared/Board.tsx`, the Agents board's look) with the project as
 * its one lane (the prototype's `boardHTML(steps, plan)`): Needs you · Working · Ready for
 * approval · Done. A card's click opens the step's agent (a peek), else its details.
 */
export function BoardView({ plan, actions, onDetails, onSendBack }: ViewProps) {
  const columns = boardColumns(plan.items);
  const [closed, setClosed] = useState(false);
  const counts = { needs: columns.needs.length, working: columns.working.length, ready: columns.ready.length, done: columns.done.length };
  const flip = boardFlipKey([{ id: plan.id, cards: BOARD_COLUMNS.flatMap((column) => columns[column].map((item) => ({ id: item.id, column }))) }]);
  const needs = columns.needs.length;
  return (
    <div data-testid="v2-project-board">
      <Board counts={counts} flipKey={flip}>
        <BoardLane
          id={plan.id}
          title={plan.title}
          icon="projects"
          iconClass="v2-plan-ic"
          closed={closed}
          onToggle={() => setClosed((value) => !value)}
          needs={needs}
          summary={
            <>
              <BoardProgress done={plan.progress.done} total={plan.progress.total} />
              <span className="v2-muted" style={{ fontSize: 13 }}>
                {AGENTS_WORDS.stepsDone(plan.progress.done, plan.progress.total)}
              </span>
            </>
          }
          cell={(column) =>
            columns[column].map((item) => {
              const look = stepLook(item, plan.items);
              const name = stepName(item);
              return (
                <BoardCard
                  key={item.id}
                  column={column}
                  flipId={item.id}
                  testId="v2-board-card"
                  kind={`Step${item.key ? ` · ${shortLabel(item, plan.items)}` : ''}`}
                  title={item.title}
                  status={<StatusBadge status={look.status} label={look.label} size="s" />}
                  label={`${name}, ${look.label}${item.runSessionId ? ' · open its agent' : ''}`}
                  onOpen={() => (actions.open(item) ? undefined : onDetails(item))}
                  cardProps={{ 'data-key': item.key ?? item.id, 'data-kind': look.kind }}
                >
                  <CardBody plan={plan} item={item} />
                  <BoardButtons>
                    <InlineButtons plan={plan} item={item} actions={actions} onSendBack={onSendBack} />
                    <MenuButton items={stepMenu(plan, item, actions)} label={`Step actions for ${name}`} testId="v2-step-menu" />
                  </BoardButtons>
                </BoardCard>
              );
            })
          }
        />
      </Board>
    </div>
  );
}

const SEGMENT_TITLE: Readonly<Record<string, string>> = {
  working: 'Agent working',
  you: 'Waiting on you',
  dependency: 'Waiting on an earlier step',
  usage: 'Paused for usage',
  paused: 'Project on hold',
  projected: 'Projected',
};

/** Timeline: one bar per step, its history as spans (the classic timeline), a now line, the summary. */
export function TimelineView({ plan, actions, onDetails }: ViewProps) {
  const now = Date.now();
  const view = useMemo(() => timeline(plan, now), [plan, now]);
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const ticks = axisTicks(view);
  const pct = (time: number): string => `${axisPercent(time, view.start, view.end).toFixed(2)}%`;
  return (
    <div className="v2-card v2-p-tl" data-testid="v2-project-timeline">
      <div className="v2-p-tl-grid">
        <div className="v2-p-tl-axis-name" />
        <div className="v2-p-tl-axis">
          {ticks.map((tick) => (
            <span key={tick} style={{ left: pct(tick) }}>
              {clock(new Date(tick).toISOString())}
            </span>
          ))}
        </div>
        {view.groups.map((group) => (
          <div key={group.repo} className="v2-p-tl-group" role="group" aria-label={group.repo}>
            <div className="v2-p-tl-g">{group.repo}</div>
            {group.rows.map((row) => {
              const item = byId.get(row.itemId);
              if (!item) return null;
              const look = stepLook(item, plan.items);
              return (
                <div key={row.itemId} className="v2-p-tl-line" data-testid="v2-timeline-row" data-key={item.key ?? item.id}>
                  <button type="button" className="v2-p-tl-n" onClick={() => (actions.open(item) ? undefined : onDetails(item))} title={`${stepName(item)} · ${look.label}`}>
                    <Mark status={look.status} />
                    <span>{stepName(item)}</span>
                    <span className="v2-sr"> · {look.label}</span>
                  </button>
                  {/* D139: the same step menu as the Steps list. */}
                  <MenuButton items={stepMenu(plan, item, actions)} label={`Step actions for ${stepName(item)}`} testId="v2-step-menu" />
                  <div className="v2-p-tl-r">
                    {row.segments.map((segment, index) => {
                      const style: CSSProperties = { left: pct(segment.from), width: `calc(${pct(segment.to)} - ${pct(segment.from)})` };
                      return <span key={index} className="v2-p-tl-b" data-seg={segment.kind} style={style} title={`${SEGMENT_TITLE[segment.kind] ?? segment.kind}${segment.note ? ` · ${segment.note}` : ''}`} />;
                    })}
                    <span className="v2-p-tl-now" style={{ left: pct(view.now) }} aria-hidden="true" />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="v2-p-tl-legend" aria-label="Legend">
        {(['working', 'you', 'dependency', 'usage', 'projected'] as const).map((kind) => (
          <span key={kind}>
            <i className="v2-p-tl-b" data-seg={kind} />
            {SEGMENT_TITLE[kind]}
          </span>
        ))}
      </div>
      <p className="v2-muted v2-p-tl-sum" data-testid="v2-timeline-summary">
        {timelineSummary(view, plan)}. Red line = now ({clock(new Date(view.now).toISOString())}).
      </p>
    </div>
  );
}
