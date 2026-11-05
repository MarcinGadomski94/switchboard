import { useEffect, useRef, useState } from 'react';
import type { ChatMovePreview, ChatMoveRun } from '../../../core/chat-move.ts';
import type { TargetDirListing } from '../../../core/takeover.ts';
import { ApiError, api } from '../../api/client.ts';
import { type ChatMoveRequest, closeChatMove } from '../../takeover/chat-move-store.ts';
import { usePairedMachines } from '../../takeover/usePairedMachines.ts';
import { Button, Chip, Dialog, Field, Icon, Select } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { type LookAtRowView, carriesLine, chatMoveBlockedReason, choiceOf, lookAtRows, staysBehind, withFolder, withLeftOut } from './chat-move-model.ts';
import { type MoveTarget, moveHeadline, moveTargets, moveTitle, runTone, stepLook, targetLabel } from './move-model.ts';

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
    if (body && typeof body.message === 'string') return body.message;
    if (body && Array.isArray(body.errors) && typeof body.errors[0]?.message === 'string') return body.errors[0].message;
    return error.status === 0 ? 'Switchboard could not be reached' : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * D155 in v2: **Move to computer…** for a chat (the chat's ⋯ menu). The same
 * dialog family as the agent's move (`MoveDialog.tsx`): both computers' view first
 * (the AI engine and account there, what is copied and what stays), then, for each
 * folder the chat looks at, the folder it will look at on the other computer (the
 * suggestion, another folder picked there, or left out), then the steps as they
 * run and the real outcome (moved, or failed and undone). It stays open until it
 * is closed and cannot be closed while the chat moves. No repos, git or worktrees.
 */
export function ChatMoveDialog({ request }: { readonly request: ChatMoveRequest }) {
  const { navigate } = useV2Router();
  const direction = request.targetMachine === null ? 'take-over' : 'move';
  const { machines } = usePairedMachines(true);
  const targets = moveTargets(machines);
  const [target, setTarget] = useState<string | null>(request.targetMachine);
  const [preview, setPreview] = useState<ChatMovePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string | null> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [run, setRun] = useState<ChatMoveRun | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const ask = useRef(0);
  const running = starting || (run !== null && run.state === 'running');
  const finished = run !== null && run.state !== 'running';
  const targetMachine = direction === 'move' ? target : null;
  const picked = direction === 'move' ? (targets.find((t) => t.id === target) ?? null) : null;
  const sourceMachine = direction === 'take-over' ? (machines.find((m) => m.name === request.machineName) ?? null) : null;
  const other: { readonly name: string; readonly state: MoveTarget['state'] } | null = picked ?? (sourceMachine ? (moveTargets([sourceMachine])[0] ?? null) : null);

  const loadPreview = (next: Record<string, string | null> | null): void => {
    const n = ++ask.current;
    setPreviewError(null);
    api.chatMovePreview({ chatId: request.chatId, targetMachine, ...(next ? { lookAt: next } : {}) }).then(
      (answer) => {
        if (n !== ask.current) return;
        setPreview(answer);
        setChoice(choiceOf(answer));
      },
      (error: unknown) => {
        if (n === ask.current) setPreviewError(errorText(error));
      },
    );
  };
  useEffect(() => {
    setPreview(null);
    setChoice(null);
    setEditing(null);
    loadPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMachine]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (next: Record<string, string | null>): void => {
    setChoice(next);
    setEditing(null);
    loadPreview(next);
  };
  const poll = (id: string): void => {
    api.chatMoveRun(id).then(
      (next) => {
        setRun(next);
        if (next.state === 'running') timer.current = window.setTimeout(() => poll(id), 400);
      },
      (error: unknown) => {
        setStartError(errorText(error));
        timer.current = window.setTimeout(() => poll(id), 1_500);
      },
    );
  };
  const reason = chatMoveBlockedReason({ preview, previewError, other, running, editing: editing !== null });
  const start = (): void => {
    if (!preview || reason !== null) return;
    setStarting(true);
    setStartError(null);
    api.chatMoveStart({ chatId: request.chatId, targetMachine, ...(choice ? { lookAt: choice } : {}) }).then(
      (next) => {
        setRun(next);
        poll(next.id);
        setStarting(false);
      },
      (error: unknown) => {
        setStartError(errorText(error));
        setStarting(false);
      },
    );
  };
  const close = (): void => {
    if (!running) closeChatMove();
  };
  const openResult = (): void => {
    if (run?.result) navigate(`/agents/${encodeURIComponent(run.result.sessionId)}`);
    closeChatMove();
  };
  const here = direction === 'take-over' ? (preview?.target.machine.name ?? 'this computer') : (preview?.source.machine.name ?? 'this computer');
  const sourceName = direction === 'take-over' ? request.machineName : here;
  const targetName = direction === 'take-over' ? here : (picked?.name ?? request.machineName);
  const rows = preview ? lookAtRows(preview, targetName) : [];
  const behind = preview ? staysBehind(preview) : [];

  return (
    <Dialog
      open
      onClose={close}
      title={moveTitle(direction, direction === 'move' ? (picked?.name ?? null) : request.machineName)}
      icon="desktop"
      width={680}
      testId="v2-chat-move-dialog"
      footer={
        <>
          {!run && reason !== null ? (
            <span className="v2-muted v2-mv-why v2-grow" data-testid="v2-chat-move-reason" role="status">
              {reason}
            </span>
          ) : (
            <span className="v2-grow" />
          )}
          <Button data-testid="v2-chat-move-close" disabled={running} title={running ? 'It is moving now: wait until it finishes.' : undefined} onClick={close}>
            {finished ? AGENT_WORDS.closeDialog : AGENT_WORDS.cancel}
          </Button>
          {finished && run?.state === 'done' && run.result ? (
            <Button variant="primary" icon="arrow-r" data-testid="v2-chat-move-open" onClick={openResult}>
              Open the chat
            </Button>
          ) : null}
          {!run ? (
            <Button variant="primary" icon="desktop" data-testid="v2-chat-move-start" disabled={reason !== null} aria-busy={starting || undefined} title={reason ?? undefined} onClick={start}>
              {direction === 'take-over' ? AGENT_WORDS.moveHere : AGENT_WORDS.move}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="v2-mv" data-testid="v2-chat-move-body" data-state={run ? run.state : preview ? 'preview' : 'loading'}>
        <p className="v2-muted v2-mv-sub" data-testid="v2-chat-move-sub">
          {request.title} · {sourceName} → {targetName}
        </p>
        {direction === 'move' && !run ? (
          <Select
            label={AGENT_WORDS.moveTo}
            value={target ?? ''}
            disabled={running}
            data-testid="v2-chat-move-target"
            options={targets.map((t) => ({ value: t.id, label: targetLabel(t), disabled: t.reason !== null && t.id !== target }))}
            onChange={(event) => setTarget(event.target.value)}
            hint={picked && picked.reason ? picked.reason : undefined}
          />
        ) : null}
        {other && other.state !== 'online' && !run ? (
          <div className="v2-mv-note" data-tone={other.state === 'offline' ? 'red' : 'amber'} role="status">
            <Icon name={other.state === 'offline' ? 'offline' : 'refresh'} size="s" />
            {other.state === 'offline' ? `${other.name} is offline. It can move once it reconnects.` : `Reconnecting to ${other.name}…`}
          </div>
        ) : null}
        {previewError ? (
          <div className="v2-mv-error" role="alert" data-testid="v2-chat-move-preview-error">
            {previewError}
          </div>
        ) : null}
        {!preview && !previewError && !run ? (
          <div className="v2-mv-loading" aria-busy="true">
            <div className="v2-skel" style={{ height: 14, width: '60%' }} />
            <span className="v2-muted">Checking both computers…</span>
          </div>
        ) : null}
        {preview && !run ? (
          <>
            <div className="v2-mv-facts">
              <div data-testid="v2-chat-move-cli">
                <Icon name="sparkle" size="s" />
                <span>
                  {preview.target.cli.label} on the account “{preview.target.account.name}” of {preview.target.machine.name}, still a chat (plan mode)
                  {preview.target.cli.available ? '' : ` · ${preview.target.cli.reason ?? 'not available'}`}
                </span>
              </div>
              <div data-testid="v2-chat-move-carries">
                <Icon name="chat" size="s" />
                <span>{carriesLine(preview)}</span>
              </div>
              {behind.length > 0 ? (
                <div data-testid="v2-chat-move-behind">
                  <Icon name="alert" size="s" />
                  <span>Stays on {sourceName}: {behind.join('; ')}</span>
                </div>
              ) : null}
            </div>
            <div className="v2-mv-folders" data-testid="v2-chat-move-lookats">
              <div className="v2-row v2-mv-folders-head">
                <b>Folders it looks at, on {targetName}</b>
              </div>
              {rows.length === 0 ? <p className="v2-muted v2-mv-small">It looks at no folders: nothing to choose.</p> : null}
              {rows.map((row) => (
                <LookAtRow
                  key={row.source}
                  row={row}
                  machine={direction === 'move' ? targetMachine : null}
                  targetName={targetName}
                  editing={editing === row.source}
                  onEdit={(on) => setEditing(on ? row.source : null)}
                  onUse={(path) => choice && change(withFolder(choice, row.source, path))}
                  onLeaveOut={() => choice && change(withLeftOut(choice, row.source))}
                />
              ))}
              {preview.remembered ? <p className="v2-muted v2-mv-small">The choices of the last move of these folders to {targetName}.</p> : null}
            </div>
            {preview.blockers.length > 0 ? (
              <div className="v2-mv-error" role="alert" data-testid="v2-chat-move-blockers">
                {preview.blockers.map((blocker) => (
                  <div key={blocker}>{blocker}</div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {run ? <ChatRunView run={run} machineName={targetName} /> : null}
        {startError ? (
          <div className="v2-mv-error" role="alert" data-testid="v2-chat-move-start-error">
            {startError}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** One looked-at folder: what it becomes on the other computer, and the choice (the suggestion, another folder there, leave it out). */
function LookAtRow({
  row,
  machine,
  targetName,
  editing,
  onEdit,
  onUse,
  onLeaveOut,
}: {
  readonly row: LookAtRowView;
  readonly machine: string | null;
  readonly targetName: string;
  readonly editing: boolean;
  readonly onEdit: (on: boolean) => void;
  readonly onUse: (path: string) => void;
  readonly onLeaveOut: () => void;
}) {
  const [typed, setTyped] = useState(row.target ?? row.suggestion ?? '');
  const [listing, setListing] = useState<TargetDirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (path: string | null): void => {
    setError(null);
    api.takeoverFolders(machine, path).then(
      (next) => {
        setListing(next);
        if (next.path) setTyped(next.path);
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  const options = [
    ...(row.suggestion ? [{ value: 'suggested', label: `Use ${row.suggestion}${row.why ? ` (${row.why})` : ''}` }] : []),
    { value: 'picked', label: row.mode === 'picked' && row.target ? `Use ${row.target}` : 'Another folder there…' },
    { value: 'left-out', label: 'Leave it out' },
  ];
  const select = (value: string): void => {
    if (value === 'suggested' && row.suggestion) onUse(row.suggestion);
    else if (value === 'left-out') onLeaveOut();
    else {
      onEdit(true);
      if (listing === null) load(null);
    }
  };
  return (
    <div className="v2-mv-repo" data-testid="v2-chat-move-lookat" data-source={row.source} data-mode={row.mode} data-tone={row.problem ? 'red' : row.mode === 'left-out' ? 'grey' : 'green'}>
      <div className="v2-row">
        <Icon name={row.problem ? 'x' : row.mode === 'left-out' ? 'circle' : 'check-circle'} size="s" />
        <b className="v2-grow" title={row.source}>
          {row.name}
        </b>
        {row.mode === 'left-out' ? <Chip size="s">left out</Chip> : null}
      </div>
      <p className="v2-muted v2-mv-small v2-mono" title={row.source}>
        {row.source}
      </p>
      <p className="v2-mv-small" data-testid="v2-chat-move-lookat-line">
        {row.line}
      </p>
      <Select label={`On ${targetName}`} value={editing ? 'picked' : row.mode} data-testid="v2-chat-move-lookat-mode" options={options} onChange={(event) => select(event.target.value)} />
      {editing ? (
        <div className="v2-mv-picker" data-testid="v2-chat-move-lookat-picker">
          {listing ? (
            <div className="v2-row v2-mv-places">
              {listing.places.map((place) => (
                <Button key={place.path} size="sm" icon={place.kind === 'home' ? 'home' : 'folder'} title={place.path} onClick={() => load(place.path)}>
                  {place.label}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="v2-row v2-mv-path">
            <Field
              className="v2-mono"
              aria-label={`A folder on ${targetName}`}
              placeholder={`A folder on ${targetName}`}
              value={typed}
              spellCheck={false}
              data-testid="v2-chat-move-lookat-path"
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') load(typed);
              }}
            />
            <Button size="sm" onClick={() => load(typed)}>
              Open
            </Button>
            <Button size="sm" variant="primary" disabled={typed.trim() === ''} data-testid="v2-chat-move-lookat-use" onClick={() => onUse(typed)}>
              Use this folder
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onEdit(false)}>
              {AGENT_WORDS.cancel}
            </Button>
          </div>
          {error ? (
            <div className="v2-mv-error" role="alert">
              {error}
            </div>
          ) : null}
          {listing && listing.path ? (
            <div className="v2-mv-dirs" role="list" aria-label={`Folders in ${listing.path}`}>
              {listing.parent ? (
                <button type="button" role="listitem" className="v2-mv-dir" onClick={() => load(listing.parent)}>
                  <Icon name="back" size="s" />
                  Up
                </button>
              ) : null}
              {listing.entries.map((entry) => (
                <button key={entry.path} type="button" role="listitem" className="v2-mv-dir" title={entry.path} onClick={() => load(entry.path)}>
                  <Icon name="folder" size="s" />
                  <span className="v2-grow">{entry.name}</span>
                  {entry.repo ? <Chip size="s">code project</Chip> : entry.workspace ? <Chip size="s">workspace</Chip> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The steps as they run, the outcome, and what was undone. */
function ChatRunView({ run, machineName }: { readonly run: ChatMoveRun; readonly machineName: string }) {
  const tone = runTone(run);
  return (
    <>
      <div className="v2-mv-headline" data-testid="v2-chat-move-headline" data-tone={tone} data-state={run.state} aria-live="polite">
        <Chip tone={tone} icon={run.state === 'done' ? 'check-circle' : run.state === 'failed' ? 'x' : 'refresh'}>
          {run.state === 'done' ? 'Done' : run.state === 'failed' ? 'Failed' : 'Moving'}
        </Chip>
        <b>{moveHeadline(run, machineName)}</b>
      </div>
      <ol className="v2-mv-steps" data-testid="v2-chat-move-steps">
        {run.steps.map((step) => {
          const look = stepLook(step.status);
          return (
            <li key={step.id} data-testid="v2-chat-move-step" data-step={step.id} data-status={step.status} data-tone={look.tone}>
              <Icon name={look.icon} size="s" label={look.word} />
              <span className="v2-grow">{step.label}</span>
              {step.detail ? <span className="v2-muted v2-mv-detail">{step.detail}</span> : null}
              <span className="v2-mv-word">{look.word}</span>
            </li>
          );
        })}
      </ol>
      {run.error ? (
        <div className="v2-mv-error" role="alert" data-testid="v2-chat-move-error">
          {run.error.message}
          {run.rollbackNotes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}
    </>
  );
}
