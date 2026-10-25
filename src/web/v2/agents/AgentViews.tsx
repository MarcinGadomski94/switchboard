import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Plan } from '../../../core/plans.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import type { TeamSummary } from '../../../core/team.ts';
import { Button, Icon, Menu, Popover, Segmented, StatusBadge } from '../components/index.ts';
import { AGENTS_WORDS, STATUS, computerProblem } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { AnswerCard } from '../shared/AnswerCard.tsx';
import { AgentComputerTag, AgentRow, agentLine } from '../shared/agent-row.tsx';
import { useNeedsYou } from '../shared/needs-you.ts';
import { type AgentEntry, type AgentSection, BOARD_COLUMNS, type BoardColumn, type BoardLane, GROUP_BYS, type GroupBy, boardLanes, cellOf, chatSections, columnOf, engineLabel, listSections, needy, offBoard, offline } from './agents-model.ts';
import { kindLabel, useAgentsPage } from './context.tsx';
import { dragSource, isMoveKey } from './dnd.ts';

/**
 * D131 · lane A · the Agents page's three views: List (`AgentRow` list rows),
 * Chats (messenger rows, Needs-you chats on top) and Board (Needs you · Working ·
 * Ready for approval · Done, swimlanes grouped by Project | Crew | Folder, cards
 * that move live, the quick-answer popover).
 */

function offlineLine(agent: AgentEntry): ReactNode {
  if (!agent.computer || !offline(agent)) return null;
  return (
    <span className="v2-cprev" data-testid="v2-offline-line">
      <Icon name="offline" size="s" />
      {AGENTS_WORDS.offlineLine(agent.computer.name, computerProblem(agent.computer.state === 'reconnecting' ? 'reconnecting' : 'offline'))}
    </span>
  );
}

function RowMenu({ agent }: { readonly agent: AgentEntry }) {
  const page = useAgentsPage();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <span className="v2-row-btns">
      <button type="button" ref={setAnchor} className="v2-icon-btn" aria-label={AGENTS_WORDS.agentActions(agent.name)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="v2-row-menu">
        <Icon name="more" />
      </button>
      <Menu items={page.agentMenu(agent)} anchor={anchor} open={open} onClose={() => setOpen(false)} label={AGENTS_WORDS.agentActions(agent.name)} testId="v2-agent-menu" />
    </span>
  );
}

function rowProps(agent: AgentEntry, openMove: (agent: AgentEntry) => void) {
  return {
    ...dragSource(agent.id),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (!isMoveKey(event)) return;
      event.preventDefault();
      openMove(agent);
    },
    'data-kind': agent.kind,
  };
}

function Tags({ agent }: { readonly agent: AgentEntry }) {
  const page = useAgentsPage();
  return (
    <>
      {kindChip(agent)}
      {page.advanced ? (
        <span className="v2-tag" title={AGENTS_WORDS.advanced} data-testid="v2-engine">
          <Icon name="cmd" size="s" />
          {engineLabel(agent.session.provider)}
        </span>
      ) : null}
    </>
  );
}

function kindChip(agent: AgentEntry): ReactNode {
  const label = kindLabel(agent);
  return label ? (
    <span className="v2-tag" data-testid="v2-kind-tag">
      {label}
    </span>
  ) : null;
}

function CrewHeader({ section, count }: { readonly section: AgentSection; readonly count: number }) {
  const needs = section.items.filter(needy).length;
  return (
    <div className="v2-cgroup" style={{ color: 'var(--v2-text-2)' }} data-testid="v2-crew-group">
      <Icon name="crew" size="s" />
      {`Crew · ${section.crew?.name ?? ''} · ${count}`}
      {needs ? (
        <span className="v2-nb">
          <Icon name="hand" size="s" />
          {needs}
        </span>
      ) : null}
      <span className="v2-grow" />
      {section.crew ? (
        <V2Link to={`/crews/${encodeURIComponent(section.crew.id)}`} className="v2-btn" data-variant="ghost" data-size="sm" style={{ textDecoration: 'none' }}>
          {AGENTS_WORDS.openCrew}
          <Icon name="chev" size="s" />
        </V2Link>
      ) : null}
    </div>
  );
}

/** List: `AgentRow` list rows (grip, avatar, name + kind, the activity or ask, computer, status, ⋯); teammates in "Crew · <name>" sections. */
export function ListView({ agents, teams }: { readonly agents: readonly AgentEntry[]; readonly teams: readonly TeamSummary[] }) {
  const page = useAgentsPage();
  const sections = useMemo(() => listSections(agents, teams), [agents, teams]);
  return (
    <div className="v2-card v2-ag-list" data-testid="v2-agents-list">
      {sections.map((section) => (
        <div key={section.id} data-section={section.kind}>
          {section.kind === 'crew' ? <CrewHeader section={section} count={section.items.length} /> : null}
          {section.items.map((agent) => (
            <AgentRow
              key={agent.id}
              variant="list"
              session={agent.session}
              activity={page.activityOf(agent.id)}
              extras={{ ask: agent.asks[0]?.title ?? null, askStatus: agent.asks.length ? agent.status : undefined, unread: agent.unread, draft: agent.draft !== null, kindLabel: '' }}
              onOpen={() => page.openAgent(agent)}
              lead={
                <span className="v2-grip" aria-hidden="true">
                  <Icon name="grip" size="s" />
                </span>
              }
              tags={<Tags agent={agent} />}
              rowProps={rowProps(agent, page.openMove)}
              line={offlineLine(agent)}
              trailing={<RowMenu agent={agent} />}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Chats: messenger rows; the chats that need you float to the top; teammates in their crews. */
export function ChatsView({ agents, teams }: { readonly agents: readonly AgentEntry[]; readonly teams: readonly TeamSummary[] }) {
  const page = useAgentsPage();
  const sections = useMemo(() => chatSections(agents, teams), [agents, teams]);
  return (
    <div className="v2-card v2-ag-list" data-testid="v2-agents-chats">
      {sections.map((section) => (
        <div key={section.id} data-section={section.kind}>
          {section.kind === 'needs' ? (
            <div className="v2-cgroup" data-tone="amber">
              <Icon name="hand" size="s" />
              {`${AGENTS_WORDS.needsYou} · ${section.items.length}`}
            </div>
          ) : section.kind === 'plain' ? (
            <div className="v2-cgroup">
              <Icon name="chats" size="s" />
              {`${AGENTS_WORDS.agentsAndConversations} · ${section.items.length}`}
            </div>
          ) : (
            <CrewHeader section={section} count={section.items.length} />
          )}
          {section.items.map((agent) => (
            <AgentRow
              key={agent.id}
              session={agent.session}
              activity={page.activityOf(agent.id)}
              extras={{ ask: agent.asks[0]?.title ?? null, askStatus: agent.asks.length ? agent.status : undefined, unread: agent.unread, draft: agent.draft !== null, kindLabel: '' }}
              onOpen={() => page.openAgent(agent)}
              tags={<Tags agent={agent} />}
              rowProps={rowProps(agent, page.openMove)}
              line={
                offlineLine(agent) ??
                (agent.draft && agent.asks.length === 0 ? (
                  <span className="v2-cprev">
                    <b className="v2-draft-txt">{AGENTS_WORDS.draftLine}</b> {agent.draft}
                  </span>
                ) : undefined)
              }
              trailing={<RowMenu agent={agent} />}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

const COLUMN_ICON: Readonly<Record<BoardColumn, string>> = { needs: 'hand', working: 'dot', ready: 'half', done: 'check-circle' };

/** Moves the cards from where they were to where they are now (FLIP), unless the developer asked for reduced motion. */
function useFlip(root: RefObject<HTMLDivElement | null>, key: unknown, layoutKey: unknown): void {
  const last = useRef(new Map<string, DOMRect>());
  const lastLayout = useRef(layoutKey);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // A new grouping re-lays the whole board: no card "moved".
    if (lastLayout.current !== layoutKey) {
      lastLayout.current = layoutKey;
      last.current = new Map();
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const now = new Map<string, DOMRect>();
    for (const card of el.querySelectorAll<HTMLElement>('[data-flip]')) {
      const id = card.dataset['flip'] ?? '';
      const box = card.getBoundingClientRect();
      now.set(id, box);
      const before = last.current.get(id);
      if (!reduce && before && card.animate) {
        const dx = before.left - box.left;
        const dy = before.top - box.top;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.2,.8,.2,1)' });
          card.classList.add('v2-flash');
          window.setTimeout(() => card.classList.remove('v2-flash'), 1500);
        }
      }
    }
    last.current = now;
  }, [root, key, layoutKey]);
}

/** Board: four columns, swimlanes (Project | Crew | Folder), live cards and a quick answer. */
export function BoardView({ agents, teams, plans, layout, groupBy, onGroupBy, closedLanes, onToggleLane }: { readonly agents: readonly AgentEntry[]; readonly teams: readonly TeamSummary[]; readonly plans: readonly Plan[]; readonly layout: SidebarLayout; readonly groupBy: GroupBy; readonly onGroupBy: (value: GroupBy) => void; readonly closedLanes: ReadonlySet<string>; readonly onToggleLane: (id: string) => void }) {
  const lanes = useMemo(() => boardLanes(agents, groupBy, { teams, plans, layout }), [agents, groupBy, teams, plans, layout]);
  const off = useMemo(() => offBoard(agents), [agents]);
  const on = agents.filter((agent) => columnOf(agent.status) !== null);
  const root = useRef<HTMLDivElement | null>(null);
  const positions = lanes.map((lane) => `${lane.id}:${lane.items.map((a) => `${a.id}=${columnOf(a.status)}`).join(',')}`).join('|');
  useFlip(root, positions, groupBy);
  return (
    <div className="v2-bd" ref={root} data-testid="v2-agents-board">
      <div className="v2-bd-groupby">
        <span>{AGENTS_WORDS.groupRowsBy}</span>
        <Segmented options={GROUP_BYS.map((value) => ({ value, label: AGENTS_WORDS.groupBy[value] }))} value={groupBy} onChange={onGroupBy} label={AGENTS_WORDS.groupRowsBy} size="s" testId="v2-groupby" />
      </div>
      <div className="v2-bd-cols">
        {BOARD_COLUMNS.map((column) => (
          <div key={column} className="v2-bd-col-h" data-col={column} data-testid={`v2-bd-col-${column}`}>
            <Icon name={COLUMN_ICON[column]} size="s" />
            {AGENTS_WORDS.columns[column]}
            <span className="v2-count">{on.filter((agent) => columnOf(agent.status) === column).length}</span>
          </div>
        ))}
      </div>
      {lanes.map((lane) => (
        <Lane key={lane.id} lane={lane} closed={closedLanes.has(lane.id)} onToggle={() => onToggleLane(lane.id)} />
      ))}
      <div className="v2-bd-foot" data-testid="v2-bd-foot">
        <Icon name="moon" size="s" />
        {off.length ? AGENTS_WORDS.notOnBoard(off.map((agent) => agent.name)) : AGENTS_WORDS.allOnBoard}
        <span className="v2-grow" />
        <Icon name="refresh" size="s" />
        {AGENTS_WORDS.cardsMove}
      </div>
    </div>
  );
}

function Lane({ lane, closed, onToggle }: { readonly lane: BoardLane; readonly closed: boolean; readonly onToggle: () => void }) {
  const needs = lane.items.filter(needy).length;
  return (
    <section className="v2-lane" {...(closed ? { 'data-closed': '' } : {})} data-lane={lane.id} data-testid="v2-lane">
      <div className="v2-lane-h">
        <button type="button" className="v2-lane-tog" onClick={onToggle} aria-expanded={!closed} aria-label={closed ? AGENTS_WORDS.expand(lane.title) : AGENTS_WORDS.collapse(lane.title)} data-testid="v2-lane-toggle">
          <Icon name="chev-down" size="s" />
        </button>
        <Icon name={lane.icon} size="s" className={lane.icon === 'projects' ? 'v2-plan-ic' : undefined} />
        <h3>{lane.title}</h3>
        {lane.plan ? (
          <>
            <span className="v2-progress" aria-label={AGENTS_WORDS.stepsDone(lane.plan.done, lane.plan.total)}>
              <b style={{ width: `${lane.plan.total ? (lane.plan.done / lane.plan.total) * 100 : 0}%` }} />
            </span>
            <span className="v2-muted" style={{ fontSize: 13 }}>
              {AGENTS_WORDS.stepsDone(lane.plan.done, lane.plan.total)}
            </span>
          </>
        ) : (
          <span className="v2-muted" style={{ fontSize: 13 }}>
            {lane.items.length}
          </span>
        )}
        {closed && needs ? (
          <span className="v2-nb">
            <Icon name="hand" size="s" />
            {needs}
          </span>
        ) : null}
        <span className="v2-grow" />
        {lane.plan ? (
          <V2Link to={`/projects/${encodeURIComponent(lane.plan.id)}`} className="v2-btn" data-size="sm" style={{ textDecoration: 'none' }}>
            <Icon name="projects" size="s" />
            {AGENTS_WORDS.openProject}
          </V2Link>
        ) : null}
        {lane.crewId ? (
          <V2Link to={`/crews/${encodeURIComponent(lane.crewId)}`} className="v2-btn" data-size="sm" style={{ textDecoration: 'none' }}>
            <Icon name="crew" size="s" />
            {AGENTS_WORDS.openCrew}
          </V2Link>
        ) : null}
      </div>
      <div className="v2-lane-g">
        {BOARD_COLUMNS.map((column) => {
          const cell = cellOf(lane, column);
          return (
            <div key={column} className="v2-bcell" data-col={column} data-testid="v2-bcell">
              {cell.length ? cell.map((agent) => <BoardCard key={agent.id} agent={agent} column={column} />) : <div className="v2-none">{AGENTS_WORDS.noneInCell}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BoardCard({ agent, column }: { readonly agent: AgentEntry; readonly column: BoardColumn }) {
  const page = useAgentsPage();
  const { items } = useNeedsYou();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const ask = agent.asks[0] ?? null;
  const item = ask ? (items.find((candidate) => candidate.key === ask.key) ?? null) : null;
  const off = offline(agent);
  const activity = page.activityOf(agent.id);
  const line = agentLine(agent.session, activity, {});
  const kindWord = agent.kind === 'step' ? 'Step' : agent.kind === 'mate' ? `Teammate${agent.crew ? ` · ${agent.crew.name}` : ''}` : agent.kind === 'routine' ? 'Routine' : agent.kind === 'conv' ? 'Conversation' : 'Agent';
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (isMoveKey(event)) {
      event.preventDefault();
      page.openMove(agent);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      page.openAgent(agent);
    }
  };
  return (
    <div
      className="v2-bcard"
      data-col={column}
      data-flip={agent.id}
      data-session={agent.id}
      data-testid="v2-bcard"
      {...(off ? { 'data-off': '' } : {})}
      {...dragSource(agent.id)}
      role="button"
      tabIndex={0}
      aria-label={`${agent.name}, ${STATUS[agent.status].label}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, a')) return;
        page.openAgent(agent);
      }}
      onKeyDown={keyDown}
    >
      <div className="v2-brow">
        <span className="v2-bkind">{kindWord}</span>
        <span className="v2-grow" />
        <AgentComputerTag machine={agent.session.machine} short />
      </div>
      <b className="v2-t">{agent.name}</b>
      <div className="v2-brow">
        <StatusBadge status={agent.status} size="s" />
      </div>
      {ask ? (
        <>
          {ask.kind !== 'ready' && ask.kind !== 'approval' ? (
            <div className="v2-bq" data-tone={agent.status === 'stopped' ? 'red' : 'amber'}>
              {`“${ask.title}”`}
            </div>
          ) : ask.kind === 'approval' ? (
            <div className="v2-bact" style={{ color: 'var(--v2-amber)', fontWeight: 600 }}>
              <Icon name="shield" size="s" />
              {AGENTS_WORDS.approvalWaiting}
            </div>
          ) : null}
          <div className="v2-brow">
            <span className="v2-grow" />
            <Button ref={setAnchor} size="sm" variant={ask.kind === 'ready' ? 'primary' : 'default'} icon={ask.kind === 'ready' ? 'merge' : agent.status === 'stopped' ? 'octagon' : 'hand'} disabled={off || !item} title={off && agent.computer ? AGENTS_WORDS.offlineWhy(agent.computer.name) : undefined} onClick={() => setOpen(true)} data-testid="v2-bcard-answer">
              {ask.kind === 'ready' ? AGENTS_WORDS.review : agent.status === 'stopped' ? AGENTS_WORDS.decide : AGENTS_WORDS.answer}
            </Button>
          </div>
          <Popover open={open && item !== null} onClose={() => setOpen(false)} anchor={anchor} label={AGENTS_WORDS.quickAnswer} width={420} testId="v2-qpop">
            <div className="v2-qpop-h">
              <Icon name="hand" size="s" />
              {AGENTS_WORDS.quickAnswer}
            </div>
            {item ? <AnswerCard item={item} variant="popover" where="board" onAnswered={() => setOpen(false)} /> : null}
          </Popover>
        </>
      ) : (
        <div className="v2-bact" data-testid="v2-bcard-activity">
          {line.tone === 'blue' ? <span className="v2-pulse" aria-hidden="true" /> : null}
          <span>{line.text}</span>
          {line.time ? <span className="v2-bt">{line.time}</span> : null}
        </div>
      )}
    </div>
  );
}

