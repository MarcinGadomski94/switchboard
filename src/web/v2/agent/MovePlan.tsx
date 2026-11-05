import { useEffect, useState } from 'react';
import type { TakeoverPreview, TargetDirListing, TargetPlacement } from '../../../core/takeover.ts';
import { suggestWorkspaceParent } from '../../../core/workspace-move.ts';
import { ApiError, api } from '../../api/client.ts';
import {
  type CarryRow,
  type MoveChoice,
  type OutsideMode,
  type OutsideRow,
  carryGroups,
  fileRows,
  newRootFrom,
  outsideClonePath,
  outsideRows,
  repoModeOf,
  runInOf,
  runInOptions,
  splitClonePath,
  stashRows,
  targetWorkspaceOf,
  tickedSecrets,
  toggleFile,
  withNewWorkspace,
  withOutsideMode,
  withRepoCarried,
  withRepoMode,
  withRunIn,
  withStash,
  withTargetWorkspace,
  workspaceView,
  worksInLine,
} from '../../takeover/complete-move.ts';
import { type RepoRow, repoRows, withRepoPath, withRoot, withoutRoot } from '../../takeover/takeover.ts';
import { Button, Checkbox, Chip, Field, Icon, Segmented, Select } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { repoActionWord, repoLook } from './move-model.ts';
import './agent.css';
import './move-plan.css';

/**
 * D152 (`docs/peers.md` → *A complete move (D152)*): everything a move needs the
 * developer to decide, in one panel shared by the agent's Move to computer, a
 * teammate's move and each teammate of a crew move: which repos it works in, the
 * workspace on the target (a folder that is there, or a new one created where the
 * developer says), each repo used from a folder there or cloned, and the
 * workspace's own files to copy (secrets marked and unticked). Every change goes
 * back through `onChange`; the caller re-runs the preview (the target checks it).
 */

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string') return body.message;
    return error.status === 0 ? 'Switchboard could not be reached' : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The whole plan of one move (the preview's parts the developer decides). */
export function MovePlanPanel({
  preview,
  machine,
  sourceName,
  targetName,
  choice,
  onChange,
  onEdit,
  testId = 'v2-move-plan',
}: {
  readonly preview: TakeoverPreview;
  /** The target computer's id (`null` = this one). */
  readonly machine: string | null;
  readonly sourceName: string;
  readonly targetName: string;
  readonly choice: MoveChoice;
  readonly onChange: (next: MoveChoice) => void;
  /** A change that does not ask the computers again yet (a clone folder being typed; asked on leaving the field). */
  readonly onEdit?: (next: MoveChoice) => void;
  readonly testId?: string;
}) {
  const edit = onEdit ?? onChange;
  const ws = workspaceView(preview, choice.placement);
  const placement = choice.placement;
  const setPlacement = (next: TargetPlacement | null): void => onChange({ ...choice, placement: next });
  // D152 follow-up: the repos outside the workspace root have their own section (and no row in the list below).
  const outside = ws.show ? outsideRows(preview, choice) : [];
  const outsideKeys = new Set(outside.map((row) => row.key));
  // D152 follow-up (*Where it runs*): a workspace agent running in one of its repos there needs no workspace root and takes no workspace files.
  const runIn = ws.show ? runInOf(choice) : null;
  return (
    <div className="v2-mp" data-testid={testId}>
      <p className="v2-mp-works" data-testid="v2-move-works-in">
        <Icon name="folder" size="s" />
        <span>
          <b>Works in:</b> {worksInLine(preview)}
        </span>
      </p>
      {ws.show ? <RunInSection preview={preview} targetName={targetName} choice={choice} onChange={onChange} /> : null}
      {ws.show && runIn === null ? (
        <WorkspaceRootSection preview={preview} machine={machine} targetName={targetName} placement={placement} onChange={setPlacement} />
      ) : (
        <FolderPicker machine={machine} machineName={targetName} placement={placement} remembered={preview.remembered} onChange={setPlacement} />
      )}
      {ws.show && ((preview.source.repos ?? []).some((repo) => repo.outside !== true) || (preview.source.leftOut ?? []).length > 0 || (preview.source.skippedWorktrees ?? []).length > 0) ? <CarrySection preview={preview} choice={choice} onChange={onChange} /> : null}
      {outside.length > 0 ? <OutsideSection rows={outside} targetWorkspace={targetWorkspaceOf(preview)} machine={machine} sourceName={sourceName} targetName={targetName} choice={choice} onChange={onChange} /> : null}
      {stashRows(preview, choice).length > 0 ? <StashSection preview={preview} choice={choice} targetName={targetName} onChange={onChange} /> : null}
      <div className="v2-mv-repos" data-testid="v2-move-repos">
        {repoRows(preview)
          .filter((row) => !outsideKeys.has(row.key))
          .map((row) => (
          <RepoRowView
            key={row.key}
            row={row}
            sourceName={sourceName}
            targetName={targetName}
            mode={repoModeOf(placement, row.key)}
            clonePath={choice.clonePaths[row.key]}
            onMode={(mode) => onChange({ ...choice, placement: withRepoMode(placement, row.key, mode) })}
            onClonePath={(value) => edit({ ...choice, clonePaths: { ...choice.clonePaths, [row.key]: value } })}
            onCloneDone={() => onChange(choice)}
            onPick={(value) => setPlacement(withRepoPath(placement, row.key, value))}
          />
          ))}
      </div>
      {runIn === null && preview.source.workspaceFiles && preview.source.workspaceFiles.files.length > 0 ? <FilesSection preview={preview} choice={choice} targetName={targetName} onChange={onChange} /> : null}
    </div>
  );
}

/**
 * D152 follow-up (*Where it runs*): where a workspace agent runs on the target: its
 * workspace root (the default), or one of the repos it carries, as a repo agent of
 * that repo (no workspace there; the other carried repos are its extra folders).
 */
function RunInSection({ preview, targetName, choice, onChange }: { readonly preview: TakeoverPreview; readonly targetName: string; readonly choice: MoveChoice; readonly onChange: (next: MoveChoice) => void }) {
  const options = runInOptions(preview, choice);
  const current = runInOf(choice);
  const picked = options.find((option) => option.value === current) ?? null;
  return (
    <div className="v2-mp-ws" data-testid="v2-move-run-in" data-mode={current === null ? 'workspace' : 'repo'}>
      <Select
        label={`Where it runs on ${targetName}`}
        data-testid="v2-move-run-in-select"
        value={current ?? ''}
        options={options.map((option) => ({ value: option.value, label: option.label }))}
        onChange={(event) => onChange(withRunIn(choice, preview, event.target.value === '' ? null : event.target.value))}
      />
      <p className="v2-muted v2-mv-small">
        {current === null
          ? `It runs in its workspace root on ${targetName}, as here.`
          : `It continues as an agent of ${picked?.label ?? current} on ${targetName}: no workspace is needed or created there, and the other repos it carries are its extra folders.`}
      </p>
    </div>
  );
}

/**
 * The workspace on the target: a folder that is there (D110's picker), or a new
 * folder the developer places: a parent picked on the target (browse or type) and
 * the new folder's name, or a full path typed as is. The suggestion is only
 * pre-filled; nothing applies until **Create it here**; the target's check (final
 * path, writable, not in a repo, empty or confirmed) shows before Move.
 */
function WorkspaceRootSection({ preview, machine, targetName, placement, onChange }: { readonly preview: TakeoverPreview; readonly machine: string | null; readonly targetName: string; readonly placement: TargetPlacement | null; readonly onChange: (next: TargetPlacement | null) => void }) {
  const ws = workspaceView(preview, placement);
  const [mode, setMode] = useState<'existing' | 'new'>(ws.creating !== null || (!ws.found && (placement?.roots.length ?? 0) === 0) ? 'new' : 'existing');
  const [input, setInput] = useState<'parent' | 'full'>('parent');
  const [parent, setParent] = useState('');
  const [name, setName] = useState(ws.suggestedName);
  const [full, setFull] = useState(ws.creating ?? '');
  const [browsing, setBrowsing] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  // The suggested parent (pre-filled only): the parent of the target's saved workspace, else its home.
  useEffect(() => {
    if (mode !== 'new' || suggested !== null) return;
    let live = true;
    api.takeoverFolders(machine, null).then(
      (listing) => {
        if (!live) return;
        const pick = suggestWorkspaceParent(listing.places) ?? '';
        setSuggested(pick);
        setParent((current) => (current === '' ? pick : current));
      },
      () => live && setSuggested(''),
    );
    return () => {
      live = false;
    };
  }, [mode, machine, suggested]);
  const asked = newRootFrom(input, parent, name, full);
  const check = preview.target.workspaceRoot ?? null;
  const switchMode = (next: 'existing' | 'new'): void => {
    setMode(next);
    if (next === 'existing' && placement?.newWorkspace) onChange(withNewWorkspace(placement, null));
  };
  return (
    <div className="v2-mp-ws" data-testid="v2-move-workspace" data-mode={mode}>
      <div className="v2-row v2-mp-ws-head">
        <b className="v2-grow">Workspace on {targetName}</b>
        <Segmented
          label={`The workspace on ${targetName}`}
          size="s"
          value={mode}
          onChange={switchMode}
          testId="v2-move-workspace-mode"
          options={[
            { value: 'existing', label: 'A folder that is there' },
            { value: 'new', label: 'Create a new folder' },
          ]}
        />
      </div>
      {ws.sourceRoot ? <p className="v2-muted v2-mv-small">On the source it is {ws.sourceRoot}; its repos keep their places inside it unless you point one elsewhere.</p> : null}
      {mode === 'existing' ? (
        <FolderPicker machine={machine} machineName={targetName} placement={placement} remembered={preview.remembered} onChange={onChange} />
      ) : (
        <div className="v2-mp-new" data-testid="v2-move-new-root">
          <Segmented
            label="How to give the place"
            size="s"
            value={input}
            onChange={setInput}
            testId="v2-move-new-root-input"
            options={[
              { value: 'parent', label: 'Folder + name' },
              { value: 'full', label: 'Full path' },
            ]}
          />
          {input === 'parent' ? (
            <>
              <div className="v2-row v2-mv-path">
                <Field label={`Create it in (a folder on ${targetName})`} className="v2-mono" value={parent} spellCheck={false} placeholder={suggested ? suggested : `A folder on ${targetName}`} data-testid="v2-move-new-root-parent" onChange={(event) => setParent(event.target.value)} />
                <Button size="sm" icon="folder" aria-expanded={browsing} data-testid="v2-move-new-root-browse" onClick={() => setBrowsing(!browsing)}>
                  {browsing ? AGENT_WORDS.closeDialog : 'Browse…'}
                </Button>
              </div>
              {browsing ? (
                <FolderBrowser
                  machine={machine}
                  start={parent.trim() === '' ? null : parent}
                  onPick={(picked) => {
                    setParent(picked);
                    setBrowsing(false);
                  }}
                />
              ) : null}
              <Field label="New folder’s name" className="v2-mono" value={name} spellCheck={false} data-testid="v2-move-new-root-name" onChange={(event) => setName(event.target.value)} />
            </>
          ) : (
            <Field label={`Full path on ${targetName} (it may not exist yet)`} className="v2-mono" value={full} spellCheck={false} placeholder="D:\code\workspace or /Users/me/workspace" data-testid="v2-move-new-root-full" onChange={(event) => setFull(event.target.value)} />
          )}
          <div className="v2-row">
            {asked.path !== null ? (
              <span className="v2-grow v2-mv-small" data-testid="v2-move-new-root-asked">
                Folder: <code>{asked.path}</code>
              </span>
            ) : (
              <span className="v2-grow v2-mv-small v2-muted" data-testid="v2-move-new-root-problem">
                {asked.problem}
              </span>
            )}
            <Button size="sm" variant="primary" disabled={asked.path === null || asked.path === placement?.newWorkspace?.path} data-testid="v2-move-new-root-use" onClick={() => asked.path && onChange(withNewWorkspace(placement, asked.path))}>
              Create it here
            </Button>
          </div>
          {placement?.newWorkspace ? (
            check === null ? (
              <p className="v2-muted v2-mv-small">Checking on {targetName}…</p>
            ) : (
              <div className="v2-mp-check" data-testid="v2-move-new-root-check" data-ok={check.ok || undefined}>
                <Chip tone={check.ok ? 'green' : check.needsConfirm ? 'amber' : 'red'} icon={check.ok ? 'check-circle' : 'alert'} size="s">
                  {check.ok ? (check.exists ? 'Used' : 'Created') : check.needsConfirm ? 'Confirm' : 'Cannot'}
                </Chip>
                <span className="v2-grow">
                  {check.ok ? (
                    <>
                      {check.exists ? 'Uses ' : 'Will create '}
                      <code data-testid="v2-move-new-root-final">{check.path}</code>
                      {check.exists && !check.empty ? ' (an existing folder: its files stay, nothing there is overwritten)' : ''}
                    </>
                  ) : (
                    check.reason
                  )}
                </span>
              </div>
            )
          ) : null}
          {placement?.newWorkspace && check && (check.needsConfirm || placement.newWorkspace.useExisting) ? (
            <Checkbox
              label="Use this existing folder anyway (its files stay; nothing is overwritten)"
              checked={placement.newWorkspace.useExisting === true}
              data-testid="v2-move-new-root-confirm"
              onChange={(event) => onChange(withNewWorkspace(placement, placement.newWorkspace?.path ?? null, event.target.checked))}
            />
          ) : null}
          <p className="v2-muted v2-mv-small">The workspace’s AGENTS.md comes along: it makes the new folder a workspace.</p>
        </div>
      )}
    </div>
  );
}

/** A folder browser of the target that picks one folder (the new workspace's parent). */
function FolderBrowser({ machine, start, onPick }: { readonly machine: string | null; readonly start: string | null; readonly onPick: (path: string) => void }) {
  const [listing, setListing] = useState<TargetDirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (path: string | null): void => {
    setError(null);
    api.takeoverFolders(machine, path).then(setListing, (caught: unknown) => {
      setError(errorText(caught));
      if (path !== null) load(null);
    });
  };
  useEffect(() => {
    load(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="v2-mv-picker" data-testid="v2-move-new-root-browser">
      {listing ? (
        <div className="v2-row v2-mv-places">
          {listing.places.map((place) => (
            <Button key={place.path} size="sm" icon={place.kind === 'home' ? 'home' : 'folder'} title={place.path} onClick={() => load(place.path)}>
              {place.label}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="v2-mv-error" role="alert">
          {error}
        </div>
      ) : null}
      {listing && listing.path ? (
        <>
          <div className="v2-row">
            <code className="v2-grow">{listing.path}</code>
            <Button size="sm" variant="primary" data-testid="v2-move-new-root-pick" onClick={() => onPick(listing.path as string)}>
              Pick this folder
            </Button>
          </div>
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
        </>
      ) : null}
    </div>
  );
}

/**
 * D152 follow-up 2026-11-05: which of the repos the agent works in the move carries.
 * Every one is ticked by default, the ones it only read in or ran commands in too
 * (it will likely need them there); unticking one leaves it out (`excludeRepos`:
 * not captured, not planned on the target). A read-only one that cannot travel is
 * listed as left out with the reason. D153: one entry per repo, its worktrees
 * nested under it; the agent's own worktrees the move skips (no remote branch,
 * merged) are listed with the reason, and a warning when their uncommitted
 * changes stay on the source.
 */
function CarrySection({ preview, choice, onChange }: { readonly preview: TakeoverPreview; readonly choice: MoveChoice; readonly onChange: (next: MoveChoice) => void }) {
  const groups = carryGroups(preview, choice);
  const leftOut = preview.source.leftOut ?? [];
  const all = groups.flatMap((group) => [...(group.main ? [group.main] : []), ...group.worktrees]);
  const count = all.filter((row) => row.carried).length;
  const tick = (row: CarryRow, label: string, why: string) => (
    <Checkbox
      plain
      label={
        <span className="v2-mp-file v2-mp-carry" title={row.path}>
          <b>{label}</b>
          {why !== '' ? <span className="v2-muted v2-mp-why">{why}</span> : null}
          <span className="v2-grow v2-muted v2-mono v2-mp-file-target">{row.path}</span>
        </span>
      }
      checked={row.carried}
      onChange={(event) => onChange(withRepoCarried(choice, row.path, event.target.checked))}
    />
  );
  return (
    <div className="v2-mp-files" data-testid="v2-move-carry">
      <div className="v2-row">
        <b className="v2-grow">Repos to carry</b>
        <span className="v2-muted v2-mv-small" data-testid="v2-move-carry-count">
          {count} of {all.length} carried
        </span>
      </div>
      <p className="v2-muted v2-mv-small">Every repo the agent worked in is carried, the ones it only read or ran commands in too. Its own worktrees travel only when their branch is on the remote and not merged. Untick one to leave it out of the move.</p>
      <ul className="v2-mp-filelist">
        {groups.map((group) => (
          <li key={group.mainPath} data-testid="v2-move-carry-group" data-name={group.name} data-worktrees={group.worktrees.length} data-skipped={group.skipped.length}>
            {group.main ? (
              <div data-testid="v2-move-carry-repo" data-name={group.main.name} data-carried={group.main.carried ? 'true' : 'false'}>
                {tick(group.main, group.name, group.main.why)}
              </div>
            ) : (
              <div className="v2-mp-file v2-mp-carry" title={group.mainPath}>
                <b>{group.name}</b>
                <span className="v2-muted v2-mp-why">not carried itself</span>
                <span className="v2-grow v2-muted v2-mono v2-mp-file-target">{group.mainPath}</span>
              </div>
            )}
            {group.worktrees.length > 0 || group.skipped.length > 0 ? (
              <ul className="v2-mp-filelist v2-mp-nested" aria-label={`Worktrees of ${group.name}`}>
                {group.worktrees.map((row) => (
                  <li key={row.path} data-testid="v2-move-carry-worktree" data-name={row.label} data-carried={row.carried ? 'true' : 'false'}>
                    {tick(row, row.label, row.why !== '' ? `worktree · ${row.why}` : 'worktree')}
                  </li>
                ))}
                {group.skipped.map((entry) => (
                  <li key={entry.path} className="v2-muted v2-mv-small" data-testid="v2-move-carry-skipped" data-name={entry.label} data-reason={entry.reason}>
                    <span>
                      worktree {entry.label}
                      {entry.branch ? ` (${entry.branch})` : ''}: not carried, {entry.text}
                    </span>
                    {entry.warning ? (
                      <span className="v2-mp-skipped-warn" data-testid="v2-move-carry-skipped-warning">
                        <Icon name="alert" size="s" /> {entry.warning}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
        {leftOut.map((entry) => (
          <li key={entry.path} className="v2-muted v2-mv-small" data-testid="v2-move-carry-leftout" data-name={entry.name}>
            {entry.name} ({entry.path}): not carried, {entry.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * D152 follow-up 2026-11-05 (`docs/peers.md` → *Repos outside the workspace*): the
 * repos the agent works in outside its workspace root. Each one: **Use a folder
 * there** (a checkout of the same remote the target found, or another checkout
 * typed), **Clone it** into a folder picked on the target (a parent and a name,
 * the path shown before Move), or **Leave it out**. Carried by default when the
 * agent edited files there or ran most of its commands there; else left out.
 */
function OutsideSection({
  rows,
  targetWorkspace,
  machine,
  sourceName,
  targetName,
  choice,
  onChange,
}: {
  readonly rows: readonly OutsideRow[];
  readonly targetWorkspace: string | null;
  readonly machine: string | null;
  readonly sourceName: string;
  readonly targetName: string;
  readonly choice: MoveChoice;
  readonly onChange: (next: MoveChoice) => void;
}) {
  const carried = rows.filter((row) => row.mode !== 'leave').length;
  return (
    <div className="v2-mp-files" data-testid="v2-move-outside">
      <div className="v2-row">
        <b className="v2-grow">Outside the workspace</b>
        <span className="v2-muted v2-mv-small" data-testid="v2-move-outside-count">
          {carried} of {rows.length} carried
        </span>
      </div>
      <p className="v2-muted v2-mv-small">Repos the agent works in outside its workspace folder. A carried one keeps working there after the move: the agent gets its folder on {targetName} as an extra folder.</p>
      <ul className="v2-mp-filelist">
        {rows.map((row) => (
          <OutsideRowView key={row.key} row={row} targetWorkspace={targetWorkspace} machine={machine} sourceName={sourceName} targetName={targetName} choice={choice} onChange={onChange} />
        ))}
      </ul>
    </div>
  );
}

function OutsideRowView({
  row,
  targetWorkspace,
  machine,
  sourceName,
  targetName,
  choice,
  onChange,
}: {
  readonly row: OutsideRow;
  readonly targetWorkspace: string | null;
  readonly machine: string | null;
  readonly sourceName: string;
  readonly targetName: string;
  readonly choice: MoveChoice;
  readonly onChange: (next: MoveChoice) => void;
}) {
  const start = splitClonePath(row.cloneTo);
  const [parent, setParent] = useState(start.parent);
  const [name, setName] = useState(start.name !== '' ? start.name : row.name);
  const [browsing, setBrowsing] = useState(false);
  const [override, setOverride] = useState<string | null>(null);
  // The target's suggestion arrives with a later preview: pre-fill the fields once.
  useEffect(() => {
    if (parent === '' && start.parent !== '') setParent(start.parent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.parent]);
  const asked = outsideClonePath(parent, name);
  const setMode = (mode: OutsideMode): void => onChange(withOutsideMode(choice, row.key, mode, targetWorkspace));
  const useClonePath = (value: string): void => onChange({ ...withOutsideMode(choice, row.key, 'clone', targetWorkspace), clonePaths: { ...choice.clonePaths, [row.key]: value } });
  return (
    <li className="v2-mv-repo" data-testid="v2-move-outside-repo" data-key={row.key} data-name={row.name} data-mode={row.mode} data-default={row.defaultCarry ? 'carry' : 'leave'} data-action={row.action ?? 'left-out'}>
      <div className="v2-row v2-mv-repo-head">
        <b>{row.name}</b>
        {row.why !== '' ? <span className="v2-muted v2-mp-why">{row.why}</span> : null}
        <span className="v2-grow v2-muted v2-mono v2-mp-file-target" title={row.path}>
          {sourceName}: {row.path}
        </span>
      </div>
      <p className="v2-muted v2-mv-small" data-testid="v2-move-outside-default">
        {row.defaultText}
      </p>
      <Segmented
        label={`${row.name} on ${targetName}`}
        size="s"
        value={row.mode}
        onChange={setMode}
        testId="v2-move-outside-mode"
        options={[
          { value: 'use', label: 'Use a folder there' },
          { value: 'clone', label: 'Clone it' },
          { value: 'leave', label: 'Leave it out' },
        ]}
      />
      {row.mode === 'leave' ? (
        <p className="v2-mv-line" data-testid="v2-move-outside-summary">
          Not carried: it stays on {sourceName}.
        </p>
      ) : (
        <p className="v2-mv-line" data-testid="v2-move-outside-summary">
          {row.target ?? `Checking on ${targetName}…`}
        </p>
      )}
      {row.mode === 'use' ? (
        override === null ? (
          <Button size="sm" variant="ghost" data-testid="v2-move-outside-other" onClick={() => setOverride(row.usePath ?? '')}>
            Another checkout…
          </Button>
        ) : (
          <Field
            label={`Use this checkout on ${targetName}`}
            className="v2-mono"
            value={override}
            placeholder={`The checkout of ${row.name} on ${targetName}`}
            spellCheck={false}
            data-testid="v2-move-outside-override"
            onChange={(event) => setOverride(event.target.value)}
            onBlur={() => onChange({ ...choice, placement: withRepoPath(withTargetWorkspace(choice.placement, targetWorkspace), row.key, override.trim() === '' ? null : override) })}
          />
        )
      ) : null}
      {row.mode === 'clone' ? (
        <div className="v2-mp-new" data-testid="v2-move-outside-clone">
          <div className="v2-row v2-mv-path">
            <Field label={`Clone it in (a folder on ${targetName})`} className="v2-mono" value={parent} spellCheck={false} data-testid="v2-move-outside-parent" onChange={(event) => setParent(event.target.value)} />
            <Button size="sm" icon="folder" aria-expanded={browsing} data-testid="v2-move-outside-browse" onClick={() => setBrowsing(!browsing)}>
              {browsing ? AGENT_WORDS.closeDialog : 'Browse…'}
            </Button>
          </div>
          {browsing ? (
            <FolderBrowser
              machine={machine}
              start={parent.trim() === '' ? null : parent}
              onPick={(picked) => {
                setParent(picked);
                setBrowsing(false);
              }}
            />
          ) : null}
          <Field label="Folder name" className="v2-mono" value={name} spellCheck={false} data-testid="v2-move-outside-name" onChange={(event) => setName(event.target.value)} />
          <div className="v2-row">
            {asked.path !== null ? (
              <span className="v2-grow v2-mv-small" data-testid="v2-move-outside-clone-path">
                Clones into <code>{asked.path}</code>
              </span>
            ) : (
              <span className="v2-grow v2-mv-small v2-muted">{asked.problem}</span>
            )}
            <Button size="sm" variant="primary" disabled={asked.path === null || asked.path === choice.clonePaths[row.key]} data-testid="v2-move-outside-clone-use" onClick={() => asked.path && useClonePath(asked.path)}>
              Clone it here
            </Button>
          </div>
          {choice.clonePaths[row.key] === undefined && row.cloneTo ? (
            <p className="v2-muted v2-mv-small">
              Suggested by {targetName}: beside the workspace folder. Pick another folder or keep it.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * D153: a checkout on the target the restore checks a branch out in has uncommitted
 * changes. The dialog shows them (names and counts, read on the target) and offers
 * **Stash them on <PC>**: only once ticked does the target run `git stash push
 * --include-untracked` there before restoring; the stash is kept (never dropped or
 * popped) and the result says how to restore it.
 */
function StashSection({ preview, choice, targetName, onChange }: { readonly preview: TakeoverPreview; readonly choice: MoveChoice; readonly targetName: string; readonly onChange: (next: MoveChoice) => void }) {
  const rows = stashRows(preview, choice);
  return (
    <div className="v2-mp-files" data-testid="v2-move-stash">
      <b>Uncommitted changes on {targetName}</b>
      {rows.map((row) => (
        <div key={row.path} className="v2-mv-warn" data-testid="v2-move-stash-row" data-path={row.path} data-confirmed={row.confirmed ? 'true' : 'false'}>
          <p>
            <code>{row.path}</code> ({row.names.join(', ')}) has {row.changes ? `${row.changes.total} uncommitted file${row.changes.total === 1 ? '' : 's'}` : 'uncommitted files'} on {targetName}. The move checks a branch out there, so they must be put aside first.
          </p>
          {row.changes && row.changes.files.length > 0 ? (
            <ul className="v2-mp-filelist" data-testid="v2-move-stash-files">
              {row.changes.files.map((file) => (
                <li key={file} className="v2-mono v2-mv-small">
                  {file}
                </li>
              ))}
              {row.changes.truncated ? <li className="v2-muted v2-mv-small">and {row.changes.total - row.changes.files.length} more</li> : null}
            </ul>
          ) : null}
          <Checkbox
            label={`Stash them on ${targetName}`}
            checked={row.confirmed}
            data-testid="v2-move-stash-confirm"
            onChange={(event) => onChange(withStash(choice, row.path, event.target.checked))}
          />
          <p className="v2-muted v2-mv-small">Switchboard runs git stash push --include-untracked there right before restoring, and keeps the stash: it is never dropped or popped, also when the move is undone. Restore it later with git stash list and git stash apply.</p>
        </div>
      ))}
    </div>
  );
}

/** The workspace's own files: ticks, secrets marked and unticked, what is there on the target, the confirmation. */
function FilesSection({ preview, choice, targetName, onChange }: { readonly preview: TakeoverPreview; readonly choice: MoveChoice; readonly targetName: string; readonly onChange: (next: MoveChoice) => void }) {
  const creating = Boolean(preview.target.workspaceRoot?.ok && !preview.target.workspaceRoot.workspace);
  const rows = fileRows(preview, choice.files, creating);
  const secrets = tickedSecrets(preview, choice.files);
  const listing = preview.source.workspaceFiles;
  const count = rows.filter((row) => row.ticked).length;
  return (
    <div className="v2-mp-files" data-testid="v2-move-files">
      <div className="v2-row">
        <b className="v2-grow">The workspace’s own files</b>
        <span className="v2-muted v2-mv-small" data-testid="v2-move-files-count">
          {count} of {rows.length} copied to {targetName}
        </span>
      </div>
      <p className="v2-muted v2-mv-small">Files in the workspace folder outside its repos, copied over the paired link. A file that looks like it holds a secret is marked and copied only if you tick it and confirm. A different file on {targetName} is never overwritten.</p>
      <ul className="v2-mp-filelist">
        {rows.map((row) => (
          <li key={row.name} data-testid="v2-move-file" data-name={row.name} data-ticked={row.ticked || undefined} data-secret={row.secret ? 'true' : undefined} data-state={row.state ?? ''}>
            <Checkbox
              plain
              label={
                <span className="v2-mp-file">
                  <code className="v2-grow">{row.name}</code>
                  <span className="v2-muted">{row.size}</span>
                  {row.secret ? (
                    <Chip tone="amber" icon="alert" size="s">
                      secret?
                    </Chip>
                  ) : null}
                  <span className="v2-muted v2-mp-file-target">{row.disabled ?? row.target}</span>
                </span>
              }
              title={row.secret ? `Looks like it holds a secret: ${row.secret}` : (row.disabled ?? undefined)}
              checked={row.ticked}
              disabled={row.disabled !== null}
              onChange={(event) => onChange({ ...choice, files: toggleFile(choice.files, row.name, event.target.checked) })}
            />
          </li>
        ))}
      </ul>
      {listing?.truncated ? <p className="v2-muted v2-mv-small">Only the first {rows.length} files are listed.</p> : null}
      {secrets.length > 0 ? (
        <div className="v2-mv-warn" data-testid="v2-move-files-secret">
          <p>
            {secrets.length === 1 ? `${secrets[0]} looks like it holds secrets.` : `${secrets.length} ticked files look like they hold secrets.`} They travel only over the paired link, are never logged, and land readable by you only.
          </p>
          <Checkbox
            label="Copy the marked files after confirming"
            checked={choice.files?.confirmSecrets === true}
            data-testid="v2-move-files-confirm"
            onChange={(event) => onChange({ ...choice, files: { copy: [...(choice.files?.copy ?? [])], ...(event.target.checked ? { confirmSecrets: true } : {}) } })}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * D110 in v2: the folders on the target (chips; none = its saved folders) and
 * **Choose folders…**: the target's saved folders and home, a path field, and its
 * folders to browse (through the peer API). Every change re-runs the preview.
 */
export function FolderPicker({
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

/** One code project: ✓ / ⚠ / ✖, both sides, D152's use-or-clone choice, the choices, another checkout, the clone folder. */
function RepoRowView({
  row,
  sourceName,
  targetName,
  mode,
  clonePath,
  onMode,
  onClonePath,
  onCloneDone,
  onPick,
}: {
  readonly row: RepoRow;
  readonly sourceName: string;
  readonly targetName: string;
  readonly mode: 'use' | 'clone';
  readonly clonePath: string | undefined;
  readonly onMode: (mode: 'use' | 'clone') => void;
  readonly onClonePath: (value: string) => void;
  readonly onCloneDone: () => void;
  readonly onPick: (path: string | null) => void;
}) {
  const [override, setOverride] = useState<string | null>(null);
  const look = repoLook(row.mark);
  const showClone = mode === 'clone' || row.action === 'clone' || (row.action === 'blocked' && row.cloneTo !== null);
  return (
    <div className="v2-mv-repo" data-testid="v2-move-repo" data-key={row.key} data-action={row.action} data-mark={row.mark} data-tone={look.tone} data-mode={mode}>
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
          <Segmented
            label={`${row.name} on ${targetName}`}
            size="s"
            value={mode}
            onChange={onMode}
            testId="v2-move-repo-mode"
            options={[
              { value: 'use', label: 'Use a folder there' },
              { value: 'clone', label: 'Clone it' },
            ]}
          />
          <span className="v2-mv-line" data-testid="v2-move-repo-summary">
            {row.target}
          </span>
          {mode === 'use' && row.choices.length > 0 ? (
            <div className="v2-mv-choices" role="group" aria-label={`Which checkout of ${row.name}`}>
              {row.choices.map((choice) => (
                <Button key={choice.path} size="sm" data-testid="v2-move-repo-choice" onClick={() => onPick(choice.path)}>
                  {choice.path} · {choice.branch ?? 'detached'}
                  {choice.dirty > 0 ? ` · ${choice.dirty} uncommitted` : ''}
                </Button>
              ))}
            </div>
          ) : null}
          {mode === 'use' ? (
            override === null ? (
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
            )
          ) : null}
          {showClone ? (
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
