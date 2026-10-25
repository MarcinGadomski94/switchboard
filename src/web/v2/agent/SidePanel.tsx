import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { AccountProfile } from '../../../core/accounts.ts';
import type { CliOverview, SessionProcesses, SessionTodo } from '../../../core/api.ts';
import { CLI_LABELS, type CliProviderId, readCliProvider } from '../../../core/cli-providers.ts';
import { ApiError, api, machineApi } from '../../api/client.ts';
import { cliChoices } from '../../components/cli.ts';
import { memoryLabel } from '../../../core/processes.ts';
import { PROCESSES_POLL_MS, processTitle, stopLine } from '../../processes/processes.ts';
import { hasSubagentChat } from '../../views/session/chat.ts';
import { freshBusy, freshEligible } from '../../views/session/fresh-offer.ts';
import { terminalLines } from '../../views/session/right-panel.ts';
import { actionErrorText, remoteToggle, rootLine } from '../../views/session/session-header.ts';
import { switchConfirmText } from '../../views/session/provider-switch.ts';
import { useSessionTodos } from '../../views/session/TodoStrip.tsx';
import { Button, Icon, Segmented, Select, StatusBadge, useToast } from '../components/index.ts';
import { AGENT_WORDS, sessionStatusToV2 } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { depthOptions, exactModel, howSummary, speedModels, speedOf } from './how-model.ts';
import type { AgentData } from './useAgent.ts';
import { browserStorage } from './useAgent.ts';

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null);
}

/** The panel's groups. */
type GroupKey = 'mem' | 'how' | 'helpers' | 'bg' | 'tasks' | 'handoff' | 'adv';

const OPEN_KEY = 'switchboard.v2.agentPanelGroups';
/** The prototype's defaults: Working memory and Helpers open. */
const DEFAULT_OPEN: Readonly<Record<GroupKey, boolean>> = { mem: true, how: true, helpers: true, bg: false, tasks: false, handoff: false, adv: false };

function loadOpen(): Record<GroupKey, boolean> {
  try {
    const raw = browserStorage()?.getItem(OPEN_KEY);
    return raw ? { ...DEFAULT_OPEN, ...(JSON.parse(raw) as Partial<Record<GroupKey, boolean>>) } : { ...DEFAULT_OPEN };
  } catch {
    return { ...DEFAULT_OPEN };
  }
}

/** One collapsible group (`details.grp`), its open state remembered per browser. */
function Group({ id, title, icon, summary, open, onToggle, children }: { readonly id: GroupKey; readonly title: string; readonly icon: string; readonly summary?: ReactNode; readonly open: boolean; readonly onToggle: (id: GroupKey, open: boolean) => void; readonly children: ReactNode }) {
  return (
    <details className="v2-ag-grp" open={open} data-group={id} data-testid={`v2-agent-group-${id}`} onToggle={(event) => onToggle(id, (event.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <Icon name={icon} size="s" />
        {title}
        {summary ? <span className="v2-ag-grp-sum">{summary}</span> : null}
        <Icon name="chev" size="s" className="v2-ag-chev" />
      </summary>
      <div className="v2-ag-grp-b">{children}</div>
    </details>
  );
}

/**
 * D131 · lane S · the agent's side panel (Details, ⌘.): collapsible groups, each
 * remembered: Working memory (with the clean slate, D83), How it works (Smart /
 * Fast, thinking depth, AI engine, account and pin: D31, D62, D63), Helpers (their
 * own chats, D36), Background apps (D127: Keep / Stop), Tasks (D68), Handoff note &
 * terminal, Advanced (branch, separate copy, path, CLI, Remote Control, hooked).
 */
export function SidePanel({ data, onHide, helperHref }: { readonly data: AgentData; readonly onHide?: () => void; readonly helperHref: (agentId: string) => string }) {
  const [open, setOpen] = useState(loadOpen);
  const toggle = (id: GroupKey, value: boolean): void => {
    setOpen((current) => {
      if (current[id] === value) return current;
      const next = { ...current, [id]: value };
      try {
        browserStorage()?.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: remembered for this page only.
      }
      return next;
    });
  };
  const { session } = data;
  if (!session) {
    return (
      <div className="v2-ag-side-body" aria-busy="true">
        <div className="v2-skel" style={{ height: 120 }} />
      </div>
    );
  }
  const helpers = session.agents.filter((agent) => agent.kind !== 'main');
  const working = helpers.filter((agent) => agent.status === 'run' || agent.status === 'need').length;
  const pct = session.context?.percent ?? null;
  return (
    <div className="v2-ag-side-body">
      {onHide ? (
        <div className="v2-row v2-ag-side-head">
          <b className="v2-grow">{AGENT_WORDS.details}</b>
          <Button size="sm" variant="ghost" onClick={onHide} title={`${AGENT_WORDS.hideDetailsLong} (⌘.)`} data-testid="v2-agent-side-hide">
            {AGENT_WORDS.hideDetails}
            <Icon name="chev" size="s" />
          </Button>
        </div>
      ) : null}
      {data.conversation ? null : (
        <Group id="mem" title={AGENT_WORDS.workingMemory} icon="cpu" summary={pct === null ? AGENT_WORDS.memoryUnknown : AGENT_WORDS.memoryUsed(Math.round(pct))} open={open.mem} onToggle={toggle}>
          <MemoryGroup data={data} />
        </Group>
      )}
      <Group id="how" title={AGENT_WORDS.howItWorks} icon="sliders" summary={howSummary(session.model)} open={open.how} onToggle={toggle}>
        <HowGroup data={data} />
      </Group>
      {data.conversation ? null : (
        <Group id="helpers" title={AGENT_WORDS.helpers} icon="crew" summary={helpers.length ? `${helpers.length} · ${working} working` : 'none'} open={open.helpers} onToggle={toggle}>
          {helpers.length === 0 ? (
            <p className="v2-muted v2-ag-none">{AGENT_WORDS.noHelpers}</p>
          ) : (
            helpers.map((agent) => (
              <div className="v2-ag-prow" key={agent.id} data-testid="v2-agent-side-helper">
                <span className="v2-grow">{agent.description || agent.name}</span>
                <StatusBadge status={sessionStatusToV2(agent.status)} size="s" />
                {hasSubagentChat(agent) ? (
                  <V2Link to={helperHref(agent.id)} className="v2-btn" data-variant="ghost" data-size="sm" aria-label={`${AGENT_WORDS.openHelperChat}: ${agent.description || agent.name}`}>
                    <Icon name="chev" size="s" />
                  </V2Link>
                ) : null}
              </div>
            ))
          )}
        </Group>
      )}
      {data.conversation ? null : (
        <Group id="bg" title={AGENT_WORDS.backgroundApps} icon="cpu" open={open.bg} onToggle={toggle}>
          <BackgroundGroup sessionId={data.sessionId} blocked={data.blocked} />
        </Group>
      )}
      {data.conversation ? null : (
        <Group id="tasks" title={AGENT_WORDS.tasks} icon="rules" summary={session.openTodoCount ? `${session.openTodoCount} open` : undefined} open={open.tasks} onToggle={toggle}>
          <TasksGroup sessionId={data.sessionId} blocked={data.blocked} />
        </Group>
      )}
      <Group id="handoff" title={AGENT_WORDS.handoff} icon="book" open={open.handoff} onToggle={toggle}>
        <HandoffGroup data={data} />
      </Group>
      <Group id="adv" title={AGENT_WORDS.advanced} icon="sliders" open={open.adv} onToggle={toggle}>
        <AdvancedGroup data={data} />
      </Group>
    </div>
  );
}

function MemoryGroup({ data }: { readonly data: AgentData }) {
  const { session, sessionId, activity, blocked } = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session) return null;
  const pct = session.context?.percent === null || session.context?.percent === undefined ? null : Math.round(session.context.percent);
  const full = pct !== null && pct >= 80;
  const can = blocked === null && freshEligible(session) && !freshBusy(session, activity) && !session.freshContinue;
  const clean = (): void => {
    setBusy(true);
    setError(null);
    api.freshSession(sessionId).then(
      () => setBusy(false),
      (caught: unknown) => {
        setBusy(false);
        setError(errorText(caught));
      },
    );
  };
  return (
    <>
      <div className="v2-ag-meter" data-full={full ? 'true' : undefined} role="meter" aria-label={AGENT_WORDS.workingMemory} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}>
        <b style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="v2-row v2-ag-small" style={{ marginTop: 8 }}>
        <span>{pct === null ? AGENT_WORDS.memoryUnknown : full ? AGENT_WORDS.almostFull : AGENT_WORDS.plentyLeft}</span>
        {session.context?.compaction?.at ? <span className="v2-muted">· {AGENT_WORDS.compacted(new Date(session.context.compaction.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span> : null}
      </div>
      {full ? (
        <div className="v2-ag-memwarn">
          <b>{AGENT_WORDS.almostFull}.</b> {AGENT_WORDS.memoryWarn}
        </div>
      ) : null}
      <Button size="sm" variant={full ? 'primary' : 'default'} icon="refresh" style={{ marginTop: 10 }} disabled={!can || busy} title={can ? undefined : 'Available between replies, for an agent that runs here.'} data-testid="v2-agent-side-clean-slate" onClick={clean}>
        {session.freshContinue ? AGENT_WORDS.cleanSlateRunning : AGENT_WORDS.cleanSlate}
      </Button>
      {error ? (
        <p className="v2-ag-dock-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function HowGroup({ data }: { readonly data: AgentData }) {
  const { session, sessionId, blocked } = data;
  const toast = useToast();
  const machine = session?.machine?.id ?? null;
  const [overview, setOverview] = useState<CliOverview | null>(null);
  const [profiles, setProfiles] = useState<readonly AccountProfile[]>([]);
  const [pending, setPending] = useState<{ readonly kind: 'cli'; readonly to: CliProviderId } | { readonly kind: 'account'; readonly to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    machineApi(machine).clis().then(
      (value) => live && setOverview(value),
      () => live && setOverview(null),
    );
    machineApi(machine).accounts().then(
      (value) => live && setProfiles(value.profiles),
      () => live && setProfiles([]),
    );
    return () => {
      live = false;
    };
  }, [machine, session?.profileId]);
  if (!session) return null;
  const model = session.model ?? null;
  const speeds = speedModels(model?.available ?? null);
  const speed = speedOf(model);
  const depth = depthOptions(model);
  const cli = readCliProvider(session.provider);
  const mine = profiles.filter((p) => p.cli === cli);
  const account = mine.find((p) => p.id === session.profileId) ?? mine.find((p) => p.builtin) ?? mine[0] ?? null;
  const disabled = blocked !== null || session.hooked === true || busy;
  const run = (work: () => Promise<unknown>, done?: string): void => {
    setBusy(true);
    setError(null);
    work().then(
      () => {
        setBusy(false);
        setPending(null);
        if (done) toast({ text: done });
        data.reload();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorText(caught));
        data.reload();
      },
    );
  };
  const setSpeed = (next: 'smart' | 'fast'): void => {
    const value = next === 'fast' ? speeds.fast : speeds.smart;
    if (!value || next === speed) return;
    run(() => api.setModel(sessionId, { model: value }), `${next === 'fast' ? 'Fast' : 'Smart'} from the next reply.`);
  };
  const running = session.providerSwitch ?? null;
  return (
    <div className="v2-ag-how">
      <Segmented
        label={AGENT_WORDS.speed}
        value={speed}
        size="s"
        testId="v2-agent-speed"
        options={[
          { value: 'smart', label: 'Smart', title: speeds.smart ? `Uses ${speeds.smart}` : AGENT_WORDS.modelUnknown },
          { value: 'fast', label: 'Fast', title: speeds.fast ? `Uses ${speeds.fast}` : AGENT_WORDS.modelUnknown },
        ]}
        onChange={(value) => (disabled || !model?.available ? undefined : setSpeed(value))}
      />
      {!model?.available ? <p className="v2-muted v2-ag-small">{AGENT_WORDS.modelUnknown}</p> : null}
      {depth.length > 0 ? (
        <Select
          label={AGENT_WORDS.thinkingDepth}
          value={model?.effort ?? ''}
          disabled={disabled}
          options={depth.map((d) => ({ value: d.value ?? '', label: d.label }))}
          onChange={(event) => run(() => api.setModel(sessionId, { effort: event.target.value === '' ? null : event.target.value }))}
          data-testid="v2-agent-depth"
        />
      ) : null}
      {data.conversation ? null : running ? (
        <p className="v2-ag-small" role="status">
          Switching to {CLI_LABELS[running.to]}…
        </p>
      ) : (
        <Select
          label={AGENT_WORDS.engine}
          value={cli}
          disabled={disabled}
          options={cliChoices(overview).map((choice) => ({ value: choice.provider, label: choice.label, disabled: choice.disabled && choice.provider !== cli }))}
          onChange={(event) => {
            const to = readCliProvider(event.target.value);
            if (to !== cli) setPending({ kind: 'cli', to });
          }}
          data-testid="v2-agent-engine"
        />
      )}
      {mine.length > 1 ? (
        session.accountSwitching ? (
          <p className="v2-ag-small" role="status">
            Switching account…
          </p>
        ) : (
          <>
            <Select
              label={AGENT_WORDS.account}
              value={account?.id ?? ''}
              disabled={disabled}
              options={mine.map((p) => ({ value: p.id, label: `${p.name}${p.exhausted ? ' (out of usage)' : !p.enabled ? ' (off)' : ''}`, disabled: !p.enabled && p.id !== account?.id }))}
              onChange={(event) => {
                if (event.target.value !== account?.id) setPending({ kind: 'account', to: event.target.value });
              }}
              data-testid="v2-agent-account"
            />
            <label className="v2-chk" data-plain="">
              <input type="checkbox" checked={session.profilePinned === true} disabled={disabled} onChange={() => run(() => api.pinProfile(sessionId, session.profilePinned !== true))} data-testid="v2-agent-pin" />
              {AGENT_WORDS.pinAccount}
            </label>
          </>
        )
      ) : null}
      {pending ? (
        <div className="v2-ag-confirm" role="alertdialog" aria-label="Confirm the switch">
          <p>{pending.kind === 'cli' ? switchConfirmText(cli, pending.to) : `Switch this agent to ${mine.find((p) => p.id === pending.to)?.name ?? 'that account'}? The chat is copied there and picked up again.`}</p>
          <div className="v2-row">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => (pending.kind === 'cli' ? api.switchProvider(sessionId, pending.to) : api.switchAccount(sessionId, pending.to)))}>
              {pending.kind === 'cli' ? AGENT_WORDS.switchEngineConfirm : AGENT_WORDS.switchAccountConfirm}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              {AGENT_WORDS.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="v2-ag-dock-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BackgroundGroup({ sessionId, blocked }: { readonly sessionId: string; readonly blocked: string | null }) {
  const [view, setView] = useState<SessionProcesses | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      api.sessionProcesses(sessionId).then(
        (answer) => live && setView(answer),
        () => live && setView(null),
      );
    };
    load();
    const timer = setInterval(load, PROCESSES_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sessionId]);
  const act = (work: () => Promise<SessionProcesses>): void => {
    setError(null);
    work().then(setView, (caught: unknown) => setError(errorText(caught)));
  };
  const list = view?.processes ?? [];
  if (list.length === 0) return <p className="v2-muted v2-ag-none">{AGENT_WORDS.noBackgroundApps}</p>;
  return (
    <>
      {list.map((process) => (
        <div className="v2-ag-prow" key={process.pid} data-testid="v2-agent-process" title={processTitle(process)}>
          <div className="v2-grow">
            <b>{process.name}</b>
            <div className="v2-muted v2-ag-small">
              {memoryLabel(process.rssBytes)} · {process.keep ? 'kept running' : 'stops when idle'}
            </div>
          </div>
          <Button size="sm" disabled={blocked !== null} aria-pressed={process.keep} onClick={() => act(() => api.keepProcess(sessionId, process.pid, !process.keep))}>
            {process.keep ? 'Kept' : AGENT_WORDS.keep}
          </Button>
          <Button size="sm" disabled={blocked !== null} onClick={() => act(() => api.stopProcess(sessionId, process.pid))}>
            {AGENT_WORDS.stopApp}
          </Button>
        </div>
      ))}
      {view ? <p className="v2-muted v2-ag-small">{stopLine(view, null)}</p> : null}
      {error ? (
        <p className="v2-ag-dock-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function todoIcon(todo: SessionTodo): string {
  return todo.state === 'done' ? 'check-circle' : todo.state === 'in_progress' ? 'dot' : 'circle';
}

function TasksGroup({ sessionId, blocked }: { readonly sessionId: string; readonly blocked: string | null }) {
  const todos = useSessionTodos(sessionId);
  const toast = useToast();
  const list = todos.list?.todos ?? [];
  if (todos.list === null) return <div className="v2-skel" style={{ height: 40 }} />;
  if (list.length === 0) return <p className="v2-muted v2-ag-none">{AGENT_WORDS.noTasks}</p>;
  return (
    <>
      {list.map((todo) => (
        <div className="v2-ag-prow" key={todo.id} data-state={todo.state} data-testid="v2-agent-side-task">
          <Icon name={todoIcon(todo)} size="s" />
          <span className="v2-grow">{todo.title}</span>
          {todo.estimateMinutes ? <span className="v2-muted v2-ag-small">est {todo.estimateMinutes}m</span> : null}
          {todo.state === 'open' ? (
            <Button
              size="sm"
              icon="play"
              disabled={blocked !== null}
              onClick={() =>
                api.runTodo(sessionId, todo.id).then(
                  () => toast({ text: `Started a new agent for “${todo.title}”.` }),
                  (caught: unknown) => toast({ text: errorText(caught), tone: 'error' }),
                )
              }
            >
              {AGENT_WORDS.run}
            </Button>
          ) : null}
        </div>
      ))}
    </>
  );
}

function HandoffGroup({ data }: { readonly data: AgentData }) {
  const { session } = data;
  const lines = useMemo(() => (session ? terminalLines(session.events, session.agents, session.status) : []), [session]);
  if (!session) return null;
  const note = session.turnWait?.ask ?? null;
  return (
    <>
      {note ? <p className="v2-ag-small" style={{ margin: '0 0 8px' }}>“{note}”</p> : null}
      {lines.length === 0 ? (
        <p className="v2-muted v2-ag-none">{AGENT_WORDS.noTerminal}</p>
      ) : (
        <div className="v2-ag-term" data-testid="v2-agent-terminal-tail">
          {lines.map((line) => (
            <div key={line.key} data-tone={line.tone}>
              {line.text}
            </div>
          ))}
        </div>
      )}
      {data.conversation ? null : (
        <p className="v2-ag-small v2-muted" style={{ marginBottom: 0 }}>
          {AGENT_WORDS.continueInTerminal}: <span className="v2-mono">{session.resumeCommand}</span>
        </p>
      )}
    </>
  );
}

function AdvancedGroup({ data }: { readonly data: AgentData }) {
  const { session } = data;
  if (!session) return null;
  const branches = [...new Set(session.agents.map((a) => (a.branch ? `${a.solutionPath ?? ''}${a.solutionPath ? ' · ' : ''}${a.branch}` : null)).filter((b): b is string => b !== null))];
  const remote = remoteToggle(session);
  const rows: Array<[string, ReactNode]> = [
    [AGENT_WORDS.engine, `${CLI_LABELS[readCliProvider(session.provider)]} · ${exactModel(session.model)}${session.model?.effort ? ` · effort ${session.model.effort}` : ''}`],
    [AGENT_WORDS.account, session.profileName ?? 'Default'],
    [AGENT_WORDS.branch, branches.length ? branches.join(', ') : '—'],
    [AGENT_WORDS.separateCopy, session.worktrees ? 'Yes (a worktree per code project)' : 'No, it works in place'],
    [AGENT_WORDS.folderPath, <span className="v2-mono">{rootLine(session)}</span>],
    [AGENT_WORDS.remoteControl, remote ? (remote.on ? 'On' : 'Off') : '—'],
    ['Agent id', <span className="v2-mono">{session.id}</span>],
  ];
  if (session.hooked) rows.push([AGENT_WORDS.hooked, 'Its terminal runs it; Switchboard follows along.']);
  return (
    <dl className="v2-ag-adv" data-testid="v2-agent-advanced">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
