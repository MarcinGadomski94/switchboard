import { useEffect, useRef, useState } from 'react';
import { HOOKED_STOP_WARNING, type TakeoverPreview, type TakeoverRun, type TargetDirListing, type TargetPlacement } from '../../../core/takeover.ts';
import { STOP_AND_CONTINUE_LABEL, STOP_TERMINAL_WARNING } from '../../../core/hooked-continue.ts';
import { ApiError, api } from '../../api/client.ts';
import { continueRefusal } from '../../hooked-continue/continue.ts';
import { type ContinueHookedRequest, closeContinueHooked, useContinueHookedRequest } from '../../hooked-continue/store.ts';
import { closeTakeover, useTakeoverRequest } from '../../takeover/store.ts';
import { type RepoRow, type TakeoverRequest, clonePathsOf, repoRows, withRepoPath, withRoot, withoutRoot } from '../../takeover/takeover.ts';
import { usePairedMachines } from '../../takeover/usePairedMachines.ts';
import { Button, Checkbox, Chip, Dialog, Field, Icon, Select, useToast } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { type MoveTarget, moveBlockedReason, moveHeadline, moveTargets, moveTitle, repoActionWord, repoLook, runTone, stepLook, targetLabel } from './move-model.ts';

/** The dialog's text of a failure (the classic dialogs' rule: the server's message, else the status). */
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
 * D131 · lane X · the v2 hosts of the D65 take-over / move and the D72 continue
 * dialogs. They read the same stores as the classic hosts (`openTakeover`,
 * `openContinueHooked`), so whatever opens them in v2 gets the v2 look. Mounted
 * once by `PeekHost` (the shell renders it on every v2 page).
 */
export function MoveDialogsHost() {
  const takeover = useTakeoverRequest();
  const hooked = useContinueHookedRequest();
  return (
    <>
      {takeover ? <MoveDialog key={`${takeover.sessionId}:${takeover.targetMachine ?? ''}`} request={takeover} /> : null}
      {hooked ? <ContinueHookedDialog key={hooked.sessionId} request={hooked} /> : null}
    </>
  );
}

/**
 * D65 / D110 in v2: **Move to computer** (this computer's agent goes to a paired
 * one, picked in the dialog) or **Move here** (a paired computer's agent comes
 * here). Same API and behaviour as the classic take-over dialog: both computers'
 * view first (the AI engine and account on the target, how the chat travels, the
 * folders on the target, ✓ / ⚠ / ✖ per code project with its choices and clone
 * folder, the terminal's stop to confirm), then the steps as they run, the result
 * or the error and what was undone, leftover branches with Delete, the git
 * commands. The main button says why it is disabled; an offline computer is
 * named and cannot be picked; nothing closes it while it runs.
 */
export function MoveDialog({ request }: { readonly request: TakeoverRequest }) {
  const { navigate } = useV2Router();
  const direction = request.targetMachine === null ? 'take-over' : 'move';
  const { machines } = usePairedMachines(true);
  const targets = moveTargets(machines);
  const [target, setTarget] = useState<string | null>(request.targetMachine);
  const [preview, setPreview] = useState<TakeoverPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [placement, setPlacement] = useState<TargetPlacement | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [run, setRun] = useState<TakeoverRun | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [deleted, setDeleted] = useState<Record<string, string>>({});
  const timer = useRef<number | undefined>(undefined);
  // Only the newest preview counts (the target or the folders changed since).
  const ask = useRef(0);
  const running = starting || (run !== null && run.state === 'running');
  const finished = run !== null && run.state !== 'running';

  const targetMachine = direction === 'move' ? target : null;
  const picked = direction === 'move' ? (targets.find((t) => t.id === target) ?? null) : null;
  const sourceMachine = direction === 'take-over' ? (machines.find((m) => m.name === request.machineName) ?? null) : null;
  const otherName = direction === 'move' ? (picked?.name ?? request.machineName) : request.machineName;
  const other: { readonly name: string; readonly state: MoveTarget['state'] } | null = picked ?? (sourceMachine ? (moveTargets([sourceMachine])[0] ?? null) : null);

  const loadPreview = (paths: Record<string, string> = {}, chosen: TargetPlacement | null | undefined = undefined): void => {
    const n = ++ask.current;
    setPreviewError(null);
    api
      .takeoverPreview({ sessionId: request.sessionId, targetMachine, ...(Object.keys(paths).length > 0 ? { clonePaths: paths } : {}), ...(chosen !== undefined ? { placement: chosen } : {}) })
      .then((next) => {
        if (n !== ask.current) return;
        setPreview(next);
        setPlacement(next.placement);
        setTyped((current) => {
          const out = { ...current };
          for (const repo of next.target.repos) if (repo.cloneTo && out[repo.key] === undefined) out[repo.key] = repo.cloneTo;
          return out;
        });
      })
      .catch((error: unknown) => {
        if (n === ask.current) setPreviewError(errorText(error));
      });
  };
  // A new target starts over: its own folders, clone paths and confirmation.
  useEffect(() => {
    setPreview(null);
    setPlacement(null);
    setTyped({});
    setConfirmed(false);
    loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMachine]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const poll = (id: string): void => {
    api.takeoverRun(id).then(
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

  const reason = moveBlockedReason({ preview, previewError, confirmed, clonePaths: typed, other, running });
  const start = (): void => {
    if (!preview || reason !== null) return;
    setStarting(true);
    setStartError(null);
    api
      .takeoverStart({ sessionId: request.sessionId, targetMachine, clonePaths: clonePathsOf(preview, typed), ...(placement ? { placement } : {}), confirmStopTerminal: confirmed })
      .then((next) => {
        setRun(next);
        poll(next.id);
      })
      .catch((error: unknown) => setStartError(errorText(error)))
      .finally(() => setStarting(false));
  };
  const close = (): void => {
    if (!running) closeTakeover();
  };
  const openResult = (): void => {
    if (run?.result) navigate(`/agents/${encodeURIComponent(run.result.sessionId)}`);
    closeTakeover();
  };
  const deleteLeftover = (machineId: string | null, id: string): void => {
    api.takeoverDeleteLeftover(machineId, id).then(
      () => setDeleted((current) => ({ ...current, [id]: 'Deleted' })),
      (error: unknown) => setDeleted((current) => ({ ...current, [id]: errorText(error) })),
    );
  };

  const here = direction === 'take-over' ? (preview?.target.machine.name ?? 'this computer') : (preview?.source.machine.name ?? 'this computer');
  const sourceName = direction === 'take-over' ? request.machineName : here;
  const targetName = direction === 'take-over' ? here : (otherName ?? 'the other computer');
  const title = moveTitle(direction, direction === 'move' ? (picked?.name ?? null) : request.machineName);

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      icon="desktop"
      width={720}
      testId="v2-move-dialog"
      footer={
        <>
          {!run && reason !== null ? (
            <span className="v2-muted v2-mv-why v2-grow" data-testid="v2-move-reason" role="status">
              {reason}
            </span>
          ) : (
            <span className="v2-grow" />
          )}
          <Button data-testid="v2-move-close" disabled={running} title={running ? 'It is moving now: wait until it finishes.' : undefined} onClick={close}>
            {finished ? AGENT_WORDS.closeDialog : AGENT_WORDS.cancel}
          </Button>
          {finished && run?.state === 'done' && run.result ? (
            <Button variant="primary" icon="arrow-r" data-testid="v2-move-open" onClick={openResult}>
              {AGENT_WORDS.openMovedAgent}
            </Button>
          ) : null}
          {!run ? (
            <Button variant="primary" icon="desktop" data-testid="v2-move-start" disabled={reason !== null} aria-busy={starting || undefined} title={reason ?? undefined} onClick={start}>
              {direction === 'take-over' ? AGENT_WORDS.moveHere : AGENT_WORDS.move}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="v2-mv" data-testid="v2-move-body" data-state={run ? run.state : preview ? 'preview' : 'loading'}>
        <p className="v2-muted v2-mv-sub" data-testid="v2-move-sub">
          {request.title} · {sourceName} → {targetName}
        </p>
        {direction === 'move' && !run ? (
          <Select
            label={AGENT_WORDS.moveTo}
            value={target ?? ''}
            disabled={running}
            data-testid="v2-move-target"
            options={targets.map((t) => ({ value: t.id, label: targetLabel(t), disabled: t.reason !== null && t.id !== target }))}
            onChange={(event) => setTarget(event.target.value)}
            hint={picked && picked.reason ? picked.reason : undefined}
          />
        ) : null}
        {other && other.state !== 'online' && !run ? (
          <div className="v2-mv-note" data-tone={other.state === 'offline' ? 'red' : 'amber'} role="status" data-testid="v2-move-offline">
            <Icon name={other.state === 'offline' ? 'offline' : 'refresh'} size="s" />
            {other.state === 'offline' ? `${other.name} is offline. It can move once it reconnects.` : `Reconnecting to ${other.name}…`}
          </div>
        ) : null}
        {previewError ? (
          <div className="v2-mv-error" role="alert" data-testid="v2-move-preview-error">
            {previewError}
          </div>
        ) : null}
        {!preview && !previewError && !run ? (
          <div className="v2-mv-loading" data-testid="v2-move-loading" aria-busy="true">
            <div className="v2-skel" style={{ height: 14, width: '60%' }} />
            <div className="v2-skel" style={{ height: 56 }} />
            <span className="v2-muted">Checking both computers…</span>
          </div>
        ) : null}
        {preview && !run ? (
          <>
            <div className="v2-mv-facts">
              <div data-testid="v2-move-cli">
                <Icon name="sparkle" size="s" />
                <span>
                  {preview.target.cli.label} on the account “{preview.target.account.name}” of {preview.target.machine.name}
                  {preview.target.cli.available ? '' : ` · ${preview.target.cli.reason ?? 'not available'}`}
                </span>
              </div>
              <div data-testid="v2-move-conversation">
                <Icon name="chat" size="s" />
                <span>
                  {preview.source.conversation.kind === 'claude-transcript'
                    ? `The chat is copied (${preview.source.conversation.files.length} file${preview.source.conversation.files.length === 1 ? '' : 's'}) and picked up there.`
                    : (preview.source.conversation.note ?? 'The chat is handed over.')}
                </span>
              </div>
            </div>
            <FolderPicker
              machine={direction === 'move' ? targetMachine : null}
              machineName={targetName}
              placement={placement}
              remembered={preview.remembered}
              onChange={(next) => {
                setPlacement(next);
                loadPreview(clonePathsOf(preview, typed), next);
              }}
            />
            <div className="v2-mv-repos" data-testid="v2-move-repos">
              {repoRows(preview).map((row) => (
                <RepoRowView
                  key={row.key}
                  row={row}
                  sourceName={sourceName}
                  targetName={targetName}
                  clonePath={typed[row.key]}
                  onClonePath={(value) => setTyped((current) => ({ ...current, [row.key]: value }))}
                  onCloneDone={() => loadPreview(clonePathsOf(preview, typed), placement)}
                  onPick={(value) => {
                    const next = withRepoPath(placement, row.key, value);
                    setPlacement(next);
                    loadPreview(clonePathsOf(preview, typed), next);
                  }}
                />
              ))}
            </div>
            {preview.stopsTerminal ? (
              <div className="v2-mv-warn" data-testid="v2-move-hooked-warning">
                <p>{HOOKED_STOP_WARNING}</p>
                <Checkbox label="Stop that terminal’s claude and move the agent" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} data-testid="v2-move-confirm" />
              </div>
            ) : null}
            {preview.blockers.length > 0 ? (
              <div className="v2-mv-error" role="alert" data-testid="v2-move-blockers">
                {preview.blockers.map((blocker) => (
                  <div key={blocker}>{blocker}</div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {run ? <RunView run={run} machineName={otherName ?? request.machineName} deleted={deleted} onDelete={deleteLeftover} showLog={showLog} onToggleLog={() => setShowLog((open) => !open)} /> : null}
        {startError ? (
          <div className="v2-mv-error" role="alert" data-testid="v2-move-start-error">
            {startError}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The steps as they run, the headline, the error and what was undone, leftover branches, the git commands. */
function RunView({
  run,
  machineName,
  deleted,
  onDelete,
  showLog,
  onToggleLog,
}: {
  readonly run: TakeoverRun;
  readonly machineName: string;
  readonly deleted: Readonly<Record<string, string>>;
  readonly onDelete: (machineId: string | null, id: string) => void;
  readonly showLog: boolean;
  readonly onToggleLog: () => void;
}) {
  const tone = runTone(run);
  return (
    <>
      <div className="v2-mv-headline" data-testid="v2-move-headline" data-tone={tone} aria-live="polite">
        <Chip tone={tone} icon={run.state === 'done' ? 'check-circle' : run.state === 'failed' ? 'x' : 'refresh'}>
          {run.state === 'done' ? 'Done' : run.state === 'failed' ? 'Failed' : 'Moving'}
        </Chip>
        <b>{moveHeadline(run, machineName)}</b>
      </div>
      <ol className="v2-mv-steps" data-testid="v2-move-steps">
        {run.steps.map((step) => {
          const look = stepLook(step.status);
          return (
            <li key={step.id} data-testid="v2-move-step" data-step={step.id} data-status={step.status} data-tone={look.tone}>
              <Icon name={look.icon} size="s" label={look.word} />
              <span className="v2-grow">{step.label}</span>
              {step.detail ? <span className="v2-muted v2-mv-detail">{step.detail}</span> : null}
              <span className="v2-mv-word">{look.word}</span>
            </li>
          );
        })}
      </ol>
      {run.error ? (
        <div className="v2-mv-error" role="alert" data-testid="v2-move-error">
          {run.error.message}
          {run.rollbackNotes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      ) : null}
      {run.leftovers.length > 0 ? (
        <div className="v2-mv-leftovers" data-testid="v2-move-leftovers">
          {run.leftovers.map((leftover) => (
            <div key={leftover.branch} className="v2-row" data-testid="v2-move-leftover">
              <span className="v2-grow">
                Temporary branch <code>{leftover.branch}</code> is still on {leftover.remoteName}
                {leftover.reason ? ` (${leftover.reason})` : ''}
              </span>
              {leftover.id !== '' ? (
                deleted[leftover.id] ? (
                  <span data-testid="v2-move-leftover-result">{deleted[leftover.id]}</span>
                ) : (
                  <Button size="sm" icon="trash" onClick={() => onDelete(leftover.machineId, leftover.id)}>
                    Delete it
                  </Button>
                )
              ) : (
                <span className="v2-muted">
                  Delete it with <code>git push {leftover.remoteName} --delete {leftover.branch}</code>
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      <Button size="sm" variant="ghost" icon={showLog ? 'chev-down' : 'chev'} aria-expanded={showLog} data-testid="v2-move-log-toggle" onClick={onToggleLog}>
        {showLog ? 'Hide the git commands' : 'Show the git commands'}
      </Button>
      {showLog ? (
        <pre className="v2-ag-code" data-testid="v2-move-log">
          {run.log.join('\n')}
        </pre>
      ) : null}
    </>
  );
}

/**
 * D110 in v2: the folders on the target (chips; none = its saved folders) and
 * **Choose folders…**: the target's saved folders and home, a path field, and its
 * folders to browse (through the peer API). Every change re-runs the preview.
 */
function FolderPicker({
  machine,
  machineName,
  placement,
  remembered,
  onChange,
}: {
  readonly machine: string | null;
  readonly machineName: string;
  readonly placement: TargetPlacement | null;
  readonly remembered: boolean;
  readonly onChange: (next: TargetPlacement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<TargetDirListing | null>(null);
  const [typed, setTyped] = useState('');
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
  const toggle = (): void => {
    if (!open && listing === null) load(null);
    setOpen(!open);
  };
  const use = (path: string): void => {
    if (path.trim() === '') return;
    onChange(withRoot(placement, path));
    setOpen(false);
  };
  const roots = placement?.roots ?? [];
  return (
    <div className="v2-mv-folders" data-testid="v2-move-folders">
      <div className="v2-row v2-mv-folders-head">
        <b>Folders on {machineName}</b>
        {roots.length === 0 ? (
          <span className="v2-muted" data-testid="v2-move-folders-saved">
            its saved folders
          </span>
        ) : (
          roots.map((root) => (
            <span key={root} className="v2-mv-root" data-testid="v2-move-root" title={root}>
              <Icon name="folder" size="s" />
              <span className="v2-mv-root-t">{root}</span>
              <button type="button" className="v2-mv-root-x" aria-label={`Remove ${root}`} onClick={() => onChange(withoutRoot(placement, root))}>
                <Icon name="x" size="s" />
              </button>
            </span>
          ))
        )}
        <span className="v2-grow" />
        <Button size="sm" icon="folder" aria-expanded={open} data-testid="v2-move-folders-toggle" onClick={toggle}>
          {open ? AGENT_WORDS.closeDialog : roots.length === 0 ? 'Choose folders…' : 'Add a folder…'}
        </Button>
      </div>
      {remembered && roots.length > 0 ? <p className="v2-muted v2-mv-small">The folders of the last move of this folder to {machineName}.</p> : null}
      {open ? (
        <div className="v2-mv-picker" data-testid="v2-move-folder-picker">
          {listing ? (
            <div className="v2-row v2-mv-places">
              {listing.places.map((place) => (
                <Button key={place.path} size="sm" icon={place.kind === 'home' ? 'home' : 'folder'} title={place.path} data-testid="v2-move-place" onClick={() => load(place.path)}>
                  {place.label}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="v2-row v2-mv-path">
            <Field
              className="v2-mono"
              aria-label={`A folder on ${machineName}`}
              placeholder={`A folder on ${machineName}`}
              value={typed}
              spellCheck={false}
              data-testid="v2-move-folder-path"
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') load(typed);
              }}
            />
            <Button size="sm" onClick={() => load(typed)}>
              Open
            </Button>
            <Button size="sm" variant="primary" disabled={typed.trim() === ''} data-testid="v2-move-folder-use" onClick={() => use(typed)}>
              Use this folder
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

/** One code project: ✓ / ⚠ / ✖ as icon + word + colour, both sides, the choices, another checkout, the clone folder. */
function RepoRowView({
  row,
  sourceName,
  targetName,
  clonePath,
  onClonePath,
  onCloneDone,
  onPick,
}: {
  readonly row: RepoRow;
  readonly sourceName: string;
  readonly targetName: string;
  readonly clonePath: string | undefined;
  readonly onClonePath: (value: string) => void;
  readonly onCloneDone: () => void;
  readonly onPick: (path: string | null) => void;
}) {
  const [override, setOverride] = useState<string | null>(null);
  const look = repoLook(row.mark);
  return (
    <div className="v2-mv-repo" data-testid="v2-move-repo" data-key={row.key} data-action={row.action} data-mark={row.mark} data-tone={look.tone}>
      <div className="v2-row v2-mv-repo-head">
        <Chip tone={look.tone} icon={look.icon} size="s">
          {look.word}
        </Chip>
        <b className="v2-grow">{row.name}</b>
        <span className="v2-mono v2-muted" data-testid="v2-move-repo-branch">
          {row.branch}
        </span>
        <span className="v2-mv-word" data-testid="v2-move-repo-action">
          {repoActionWord(row.action)}
        </span>
      </div>
      <div className="v2-mv-cols">
        <div>
          <span className="v2-mv-col-h">{sourceName}</span>
          {row.remoteUrl ? <span className="v2-muted v2-mono v2-mv-line">{row.remoteUrl}</span> : null}
          <span className="v2-mv-line">{row.work} · carried through a temporary branch</span>
        </div>
        <div>
          <span className="v2-mv-col-h">{targetName}</span>
          <span className="v2-mv-line" data-testid="v2-move-repo-summary">
            {row.target}
          </span>
          {row.choices.length > 0 ? (
            <div className="v2-mv-choices" role="group" aria-label={`Which checkout of ${row.name}`}>
              {row.choices.map((choice) => (
                <Button key={choice.path} size="sm" data-testid="v2-move-repo-choice" onClick={() => onPick(choice.path)}>
                  {choice.path} · {choice.branch ?? 'detached'}
                  {choice.dirty > 0 ? ` · ${choice.dirty} uncommitted` : ''}
                </Button>
              ))}
            </div>
          ) : null}
          {override === null ? (
            <Button size="sm" variant="ghost" data-testid="v2-move-repo-other" onClick={() => setOverride(row.path ?? '')}>
              Another checkout…
            </Button>
          ) : (
            <Field
              label="Use this checkout"
              className="v2-mono"
              value={override}
              placeholder={`The checkout of ${row.name} on ${targetName}`}
              spellCheck={false}
              data-testid="v2-move-repo-override"
              onChange={(event) => setOverride(event.target.value)}
              onBlur={() => onPick(override.trim() === '' ? null : override)}
            />
          )}
          {row.action === 'clone' || (row.action === 'blocked' && row.cloneTo !== null) ? (
            <Field
              label="Clone into"
              className="v2-mono"
              value={clonePath ?? row.cloneTo ?? ''}
              spellCheck={false}
              data-testid="v2-move-clone-path"
              onChange={(event) => onClonePath(event.target.value)}
              onBlur={onCloneDone}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

type HookedPhase = { readonly kind: 'working' } | { readonly kind: 'confirm'; readonly pid: number | null } | { readonly kind: 'stopping' } | { readonly kind: 'error'; readonly text: string };

/**
 * D72 in v2: **Continue in Switchboard** for an agent started in a terminal.
 * Same behaviour as the classic dialog: it asks the service at once; a terminal
 * that is gone continues straight away (the dialog closes and the agent opens); a
 * terminal whose `claude` still runs asks first, then stops it and continues; a
 * refusal shows its reason (nothing changed). It cannot be closed while it works.
 */
export function ContinueHookedDialog({ request }: { readonly request: ContinueHookedRequest }) {
  const { navigate } = useV2Router();
  const toast = useToast();
  const [phase, setPhase] = useState<HookedPhase>({ kind: 'working' });
  const started = useRef(false);
  const busy = phase.kind === 'working' || phase.kind === 'stopping';

  const call = (confirm: boolean): void => {
    setPhase(confirm ? { kind: 'stopping' } : { kind: 'working' });
    api.continueHookedSession(request.sessionId, confirm).then(
      () => {
        closeContinueHooked();
        toast({ text: AGENT_WORDS.continuedHere(request.title) });
        navigate(`/agents/${encodeURIComponent(request.sessionId)}`);
      },
      (error: unknown) => {
        const failed = error instanceof ApiError ? error : new ApiError(0, String(error));
        const view = continueRefusal(failed.status, failed.body);
        // A second "running" after the confirmation cannot ask again: it is the reason.
        setPhase(view.kind === 'confirm' && confirm ? { kind: 'error', text: 'The terminal’s claude is still running.' } : view);
      },
    );
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    call(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = (): void => {
    if (!busy) closeContinueHooked();
  };
  return (
    <Dialog
      open
      onClose={close}
      title={request.machineName ? `${AGENT_WORDS.continueHooked} (on ${request.machineName})` : AGENT_WORDS.continueHooked}
      icon="cmd"
      width={560}
      testId="v2-continue-hooked"
      footer={
        <>
          {busy ? (
            <span className="v2-muted v2-mv-why v2-grow" role="status">
              {phase.kind === 'stopping' ? 'Stopping the terminal’s claude, then continuing…' : 'Continuing…'}
            </span>
          ) : (
            <span className="v2-grow" />
          )}
          <Button data-testid="v2-continue-hooked-close" disabled={busy} title={busy ? 'It is continuing now: wait a moment.' : undefined} onClick={close}>
            {phase.kind === 'error' ? AGENT_WORDS.closeDialog : AGENT_WORDS.cancel}
          </Button>
          {phase.kind === 'confirm' ? (
            <Button variant="primary" icon="stop" data-testid="v2-continue-hooked-confirm" onClick={() => call(true)}>
              {STOP_AND_CONTINUE_LABEL}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="v2-mv" data-testid="v2-continue-hooked-body" data-state={phase.kind}>
        <p className="v2-muted v2-mv-sub">{request.title}</p>
        {busy ? (
          <div className="v2-mv-loading" aria-busy="true">
            <div className="v2-skel" style={{ height: 14, width: '50%' }} />
          </div>
        ) : null}
        {phase.kind === 'confirm' ? (
          <div className="v2-mv-warn" data-testid="v2-continue-hooked-warning">
            <p>{STOP_TERMINAL_WARNING}</p>
            {phase.pid !== null ? <p className="v2-muted v2-mono">claude process {phase.pid}</p> : null}
          </div>
        ) : null}
        {phase.kind === 'error' ? (
          <div className="v2-mv-error" role="alert" data-testid="v2-continue-hooked-error">
            {phase.text}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
