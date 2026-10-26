import { useMemo, useState } from 'react';
import { ApiError, api } from '../../api/client.ts';
import { useTick } from '../../activity/useActivity.ts';
import { loopRefusal } from '../../views/owned-loops.ts';
import { Button, Dialog, Icon, Popover, useToast } from '../components/index.ts';
import { ROUTINES_WORDS } from '../glossary.ts';
import { EditRoutineDialog } from '../agents/routines/RoutinesPage.tsx';
import type { RoutineAllowed } from '../agents/routines/routines-model.ts';
import { type AgentRoutineItem, type AgentRoutines, agentRoutines } from './routines-indicator.ts';
import type { AgentData } from './useAgent.ts';

/** Relative times ("next 14:00", "stale") are read again this often. */
const CLOCK_MS = 30_000;

function refusal(error: unknown): string {
  const failed = error instanceof ApiError ? error : new ApiError(0, String(error));
  return loopRefusal(failed.unreachable ? 0 : failed.status, failed.body);
}

function why(allowed: RoutineAllowed): string | undefined {
  return allowed.ok ? undefined : allowed.reason;
}

/** The agent's loops and schedules (`routines-indicator.ts`), live with its detail (`sessionUpdated`). */
export function useAgentRoutines(data: AgentData): AgentRoutines {
  const now = useTick(CLOCK_MS);
  const session = data.session;
  return useMemo(() => {
    if (!session) return agentRoutines(null, now);
    // A paired computer's live state (offline blocks the actions with its reason).
    const live = data.machine && session.machine ? { ...session, machine: data.machine } : session;
    return agentRoutines(live, now);
  }, [session, data.machine, now]);
}

type Pending = { readonly kind: 'edit' | 'cancel'; readonly item: AgentRoutineItem } | null;

/**
 * The actions of the agent's routines (Pause / Resume, Run now, Edit, Cancel with
 * a confirmation) and the dialogs they open. The dialogs live with the caller, not
 * inside the popover, so they stay open when the popover closes.
 */
function useRoutineActions(data: AgentData) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const act = async (item: AgentRoutineItem, work: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(item.key);
    try {
      await work();
      toast({ text: done });
      data.reload();
      return true;
    } catch (error) {
      toast({ text: `Not done: ${refusal(error)}`, tone: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const handlers = {
    busy,
    pause: (item: AgentRoutineItem): void => {
      const loop = item.loop;
      if (!loop) return;
      const resume = loop.state === 'paused';
      void act(item, () => api.loopAction(loop.sessionId, loop.id, resume ? 'resume' : 'pause'), resume ? ROUTINES_WORDS.resumedToast : ROUTINES_WORDS.pausedToast);
    },
    run: (item: AgentRoutineItem): void => {
      const loop = item.loop;
      if (!loop) return;
      void act(item, () => api.loopAction(loop.sessionId, loop.id, 'run'), ROUTINES_WORDS.ranLoopToast.replace('{agent}', item.routine.agent?.name ?? 'its agent'));
    },
    edit: (item: AgentRoutineItem): void => setPending({ kind: 'edit', item }),
    cancel: (item: AgentRoutineItem): void => setPending({ kind: 'cancel', item }),
  };
  const confirmCancel = async (item: AgentRoutineItem): Promise<void> => {
    const loop = item.loop;
    if (!loop) return;
    if (await act(item, () => api.cancelLoop(loop.sessionId, loop.id), ROUTINES_WORDS.cancelledToast)) setPending(null);
  };
  const dialogs =
    pending?.kind === 'cancel' ? (
      <Dialog
        open
        onClose={() => setPending(null)}
        icon="routine"
        title={ROUTINES_WORDS.cancelTitle.replace('{name}', pending.item.name)}
        testId="v2-agent-routine-cancel-dialog"
        footer={
          <>
            <span className="v2-grow" />
            <Button onClick={() => setPending(null)}>{ROUTINES_WORDS.keep}</Button>
            <Button variant="danger" disabled={busy === pending.item.key} onClick={() => void confirmCancel(pending.item)} data-testid="v2-agent-routine-cancel-yes">
              {ROUTINES_WORDS.cancel}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{ROUTINES_WORDS.cancelLoopText}</p>
      </Dialog>
    ) : pending?.kind === 'edit' ? (
      <EditRoutineDialog routine={pending.item.routine} onClose={() => setPending(null)} onSaved={data.reload} />
    ) : null;
  return { handlers, dialogs };
}

type Handlers = ReturnType<typeof useRoutineActions>['handlers'];

const LAST_ICON: Readonly<Record<NonNullable<AgentRoutineItem['last']>['tone'], string>> = { ok: 'check', fail: 'x', skip: 'clock', run: 'play', need: 'hand' };

/** One loop or schedule: name, kind, schedule · next, last result, state, the actions (CLI ones disabled with the reason). */
function RoutineRow({ item, handlers, blocked }: { readonly item: AgentRoutineItem; readonly handlers: Handlers; readonly blocked: string | null }) {
  const { actions } = item.routine;
  const off = (allowed: RoutineAllowed): boolean => handlers.busy === item.key || !allowed.ok || blocked !== null;
  const title = (allowed: RoutineAllowed): string | undefined => blocked ?? why(allowed);
  const paused = item.state === 'paused';
  const reasons = item.source === 'cli' ? ROUTINES_WORDS.cliManaged : null;
  return (
    <li className="v2-ag-rt" data-testid="v2-agent-routine" data-key={item.key} data-source={item.source} data-state={item.state}>
      <div className="v2-ag-rt-head">
        <Icon name={item.source === 'cli' ? 'eye' : 'routine'} size="s" />
        <b className="v2-ag-rt-name" title={item.what || item.name} data-testid="v2-agent-routine-name">
          {item.name}
        </b>
        {item.kindText !== item.name ? <span className="v2-ag-rt-kind">{item.kindText}</span> : null}
      </div>
      {item.what && item.what !== item.name ? (
        <div className="v2-ag-rt-what v2-muted" title={item.what}>
          {item.what}
        </div>
      ) : null}
      <div className="v2-ag-rt-line" data-testid="v2-agent-routine-when">
        {item.scheduleText}
        {item.nextText ? ` · next ${item.nextText}` : ''}
      </div>
      <div className="v2-ag-rt-line v2-muted">
        <span className="v2-ag-rt-state" data-state={item.state} data-testid="v2-agent-routine-state">
          {item.stateText}
        </span>
        {item.last ? (
          <span className="v2-ag-rt-last" data-tone={item.last.tone} data-testid="v2-agent-routine-last">
            {' · last: '}
            <Icon name={LAST_ICON[item.last.tone] ?? 'clock'} size="s" />
            {item.last.text}
          </span>
        ) : (
          <span data-testid="v2-agent-routine-last"> · no runs yet</span>
        )}
      </div>
      <div className="v2-ag-rt-actions">
        <Button size="sm" icon={paused ? 'play' : 'pause'} disabled={off(actions.pause)} title={title(actions.pause)} onClick={() => handlers.pause(item)} data-testid="v2-agent-routine-pause">
          {paused ? ROUTINES_WORDS.resume : ROUTINES_WORDS.pause}
        </Button>
        <Button size="sm" variant="ghost" icon="play" disabled={off(actions.run)} title={title(actions.run)} onClick={() => handlers.run(item)} data-testid="v2-agent-routine-run">
          {ROUTINES_WORDS.runNow}
        </Button>
        <Button size="sm" variant="ghost" icon="edit" disabled={off(actions.edit)} title={title(actions.edit)} onClick={() => handlers.edit(item)} data-testid="v2-agent-routine-edit">
          {ROUTINES_WORDS.edit}
        </Button>
        <Button size="sm" variant="ghost" disabled={off(actions.cancel)} title={title(actions.cancel)} aria-label={`Cancel ${item.name}`} onClick={() => handlers.cancel(item)} data-testid="v2-agent-routine-cancel">
          Cancel
        </Button>
      </div>
      {reasons ? (
        <div className="v2-ag-rt-why v2-muted" data-testid="v2-agent-routine-why">
          {reasons}
        </div>
      ) : null}
    </li>
  );
}

function RoutineList({ routines, handlers, blocked, testId }: { readonly routines: AgentRoutines; readonly handlers: Handlers; readonly blocked: string | null; readonly testId: string }) {
  return (
    <ul className="v2-ag-rts" data-testid={testId} data-count={routines.count}>
      {routines.items.map((item) => (
        <RoutineRow key={item.key} item={item} handlers={handlers} blocked={blocked} />
      ))}
    </ul>
  );
}

/**
 * Fix after 2.0 · the dock status row's routines part ("⏰ Next: Nightly check 14:00 ·
 * 2 routines"; "14:00 · 2" on a phone and in the peek). Click: a popover listing every
 * loop and schedule of the agent with its actions. Hidden when it has none.
 */
export function RoutinesIndicator({ data, compact }: { readonly data: AgentData; readonly compact: boolean }) {
  const routines = useAgentRoutines(data);
  const { handlers, dialogs } = useRoutineActions(data);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (routines.count === 0) return dialogs;
  return (
    <>
      <span className="v2-ag-sep" aria-hidden="true">
        ·
      </span>
      <button
        type="button"
        ref={setAnchor}
        className="v2-ag-spart v2-ag-rt-ind"
        data-tone={routines.tone}
        data-testid="v2-agent-routines"
        data-count={routines.count}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={routines.text}
        aria-label={`Routines: ${routines.text}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="clock" size="s" />
        <span className="v2-ag-rt-ind-text">{compact ? routines.short : routines.text}</span>
        <Icon name="chev" size="s" className="v2-ag-chev" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Routines of this agent" align="start" width={420} testId="v2-agent-routines-pop">
        <h4>
          Routines · {routines.count}
          {routines.next ? ` · next ${routines.next.nextText}` : ''}
        </h4>
        <RoutineList routines={routines} handlers={handlers} blocked={data.blocked} testId="v2-agent-routines-list" />
      </Popover>
      {dialogs}
    </>
  );
}

/** The side panel's Routines group body: the same items and actions as the popover. */
export function RoutinesGroupBody({ data, routines }: { readonly data: AgentData; readonly routines: AgentRoutines }) {
  const { handlers, dialogs } = useRoutineActions(data);
  return (
    <>
      <RoutineList routines={routines} handlers={handlers} blocked={data.blocked} testId="v2-agent-side-routines" />
      {dialogs}
    </>
  );
}
