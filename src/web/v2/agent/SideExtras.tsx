import { useEffect, useMemo, useState } from 'react';
import type { MemorySessionCount } from '../../../core/memory.ts';
import { memoryCountTooltip } from '../../../core/memory.ts';
import { groupByRepo, worktreeLabel } from '../../../core/move-worktrees.ts';
import { type WorksInRepo, worksInEvidenceLabel, worksInSourceLabel, worksInSummary } from '../../../core/workspace-move.ts';
import { overviewActivityLabel, workingActivityState } from '../../activity/activity.ts';
import { useTick } from '../../activity/useActivity.ts';
import { api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { memoryApi } from '../../memory/api.ts';
import { useMemory } from '../../memory/store.ts';
// Project memory (D107) hook (docs/memory-removal.md): the imports above.
import { usePlans } from '../../plans/store.ts';
import { agentActivity, resumeBlocked } from '../../views/session/workflow-agents.ts';
import { Button, Icon, StatusBadge } from '../components/index.ts';
import { AGENT_WORDS, sessionStatusToV2 } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { Group, type GroupKey } from './SidePanel.tsx';
import { agentProjects, foldOverview, notesHref, type OverviewFold, type OverviewItem, overviewItems, overviewSummary, reportedView } from './side-model.ts';
import { EarlierToggle, ShowMoreHelpers, useFoldClock } from './HelpersFold.tsx';
import { HELPERS_PAGE, withPendingHelpers } from './helpers-model.ts';
import { helpersOverview } from './helpers-view.ts';
import type { AgentData } from './useAgent.ts';

/** The overview's live activity text refreshes this often (the classic overview's tick). */
const TICK_MS = 1_000;

/**
 * D131 · lane X · D99: the project the agent belongs to, as a link (its plan agent,
 * or the step it runs with that step's status). Nothing when it belongs to none.
 */
export function ProjectLine({ sessionId }: { readonly sessionId: string }) {
  const { on, plans } = usePlans();
  const mine = useMemo(() => (on ? agentProjects(plans, sessionId) : []), [on, plans, sessionId]);
  if (mine.length === 0) return null;
  return (
    <div className="v2-ag-xline" data-testid="v2-agent-project">
      {mine.map((project) => (
        <V2Link key={project.planId} to={project.href} className="v2-ag-xlink" data-testid="v2-agent-project-link" data-plan-id={project.planId} data-role={project.role}>
          <Icon name="projects" size="s" />
          <span className="v2-grow v2-ag-xtext">
            <b>
              {AGENT_WORDS.project} · {project.title}
            </b>
            <small className="v2-muted">
              {project.role === 'step' && project.step ? `${AGENT_WORDS.projectStep(project.step)} · ` : `${AGENT_WORDS.projectSource} · `}
              {project.progress}
            </small>
          </span>
          <StatusBadge status={project.status} label={project.statusLabel} size="s" />
          <Icon name="chev" size="s" />
        </V2Link>
      ))}
    </div>
  );
}

/**
 * D131 · lane X · D107: "What agents know": the approved notes this agent gets for
 * its folder and the proposals waiting, with a link to Notes scoped to the folder.
 * This computer's agents only (as classic); nothing while Project memory is off.
 */
export function NotesLine({ sessionId, folderPath, remote }: { readonly sessionId: string; readonly folderPath: string | null | undefined; readonly remote: boolean }) {
  const { on } = useMemory();
  const [count, setCount] = useState<MemorySessionCount | null>(null);
  const [tick, setTick] = useState(0);
  useHubEvent('memoryChanged', () => setTick((n) => n + 1));
  useEffect(() => {
    if (!on || remote || !folderPath) return undefined;
    let live = true;
    memoryApi(null)
      .sessionCount(sessionId)
      .then(
        (answer) => live && setCount(answer),
        () => live && setCount(null),
      );
    return () => {
      live = false;
    };
  }, [on, remote, folderPath, sessionId, tick]);
  const href = notesHref(count, folderPath);
  if (!on || remote || !href) return null;
  const proposed = count?.proposed ?? 0;
  return (
    <div className="v2-ag-xline" data-testid="v2-agent-memory">
      <V2Link to={href} className="v2-ag-xlink" data-testid="v2-agent-memory-link" title={count ? memoryCountTooltip(count) : undefined}>
        <Icon name="book" size="s" />
        <span className="v2-grow v2-ag-xtext">
          <b>{AGENT_WORDS.whatAgentsKnow}</b>
          <small className="v2-muted" data-testid="v2-agent-memory-count">
            {count ? AGENT_WORDS.notesCount(count.count) : '…'}
            {proposed > 0 ? ` · ${AGENT_WORDS.notesToReview(proposed)}` : ''}
          </small>
        </span>
        <span className="v2-ag-xaction">{AGENT_WORDS.openNotes}</span>
        <Icon name="chev" size="s" />
      </V2Link>
    </div>
  );
}

/**
 * D131 · lane X · D21 / D27 / D51: the agents overview: one row per agent that has
 * not finished (Agent · What it does · Code project · Status, the live action while
 * it works), each Workflow run with its agents under it and **Resume run** under a
 * stopped one, and the table the agent printed. A helper's row opens its chat. The
 * group opens by itself while a run can be resumed.
 */
export function OverviewGroup({
  data,
  helperHref,
  open,
  onToggle,
}: {
  readonly data: AgentData;
  readonly helperHref: (agentId: string) => string;
  readonly open: boolean;
  readonly onToggle: (id: GroupKey, open: boolean) => void;
}) {
  const overview = useOverview(data);
  if (!overview.session) return null;
  return (
    <Group id="overview" title={AGENT_WORDS.overview} icon="table" summary={overview.summary} open={open || overview.resumable} onToggle={onToggle}>
      <OverviewTable data={data} helperHref={helperHref} overview={overview} />
    </Group>
  );
}

/** What the agents overview holds now: its rows (the older ones folded), the table the agent printed, and its one-line summary. */
export interface Overview {
  readonly session: AgentData['session'];
  readonly fold: OverviewFold;
  readonly reported: ReturnType<typeof reportedView>;
  /** "4 agents · 3 working". */
  readonly summary: string;
  /** A stopped run can be resumed (the Details group then opens by itself). */
  readonly resumable: boolean;
}

/**
 * SPIKE: the overview's data apart from where it is drawn (the Details group, the side
 * panel's Helpers tab). `everyHelper`: the Helpers tab's rows, where a helper keeps its
 * row after it finished and while it works in the background (`helpers-view.ts`).
 */
export function useOverview(data: AgentData, options: { readonly everyHelper?: boolean } = {}): Overview {
  const session = data.session;
  const everyHelper = options.everyHelper === true;
  const all = useMemo(() => (session && !everyHelper ? overviewItems(session) : []), [session, everyHelper]);
  // 2026-10-27 · the helpers fold: helpers and runs that ended over 10 minutes ago fold under one row.
  const now = useFoldClock(session);
  const background = data.activity?.background;
  const fold = useMemo<OverviewFold>(() => {
    if (!session) return { shown: [], earlier: [], earlierCount: 0 };
    if (everyHelper) return helpersOverview(session, background, now);
    return foldOverview(all, { agents: withPendingHelpers(session.agents, background), workflows: session.workflows }, now);
  }, [all, session, background, now, everyHelper]);
  const reported = useMemo(() => (session ? reportedView(session) : null), [session]);
  // The Helpers tab counts every helper it lists, folded ones too; Details counts what it shows.
  return { session, fold, reported, summary: overviewSummary(everyHelper ? [...fold.shown, ...fold.earlier] : fold.shown), resumable: fold.shown.some((item) => item.kind === 'workflow' && item.resume !== null) };
}

/** The overview's table ({@link OverviewGroup} says what it holds). */
export function OverviewTable({ data, helperHref, overview }: { readonly data: AgentData; readonly helperHref: (agentId: string) => string; readonly overview: Overview }) {
  const { session, fold, reported } = overview;
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(HELPERS_PAGE);
  useEffect(() => {
    setExpanded(false);
    setLimit(HELPERS_PAGE);
  }, [data.sessionId]);
  if (!session) return null;
  const earlierRows = expanded ? cutRows(fold.earlier, limit) : { rows: [], more: 0 };
  const items = [...fold.shown, ...earlierRows.rows];
  return (
    <>
      <table className="v2-ag-ov" data-testid="v2-agent-overview">
        <colgroup>
          <col />
          <col style={{ width: '42%' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{AGENT_WORDS.overviewColumns[0]}</th>
            <th scope="col">{AGENT_WORDS.overviewColumns[3]}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) =>
            item.kind === 'workflow' ? (
              <WorkflowRows key={`wf:${item.runId}`} data={data} item={item} />
            ) : (
              <AgentRow key={item.id} data={data} item={item} href={item.opensChat ? helperHref(item.id) : null} />
            ),
          )}
        </tbody>
      </table>
      <ShowMoreHelpers more={earlierRows.more} testId="v2-agent-overview-more" onMore={() => setLimit((value) => value + HELPERS_PAGE)} />
      <EarlierToggle
        count={fold.earlierCount}
        expanded={expanded}
        words={AGENT_WORDS.showEarlierOverview}
        testId="v2-agent-overview-earlier"
        onToggle={() => {
          setExpanded((value) => !value);
          setLimit(HELPERS_PAGE);
        }}
      />
      {session.reportedTable ? (
        <div className="v2-ag-ov-rep" data-testid="v2-agent-overview-reported">
          <div className="v2-muted v2-ag-small">
            {AGENT_WORDS.overviewReported} · {new Date(session.reportedTable.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          {reported ? (
            <table className="v2-ag-ov" data-testid="v2-agent-overview-reported-table">
              <thead>
                <tr>
                  {reported.columns.map((column, index) => (
                    <th key={index} scope="col" style={{ width: column.width }} title={column.name}>
                      {column.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reported.rows.map((row, index) => (
                  <tr key={index}>
                    {row.cells.map((cell, column) => (
                      <td key={column} title={cell.text || undefined}>
                        {cell.status ? <StatusBadge status={sessionStatusToV2(cell.status)} label={cell.text} size="s" /> : cell.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="v2-muted v2-ag-small">{AGENT_WORDS.overviewUnreadable}</p>
          )}
          <details className="v2-ag-ov-printed">
            <summary>{AGENT_WORDS.overviewAsPrinted}</summary>
            <pre className="v2-ag-code">{session.reportedTable.text}</pre>
          </details>
        </div>
      ) : null}
    </>
  );
}

/** The first `limit` folded units' rows (a run's agents stay with their run) and how many units wait behind "Show more". */
function cutRows(rows: readonly OverviewItem[], limit: number): { readonly rows: readonly OverviewItem[]; readonly more: number } {
  const out: OverviewItem[] = [];
  let units = 0;
  let more = 0;
  for (const row of rows) {
    const starts = !(row.kind === 'agent' && row.depth === 1);
    if (starts) units += 1;
    if (units <= limit) out.push(row);
    else if (starts) more += 1;
  }
  return { rows: out, more };
}

function AgentRow({ data, item, href }: { readonly data: AgentData; readonly item: Extract<OverviewItem, { kind: 'agent' }>; readonly href: string | null }) {
  const now = useTick(TICK_MS);
  const agent = data.session?.agents.find((candidate) => candidate.id === item.id) ?? null;
  const entry = agent ? agentActivity(data.activity, agent) : null;
  const live = entry ? overviewActivityLabel(entry, item.main && data.activity ? data.activity.turnStartedAt : null, now, data.activity?.background ?? []) : null;
  // D30: an agent waiting on background work reads as working.
  // D143 / D164: not for a dev server or watcher alone: only a wait (subagents, a wake-up, a background build).
  const status = entry?.state === 'background' && workingActivityState(data.activity) === 'background' ? 'working' : item.status;
  const text = live ? `${live.text}${live.time ? ` ${live.time}` : ''}` : item.statusText;
  return (
    <tr data-testid="v2-agent-overview-row" data-agent-id={item.id} data-depth={item.depth} data-status={status}>
      <td>
        <div className="v2-ag-ov-name" title={item.name}>
          {href ? (
            <V2Link to={href} className="v2-ag-ov-open" title={AGENT_WORDS.openHelperChat}>
              {item.name}
            </V2Link>
          ) : (
            item.name
          )}
        </div>
        {item.description || item.solutionPath ? (
          <div className="v2-ag-ov-sub v2-muted" title={[item.description, item.solutionPath].filter(Boolean).join(' · ')}>
            {item.description}
            {item.description && item.solutionPath ? ' · ' : ''}
            {item.solutionPath ? <span className="v2-mono">{item.solution}</span> : null}
          </div>
        ) : null}
      </td>
      <td title={text}>
        <StatusBadge status={status} label={text.replace(/^[●✓✕⏸]\s*/u, '')} size="s" />
      </td>
    </tr>
  );
}

/**
 * D180 · one line of the side panel's Helpers sections: the helper's name (the link to its own
 * chat), and on the right what it does now with the time (working, in blue), or its status word
 * (`look`: red for a failed one, amber for one that waits, muted for a finished one).
 */
export function HelperLine({ data, item, href, look, indent = false }: { readonly data: AgentData; readonly item: Extract<OverviewItem, { kind: 'agent' }>; readonly href: string | null; readonly look: 'working' | 'failed' | 'waiting' | 'finished'; readonly indent?: boolean }) {
  const now = useTick(TICK_MS);
  const agent = data.session?.agents.find((candidate) => candidate.id === item.id) ?? null;
  const entry = agent ? agentActivity(data.activity, agent) : null;
  const live = entry ? overviewActivityLabel(entry, null, now, data.activity?.background ?? []) : null;
  const text = look === 'working' && live ? `${live.text}${live.time ? ` ${live.time}` : ''}` : item.statusText;
  const name = item.description || item.name;
  return (
    <div className="v2-sp-hrow" data-look={look} data-indent={indent ? 'true' : undefined} data-agent-id={item.id} data-testid="v2-side-helper-row">
      <span className="v2-sp-hname v2-grow" title={[item.name, item.description].filter(Boolean).join(' · ')}>
        {href ? (
          <V2Link to={href} className="v2-ag-ov-open" title={AGENT_WORDS.openHelperChat}>
            {name}
          </V2Link>
        ) : (
          name
        )}
      </span>
      <span className="v2-sp-hstate" title={text}>
        {text.replace(/^[●✓✕⏸]\s*/u, '')}
      </span>
    </div>
  );
}

function WorkflowRows({ data, item }: { readonly data: AgentData; readonly item: Extract<OverviewItem, { kind: 'workflow' }> }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const session = data.session;
  const blocked = session ? resumeBlocked(session) : null;
  const resume = (): void => {
    if (!item.resume) return;
    setState('sending');
    api.sendMessage(data.sessionId, item.resume).then(
      () => setState('sent'),
      () => setState('failed'),
    );
  };
  const note = blocked ?? (state === 'sent' ? AGENT_WORDS.resumeRunSent : state === 'failed' ? AGENT_WORDS.resumeRunFailed : null);
  return (
    <>
      <tr className="v2-ag-ov-wf" data-testid="v2-agent-overview-workflow" data-run-id={item.runId} data-status={item.status}>
        <td>
          <div className="v2-ag-ov-name" title={item.name}>
            <Icon name="routine" size="s" /> <b>{item.name}</b>
          </div>
          {item.summary ? (
            <div className="v2-ag-ov-sub v2-muted" title={item.summary}>
              {item.summary}
            </div>
          ) : null}
        </td>
        <td title={item.statusText}>
          <StatusBadge status={item.status} label={item.statusText.replace(/^[●✓✕⏸]\s*/u, '')} size="s" />
        </td>
      </tr>
      {item.resume !== null ? (
        <tr className="v2-ag-ov-actions" data-run-id={item.runId}>
          <td colSpan={2}>
            <div className="v2-row">
              <Button size="sm" icon="play" data-testid="v2-agent-resume-run" disabled={blocked !== null || state === 'sending' || state === 'sent'} title={blocked ?? AGENT_WORDS.resumeRunHint} onClick={resume}>
                {AGENT_WORDS.resumeRun}
              </Button>
              {note ? (
                <span className="v2-muted v2-ag-small" data-testid="v2-agent-resume-note" role="status">
                  {note}
                </span>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * D152: **Works in**: the repos this agent works in, from its history (its separate
 * copies, the solutions picked at start, the repos of the files it edited, its
 * working folder's; D152 follow-up 2026-11-05: and the repos it only read files in
 * or ran shell commands in), ranked by evidence, each with its path, branch and
 * (subtly) what it did there, so it is clear which repo a workspace agent works on
 * before moving it. Read when the panel opens and after each turn (`status`: the
 * caller's refresh key, which changes when a turn ends even if the status went
 * run → idle between two renders, and stays put while a turn runs); it never holds
 * the panel up: "…" while the answer is on its way, "No repo found yet" when empty.
 */
export function WorksInLine({ sessionId, status, folded = false }: { readonly sessionId: string; readonly status: string | null | undefined; /** D180: the side panel's ⓘ: a closed group with its one-line summary ("acme-notes · main"). */ readonly folded?: boolean }) {
  // `undefined`: being read the first time; `null`: it could not be read (the line is hidden).
  const [repos, setRepos] = useState<readonly WorksInRepo[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.sessionWorksIn(sessionId).then(
      (answer) => live && setRepos(answer.repos),
      () => live && setRepos(null),
    );
    return () => {
      live = false;
    };
  }, [sessionId, status]);
  useEffect(() => setRepos(undefined), [sessionId]);
  if (repos === null) return null;
  const state = repos === undefined ? 'loading' : repos.length === 0 ? 'empty' : 'found';
  if (folded) {
    return (
      <details className="v2-ag-grp" data-group="works-in" data-testid="v2-agent-works-in" data-tour="v2-agent-works-in" data-state={state}>
        <summary>
          <Icon name="folder" size="s" />
          Works in
          <span className="v2-ag-grp-sum">{repos === undefined ? '…' : worksInSummary(repos)}</span>
          <Icon name="chev" size="s" className="v2-ag-chev" />
        </summary>
        <div className="v2-ag-grp-b">
          <WorksInList repos={repos ?? []} />
        </div>
      </details>
    );
  }
  return (
    <div className="v2-ag-xline" data-testid="v2-agent-works-in" data-tour="v2-agent-works-in" data-state={state}>
      <div className="v2-ag-xlink" style={{ cursor: 'default' }}>
        <Icon name="folder" size="s" />
        <span className="v2-grow v2-ag-xtext">
          <b>Works in · {repos === undefined ? '…' : worksInSummary(repos)}</b>
          <WorksInList repos={repos ?? []} />
        </span>
      </div>
    </div>
  );
}

/** The repos of {@link WorksInLine}, one entry per repo with its worktrees nested. */
function WorksInList({ repos }: { readonly repos: readonly WorksInRepo[] }) {
  return (
        <>
          {groupByRepo(repos ?? []).map((group) => {
            // D153: one entry per repo, its worktrees nested under it (never N entries with one name).
            const row = (repo: WorksInRepo, nested: boolean) => {
              // The source label already names one kind ("it read files here"): the rest are added subtly.
              const evidence = worksInEvidenceLabel((repo.evidence ?? []).filter((kind) => kind !== repo.source));
              return (
                <small
                  key={repo.path}
                  className="v2-muted"
                  data-testid={nested ? 'v2-agent-works-in-worktree' : 'v2-agent-works-in-repo'}
                  data-name={nested ? worktreeLabel(repo) : repo.name}
                  data-source={repo.source}
                  data-evidence={(repo.evidence ?? []).join(' ')}
                  title={repo.remoteUrl ?? undefined}
                  style={{ display: 'block', overflowWrap: 'anywhere', ...(nested ? { paddingLeft: '1em' } : {}) }}
                >
                  {nested ? `↳ worktree ${worktreeLabel(repo)}` : repo.name}
                  {repo.branch ? ` · ${repo.branch}` : ''} · {repo.path} ({worksInSourceLabel(repo.source)})
                  {evidence !== '' ? (
                    <span data-testid="v2-agent-works-in-evidence" style={{ opacity: 0.75 }}>
                      {' '}
                      · {evidence}
                    </span>
                  ) : null}
                </small>
              );
            };
            return (
              <span key={group.mainPath} data-testid="v2-agent-works-in-group" data-name={group.name} data-worktrees={group.worktrees.length} style={{ display: 'block' }}>
                {group.main ? (
                  row(group.main, false)
                ) : (
                  <small className="v2-muted" data-testid="v2-agent-works-in-repo" data-name={group.name} style={{ display: 'block', overflowWrap: 'anywhere' }}>
                    {group.name} · {group.mainPath}
                  </small>
                )}
                {group.worktrees.map((worktree) => row(worktree, true))}
              </span>
            );
          })}
        </>
  );
}
