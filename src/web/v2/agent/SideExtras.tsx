import { useEffect, useMemo, useState } from 'react';
import type { MemorySessionCount } from '../../../core/memory.ts';
import { memoryCountTooltip } from '../../../core/memory.ts';
import { overviewActivityLabel } from '../../activity/activity.ts';
import { useTick } from '../../activity/useActivity.ts';
import { api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { memoryApi } from '../../memory/api.ts';
import { useMemory } from '../../memory/store.ts';
import { usePlans } from '../../plans/store.ts';
import { agentActivity, resumeBlocked } from '../../views/session/workflow-agents.ts';
import { Button, Icon, StatusBadge } from '../components/index.ts';
import { AGENT_WORDS, sessionStatusToV2 } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { Group, type GroupKey } from './SidePanel.tsx';
import { agentProjects, notesHref, type OverviewItem, overviewItems, overviewSummary, reportedView } from './side-model.ts';
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
  const session = data.session;
  const items = useMemo(() => (session ? overviewItems(session) : []), [session]);
  const reported = useMemo(() => (session ? reportedView(session) : null), [session]);
  if (!session) return null;
  const resumable = items.some((item) => item.kind === 'workflow' && item.resume !== null);
  return (
    <Group id="overview" title={AGENT_WORDS.overview} icon="table" summary={overviewSummary(items)} open={open || resumable} onToggle={onToggle}>
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
    </Group>
  );
}

function AgentRow({ data, item, href }: { readonly data: AgentData; readonly item: Extract<OverviewItem, { kind: 'agent' }>; readonly href: string | null }) {
  const now = useTick(TICK_MS);
  const agent = data.session?.agents.find((candidate) => candidate.id === item.id) ?? null;
  const entry = agent ? agentActivity(data.activity, agent) : null;
  const live = entry ? overviewActivityLabel(entry, item.main && data.activity ? data.activity.turnStartedAt : null, now, data.activity?.background ?? []) : null;
  // D30: an agent waiting on background work reads as working.
  const status = entry?.state === 'background' ? 'working' : item.status;
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
