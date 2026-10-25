import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Schedule, SessionListItem, TerminalLoop } from '../../../../core/api.ts';
import type { MachineState, SessionMachine } from '../../../../core/peers.ts';
import { ApiError, api } from '../../../api/client.ts';
import { useApi } from '../../../api/useApi.ts';
import { useHubEvent } from '../../../api/useHub.ts';
import { useMachineStateChange, useMachines } from '../../../api/useMachines.ts';
import { useSessionListOf } from '../../../api/session-list.ts';
import { useThrottled } from '../../../api/useThrottled.ts';
import { type LoopDraft, draftFromLoop, draftInput, loopRefusal } from '../../../views/owned-loops.ts';
import { Button, ComputerTag, Dialog, EmptyState, Field, Icon, Segmented, Skeleton, StatusBadge, TextArea, useToast } from '../../components/index.ts';
import { ROUTINES_WORDS } from '../../glossary.ts';
import { V2Link } from '../../nav.tsx';
import { openNew } from '../../new/index.tsx';
import { type RoutineAllowed, type RoutineHistoryLine, type RoutineModel, type ScheduleDraft, cronText, routineCountText, routineLists, scheduleDraft, scheduleEditBody } from './routines-model.ts';
import './routines.css';

/** The relative times ("next run 14:00") are read again this often. */
const CLOCK_MS = 30_000;
/** Terminal loops and paired computers' schedules change without an event here: read again this often. */
const POLL_MS = 15_000;

function refusal(error: unknown): string {
  const failed = error instanceof ApiError ? error : new ApiError(0, String(error));
  return loopRefusal(failed.unreachable ? 0 : failed.status, failed.body);
}

function computerState(state: MachineState): 'online' | 'reconnecting' | 'offline' {
  return state === 'online' ? 'online' : state === 'reconnecting' ? 'reconnecting' : 'offline';
}

/** The routines' data: the session list (owned and CLI loops), the schedules, the terminal loops; live from `/hub`. */
function useRoutineData() {
  const sessions = useSessionListOf('open');
  const schedules = useApi(api.schedules);
  const terminal = useApi(api.terminalLoops);
  const machines = useMachines();
  const reloadSchedules = schedules.reload;
  const reloadTerminal = terminal.reload;
  useHubEvent('scheduleRun', () => reloadSchedules());
  useHubEvent('schedulesChanged', () => reloadSchedules());
  useHubEvent('sessionUpdated', useThrottled(reloadSchedules, 1_000));
  useMachineStateChange(
    useCallback(() => {
      reloadSchedules();
      reloadTerminal();
    }, [reloadSchedules, reloadTerminal]),
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      reloadTerminal();
      reloadSchedules();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [reloadSchedules, reloadTerminal]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // A paired computer's live state (it may have changed since the lists were read).
  const states = new Map(machines.map((machine) => [machine.id, machine.state]));
  const liveMachine = <T extends SessionMachine | null | undefined>(machine: T): T => {
    const state = machine ? states.get(machine.id) : undefined;
    return machine && state && state !== machine.state ? ({ ...machine, state } as T) : machine;
  };
  const statesKey = machines.map((machine) => `${machine.id}:${machine.state}`).join(',');
  const lists = useMemo(() => {
    const liveSessions: SessionListItem[] = (sessions.data ?? []).map((session) => (session.machine ? { ...session, machine: liveMachine(session.machine) } : session));
    const liveSchedules: Schedule[] = (schedules.data ?? []).map((schedule) => (schedule.machine ? { ...schedule, machine: liveMachine(schedule.machine) } : schedule));
    const liveTerminal: TerminalLoop[] = (terminal.data ?? []).map((entry) => (entry.machine ? { ...entry, machine: liveMachine(entry.machine) } : entry));
    return routineLists({ sessions: liveSessions, schedules: liveSchedules, terminalLoops: liveTerminal }, now);
  }, [sessions.data, schedules.data, terminal.data, now, statesKey]);
  const loaded = sessions.data !== null && (schedules.data !== null || schedules.error !== null);
  return { lists, loaded, reloadSchedules };
}

type Pending = { readonly kind: 'cancel' | 'edit'; readonly routine: RoutineModel } | null;

/**
 * D131 · lane A · Routines (`/routines`): every routine as a routine panel (the
 * prototype's `routinePanel()`): its schedule in plain words, its status, Pause /
 * Resume, Run now, Edit, Cancel routine (with a confirmation), disabled with the
 * reason where they cannot be used, the run history, the agent it belongs to and
 * its computer. Switchboard loops, scheduled runs, and the AI engine's own loops
 * (watched only). "New routine" opens the + New sheet.
 */
export function RoutinesPage() {
  const toast = useToast();
  const { lists, loaded, reloadSchedules } = useRoutineData();
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [showEnded, setShowEnded] = useState(false);

  const run = async (routine: RoutineModel, work: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(routine.key);
    try {
      await work();
      toast({ text: done });
      if (routine.source === 'schedule') reloadSchedules();
      return true;
    } catch (error) {
      toast({ text: `Not done: ${refusal(error)}`, tone: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const pause = (routine: RoutineModel): void => {
    const resume = routine.paused;
    const done = resume ? ROUTINES_WORDS.resumedToast : ROUTINES_WORDS.pausedToast;
    if (routine.loop) void run(routine, () => api.loopAction(routine.loop!.sessionId, routine.id, resume ? 'resume' : 'pause'), done);
    else if (routine.schedule) void run(routine, () => (resume ? api.resumeSchedule(routine.id) : api.pauseSchedule(routine.id)), done);
  };
  const runNow = (routine: RoutineModel): void => {
    if (routine.loop) void run(routine, () => api.loopAction(routine.loop!.sessionId, routine.id, 'run'), ROUTINES_WORDS.ranLoopToast.replace('{agent}', routine.agent?.name ?? 'its agent'));
    else if (routine.schedule) void run(routine, () => api.runSchedule(routine.id), ROUTINES_WORDS.ranScheduleToast);
  };
  const cancel = async (routine: RoutineModel): Promise<void> => {
    let ok = false;
    if (routine.loop) ok = await run(routine, () => api.cancelLoop(routine.loop!.sessionId, routine.id), ROUTINES_WORDS.cancelledToast);
    else if (routine.schedule) ok = await run(routine, () => api.deleteSchedule(routine.id), ROUTINES_WORDS.cancelledToast);
    if (ok) setPending(null);
  };

  const count = lists.active.length;

  return (
    <div className="v2-page v2-routines" data-testid="v2-page-routines" data-area="routines">
      <h1>{ROUTINES_WORDS.title}</h1>
      <p className="v2-page-sub">{ROUTINES_WORDS.sub}</p>
      <div className="v2-routines-crumbs">
        <b>{ROUTINES_WORDS.title}</b>
        {loaded ? <span data-testid="v2-routines-count">· {routineCountText(count)}</span> : null}
        <span className="v2-grow" />
        <Button variant="primary" size="sm" icon="plus" onClick={() => openNew({ kind: 'routine' })} data-testid="v2-routines-new">
          {ROUTINES_WORDS.newRoutine}
        </Button>
      </div>

      {!loaded ? (
        <div data-testid="v2-routines-loading" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="v2-card v2-routines-panel">
              <Skeleton width="45%" height={16} />
              <Skeleton lines={3} style={{ marginTop: 14 }} />
            </div>
          ))}
        </div>
      ) : count === 0 ? (
        <EmptyState
          icon="routine"
          tone="grey"
          title={ROUTINES_WORDS.emptyTitle}
          text={ROUTINES_WORDS.emptyText}
          testId="v2-routines-empty"
          action={
            <Button variant="primary" icon="plus" onClick={() => openNew({ kind: 'routine' })}>
              {ROUTINES_WORDS.newRoutine}
            </Button>
          }
        />
      ) : (
        <div className="v2-routines-list" data-testid="v2-routines-list">
          {lists.active.map((routine) => (
            <RoutinePanel
              key={routine.key}
              routine={routine}
              busy={busy === routine.key}
              onPause={pause}
              onRun={runNow}
              onEdit={(r) => setPending({ kind: 'edit', routine: r })}
              onCancel={(r) => setPending({ kind: 'cancel', routine: r })}
            />
          ))}
        </div>
      )}

      {lists.ended.length > 0 ? (
        <section className="v2-routines-ended">
          <Button variant="ghost" size="sm" icon={showEnded ? 'chev-down' : 'chev'} aria-expanded={showEnded} onClick={() => setShowEnded((on) => !on)} data-testid="v2-routines-show-ended">
            {showEnded ? ROUTINES_WORDS.hideEnded : ROUTINES_WORDS.showEnded} ({lists.ended.length})
          </Button>
          {showEnded ? (
            <div className="v2-routines-list" data-testid="v2-routines-ended">
              {lists.ended.map((routine) => (
                <RoutinePanel key={routine.key} routine={routine} busy={false} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <p className="v2-routines-note">
        <Icon name="sparkle" size="s" />
        <span>{ROUTINES_WORDS.formNote}</span>
      </p>

      {pending?.kind === 'cancel' ? (
        <Dialog
          open
          onClose={() => setPending(null)}
          icon="routine"
          title={ROUTINES_WORDS.cancelTitle.replace('{name}', pending.routine.name)}
          testId="v2-routines-cancel-dialog"
          footer={
            <>
              <span className="v2-grow" />
              <Button onClick={() => setPending(null)}>{ROUTINES_WORDS.keep}</Button>
              <Button variant="danger" disabled={busy === pending.routine.key} onClick={() => void cancel(pending.routine)} data-testid="v2-routines-cancel-yes">
                {ROUTINES_WORDS.cancel}
              </Button>
            </>
          }
        >
          <p style={{ margin: 0 }}>{pending.routine.source === 'loop' ? ROUTINES_WORDS.cancelLoopText : ROUTINES_WORDS.cancelScheduleText}</p>
        </Dialog>
      ) : null}
      {pending?.kind === 'edit' ? <EditRoutineDialog routine={pending.routine} onClose={() => setPending(null)} onSaved={reloadSchedules} /> : null}
    </div>
  );
}

function whyOf(allowed: RoutineAllowed): string | undefined {
  return allowed.ok ? undefined : allowed.reason;
}

const HISTORY_ICON: Readonly<Record<RoutineHistoryLine['tone'], { icon: string; word: string }>> = {
  ok: { icon: 'check', word: 'Passed' },
  fail: { icon: 'x', word: 'Failed' },
  skip: { icon: 'clock', word: 'Skipped' },
  run: { icon: 'play', word: 'Running' },
  need: { icon: 'hand', word: 'Waiting for you' },
};

/** One routine (prototype `.routine-panel`): name, status, buttons; summary; agent and computer; run history. */
function RoutinePanel({
  routine,
  busy,
  onPause,
  onRun,
  onEdit,
  onCancel,
}: {
  readonly routine: RoutineModel;
  readonly busy: boolean;
  readonly onPause?: (routine: RoutineModel) => void;
  readonly onRun?: (routine: RoutineModel) => void;
  readonly onEdit?: (routine: RoutineModel) => void;
  readonly onCancel?: (routine: RoutineModel) => void;
}) {
  const { actions } = routine;
  const reasons = [...new Set([actions.pause, actions.run, actions.edit, actions.cancel].map(whyOf).filter((why): why is string => why !== undefined))];
  const showActions = !routine.ended;
  return (
    <article className="v2-card v2-routines-panel" data-testid="v2-routines-panel" data-key={routine.key} data-source={routine.source} data-status={routine.status} aria-labelledby={`rt-${routine.key}`}>
      <div className="v2-routines-head">
        <Icon name="routine" />
        <h2 className="v2-grow v2-routines-name" id={`rt-${routine.key}`} title={routine.name} data-testid="v2-routines-name">
          {routine.name}
        </h2>
        <StatusBadge status={routine.status} label={routine.statusLabel} size="s" />
        {routine.source === 'cli' ? (
          <span className="v2-routines-watched" title={ROUTINES_WORDS.cliManaged}>
            <Icon name="eye" size="s" />
            {ROUTINES_WORDS.cliTag}
          </span>
        ) : null}
        {showActions ? (
          <div className="v2-routines-actions">
            <Button size="sm" icon={routine.paused ? 'play' : 'pause'} disabled={busy || !actions.pause.ok} title={whyOf(actions.pause)} onClick={() => onPause?.(routine)} data-testid="v2-routines-pause">
              {routine.paused ? ROUTINES_WORDS.resume : ROUTINES_WORDS.pause}
            </Button>
            <Button size="sm" variant="primary" icon="play" disabled={busy || !actions.run.ok} title={whyOf(actions.run)} onClick={() => onRun?.(routine)} data-testid="v2-routines-run">
              {ROUTINES_WORDS.runNow}
            </Button>
            <Button size="sm" icon="edit" disabled={busy || !actions.edit.ok} title={whyOf(actions.edit)} onClick={() => onEdit?.(routine)} data-testid="v2-routines-edit">
              {ROUTINES_WORDS.edit}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || !actions.cancel.ok} title={whyOf(actions.cancel)} onClick={() => onCancel?.(routine)} data-testid="v2-routines-cancel">
              {ROUTINES_WORDS.cancel}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="v2-routines-summary" data-testid="v2-routines-summary">
        {routine.summary}
      </div>
      <div className="v2-routines-meta">
        {routine.what ? <span className="v2-routines-what">{routine.what}</span> : null}
        {routine.agent ? (
          <span>
            {routine.agent.label}:{' '}
            <V2Link to={{ area: 'agent', id: routine.agent.id, tab: 'chat' }} data-testid="v2-routines-agent">
              {routine.agent.name}
            </V2Link>
          </span>
        ) : routine.terminalName ? (
          <span>{routine.terminalName}</span>
        ) : null}
        {routine.machine ? <ComputerTag name={routine.machine.name} state={computerState(routine.machine.state)} /> : null}
      </div>
      {showActions && reasons.length > 0 ? (
        <div className="v2-routines-why" data-testid="v2-routines-why">
          {reasons.join(' ')}
        </div>
      ) : null}
      <div className="v2-routines-hhead">{ROUTINES_WORDS.historyHeading}</div>
      <ul className="v2-routines-history" data-testid="v2-routines-history">
        {routine.history.length === 0 ? (
          <li className="v2-muted">{ROUTINES_WORDS.noRuns}</li>
        ) : (
          routine.history.map((line, index) => (
            <li key={`${line.time}-${index}`} className="v2-routines-hline" data-tone={line.tone} data-testid="v2-routines-hline">
              <span className="v2-mono v2-routines-htime">{line.time}</span>
              <span className="v2-routines-hicon" title={HISTORY_ICON[line.tone].word}>
                <Icon name={HISTORY_ICON[line.tone].icon} size="s" />
                <span className="v2-sr">{HISTORY_ICON[line.tone].word}: </span>
              </span>
              <span>{line.text}</span>
            </li>
          ))
        )}
      </ul>
    </article>
  );
}

type LoopKind = LoopDraft['kind'];

/**
 * Edit a routine in place: a Switchboard loop (`updateLoop`: name, what, how often)
 * or a scheduled run (its cron and prompt, the rest of its settings kept).
 * Lane R's + New sheet only creates, so editing lives here.
 */
function EditRoutineDialog({ routine, onClose, onSaved }: { readonly routine: RoutineModel; readonly onClose: () => void; readonly onSaved: () => void }) {
  const toast = useToast();
  const [loopDraft, setLoopDraft] = useState<LoopDraft | null>(() => (routine.loop ? draftFromLoop(routine.loop) : null));
  const [schedDraft, setSchedDraft] = useState<ScheduleDraft | null>(() => (routine.schedule ? scheduleDraft(routine.schedule) : null));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setError(null);
    try {
      if (routine.loop && loopDraft) {
        const checked = draftInput(loopDraft, new Date());
        if (!checked.ok) {
          setError(checked.error);
          return;
        }
        setSaving(true);
        await api.updateLoop(routine.loop.sessionId, routine.id, checked.input);
      } else if (routine.schedule && schedDraft) {
        const checked = scheduleEditBody(routine.schedule, schedDraft);
        if (!checked.ok) {
          setError(checked.error);
          return;
        }
        setSaving(true);
        await api.createSchedule(checked.body);
        onSaved();
      }
      toast({ text: ROUTINES_WORDS.savedToast });
      onClose();
    } catch (failure) {
      setError(refusal(failure));
    } finally {
      setSaving(false);
    }
  };

  const kinds: { value: LoopKind; label: string }[] = [
    { value: 'every', label: ROUTINES_WORDS.howEvery },
    { value: 'cron', label: ROUTINES_WORDS.howCron },
    { value: 'at', label: ROUTINES_WORDS.howAt },
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      icon="routine"
      title={`${ROUTINES_WORDS.editTitle} · ${routine.name}`}
      testId="v2-routines-edit-dialog"
      footer={
        <>
          <span className="v2-grow" />
          <Button onClick={onClose}>{ROUTINES_WORDS.close}</Button>
          <Button variant="primary" icon="check" disabled={saving} onClick={() => void save()} data-testid="v2-routines-edit-save">
            {ROUTINES_WORDS.save}
          </Button>
        </>
      }
    >
      {loopDraft ? (
        <div className="v2-routines-form">
          <Field label={ROUTINES_WORDS.fieldName} hint={ROUTINES_WORDS.fieldNameHint} value={loopDraft.label} maxLength={60} onChange={(event) => setLoopDraft({ ...loopDraft, label: event.target.value })} data-testid="v2-routines-edit-name" />
          <TextArea label={ROUTINES_WORDS.fieldWhat} value={loopDraft.prompt} onChange={(event) => setLoopDraft({ ...loopDraft, prompt: event.target.value })} data-testid="v2-routines-edit-what" />
          <div className="v2-label">{ROUTINES_WORDS.fieldHow}</div>
          <Segmented options={kinds} value={loopDraft.kind} onChange={(kind) => setLoopDraft({ ...loopDraft, kind })} label={ROUTINES_WORDS.fieldHow} testId="v2-routines-edit-kind" />
          {loopDraft.kind === 'every' ? (
            <Field label={ROUTINES_WORDS.fieldEvery} type="number" min={1} value={loopDraft.every} onChange={(event) => setLoopDraft({ ...loopDraft, every: event.target.value })} data-testid="v2-routines-edit-every" />
          ) : loopDraft.kind === 'cron' ? (
            <Field label={ROUTINES_WORDS.fieldCron} hint={loopDraft.cron.trim() ? cronText(loopDraft.cron) : undefined} value={loopDraft.cron} onChange={(event) => setLoopDraft({ ...loopDraft, cron: event.target.value })} data-testid="v2-routines-edit-cron" />
          ) : (
            <Field label={ROUTINES_WORDS.fieldAt} type="datetime-local" value={loopDraft.at} onChange={(event) => setLoopDraft({ ...loopDraft, at: event.target.value })} data-testid="v2-routines-edit-at" />
          )}
        </div>
      ) : schedDraft ? (
        <div className="v2-routines-form">
          <TextArea label={ROUTINES_WORDS.fieldWhat} value={schedDraft.what} onChange={(event) => setSchedDraft({ ...schedDraft, what: event.target.value })} data-testid="v2-routines-edit-what" />
          <Field label={ROUTINES_WORDS.fieldCron} hint={schedDraft.cron.trim() ? cronText(schedDraft.cron) : undefined} value={schedDraft.cron} onChange={(event) => setSchedDraft({ ...schedDraft, cron: event.target.value })} data-testid="v2-routines-edit-cron" />
        </div>
      ) : null}
      <p className="v2-muted v2-routines-form-note">{ROUTINES_WORDS.formNote}</p>
      {error ? (
        <p className="v2-field-error" role="alert" data-testid="v2-routines-edit-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
