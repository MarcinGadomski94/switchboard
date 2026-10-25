import { useMemo, useState } from 'react';
import type { TeamSummary } from '../../../core/team.ts';
import { Icon, Segmented } from '../components/index.ts';
import { AGENTS_WORDS } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { AgentRow } from '../shared/agent-row.tsx';
import { type AgentEntry, BOARD_COLUMNS, type BoardColumn, PHONE_VIEWS, PREF_KEYS, type PhoneView, chatSections, columnOf, isPhoneView, sortAgents } from './agents-model.ts';
import { kindLabel, useAgentsPage } from './context.tsx';
import { type AgentTree, type TreeCrew, type TreeFolder, drill } from './tree-model.ts';
import { type NewDraft, usePref } from './useAgentsData.ts';

/**
 * D131 · lane A · Agents on a phone (≤ 767 px; the prototype's phone frame
 * "Agents · chats with folders drill-down"): Chats | Folders | Board. Folders is
 * a drill-down list with a breadcrumb, browse only (rearranging happens on a
 * computer; the phone follows the shared layout).
 */
export function PhoneAgents({ agents, tree, teams, newDraft }: { readonly agents: readonly AgentEntry[]; readonly tree: AgentTree; readonly teams: readonly TeamSummary[]; readonly newDraft: NewDraft | null }) {
  const [view, setView] = usePref<PhoneView>(PREF_KEYS.phoneView, 'chats', isPhoneView);
  return (
    <div data-testid="v2-agents-phone">
      <Segmented options={PHONE_VIEWS.map((value) => ({ value, label: AGENTS_WORDS.views[value] }))} value={view} onChange={setView} label={AGENTS_WORDS.viewLabel} testId="v2-phone-view" tour="v2-agents-view" />
      {view === 'chats' ? <PhoneChats agents={agents} teams={teams} newDraft={newDraft} /> : view === 'folders' ? <PhoneFolders tree={tree} /> : <PhoneBoard agents={agents} />}
    </div>
  );
}

function Row({ agent }: { readonly agent: AgentEntry }) {
  const page = useAgentsPage();
  const label = kindLabel(agent);
  return (
    <AgentRow
      session={agent.session}
      activity={page.activityOf(agent.id)}
      extras={{ ask: agent.asks[0]?.title ?? null, askStatus: agent.asks.length ? agent.status : undefined, unread: agent.unread, draft: agent.draft !== null, kindLabel: '' }}
      tags={label ? <span className="v2-tag">{label}</span> : null}
      onOpen={() => page.openAgent(agent)}
    />
  );
}

function PhoneChats({ agents, teams, newDraft }: { readonly agents: readonly AgentEntry[]; readonly teams: readonly TeamSummary[]; readonly newDraft: NewDraft | null }) {
  const sections = useMemo(() => chatSections(agents, teams), [agents, teams]);
  const drafts = agents.filter((agent) => agent.draft !== null).length + (newDraft ? 1 : 0);
  return (
    <div data-testid="v2-phone-chats">
      {drafts ? (
        <div className="v2-p-list" style={{ marginTop: 12 }}>
          <div className="v2-p-fold" style={{ cursor: 'default' }}>
            <Icon name="edit" />
            <span className="v2-grow">
              <b style={{ display: 'block' }}>{AGENTS_WORDS.draftsTitle(drafts)}</b>
              <span className="v2-muted" style={{ fontSize: 13 }}>
                {AGENTS_WORDS.draftsNote}
              </span>
            </span>
          </div>
        </div>
      ) : null}
      {sections.map((section) => (
        <div key={section.id}>
          <div className="v2-p-sec" {...(section.kind === 'needs' ? { 'data-tone': 'amber' } : {})}>
            <Icon name={section.kind === 'needs' ? 'hand' : section.kind === 'crew' ? 'crew' : 'chats'} size="s" />
            {section.kind === 'needs' ? `${AGENTS_WORDS.needsYou} · ${section.items.length}` : section.kind === 'crew' ? `Crew · ${section.crew?.name ?? ''}` : AGENTS_WORDS.everythingElse}
          </div>
          <div className="v2-p-list">
            {section.items.map((agent) => (
              <Row key={agent.id} agent={agent} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FolderButton({ folder, onOpen }: { readonly folder: TreeFolder; readonly onOpen: () => void }) {
  return (
    <button type="button" className="v2-p-fold" onClick={onOpen} data-testid="v2-phone-folder">
      <span className="v2-ficon">{folder.plan ? <Icon name="projects" className="v2-plan-ic" /> : <Icon name="folder" />}</span>
      <span className="v2-grow">
        <b style={{ display: 'block', fontWeight: 600 }}>{folder.name}</b>
        <span className="v2-muted" style={{ fontSize: 13 }}>
          {AGENTS_WORDS.agentsCount(folder.count)}
          {folder.children.length ? ` · ${AGENTS_WORDS.foldersCount(folder.children.length)}` : ''}
        </span>
      </span>
      {folder.needs ? (
        <span className="v2-nb">
          <Icon name="hand" size="s" />
          {folder.needs}
        </span>
      ) : null}
      <Icon name="chev" size="s" />
    </button>
  );
}

function PhoneFolders({ tree }: { readonly tree: AgentTree }) {
  const [path, setPath] = useState<readonly string[]>([]);
  const [crew, setCrew] = useState<TreeCrew | null>(null);
  const level = drill(tree, path);
  const top = path.length === 0 && !crew;
  return (
    <div data-testid="v2-phone-folders">
      <nav className="v2-p-crumb" aria-label={AGENTS_WORDS.folderPath} data-testid="v2-phone-crumb">
        {top ? (
          <b style={{ color: 'var(--v2-text)', padding: '0 6px', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>{AGENTS_WORDS.title}</b>
        ) : (
          <button
            type="button"
            onClick={() => {
              setPath([]);
              setCrew(null);
            }}
          >
            {AGENTS_WORDS.title}
          </button>
        )}
        {crew ? (
          <>
            <Icon name="chev" size="s" />
            <b style={{ color: 'var(--v2-text)' }}>{`Crew · ${crew.name}`}</b>
          </>
        ) : (
          level.crumbs.map((folder, i) => (
            <span key={folder.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <Icon name="chev" size="s" />
              {i === level.crumbs.length - 1 ? <b style={{ color: 'var(--v2-text)', padding: '0 6px' }}>{folder.name}</b> : <button type="button" onClick={() => setPath(path.slice(0, i + 1))}>{folder.name}</button>}
            </span>
          ))
        )}
      </nav>
      {crew ? (
        <div className="v2-p-list">
          {sortAgents(crew.members).map((agent) => (
            <Row key={agent.id} agent={agent} />
          ))}
        </div>
      ) : top ? (
        <>
          {tree.pinned.length ? (
            <>
              <div className="v2-p-sec">
                <Icon name="pin" size="s" />
                {AGENTS_WORDS.pinned}
              </div>
              <div className="v2-p-list">
                {tree.pinned.map((agent) => (
                  <Row key={agent.id} agent={agent} />
                ))}
              </div>
            </>
          ) : null}
          {tree.folders.length ? (
            <>
              <div className="v2-p-sec">
                <Icon name="folder" size="s" />
                {AGENTS_WORDS.folders}
              </div>
              <div className="v2-p-list">
                {tree.folders.map((folder) => (
                  <FolderButton key={folder.id} folder={folder} onOpen={() => setPath([folder.id])} />
                ))}
              </div>
            </>
          ) : null}
          {tree.crews.length ? (
            <>
              <div className="v2-p-sec">
                <Icon name="crew" size="s" />
                {AGENTS_WORDS.crews}
              </div>
              <div className="v2-p-list">
                {tree.crews.map((c) => (
                  <button key={c.id} type="button" className="v2-p-fold" onClick={() => setCrew(c)}>
                    <span className="v2-ficon">
                      <Icon name="crew" />
                    </span>
                    <span className="v2-grow">
                      <b style={{ display: 'block', fontWeight: 600 }}>{`Crew · ${c.name}`}</b>
                      <span className="v2-muted" style={{ fontSize: 13 }}>
                        {AGENTS_WORDS.agentsCount(c.members.length)}
                      </span>
                    </span>
                    {c.needs ? (
                      <span className="v2-nb">
                        <Icon name="hand" size="s" />
                        {c.needs}
                      </span>
                    ) : null}
                    <Icon name="chev" size="s" />
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {tree.loose.length ? (
            <>
              <div className="v2-p-sec">{AGENTS_WORDS.notInFolder}</div>
              <div className="v2-p-list">
                {tree.loose.map((agent) => (
                  <Row key={agent.id} agent={agent} />
                ))}
              </div>
            </>
          ) : null}
          <div className="v2-p-list" style={{ marginTop: 14 }}>
            <V2Link to="/agents?show=closed" className="v2-p-fold" style={{ textDecoration: 'none' }}>
              <span className="v2-ficon">
                <Icon name="clock" />
              </span>
              <span className="v2-grow">
                <b style={{ display: 'block', fontWeight: 600 }}>{AGENTS_WORDS.closed}</b>
              </span>
              <Icon name="chev" size="s" />
            </V2Link>
          </div>
        </>
      ) : (
        <>
          {level.folder ? (
            <div className="v2-row" style={{ margin: '2px 0 10px', gap: 8 }}>
              {level.folder.plan ? <Icon name="projects" className="v2-plan-ic" /> : <Icon name="folder" />}
              <b style={{ fontSize: 18 }} className="v2-grow">
                {level.folder.name}
              </b>
              {level.folder.plan ? <span className="v2-tag">Project</span> : null}
            </div>
          ) : null}
          {level.folders.length ? (
            <div className="v2-p-list" style={{ marginBottom: 10 }}>
              {level.folders.map((folder) => (
                <FolderButton key={folder.id} folder={folder} onOpen={() => setPath([...path.slice(0, level.crumbs.length), folder.id])} />
              ))}
            </div>
          ) : null}
          {level.agents.length ? (
            <div className="v2-p-list">
              {sortAgents(level.agents).map((agent) => (
                <Row key={agent.id} agent={agent} />
              ))}
            </div>
          ) : level.folders.length ? null : (
            <p className="v2-muted">{AGENTS_WORDS.emptyFolderTitle}.</p>
          )}
        </>
      )}
      <p className="v2-tree-note" style={{ margin: '14px 2px' }}>
        <Icon name="refresh" size="s" />
        <span>{AGENTS_WORDS.phoneNote}</span>
      </p>
    </div>
  );
}

function PhoneBoard({ agents }: { readonly agents: readonly AgentEntry[] }) {
  const [open, setOpen] = useState<Readonly<Record<BoardColumn, boolean>>>({ needs: true, working: true, ready: false, done: false });
  return (
    <div data-testid="v2-phone-board" style={{ marginTop: 10 }}>
      {BOARD_COLUMNS.map((column) => {
        const items = sortAgents(agents.filter((agent) => columnOf(agent.status) === column));
        return (
          <div key={column}>
            <button type="button" className="v2-p-grp" aria-expanded={open[column]} onClick={() => setOpen({ ...open, [column]: !open[column] })} data-testid={`v2-phone-col-${column}`}>
              <Icon name="chev" size="s" className="v2-chev" />
              {AGENTS_WORDS.columns[column]}
              <span className="v2-count">{items.length}</span>
            </button>
            {open[column] ? (
              <div className="v2-p-list" style={{ marginBottom: 12 }}>
                {items.length ? items.map((agent) => <Row key={agent.id} agent={agent} />) : <p className="v2-muted" style={{ padding: '0 14px' }}>{AGENTS_WORDS.nothingHere}</p>}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
