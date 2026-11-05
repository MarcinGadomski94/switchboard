import { useEffect, useState } from 'react';
import { type MoveDetail, type MoveRecord, type MoveRetry, moveAgentName, moveAsRun, moveRetry } from '../../../core/moves.ts';
import type { TeamMember } from '../../../core/team.ts';
import { ApiError, api } from '../../api/client.ts';
import { choiceOfRetry, selfMachineId } from '../../takeover/retry.ts';
import { teamApi } from '../../team/api.ts';
import { MoveToComputerDialog } from '../crews/dialogs.tsx';
import { Button, Dialog } from '../components/index.ts';
import { MOVES_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { moveRetryDialog, moveStatusDialog, startRetry, useMoves } from '../shared/moves.ts';
import { RunView } from './MoveDialog.tsx';

/**
 * D154 (`docs/v2.md` → *Moves*): the move dialog attached to a run that is already
 * listed (a badge, Home's Moves card, a Needs-you item): its steps live (the moves
 * list follows `/hub`), how it ended, leftover branches, the git commands; **Try again**
 * after a failure (the agent's or the teammate's move dialog, pre-filled with the last
 * choices), **Open the agent** after a success, **Dismiss** once it ended. Also hosts
 * a teammate's Try again (its Move to computer… dialog). Mounted once by `MoveDialogsHost`.
 */
export function MoveStatusHost() {
  const status = moveStatusDialog.use();
  const retry = moveRetryDialog.use();
  return (
    <>
      {status ? <MoveStatusDialog key={status.moveId} moveId={status.moveId} /> : null}
      {retry && retry.kind === 'teammate' && retry.member ? <TeammateRetry key={`${retry.member.id}:${retry.targetId}`} retry={retry} /> : null}
    </>
  );
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string') return body.message;
    return error.status === 0 ? 'Switchboard could not be reached' : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function titleOf(move: MoveRecord): string {
  const name = moveAgentName(move);
  if (move.state === 'running') return MOVES_WORDS.movingTitle(name, move.target.name);
  return move.state === 'done' ? MOVES_WORDS.doneTitle(name, move.target.name) : MOVES_WORDS.failedTitle(name, move.target.name);
}

export function MoveStatusDialog({ moveId }: { readonly moveId: string }) {
  const { navigate } = useV2Router();
  const { moves, loaded } = useMoves();
  const listed = moves.find((move) => move.id === moveId) ?? null;
  const [detail, setDetail] = useState<MoveDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [deleted, setDeleted] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const move: MoveRecord | null = listed ?? detail;
  // The git commands: read again when the step or the state changes (the list carries the rest live).
  const stage = listed ? `${listed.state}:${listed.step?.id ?? ''}:${listed.steps.map((step) => step.status).join(',')}` : '';
  useEffect(() => {
    let alive = true;
    api.move(moveId).then(
      (answer) => alive && setDetail(answer),
      (caught: unknown) => alive && setError(errorText(caught)),
    );
    return () => {
      alive = false;
    };
  }, [moveId, stage]);
  const close = (): void => moveStatusDialog.close();
  const tryAgain = async (): Promise<void> => {
    if (!move) return;
    setBusy(true);
    try {
      const retry = moveRetry(move, await selfMachineId());
      moveStatusDialog.close();
      await startRetry(retry);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = (): void => {
    api.dismissMove(moveId).then(
      () => moveStatusDialog.close(),
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  const deleteLeftover = (machineId: string | null, id: string): void => {
    api.takeoverDeleteLeftover(machineId, id).then(
      () => setDeleted((current) => ({ ...current, [id]: 'Deleted' })),
      (caught: unknown) => setDeleted((current) => ({ ...current, [id]: errorText(caught) })),
    );
  };
  const running = move?.state === 'running';
  return (
    <Dialog
      open
      onClose={close}
      title={move ? titleOf(move) : MOVES_WORDS.title}
      icon="desktop"
      width={720}
      testId="v2-move-status"
      footer={
        <>
          <span className="v2-grow" />
          {move && !running ? (
            <Button variant="ghost" data-testid="v2-move-status-dismiss" onClick={dismiss}>
              {MOVES_WORDS.dismiss}
            </Button>
          ) : null}
          <Button data-testid="v2-move-status-close" onClick={close}>
            {running ? MOVES_WORDS.hide : MOVES_WORDS.close}
          </Button>
          {move?.state === 'failed' ? (
            <Button variant="primary" icon="refresh" data-testid="v2-move-status-retry" aria-busy={busy || undefined} disabled={busy} onClick={() => void tryAgain()}>
              {MOVES_WORDS.tryAgain}
            </Button>
          ) : null}
          {move?.state === 'done' ? (
            <Button
              variant="primary"
              icon="arrow-r"
              data-testid="v2-move-status-open"
              onClick={() => {
                close();
                navigate(`/agents/${encodeURIComponent(move.agentSessionId)}`);
              }}
            >
              {MOVES_WORDS.openAgent}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="v2-mv" data-testid="v2-move-status-body" data-state={move ? move.state : 'loading'} data-move={moveId}>
        {move ? (
          <>
            <p className="v2-muted v2-mv-sub" data-testid="v2-move-status-sub">
              {move.title} · {move.source.name} → {move.target.name}
              {move.machine ? ` · ${MOVES_WORDS.drivenBy(move.machine.name)}` : ''}
            </p>
            {move.machine && move.machine.state !== 'online' ? (
              <div className="v2-mv-note" data-tone="amber" role="status">
                {MOVES_WORDS.offline(move.machine.name)}
              </div>
            ) : null}
            <RunView run={moveAsRun(move, detail?.log ?? [])} machineName={move.target.name} deleted={deleted} onDelete={deleteLeftover} showLog={showLog} onToggleLog={() => setShowLog((open) => !open)} />
          </>
        ) : loaded && error ? (
          <div className="v2-mv-error" role="alert" data-testid="v2-move-status-gone">
            {MOVES_WORDS.gone}
          </div>
        ) : (
          <div className="v2-mv-loading" aria-busy="true">
            <div className="v2-skel" style={{ height: 14, width: '60%' }} />
            <span className="v2-muted">{MOVES_WORDS.loading}</span>
          </div>
        )}
        {move && error ? (
          <div className="v2-mv-error" role="alert" data-testid="v2-move-status-error">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** A teammate's Try again: its Move to computer… dialog with the same computer and the last choices. */
function TeammateRetry({ retry }: { readonly retry: MoveRetry }) {
  const [member, setMember] = useState<TeamMember | null>(null);
  useEffect(() => {
    let alive = true;
    const crew = retry.member?.teamId;
    teamApi.view(crew).then(
      (view) => {
        if (!alive) return;
        const found = view.members.find((entry) => entry.id === retry.member?.id) ?? null;
        if (found) setMember(found);
        else moveRetryDialog.close();
      },
      () => alive && moveRetryDialog.close(),
    );
    return () => {
      alive = false;
    };
  }, [retry]);
  if (!member) return null;
  return <MoveToComputerDialog member={member} onClose={() => moveRetryDialog.close()} initial={{ pick: retry.targetId, choice: choiceOfRetry(retry.choices) }} />;
}
