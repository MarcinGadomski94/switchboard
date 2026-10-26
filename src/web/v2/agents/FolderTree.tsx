import { type KeyboardEvent, useState } from 'react';
import { Icon, IconButton, Menu, type MenuItem } from '../components/index.ts';
import { V2Link } from '../nav.tsx';
import { AGENTS_WORDS, computerProblem } from '../glossary.ts';
import { type AgentEntry, offline } from './agents-model.ts';
import { MiniStatus, useAgentsPage } from './context.tsx';
import { dragSource, dropTarget, isMoveKey } from './dnd.ts';
import { type AgentTree, type Selection, type TreeFolder, canNest } from './tree-model.ts';

/**
 * D131 · lane A · the folder tree left of Agents (`.ftree`): All agents, Needs
 * you, Pinned, the folders (nested, counts, a Needs-you badge on a folded one,
 * project subfolders), Not in a folder, Drafts, Closed, and the links
 * to Notes, Tasks and Routines. Agents drag onto folders; ⋯ on a folder makes a
 * subfolder, pins, renames or deletes it; ⋯ on an agent offers Move to folder…
 * (or `M`). Teammates are not here: the Crews pages own them (fix after 2.0).
 */
export function FolderTree({ tree, selection, onSelect, draftCount, closedCount, shareText }: { readonly tree: AgentTree; readonly selection: Selection; readonly onSelect: (selection: Selection) => void; readonly draftCount: number; readonly closedCount: number | null; readonly shareText: string }) {
  const page = useAgentsPage();
  return (
    <nav className="v2-ftree" aria-label={AGENTS_WORDS.folders} data-testid="v2-ftree">
      <SmartRow id="all" icon="agents" label={AGENTS_WORDS.allAgents} count={tree.all} selection={selection} onSelect={onSelect} />
      <SmartRow id="needs" icon="hand" label={AGENTS_WORDS.needsYou} count={tree.needs} amber selection={selection} onSelect={onSelect} />
      {tree.pinned.length ? (
        <>
          <h4>
            <Icon name="pin" size="s" />
            {AGENTS_WORDS.pinned}
          </h4>
          <div data-testid="v2-tree-pinned">
            {tree.pinned.map((agent) => (
              <Leaf key={agent.id} agent={agent} depth={0} />
            ))}
          </div>
        </>
      ) : null}
      <h4>
        {AGENTS_WORDS.folders}
        <IconButton icon="folder-plus" label={AGENTS_WORDS.newFolder} title={AGENTS_WORDS.newFolder} onClick={() => page.openFolderDialog({ mode: 'new', parentId: null })} data-testid="v2-tree-new-folder" />
      </h4>
      <div role="tree" aria-label={AGENTS_WORDS.folders}>
        {tree.folders.map((folder) => (
          <FolderNode key={folder.id} folder={folder} tree={tree} selection={selection} onSelect={onSelect} />
        ))}
      </div>
      <h4 data-testid="v2-tree-loose" {...dropTarget((id) => {
          const agent = allAgents.get(id);
          if (agent) void page.actions.move(agent, { kind: 'loose' });
        })}>
        <button type="button" className="v2-fn-main" style={{ minHeight: 28, padding: 0, textTransform: 'inherit', letterSpacing: 'inherit', fontSize: 'inherit', color: 'inherit' }} onClick={() => onSelect('loose')} aria-pressed={selection === 'loose'}>
          <span className="v2-nm">{AGENTS_WORDS.notInFolder}</span>
          <span className="v2-n">{tree.loose.length}</span>
        </button>
      </h4>
      {tree.loose.map((agent) => (
        <Leaf key={agent.id} agent={agent} depth={0} />
      ))}
      <h4>{AGENTS_WORDS.also}</h4>
      {draftCount > 0 ? <SmartRow id="drafts" icon="edit" label={AGENTS_WORDS.drafts} count={draftCount} selection={selection} onSelect={onSelect} /> : null}
      <LinkRow to="/agents?show=closed" icon="clock" label={AGENTS_WORDS.closed} count={closedCount} testId="v2-tree-closed" />
      <LinkRow to="/notes" icon="book" label={AGENTS_WORDS.notes} />
      <LinkRow to="/tasks" icon="task" label={AGENTS_WORDS.tasks} />
      <LinkRow to="/routines" icon="routine" label={AGENTS_WORDS.routines} />
      <p className="v2-tree-note" data-testid="v2-tree-note">
        <Icon name="refresh" size="s" />
        <span>{shareText}</span>
      </p>
    </nav>
  );
}

/** Every agent by id (the drop targets look the dragged one up here, wherever it was dragged from). */
let allAgents = new Map<string, AgentEntry>();
/** The page keeps this current (rows outside the tree are dragged too). */
export function setDraggableAgents(list: readonly AgentEntry[]): void {
  allAgents = new Map(list.map((agent) => [agent.id, agent]));
}

function SmartRow({ id, icon, label, count, amber = false, selection, onSelect }: { readonly id: Selection; readonly icon: string; readonly label: string; readonly count: number; readonly amber?: boolean; readonly selection: Selection; readonly onSelect: (selection: Selection) => void }) {
  return (
    <div className="v2-fn" {...(selection === id ? { 'data-on': '' } : {})}>
      <span className="v2-fn-tog" data-blank="" />
      <button type="button" className="v2-fn-main" onClick={() => onSelect(id)} aria-current={selection === id ? 'true' : undefined} data-testid={`v2-tree-${id}`}>
        <Icon name={icon} size="s" />
        <span className="v2-nm">{label}</span>
        {amber && count ? (
          <span className="v2-nb">
            <Icon name="hand" size="s" />
            {count}
          </span>
        ) : (
          <span className="v2-n">{count}</span>
        )}
      </button>
    </div>
  );
}

function LinkRow({ to, icon, label, count = null, testId }: { readonly to: string; readonly icon: string; readonly label: string; readonly count?: number | null; readonly testId?: string }) {
  return (
    <div className="v2-fn">
      <span className="v2-fn-tog" data-blank="" />
      <V2Link to={to} className="v2-fn-main" data-testid={testId} style={{ textDecoration: 'none' }}>
        <Icon name={icon} size="s" />
        <span className="v2-nm">{label}</span>
        {count !== null ? <span className="v2-n">{count}</span> : null}
      </V2Link>
    </div>
  );
}

function folderIcon(folder: Pick<TreeFolder, 'plan'>) {
  return folder.plan ? <Icon name="projects" size="s" className="v2-plan-ic" /> : <Icon name="folder" size="s" />;
}

function FolderNode({ folder, tree, selection, onSelect }: { readonly folder: TreeFolder; readonly tree: AgentTree; readonly selection: Selection; readonly onSelect: (selection: Selection) => void }) {
  const page = useAgentsPage();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const open = !folder.collapsed;
  const on = selection === `folder:${folder.id}`;
  const items: MenuItem[] = [
    folder.plan
      ? { id: 'open-project', label: AGENTS_WORDS.openProject, icon: 'projects', onSelect: () => onSelect(`folder:${folder.id}`) }
      : { id: 'new-sub', label: AGENTS_WORDS.newSubfolder, icon: 'folder-plus', onSelect: () => page.openFolderDialog({ mode: 'new', parentId: folder.id }), ...(canNest(folder) ? {} : { disabledReason: AGENTS_WORDS.tooDeep }) },
    { id: 'rename', label: AGENTS_WORDS.rename, icon: 'edit', onSelect: () => page.openFolderDialog({ mode: 'rename', folderId: folder.id }), ...(folder.plan ? { disabledReason: AGENTS_WORDS.managedPlan } : {}) },
    { id: 'delete', label: AGENTS_WORDS.delete, icon: 'trash', danger: true, onSelect: () => page.openFolderDialog({ mode: 'delete', folderId: folder.id }) },
  ];
  return (
    <>
      <div
        className="v2-fn"
        role="treeitem"
        aria-level={folder.level}
        aria-expanded={open}
        aria-selected={on}
        data-folder={folder.id}
        data-testid="v2-tree-folder"
        {...(on ? { 'data-on': '' } : {})}
        style={{ paddingLeft: (folder.level - 1) * 14 }}
        {...dropTarget((id) => {
          const agent = allAgents.get(id);
          if (agent) void page.actions.move(agent, { kind: 'folder', folderId: folder.id });
        })}
      >
        <button type="button" className="v2-fn-tog" onClick={() => void page.actions.setCollapsed(folder.id, open)} aria-label={open ? AGENTS_WORDS.collapse(folder.name) : AGENTS_WORDS.expand(folder.name)} data-testid="v2-tree-toggle">
          <Icon name="chev" size="s" />
        </button>
        <button type="button" className="v2-fn-main" onClick={() => onSelect(`folder:${folder.id}`)} data-testid="v2-tree-folder-main">
          {folderIcon(folder)}
          <span className="v2-nm" data-testid="v2-tree-folder-name">
            {folder.name}
          </span>
          {!open && folder.needs ? (
            <span className="v2-nb" title={AGENTS_WORDS.needCount(folder.needs)} data-testid="v2-tree-needs">
              <Icon name="hand" size="s" />
              {folder.needs}
            </span>
          ) : null}
          <span className="v2-n" data-testid="v2-tree-count">
            {folder.count}
          </span>
        </button>
        <button type="button" ref={setAnchor} className="v2-fn-more" aria-label={AGENTS_WORDS.folderActions(folder.name)} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} data-testid="v2-tree-folder-menu">
          <Icon name="more" size="s" />
        </button>
        <Menu items={items} anchor={anchor} open={menu} onClose={() => setMenu(false)} label={AGENTS_WORDS.folderActions(folder.name)} testId="v2-folder-menu" />
      </div>
      {open ? (
        <div role="group">
          {folder.children.map((child) => (
            <FolderNode key={child.id} folder={child} tree={tree} selection={selection} onSelect={onSelect} />
          ))}
          {folder.agents.map((agent) => (
            <Leaf key={agent.id} agent={agent} depth={folder.level} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** An agent in the tree (`.fl`): its status mark, name, computer; draggable; ⋯ and `M`. */
function Leaf({ agent, depth }: { readonly agent: AgentEntry; readonly depth: number }) {
  const page = useAgentsPage();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const off = offline(agent);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isMoveKey(event)) return;
    event.preventDefault();
    page.openMove(agent);
  };
  return (
    <div className="v2-fl" {...dragSource(agent.id)} {...(off ? { 'data-off': '' } : {})} style={{ paddingLeft: depth * 14 + 30 }} data-testid="v2-tree-agent" data-session={agent.id} onKeyDown={keyDown}>
      <button type="button" className="v2-fl-main" onClick={() => page.openAgent(agent)} title={off && agent.computer ? AGENTS_WORDS.offlineLine(agent.computer.name, computerProblem(agent.computer.state === 'reconnecting' ? 'reconnecting' : 'offline')) : agent.name}>
        <MiniStatus status={agent.status} />
        <span className="v2-nm">{agent.name}</span>
        {agent.computer ? (
          <span className="v2-ctag" data-state={agent.computer.state} title={`${agent.computer.name}${off ? ' · offline' : ''}`}>
            <Icon name={off ? 'offline' : 'desktop'} size="s" />
            <span className="v2-sr">{`${agent.computer.name}${off ? ' offline' : ''}`}</span>
          </span>
        ) : null}
      </button>
      <button type="button" ref={setAnchor} className="v2-fn-more" aria-label={AGENTS_WORDS.agentActions(agent.name)} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} data-testid="v2-tree-agent-menu">
        <Icon name="more" size="s" />
      </button>
      <Menu items={page.agentMenu(agent)} anchor={anchor} open={menu} onClose={() => setMenu(false)} label={AGENTS_WORDS.agentActions(agent.name)} testId="v2-agent-menu" />
    </div>
  );
}

