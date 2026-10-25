import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import { SIDEBAR_FOLDER_NAME_MAX } from '../../../core/sidebar-layout.ts';
import { Button, Dialog, Field, Icon, Select } from '../components/index.ts';
import { AGENTS_WORDS } from '../glossary.ts';
import type { AgentEntry } from './agents-model.ts';
import type { FolderDialogRequest } from './context.tsx';
import { type AgentTree, deleteSummary, findFolder, parentOptions, pickRows } from './tree-model.ts';
import type { TreeActions } from './useTreeActions.ts';

/**
 * D131 · lane A · the Agents page's dialogs: Move to folder (the keyboard way to
 * drag, ↑ ↓ ↩; a teammate picks a crew instead), New / Rename / Delete folder,
 * Rename agent.
 */

/** Move to folder (or, for a teammate, to another crew). */
export function MoveDialog({ agent, layout, tree, actions, onClose }: { readonly agent: AgentEntry | null; readonly layout: SidebarLayout; readonly tree: AgentTree; readonly actions: TreeActions; readonly onClose: () => void }) {
  const mate = agent?.kind === 'mate';
  const rows = agent && !mate ? pickRows(agent, layout, tree) : [];
  const crews = agent && mate ? tree.crews : [];
  const initial = agent ? (mate ? (agent.crew?.id ?? '') : (rows.find((row) => row.current)?.value ?? 'loose')) : '';
  const [value, setValue] = useState(initial);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setValue(initial);
    // Only when another agent's dialog opens.
  }, [agent?.id]);
  if (!agent) return null;
  const go = (): void => {
    onClose();
    if (mate) void actions.move(agent, { kind: 'crew', crewId: value });
    else void actions.move(agent, value === 'loose' ? { kind: 'loose' } : { kind: 'folder', folderId: value });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      go();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      icon="folder-move"
      title={mate ? AGENTS_WORDS.moveToCrew.replace('…', '') : AGENTS_WORDS.moveTitle}
      width={520}
      testId="v2-move-dialog"
      footer={
        <>
          <Button onClick={onClose}>{AGENTS_WORDS.cancel}</Button>
          <Button variant="primary" icon="folder-move" onClick={go} data-testid="v2-move-go">
            {AGENTS_WORDS.moveHere}
          </Button>
        </>
      }
    >
      <p className="v2-muted" style={{ marginTop: 0, fontSize: 14 }}>
        <b style={{ color: 'var(--v2-text)' }}>{agent.name}</b>
      </p>
      <p className="v2-muted" style={{ marginTop: 0, fontSize: 13.5 }}>
        {AGENTS_WORDS.moveHint}
      </p>
      <div className="v2-fpick" role="radiogroup" aria-label={AGENTS_WORDS.folders} ref={list} onKeyDown={keyDown} data-testid="v2-move-list">
        {mate
          ? crews.map((crew) => (
              <label key={crew.id}>
                <input type="radio" name="v2-move" value={crew.id} checked={value === crew.id} onChange={() => setValue(crew.id)} {...(crew.id === initial ? { 'data-autofocus': '' } : {})} />
                <Icon name="crew" size="s" />
                <span className="v2-grow">{crew.name}</span>
              </label>
            ))
          : rows.map((row) => (
              <label key={row.value} style={{ paddingLeft: 10 + row.depth * 20 }} {...(row.disabled ? { 'data-disabled': '' } : {})} data-testid="v2-move-option">
                <input type="radio" name="v2-move" value={row.value} checked={value === row.value} disabled={row.disabled !== null} onChange={() => setValue(row.value)} {...(row.value === initial ? { 'data-autofocus': '' } : {})} />
                <Icon name={row.value === 'loose' ? 'agents' : row.plan ? 'projects' : 'folder'} size="s" className={row.plan ? 'v2-plan-ic' : undefined} />
                <span className="v2-grow">{row.label}</span>
                <span className="v2-muted" style={{ fontSize: 12 }}>
                  {row.disabled && row.disabled !== '' ? (row.plan ? AGENTS_WORDS.projectStepsOnly : '') : row.count}
                </span>
              </label>
            ))}
      </div>
    </Dialog>
  );
}

/** New folder (with "Inside"), Rename folder, Delete folder. */
export function FolderDialog({ request, tree, actions, onClose, onCreated }: { readonly request: FolderDialogRequest | null; readonly tree: AgentTree; readonly actions: TreeActions; readonly onClose: () => void; readonly onCreated: (id: string) => void }) {
  const folder = request && request.mode !== 'new' ? findFolder(tree, request.folderId) : null;
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!request) return;
    setName(request.mode === 'rename' ? (folder?.name ?? '') : request.mode === 'new' ? AGENTS_WORDS.newFolder : '');
    setParent(request.mode === 'new' ? (request.parentId ?? '') : '');
    window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 30);
  }, [request]);
  if (!request || (request.mode !== 'new' && !folder)) return null;
  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    onClose();
    if (request.mode === 'new') {
      void actions.createFolder(name.trim() || AGENTS_WORDS.newFolder, parent || null).then((id) => id && onCreated(id));
    } else if (request.mode === 'rename' && folder) {
      const next = name.trim();
      if (next && next !== folder.name) void actions.renameFolder(folder.id, next);
    } else if (folder) void actions.deleteFolder(folder.id);
  };
  const parentName = folder?.parentId ? (findFolder(tree, folder.parentId)?.name ?? null) : null;
  const title = request.mode === 'new' ? AGENTS_WORDS.newFolder : request.mode === 'rename' ? AGENTS_WORDS.renameFolderTitle : AGENTS_WORDS.deleteTitle(folder?.name ?? '');
  return (
    <Dialog
      open
      onClose={onClose}
      icon={request.mode === 'delete' ? 'trash' : request.mode === 'rename' ? 'edit' : 'folder-plus'}
      title={title}
      width={500}
      testId="v2-folder-dialog"
      footer={
        <>
          <Button onClick={onClose}>{AGENTS_WORDS.cancel}</Button>
          <Button variant={request.mode === 'delete' ? 'danger' : 'primary'} onClick={() => submit()} data-testid="v2-folder-go">
            {request.mode === 'new' ? AGENTS_WORDS.createFolder : request.mode === 'rename' ? AGENTS_WORDS.renameButton : AGENTS_WORDS.deleteButton}
          </Button>
        </>
      }
    >
      {request.mode === 'delete' && folder ? (
        <p style={{ margin: 0 }} data-testid="v2-folder-delete-text">
          {deleteSummary(folder, parentName)}
        </p>
      ) : (
        <form onSubmit={submit}>
          <Field ref={input} label={AGENTS_WORDS.name} value={name} maxLength={SIDEBAR_FOLDER_NAME_MAX} onChange={(event) => setName(event.target.value)} data-testid="v2-folder-name" />
          {request.mode === 'new' ? (
            <>
              <Select label={AGENTS_WORDS.inside} value={parent} onChange={(event) => setParent(event.target.value)} options={[{ value: '', label: AGENTS_WORDS.topLevel }, ...parentOptions(tree).map((option) => ({ value: option.id, label: option.label }))]} data-testid="v2-folder-parent" />
              <p className="v2-muted" style={{ fontSize: 13, marginBottom: 0 }}>
                {AGENTS_WORDS.nestHint}
              </p>
            </>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}

/** Rename an agent (its title, `PUT /api/sessions/{id}/title`). */
export function RenameDialog({ agent, onClose, onRename }: { readonly agent: AgentEntry | null; readonly onClose: () => void; readonly onRename: (agent: AgentEntry, title: string) => void }) {
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setName(agent?.name ?? '');
    window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 30);
  }, [agent]);
  if (!agent) return null;
  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    onClose();
    const next = name.trim();
    if (next && next !== agent.name) onRename(agent, next);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      icon="edit"
      title={AGENTS_WORDS.renameAgentTitle}
      width={500}
      testId="v2-rename-dialog"
      footer={
        <>
          <Button onClick={onClose}>{AGENTS_WORDS.cancel}</Button>
          <Button variant="primary" onClick={() => submit()}>
            {AGENTS_WORDS.renameButton}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field ref={input} label={AGENTS_WORDS.name} value={name} onChange={(event) => setName(event.target.value)} />
      </form>
    </Dialog>
  );
}
