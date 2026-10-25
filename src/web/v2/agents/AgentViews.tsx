import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react';
import type { Plan } from '../../../core/plans.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import type { TeamSummary } from '../../../core/team.ts';
import { Button, Icon, Menu, Popover, Segmented, StatusBadge } from '../components/index.ts';
import { AGENTS_WORDS, STATUS, computerProblem } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { AnswerCard } from '../shared/AnswerCard.tsx';
import { AgentComputerTag, AgentRow, agentLine } from '../shared/agent-row.tsx';
import { Board, BoardActivity, BoardButtons, BoardCard, BoardLane, BoardProgress, BoardQuote } from '../shared/Board.tsx';
import { boardCounts, boardFlipKey } from '../shared/board-model.ts';
import { useNeedsYou } from '../shared/needs-you.ts';
import { type AgentEntry, type AgentSection, type BoardColumn, type BoardLane as BoardLaneModel, GROUP_BYS, type GroupBy, boardLanes, cellOf, chatSections, columnOf, engineLabel, listSections, needy, offBoard, offline } from './agents-model.ts';
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
    <span className="v2-tag" data-testid="v2-kind-tag" title={label}>
      <span className="v2-tag-t">{label}</span>
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

/** Board: the shared board (`../shared/Board.tsx`) with swimlanes grouped by Project | Crew | Folder, live cards and a quick answer. */
export function BoardView({ agents, teams, plans, layout, groupBy, onGroupBy, closedLanes, onToggleLane }: { readonly agents: readonly AgentEntry[]; readonly teams: readonly TeamSummary[]; readonly plans: readonly Plan[]; readonly layout: SidebarLayout; readonly groupBy: GroupBy; readonly onGroupBy: (value: GroupBy) => void; readonly closedLanes: ReadonlySet<string>; readonly onToggleLane: (id: string) => void }) {
  const lanes = useMemo(() => boardLanes(agents, groupBy, { teams, plans, layout }), [agents, groupBy, teams, plans, layout]);
  const off = useMemo(() => offBoard(agents), [agents]);
  const counts = useMemo(() => boardCounts(agents, (agent) => columnOf(agent.status)), [agents]);
  const flip = boardFlipKey(lanes.map((lane) => ({ id: lane.id, cards: lane.items.map((agent) => ({ id: agent.id, column: columnOf(agent.status) })) })));
  return (
    <Board
      testId="v2-agents-board"
      colTestIds
      counts={counts}
      flipKey={flip}
      layoutKey={groupBy}
      toolbar={
        <div className="v2-bd-groupby">
          <span>{AGENTS_WORDS.groupRowsBy}</span>
          <Segmented options={GROUP_BYS.map((value) => ({ value, label: AGENTS_WORDS.groupBy[value] }))} value={groupBy} onChange={onGroupBy} label={AGENTS_WORDS.groupRowsBy} size="s" testId="v2-groupby" />
        </div>
      }
      foot={
        <>
          <Icon name="moon" size="s" />
          {off.length ? AGENTS_WORDS.notOnBoard(off.map((agent) => agent.name)) : AGENTS_WORDS.allOnBoard}
          <span className="v2-grow" />
          <Icon name="refresh" size="s" />
          {AGENTS_WORDS.cardsMove}
        </>
      }
    >
      {lanes.map((lane) => (
        <Lane key={lane.id} lane={lane} closed={closedLanes.has(lane.id)} onToggle={() => onToggleLane(lane.id)} />
      ))}
    </Board>
  );
}

function Lane({ lane, closed, onToggle }: { readonly lane: BoardLaneModel; readonly closed: boolean; readonly onToggle: () => void }) {
  return (
    <BoardLane
      id={lane.id}
      title={lane.title}
      icon={lane.icon}
      {...(lane.icon === 'projects' ? { iconClass: 'v2-plan-ic' } : {})}
      closed={closed}
      onToggle={onToggle}
      needs={lane.items.filter(needy).length}
      summary={
        lane.plan ? (
          <>
            <BoardProgress done={lane.plan.done} total={lane.plan.total} />
            <span className="v2-muted" style={{ fontSize: 13 }}>
              {AGENTS_WORDS.stepsDone(lane.plan.done, lane.plan.total)}
            </span>
          </>
        ) : (
          <span className="v2-muted" style={{ fontSize: 13 }}>
            {lane.items.length}
          </span>
        )
      }
      actions={
        <>
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
        </>
      }
      cell={(column) => cellOf(lane, column).map((agent) => <AgentBoardCard key={agent.id} agent={agent} column={column} />)}
    />
  );
}

/** An agent's card: kind, computer, name, status, then its ask with the quick answer (popover) or its activity. A click peeks (`openPeek`). */
function AgentBoardCard({ agent, column }: { readonly agent: AgentEntry; readonly column: BoardColumn }) {
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
  return (
    <BoardCard
      column={column}
      flipId={agent.id}
      testId="v2-bcard"
      kind={kindWord}
      corner={<AgentComputerTag machine={agent.session.machine} short />}
      title={agent.name}
      status={<StatusBadge status={agent.status} size="s" />}
      label={`${agent.name}, ${STATUS[agent.status].label}`}
      off={off}
      onOpen={() => page.peekAgent(agent)}
      onKey={(event) => {
        if (!isMoveKey(event)) return false;
        event.preventDefault();
        page.openMove(agent);
        return true;
      }}
      cardProps={{ ...dragSource(agent.id), 'data-session': agent.id }}
    >
      {ask ? (
        <>
          {ask.kind !== 'ready' && ask.kind !== 'approval' ? (
            <BoardQuote tone={agent.status === 'stopped' ? 'red' : 'amber'}>{`“${ask.title}”`}</BoardQuote>
          ) : ask.kind === 'approval' ? (
            <div className="v2-bact" style={{ color: 'var(--v2-amber)', fontWeight: 600 }}>
              <Icon name="shield" size="s" />
              {AGENTS_WORDS.approvalWaiting}
            </div>
          ) : null}
          <BoardButtons>
            <Button ref={setAnchor} size="sm" variant={ask.kind === 'ready' ? 'primary' : 'default'} icon={ask.kind === 'ready' ? 'merge' : agent.status === 'stopped' ? 'octagon' : 'hand'} disabled={off || !item} title={off && agent.computer ? AGENTS_WORDS.offlineWhy(agent.computer.name) : undefined} onClick={() => setOpen(true)} data-testid="v2-bcard-answer">
              {ask.kind === 'ready' ? AGENTS_WORDS.review : agent.status === 'stopped' ? AGENTS_WORDS.decide : AGENTS_WORDS.answer}
            </Button>
          </BoardButtons>
          <Popover open={open && item !== null} onClose={() => setOpen(false)} anchor={anchor} label={AGENTS_WORDS.quickAnswer} width={420} testId="v2-qpop">
            <div className="v2-qpop-h">
              <Icon name="hand" size="s" />
              {AGENTS_WORDS.quickAnswer}
            </div>
            {item ? <AnswerCard item={item} variant="popover" where="board" onAnswered={() => setOpen(false)} /> : null}
          </Popover>
        </>
      ) : (
        <BoardActivity live={line.tone === 'blue'} time={line.time} testId="v2-bcard-activity">
          {line.text}
        </BoardActivity>
      )}
    </BoardCard>
  );
}
