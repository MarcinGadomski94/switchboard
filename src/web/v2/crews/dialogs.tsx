import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionModelOption } from '../../../core/api.ts';
import { type CrewMoveCheck, type CrewMoveRun, type TeamCharter, type TeamMember, type TeamMoveRun, type TeamSuggestion, type TeamSummary, crewMoveSummary } from '../../../core/team.ts';
import type { TakeoverPreview } from '../../../core/takeover.ts';
import { EMPTY_CHOICE, type MoveChoice, choiceAfterPreview, choiceBody, shareChoice, stashLines } from '../../takeover/complete-move.ts';
import { MovePlanPanel } from '../agent/MovePlan.tsx';
import type { TeamTemplate } from '../../../core/team-templates.ts';
import { api } from '../../api/client.ts';
import { useMachines } from '../../api/useMachines.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { type MoveCheck, refusalText, teamApi } from '../../team/api.ts';
import { draftCharter } from '../../team/charter-draft.ts';
import { useTeamSwitch } from '../../team/hidden.ts';
import { EMPTY_FORM, type MemberForm, formBody, formFromSuggestion, formFromTemplate, newMemberSession } from '../../team/model.ts';
import { Button, Checkbox, Chip, Dialog, Field, Select, TextArea, useToast } from '../components/index.ts';
import { CREW_WORDS, WORDS } from '../glossary.ts';
import { MOVE_POLL_ERRORS, type MoveProgress, checkBudget, computerChoices, moveProgress, moveTargetReason } from './crew-model.ts';
import { reloadTeam } from '../../team/useTeamData.ts';

/**
 * D131 · lane P · the Crews dialogs: New crew, Rename, Delete, Move to crew… (with Undo by the
 * caller), Move to computer… (D100's move: the take-over's checks, then the run), Budget, Model,
 * a job description's Edit (D105), and **New teammate** (role templates, the suggestions, or an
 * existing agent adopted).
 */

function ErrorLine({ text }: { readonly text: string | null }) {
  return text ? (
    <p className="v2-field-error" role="alert">
      {text}
    </p>
  ) : null;
}

/** New crew: a name; it goes last in the order. */
export function NewCrewDialog({ onClose, onCreated }: { readonly onClose: () => void; readonly onCreated: (crew: TeamSummary) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async (): Promise<void> => {
    try {
      onCreated(await teamApi.createTeam(name.trim()));
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={CREW_WORDS.newCrew}
      icon="crew"
      testId="v2-new-crew"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={name.trim() === ''} onClick={() => void create()} data-testid="v2-new-crew-go">
            Create crew
          </Button>
        </>
      }
    >
      <Field label="Crew name" value={name} autoFocus maxLength={60} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && name.trim() !== '' && void create()} data-testid="v2-new-crew-name" />
      <p className="v2-muted v2-c-small">It goes last in your crew order. Add teammates next.</p>
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Rename a crew. */
export function RenameCrewDialog({ crew, onClose, onDone }: { readonly crew: TeamSummary; readonly onClose: () => void; readonly onDone: () => void }) {
  const [name, setName] = useState(crew.name);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    try {
      await teamApi.rename(name.trim(), crew.id);
      onDone();
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <Dialog open onClose={onClose} title="Rename crew" icon="edit" testId="v2-rename-crew" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={name.trim() === ''} onClick={() => void save()}>Rename</Button></>}>
      <Field label="Name" value={name} autoFocus maxLength={60} onChange={(event) => setName(event.currentTarget.value)} />
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Delete a crew: its teammates go back to Agents as plain agents. */
export function DeleteCrewDialog({ crew, onClose, onDone }: { readonly crew: TeamSummary; readonly onClose: () => void; readonly onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete crew “${crew.name}”?`}
      icon="trash"
      testId="v2-delete-crew"
      footer={
        <>
          <Button onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              try {
                await teamApi.deleteTeam(crew.id);
                onDone();
              } catch (e) {
                setError(refusalText(e));
              }
            }}
          >
            Delete crew
          </Button>
        </>
      }
    >
      <p className="v2-c-p">Its {crew.members} teammate{crew.members === 1 ? '' : 's'} go back to Agents with their chats, tasks and routines. No agent is deleted.</p>
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Move to crew…: the crews as a radio list (↑ ↓ pick, ↩ moves). */
export function MoveToCrewDialog({ member, crews, onClose, onMove }: { readonly member: TeamMember; readonly crews: readonly TeamSummary[]; readonly onClose: () => void; readonly onMove: (crewId: string) => void }) {
  const [pick, setPick] = useState(member.teamId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move ${member.name} to crew`}
      icon="crew"
      testId="v2-move-crew"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pick === member.teamId} onClick={() => onMove(pick)} data-testid="v2-move-crew-go">
            Move to crew
          </Button>
        </>
      }
    >
      <p className="v2-muted v2-c-small">Keeps its chat, job description and budget.</p>
      <div className="v2-c-pick" role="radiogroup" aria-label="Crews">
        {crews.map((crew) => (
          <label key={crew.id} className="v2-c-pick-row" data-testid="v2-move-crew-option" data-crew={crew.id}>
            <input
              type="radio"
              name="v2-move-crew"
              checked={pick === crew.id}
              onChange={() => setPick(crew.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && pick !== member.teamId) onMove(pick);
              }}
            />
            <span className="v2-grow">{crew.name}</span>
            <span className="v2-muted v2-c-small">{crew.id === member.teamId ? 'now' : CREW_WORDS.teammates(crew.members)}</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

/** How often a running move is read again, and for how long (a take-over with a large conversation takes minutes). */
const MOVE_POLL_MS = 2_000;
const MOVE_WAIT_MS = 15 * 60_000;

/**
 * Move to computer…: the computers (offline / reconnecting ones disabled, and Move says why),
 * the move's checks, then the move run (D100 / D65). The dialog stays open while it moves and
 * shows how it ended: a failure with its reason (nothing changed, Try again), success only once
 * the teammate's record names the new computer (the crew page is read again then). Closed while
 * moving, it keeps following the run and says the outcome in a toast (a failure stays longer).
 */
export function MoveToComputerDialog({ member, onClose }: { readonly member: TeamMember; readonly onClose: () => void }) {
  const machines = useMachines();
  const [self, setSelf] = useState<{ id: string; name: string } | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'checking' | 'moving'>('idle');
  const [progress, setProgress] = useState<MoveProgress | null>(null);
  // D152: the move's plan on the picked computer (the take-over's preview) and what the developer chose in it.
  const [plan, setPlan] = useState<MoveCheck | null>(null);
  const [choice, setChoice] = useState<MoveChoice>(EMPTY_CHOICE);
  const ask = useRef(0);
  const open = useRef(true);
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    api
      .machines()
      .then((view) => alive && setSelf({ id: view.self.id, name: view.self.name }))
      .catch(() => alive && setSelf({ id: 'self', name: 'This computer' }));
    return () => {
      alive = false;
      open.current = false;
    };
  }, []);
  const choices = self ? computerChoices(member, self, machines) : [];
  const nameOf = (id: string): string => choices.find((choice) => choice.id === id)?.name ?? 'the other computer';
  const targetWhy = pick === null ? null : moveTargetReason(choices, pick);
  /** Asks the teammate's computer for the move's plan on `target` with `next` (the first ask: the remembered folders). */
  const loadPlan = (target: string, next: MoveChoice | undefined): void => {
    const n = ++ask.current;
    teamApi.moveCheck(member.id, target, next ? choiceBody(next, true) : {}).then(
      (answer) => {
        if (n !== ask.current) return;
        setPlan(answer);
        setBlockers(answer.blockers);
        if (answer.preview) setChoice((current) => choiceAfterPreview(next ?? current, answer.preview as TakeoverPreview));
      },
      (caught: unknown) => n === ask.current && setError(refusalText(caught)),
    );
  };
  useEffect(() => {
    setPlan(null);
    setChoice(EMPTY_CHOICE);
    setBlockers([]);
    if (pick !== null && moveTargetReason(choices, pick) === null) loadPlan(pick, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick]);
  /** Follows the run until it ends; the outcome goes to the dialog while it is open, else to a toast. */
  const follow = async (runId: string, target: string): Promise<void> => {
    const targetName = nameOf(target);
    const until = Date.now() + MOVE_WAIT_MS;
    let pollErrors = 0;
    let pollError: string | null = null;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, MOVE_POLL_MS));
      let run: TeamMoveRun | null = null;
      try {
        run = await teamApi.moveRun(runId);
        pollErrors = 0;
      } catch (caught) {
        pollErrors += 1;
        pollError = refusalText(caught);
      }
      let memberMachineId: string | null | undefined;
      let currentName: string | undefined;
      if (run?.state === 'done' || run?.state === 'failed' || pollErrors >= MOVE_POLL_ERRORS) {
        // Read the teammate again: success is what its record says, not what the run says.
        await reloadTeam();
        const now = await teamApi
          .view(member.teamId)
          .then((view) => view.members.find((entry) => entry.id === member.id) ?? null)
          .catch(() => undefined);
        if (now !== undefined) {
          memberMachineId = now?.machineId ?? null;
          currentName = now?.machineName;
        }
      }
      const progress = moveProgress({ run, memberName: member.name, targetName, memberMachineId, ...(currentName ? { currentName } : {}), pollErrors, pollError, timedOut: Date.now() > until });
      // D153: a stash the move made on the target is kept: say where and how to restore it.
      const stashed = stashLines(run?.stashes).join(' ');
      const next = progress.kind !== 'moving' && stashed !== '' ? { ...progress, text: `${progress.text} ${stashed}` } : progress;
      if (next.kind === 'moving') {
        if (open.current) setProgress(next);
        continue;
      }
      if (open.current) {
        setProgress(next);
        setState('idle');
        if (next.kind === 'done') {
          toast({ text: next.text });
          onClose();
        }
      } else {
        toast(next.kind === 'done' ? { text: next.text } : { text: next.text, tone: 'error', ms: 15_000 });
      }
      return;
    }
  };
  const move = async (): Promise<void> => {
    if (!pick || targetWhy !== null) return;
    setState('checking');
    setError(null);
    setBlockers([]);
    setProgress(null);
    try {
      const body = plan?.preview ? choiceBody(choice, true) : {};
      const check = await teamApi.moveCheck(member.id, pick, body);
      setPlan(check);
      if (!check.ok) {
        setBlockers(check.blockers);
        setState('idle');
        return;
      }
      setState('moving');
      const run = await teamApi.move(member.id, pick, body);
      setProgress({ kind: 'moving', text: `Moving ${member.name} to ${nameOf(pick)}…` });
      void follow(run.id, pick);
    } catch (e) {
      setError(refusalText(e));
      setState('idle');
    }
  };
  const failed = progress?.kind === 'failed';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move “${member.name}” to a computer`}
      icon="desktop"
      testId="v2-move-computer"
      footer={
        <>
          <Button onClick={onClose}>{state === 'moving' ? 'Hide' : 'Cancel'}</Button>
          <Button variant="primary" disabled={!pick || targetWhy !== null || state !== 'idle'} title={targetWhy ?? undefined} onClick={() => void move()} data-testid="v2-move-computer-go">
            {state === 'checking' ? 'Checking…' : state === 'moving' ? 'Moving…' : failed ? 'Try again' : 'Move'}
          </Button>
        </>
      }
    >
      <p className="v2-muted v2-c-small">Move it when it is not working: it continues on the new computer with its chat, tasks, routines and separate copies.</p>
      <div className="v2-c-pick" role="radiogroup" aria-label="Computers">
        {choices.map((choice) => (
          <label key={choice.id} className="v2-c-pick-row" data-testid="v2-move-computer-option" data-machine={choice.id} data-disabled={choice.disabledReason !== null || undefined}>
            <input type="radio" name="v2-move-computer" disabled={state !== 'idle' || choice.current || choice.disabledReason !== null} checked={pick === choice.id} onChange={() => setPick(choice.id)} />
            <span className="v2-grow">
              {choice.name}
              {choice.current ? <span className="v2-muted v2-c-small"> · now</span> : null}
            </span>
            {choice.disabledReason ? <span className="v2-muted v2-c-small">{choice.disabledReason}</span> : null}
          </label>
        ))}
      </div>
      {pick !== null && targetWhy !== null ? (
        <p className="v2-muted v2-c-small" data-testid="v2-move-computer-why">
          {targetWhy}
        </p>
      ) : null}
      {pick !== null && targetWhy === null && plan?.preview && state === 'idle' && progress?.kind !== 'moving' ? (
        <MovePlanPanel
          preview={plan.preview}
          machine={pick}
          sourceName={plan.preview.source.machine.name}
          targetName={nameOf(pick)}
          choice={choice}
          onChange={(next) => {
            setChoice(next);
            loadPlan(pick, next);
          }}
          onEdit={setChoice}
        />
      ) : null}
      {blockers.length > 0 ? (
        <ul className="v2-c-blockers" data-testid="v2-move-computer-blockers">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
      {progress ? (
        <p className={progress.kind === 'failed' ? 'v2-field-error' : 'v2-muted v2-c-small'} role={progress.kind === 'failed' ? 'alert' : 'status'} data-testid="v2-move-computer-progress" data-state={progress.kind}>
          {progress.text}
        </p>
      ) : null}
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** How often a running crew move is read again. */
const CREW_POLL_MS = 1_500;

/**
 * D152 · **Move crew to computer…** (`docs/team.md` → *Moving a whole crew*): one dialog for
 * the whole crew. Pick the computer; every teammate is checked at once (all blockers shown
 * together, per teammate), each with the move's plan (the workspace on the target, each repo
 * used or cloned, the workspace files); a choice for a workspace or a repo that teammates share
 * applies to all of them. **Move crew** moves them one by one in the crew's order; a failure
 * stops the rest, and the dialog says who moved and who did not.
 */
export function MoveCrewDialog({ crew, onClose }: { readonly crew: TeamSummary; readonly onClose: () => void }) {
  const machines = useMachines();
  const [self, setSelf] = useState<{ id: string; name: string } | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [check, setCheck] = useState<CrewMoveCheck | null>(null);
  const [choices, setChoices] = useState<Record<string, MoveChoice>>({});
  const [run, setRun] = useState<CrewMoveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    api.machines().then(
      (view) => alive && setSelf({ id: view.self.id, name: view.self.name }),
      () => alive && setSelf({ id: 'self', name: 'This computer' }),
    );
    return () => {
      alive = false;
      window.clearTimeout(timer.current);
    };
  }, []);
  const targets = self ? [{ id: self.id, name: self.name, state: 'online' as const }, ...machines.map((machine) => ({ id: machine.id, name: machine.name, state: machine.state }))] : [];
  const nameOf = (id: string): string => targets.find((entry) => entry.id === id)?.name ?? 'the other computer';
  const previews = useMemo(() => Object.fromEntries((check?.members ?? []).map((member) => [member.memberId, (member.preview ?? null) as TakeoverPreview | null])), [check]);
  const bodies = (next: Readonly<Record<string, MoveChoice>>): Record<string, ReturnType<typeof choiceBody>> => Object.fromEntries(Object.entries(next).map(([id, value]) => [id, choiceBody(value, true)]));
  const loadCheck = (target: string, next: Readonly<Record<string, MoveChoice>> | null): void => {
    const n = ++ask.current;
    setError(null);
    teamApi.crewMoveCheck(crew.id, target, next ? bodies(next) : {}).then(
      (answer) => {
        if (n !== ask.current) return;
        setCheck(answer);
        setChoices((current) => {
          const base = next ?? current;
          const out: Record<string, MoveChoice> = {};
          for (const member of answer.members) {
            const preview = (member.preview ?? null) as TakeoverPreview | null;
            out[member.memberId] = preview ? choiceAfterPreview(base[member.memberId] ?? EMPTY_CHOICE, preview) : (base[member.memberId] ?? EMPTY_CHOICE);
          }
          return out;
        });
      },
      (caught: unknown) => n === ask.current && setError(refusalText(caught)),
    );
  };
  useEffect(() => {
    setCheck(null);
    setChoices({});
    if (pick !== null) loadCheck(pick, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick]);
  const follow = (runId: string): void => {
    teamApi.crewMoveRun(runId).then(
      (next) => {
        setRun(next);
        if (next.state === 'running') timer.current = window.setTimeout(() => follow(runId), CREW_POLL_MS);
        else {
          setBusy(false);
          void reloadTeam();
          if (next.state === 'done') toast({ text: crewMoveSummary(next, nameOf(next.targetMachineId)) });
        }
      },
      () => {
        timer.current = window.setTimeout(() => follow(runId), CREW_POLL_MS * 2);
      },
    );
  };
  const move = async (): Promise<void> => {
    if (!pick || !check?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const started = await teamApi.crewMove(crew.id, pick, bodies(choices));
      setRun(started);
      follow(started.id);
    } catch (caught) {
      setBusy(false);
      setError(refusalText(caught));
      loadCheck(pick, choices);
    }
  };
  const moving = run?.state === 'running';
  const blocked = (check?.members ?? []).filter((member) => member.state === 'blocked');
  const why = pick === null ? 'Pick a computer.' : check === null ? 'Checking every teammate…' : blocked.length > 0 ? `${blocked.length} teammate${blocked.length === 1 ? '' : 's'} cannot move yet: see below.` : !check.ok ? 'Every teammate runs there already.' : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move “${crew.name}” to a computer`}
      icon="desktop"
      width={760}
      testId="v2-move-crew-computer"
      footer={
        <>
          {!run && why !== null ? (
            <span className="v2-muted v2-grow v2-c-small" data-testid="v2-move-crew-why" role="status">
              {why}
            </span>
          ) : (
            <span className="v2-grow" />
          )}
          <Button onClick={onClose}>{moving ? 'Hide' : run ? 'Close' : 'Cancel'}</Button>
          {run?.state === 'failed' ? (
            <Button
              data-testid="v2-move-crew-again"
              onClick={() => {
                setRun(null);
                if (pick) loadCheck(pick, choices);
              }}
            >
              Check the rest again
            </Button>
          ) : null}
          {!run ? (
            <Button variant="primary" icon="desktop" disabled={why !== null || busy} title={why ?? undefined} onClick={() => void move()} data-testid="v2-move-crew-go">
              {busy ? 'Moving…' : 'Move crew'}
            </Button>
          ) : null}
        </>
      }
    >
      <p className="v2-muted v2-c-small">Every teammate is checked first; then they move one at a time, in the crew’s order. If one fails, the rest stay where they are and the ones that moved stay moved.</p>
      {!run ? (
        <div className="v2-c-pick" role="radiogroup" aria-label="Computers">
          {targets.map((target) => (
            <label key={target.id} className="v2-c-pick-row" data-testid="v2-move-crew-option" data-machine={target.id}>
              <input type="radio" name="v2-move-crew-computer" disabled={target.state !== 'online'} checked={pick === target.id} onChange={() => setPick(target.id)} />
              <span className="v2-grow">{target.name}</span>
              {target.state !== 'online' ? <span className="v2-muted v2-c-small">{target.state === 'reconnecting' ? 'Reconnecting…' : 'Offline'}</span> : null}
            </label>
          ))}
        </div>
      ) : null}
      <div className="v2-mp-crew" data-testid="v2-move-crew-members">
        {(run?.members ?? check?.members ?? []).map((member) => {
          const preview = previews[member.memberId] ?? null;
          const tone = member.state === 'moved' || member.state === 'ready' ? 'green' : member.state === 'blocked' || member.state === 'failed' ? 'red' : member.state === 'moving' ? 'blue' : 'grey';
          return (
            <details key={member.memberId} className="v2-mp-mate" data-testid="v2-move-crew-member" data-member={member.memberId} data-state={member.state} open={member.state === 'blocked' || member.state === 'failed'}>
              <summary>
                <Chip tone={tone} size="s">
                  {member.state === 'ready' ? 'ready' : member.state === 'not-moved' ? 'not moved' : member.state}
                </Chip>
                <b className="v2-grow">{member.name}</b>
                <span className="v2-muted v2-c-small">{member.note ?? (member.blockers.length > 0 ? member.blockers[0] : '')}</span>
              </summary>
              {member.blockers.length > 0 ? (
                <ul className="v2-c-blockers" data-testid="v2-move-crew-blockers">
                  {member.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : null}
              {!run && preview && pick ? (
                <MovePlanPanel
                  preview={preview}
                  machine={pick}
                  sourceName={preview.source.machine.name}
                  targetName={nameOf(pick)}
                  choice={choices[member.memberId] ?? EMPTY_CHOICE}
                  testId="v2-move-crew-plan"
                  onEdit={(next) => setChoices((current) => ({ ...current, [member.memberId]: next }))}
                  onChange={(next) => {
                    const shared = shareChoice(choices, previews, member.memberId, next);
                    setChoices(shared);
                    loadCheck(pick, shared);
                  }}
                />
              ) : null}
            </details>
          );
        })}
      </div>
      {run && run.state !== 'running' ? (
        <p className={run.state === 'failed' ? 'v2-field-error' : 'v2-muted v2-c-small'} role={run.state === 'failed' ? 'alert' : 'status'} data-testid="v2-move-crew-result" data-state={run.state}>
          {run.state === 'failed' ? `${run.error ?? ''} ${crewMoveSummary(run, nameOf(run.targetMachineId))}` : crewMoveSummary(run, nameOf(run.targetMachineId))}
        </p>
      ) : run ? (
        <p className="v2-muted v2-c-small" role="status" data-testid="v2-move-crew-result" data-state="running">
          {crewMoveSummary(run, nameOf(run.targetMachineId))}
        </p>
      ) : null}
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Budget: the teammate's daily share of its account's usage (empty = none). */
export function BudgetDialog({ member, onClose }: { readonly member: TeamMember; readonly onClose: () => void }) {
  const [value, setValue] = useState(member.budget.dailyPct === null ? '' : String(member.budget.dailyPct));
  const [error, setError] = useState<string | null>(null);
  const check = checkBudget(value);
  const toast = useToast();
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Budget · ${member.name}`}
      icon="wallet"
      testId="v2-budget-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!check.ok}
            onClick={async () => {
              if (!check.ok) return;
              try {
                await teamApi.updateMember(member.id, { budget: { dailyPct: check.dailyPct, profileId: member.budget.profileId } });
                toast({ text: check.dailyPct === null ? `${member.name} has no budget now.` : `${member.name} may use ${check.dailyPct}% of its account a day.` });
                onClose();
              } catch (e) {
                setError(refusalText(e));
              }
            }}
            data-testid="v2-budget-save"
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Share of the account’s daily usage (%)" inputMode="numeric" value={value} autoFocus onChange={(event) => setValue(event.currentTarget.value)} error={check.ok ? null : check.message} hint="Over it, its routines pause for the rest of the day and Needs you asks you. Empty = no budget." data-testid="v2-budget-value" />
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Model…: the models its engine offers (the session's list), and the effort (the CLI's level names) when the model has levels. */
export function ModelDialog({ member, onClose }: { readonly member: TeamMember; readonly onClose: () => void }) {
  const sessions = useSessionListOf();
  const session = sessions.data?.find((entry) => entry.id === member.sessionRef) ?? null;
  const [listed, setListed] = useState<readonly SessionModelOption[] | null>(null);
  const available = session?.model?.available ?? listed;
  const [model, setModel] = useState<string>(member.model ?? session?.model?.current ?? '');
  const [effort, setEffort] = useState<string>(member.effort ?? session?.model?.effort ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (session?.model?.available) return;
    let alive = true;
    api
      .models()
      .then((settings) => {
        if (alive && settings.options) setListed(settings.options);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session?.model?.available]);
  const levels = useMemo(() => available?.find((option) => option.value === model)?.efforts ?? [], [available, model]);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Model · ${member.name}`}
      icon="sparkle"
      testId="v2-model-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={model === ''}
            onClick={async () => {
              try {
                await teamApi.updateMember(member.id, { model, effort: effort === '' || !levels.includes(effort) ? null : effort });
                onClose();
              } catch (e) {
                setError(refusalText(e));
              }
            }}
            data-testid="v2-model-save"
          >
            Save
          </Button>
        </>
      }
    >
      <Select label={WORDS.model} value={model} onChange={(event) => setModel(event.currentTarget.value)} options={[...(model === '' ? [{ value: '', label: 'Choose a model', disabled: true }] : []), ...(available ?? []).map((option) => ({ value: option.value, label: option.label }))]} data-testid="v2-model-select" />
      {levels.length > 0 ? (
        <Select label={WORDS.effort} value={effort} onChange={(event) => setEffort(event.currentTarget.value)} options={[{ value: '', label: 'Default' }, ...levels.map((level) => ({ value: level, label: level }))]} data-testid="v2-model-effort-select" />
      ) : null}
      <p className="v2-muted v2-c-small">Its agent uses it from its next reply; a running reply finishes on the current one.</p>
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** D105 · Edit… a proposed job description, then accept it with your edits. */
export function CharterEditDialog({ member, charter, requestId, onClose }: { readonly member: TeamMember; readonly charter: TeamCharter; readonly requestId: string; readonly onClose: () => void }) {
  const [form, setForm] = useState<TeamCharter>({ owns: charter.owns, produces: charter.produces, neverDoes: charter.neverDoes, howItWorks: charter.howItWorks ?? '' });
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const set = (key: keyof TeamCharter, value: string): void => setForm((current) => ({ ...current, [key]: value }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Job description · ${member.name}`}
      icon="edit"
      width={640}
      testId="v2-charter-edit"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const how = (form.howItWorks ?? '').trim();
                await teamApi.decide(requestId, 'approve', { charter: { owns: form.owns.trim(), produces: form.produces.trim(), neverDoes: form.neverDoes.trim(), ...(how ? { howItWorks: how } : {}) } });
                toast({ text: `Accepted ${member.name}’s job description with your edits.` });
                onClose();
              } catch (e) {
                setError(refusalText(e));
              }
            }}
            data-testid="v2-charter-edit-save"
          >
            Accept with my edits
          </Button>
        </>
      }
    >
      <TextArea label="Owns" rows={2} value={form.owns} onChange={(event) => set('owns', event.currentTarget.value)} />
      <TextArea label="Produces" rows={2} value={form.produces} onChange={(event) => set('produces', event.currentTarget.value)} />
      <TextArea label="How it works" rows={3} value={form.howItWorks ?? ''} onChange={(event) => set('howItWorks', event.currentTarget.value)} />
      <TextArea label="Never does" rows={2} value={form.neverDoes} onChange={(event) => set('neverDoes', event.currentTarget.value)} />
      <ErrorLine text={error} />
    </Dialog>
  );
}

/**
 * New teammate: start from a role (the templates), from a suggestion (sessions that look like a
 * role, `GET /api/team/suggestions`), or make an existing agent a teammate; it joins the crew
 * picked here. A new one starts on this computer in the folder picked (move it later).
 */
export function NewTeammateDialog({ crews, crewId, onClose, onCreated }: { readonly crews: readonly TeamSummary[]; readonly crewId: string | null; readonly onClose: () => void; readonly onCreated: (member: TeamMember) => void }) {
  const [templates, setTemplates] = useState<readonly TeamTemplate[]>([]);
  const [suggestions, setSuggestions] = useState<readonly TeamSuggestion[]>([]);
  const [folders, setFolders] = useState<readonly { readonly id: string; readonly label: string }[]>([]);
  const [form, setForm] = useState<MemberForm>({ ...EMPTY_FORM });
  const [adopt, setAdopt] = useState(false);
  const [agent, setAgent] = useState('');
  const [crew, setCrew] = useState(crewId ?? crews[0]?.id ?? '');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sessions = useSessionListOf();
  const { hidden } = useTeamSwitch();
  useEffect(() => {
    let alive = true;
    void teamApi.templates().then((list) => alive && setTemplates(list)).catch(() => undefined);
    void teamApi.suggestions().then((list) => alive && setSuggestions(list)).catch(() => undefined);
    void api
      .savedFolders()
      .then((list) => alive && setFolders(list.map((entry) => ({ id: entry.id, label: entry.displayName }))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const agents = (sessions.data ?? []).filter((session) => !session.closedAt && !hidden.has(session.id));
  const templateOf = (id: string): TeamTemplate | null => templates.find((template) => template.id === id) ?? null;
  const useTemplate = (template: TeamTemplate): void => setForm((current) => ({ ...formFromTemplate(template), folder: current.folder }));
  const useSuggestion = (suggestion: TeamSuggestion): void => {
    const template = templateOf(suggestion.templateId);
    setForm(formFromSuggestion(suggestion, template, draftCharter(suggestion, template), []));
    setAdopt(true);
    setAgent(suggestion.sessionId);
  };
  const create = async (): Promise<void> => {
    const check = formBody(form);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    if (adopt && agent === '') {
      setErrors({ agent: 'Pick the agent that becomes a teammate.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const member = await teamApi.addMember({ ...check.body, ...(crew ? { teamId: crew } : {}), ...(adopt ? { sessionId: agent } : { session: newMemberSession(form) }) });
      onCreated(member);
    } catch (e) {
      setError(refusalText(e));
      setBusy(false);
    }
  };
  const set = (key: keyof MemberForm, value: string): void => setForm((current) => ({ ...current, [key]: value }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={CREW_WORDS.newTeammate}
      icon="crew"
      width={680}
      testId="v2-new-teammate"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || form.name.trim() === ''} onClick={() => void create()} data-testid="v2-new-teammate-go">
            {adopt ? 'Make teammate' : 'Add teammate'}
          </Button>
        </>
      }
    >
      <div className="v2-c-chips" role="group" aria-label="Start from a role">
        <span className="v2-muted v2-c-small">Start from a role:</span>
        {templates.map((template) => (
          <button key={template.id} type="button" className="v2-c-fchip" aria-pressed={form.templateId === template.id} title={template.summary} onClick={() => useTemplate(template)} data-testid="v2-new-teammate-role">
            {template.name}
          </button>
        ))}
      </div>
      {suggestions.length > 0 ? (
        <div className="v2-c-chips" role="group" aria-label="Suggestions" data-testid="v2-new-teammate-suggestions">
          <span className="v2-muted v2-c-small">Suggested:</span>
          {suggestions.slice(0, 4).map((suggestion) => (
            <button key={suggestion.sessionId} type="button" className="v2-c-fchip" title={suggestion.reason} onClick={() => useSuggestion(suggestion)} data-testid="v2-new-teammate-suggestion">
              {templateOf(suggestion.templateId)?.name ?? suggestion.templateId} ← “{suggestion.title}”
            </button>
          ))}
        </div>
      ) : null}
      <Checkbox label="Make an existing agent a teammate instead" checked={adopt} onChange={(event) => setAdopt(event.currentTarget.checked)} data-testid="v2-new-teammate-adopt" />
      {adopt ? (
        <Select
          label="Agent"
          value={agent}
          onChange={(event) => setAgent(event.currentTarget.value)}
          error={errors['agent'] ?? null}
          options={[{ value: '', label: 'Choose an agent', disabled: true }, ...agents.map((session) => ({ value: session.id, label: session.displayTitle ?? session.title ?? session.name }))]}
          data-testid="v2-new-teammate-agent"
        />
      ) : (
        <Select label="Folder" value={form.folder} onChange={(event) => set('folder', event.currentTarget.value)} options={[{ value: '', label: 'The default folder' }, ...folders.map((folder) => ({ value: folder.id, label: folder.label }))]} />
      )}
      <div className="v2-c-grid2">
        <Field label="Role" value={form.name} onChange={(event) => set('name', event.currentTarget.value)} error={errors['name'] ?? null} data-testid="v2-new-teammate-role-name" />
        <Select label="Joins which crew?" value={crew} onChange={(event) => setCrew(event.currentTarget.value)} options={crews.map((entry) => ({ value: entry.id, label: entry.name }))} data-testid="v2-new-teammate-crew" />
      </div>
      <TextArea label="Owns" rows={2} value={form.owns} onChange={(event) => set('owns', event.currentTarget.value)} />
      <TextArea label="Produces" rows={2} value={form.produces} onChange={(event) => set('produces', event.currentTarget.value)} />
      <TextArea label="Never does" rows={2} value={form.neverDoes} onChange={(event) => set('neverDoes', event.currentTarget.value)} />
      <div className="v2-c-grid2">
        <Field label="Budget (% of the account a day)" inputMode="numeric" value={form.budget} onChange={(event) => set('budget', event.currentTarget.value)} error={errors['budget'] ?? null} />
        <Checkbox label="Picks up hand-offs as they arrive" checked={form.onHandoff} onChange={(event) => setForm((current) => ({ ...current, onHandoff: event.currentTarget.checked }))} />
      </div>
      <p className="v2-muted v2-c-small">{adopt ? 'It keeps its chat, tasks and routines, and leaves the Agents list for its crew.' : 'It starts on this computer; move it to another one later from its ⋯ menu.'}</p>
      <ErrorLine text={error} />
    </Dialog>
  );
}
