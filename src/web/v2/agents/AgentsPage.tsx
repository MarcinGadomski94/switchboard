import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../../api/client.ts';
import { useLiveActivities } from '../../activity/useActivity.ts';
import { draftAnswerText, draftMemory, offersMemoryDraft } from '../../memory/draft.ts';
// Project memory (D107) hook (docs/memory-removal.md): the imports above.
import { useLayout } from '../../shell/useLayout.ts';
import { Button, Card, Dialog, EmptyState, Icon, MenuButton, type MenuItem, Segmented, Skeleton, useToast } from '../components/index.ts';
import { AGENTS_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { openNew } from '../new/index.tsx';
import { useOpenAgent } from '../shared/open-agent.ts';
import { modKey, useShortcut } from '../shell/shortcuts.ts';
import { AGENT_VIEWS, type AgentEntry, type AgentView, type GroupBy, PREF_KEYS, isAgentView, isGroupBy, offline } from './agents-model.ts';
import { BoardView, ChatsView, ListView } from './AgentViews.tsx';
import { AgentsPageProvider, type AgentsPageApi, type FolderDialogRequest } from './context.tsx';
import { FolderDialog, MoveDialog, RenameDialog } from './Dialogs.tsx';
import { ClosedView, DraftsCard } from './DraftsAndClosed.tsx';
import { FolderTree, setDraggableAgents } from './FolderTree.tsx';
import { PhoneAgents } from './PhoneAgents.tsx';
import { type Selection, agentsOf, findFolder, pathOf, placeOfAgent, selectionExists } from './tree-model.ts';
import { readPref, useAgentsData, useNewDraft, usePref, useSharing, writePref } from './useAgentsData.ts';
import { useTreeActions } from './useTreeActions.ts';
import './agents.css';

/**
 * D131 · lane A · the Agents page (`/agents`; `?show=closed` = Closed): every
 * agent on every computer — Switchboard sessions, conversations, routines'
 * sessions, project steps (teammates are the Crews pages'), the paired
 * computers' — as List, Chats or Board (remembered per browser), the folder tree
 * on the left (the shared sidebar layout, ⌘\ hides it), Drafts on top. On a phone:
 * Chats | Folders (a drill-down) | Board.
 */
export function AgentsPage({ showClosed }: { readonly showClosed: boolean }) {
  const data = useAgentsData();
  const layoutKind = useLayout();
  const toast = useToast();
  const { navigate } = useV2Router();
  const [view, setView] = usePref<AgentView>(PREF_KEYS.view, 'list', isAgentView);
  const [groupBy, setGroupBy] = usePref<GroupBy>(PREF_KEYS.groupBy, 'project', isGroupBy);
  const [treeHidden, setTreeHidden] = useState(() => readPref(PREF_KEYS.treeHidden) === '1');
  const [advanced, setAdvanced] = useState(() => readPref(PREF_KEYS.advanced) === '1');
  const [closedLanes, setClosedLanes] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(readPref(PREF_KEYS.lanesClosed) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const [selection, setSelection] = useState<Selection>('all');
  const [moving, setMoving] = useState<AgentEntry | null>(null);
  const [folderRequest, setFolderRequest] = useState<FolderDialogRequest | null>(null);
  const [renaming, setRenaming] = useState<AgentEntry | null>(null);
  const [confirmClose, setConfirmClose] = useState<AgentEntry | null>(null);
  const sharing = useSharing();
  const { draft: newDraft, remove: removeNewDraft } = useNewDraft();
  const activityOf = useLiveActivities(data.sessions);
  const shareNote = AGENTS_WORDS.syncedTo(sharing.shared);
  const shareText = `${sharing.shared.length ? AGENTS_WORDS.shareOn(sharing.shared) : AGENTS_WORDS.shareOff} ${AGENTS_WORDS.sameAsClassic}`;
  const actions = useTreeActions({ layout: data.layout, tree: data.tree, apply: data.applyLayout, shareNote });

  useEffect(() => setDraggableAgents(data.agents), [data.agents]);
  useEffect(() => {
    if (!selectionExists(selection, data.tree)) setSelection('all');
  }, [selection, data.tree]);

  const toggleTree = useCallback(() => {
    setTreeHidden((hidden) => {
      writePref(PREF_KEYS.treeHidden, hidden ? '0' : '1');
      return !hidden;
    });
  }, []);
  useShortcut('folder-tree', toggleTree);

  const toggleLane = useCallback((id: string) => {
    setClosedLanes((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writePref(PREF_KEYS.lanesClosed, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const openAgent = useCallback(
    (agent: AgentEntry) => {
      data.markSeen(agent.id);
      navigate(`/agents/${encodeURIComponent(agent.id)}`);
    },
    [data, navigate],
  );

  const openAgentOf = useOpenAgent();
  const peekAgent = useCallback(
    (agent: AgentEntry) => {
      data.markSeen(agent.id);
      openAgentOf(agent.id);
    },
    [data, openAgentOf],
  );

  const close = useCallback(
    async (agent: AgentEntry, confirm: boolean) => {
      try {
        await api.closeSession(agent.id, confirm);
        toast({ text: AGENTS_WORDS.closedToast(agent.name), undo: () => api.reopenSession(agent.id) });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && !confirm) setConfirmClose(agent);
        else toast({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
      }
    },
    [toast],
  );

  const rename = useCallback(
    async (agent: AgentEntry, title: string) => {
      const old = agent.session.title ?? null;
      try {
        await api.renameSession(agent.id, title);
        toast({ text: AGENTS_WORDS.renamed(title), undo: () => api.renameSession(agent.id, old) });
      } catch (error) {
        toast({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
      }
    },
    [toast],
  );

  const agentMenu = useCallback(
    (agent: AgentEntry): MenuItem[] => {
      const off = offline(agent);
      const offWhy = off && agent.computer ? AGENTS_WORDS.offlineWhy(agent.computer.name) : undefined;
      const pinned = placeOfAgent(data.layout, agent.id) === 'pinned';
      const notes = offersMemoryDraft(agent.session);
      return [
        { id: 'open', label: AGENTS_WORDS.open, icon: 'external', onSelect: () => openAgent(agent) },
        { id: 'pin', label: pinned ? AGENTS_WORDS.unpin : AGENTS_WORDS.pin, icon: 'pin', onSelect: () => void actions.togglePin(agent) },
        { id: 'move', label: AGENTS_WORDS.moveToFolder, icon: 'folder-move', kbd: 'M', onSelect: () => setMoving(agent) },
        { id: 'rename', label: AGENTS_WORDS.rename, icon: 'edit', onSelect: () => setRenaming(agent), ...(offWhy ? { disabledReason: offWhy } : {}) },
        { separator: true, id: 'sep-1' },
        {
          id: 'notes',
          label: AGENTS_WORDS.draftNotes,
          icon: 'book',
          onSelect: () =>
            void draftMemory({ sessionId: agent.id }).then(
              (answer) => toast({ text: draftAnswerText(answer, agent.name) }),
              (error: unknown) => toast({ text: error instanceof Error ? error.message : String(error), tone: 'error' }),
            ),
          ...(notes ? {} : { disabledReason: agent.session.machine ? 'Only for agents on this computer.' : agent.kind === 'conv' ? 'Conversations don’t keep notes.' : 'Only for agents in a project folder.' }),
        },
        { id: 'close', label: AGENTS_WORDS.closeAgent, icon: 'trash', danger: true, onSelect: () => void close(agent, false), ...(offWhy ? { disabledReason: offWhy } : {}) },
      ];
    },
    [data.layout, actions, openAgent, close, toast],
  );

  const pageApi: AgentsPageApi = useMemo(
    () => ({ actions, openAgent, peekAgent, openMove: setMoving, openFolderDialog: setFolderRequest, agentMenu, shareNote, advanced, activityOf }),
    [actions, openAgent, peekAgent, agentMenu, shareNote, advanced, activityOf],
  );

  const phone = layoutKind === 'phone';
  const listed = agentsOf(selection, data.tree, data.agents);

  const header = (
    <div className="v2-ag-ph">
      <div className="v2-grow">
        <h1>{showClosed ? AGENTS_WORDS.closedTitle : AGENTS_WORDS.title}</h1>
        <p className="v2-page-sub">{showClosed ? AGENTS_WORDS.closedSub : AGENTS_WORDS.sub}</p>
      </div>
      <div className="v2-ag-ph-tools">
        {!showClosed && !phone ? <Segmented options={AGENT_VIEWS.map((value) => ({ value, label: AGENTS_WORDS.views[value], icon: value === 'list' ? 'list' : value === 'chats' ? 'chats' : 'board' }))} value={view} onChange={setView} label={AGENTS_WORDS.viewLabel} testId="v2-agents-view" tour="v2-agents-view" /> : null}
        {!showClosed && !phone ? (
          <Button variant="ghost" icon="sheet" aria-pressed={!treeHidden} title={`${AGENTS_WORDS.foldersToggle} · ${modKey('\\')}`} onClick={toggleTree} data-testid="v2-tree-toggle-button">
            {AGENTS_WORDS.foldersButton}
          </Button>
        ) : null}
        {!showClosed && !phone ? (
          <MenuButton
            label={AGENTS_WORDS.advanced}
            icon="sliders"
            testId="v2-agents-advanced"
            items={[
              {
                id: 'engine',
                label: `${advanced ? '✓ ' : ''}${AGENTS_WORDS.showEngine}`,
                icon: 'cmd',
                onSelect: () => {
                  writePref(PREF_KEYS.advanced, advanced ? '0' : '1');
                  setAdvanced(!advanced);
                },
              },
            ]}
          />
        ) : null}
        <Button variant="primary" icon="plus" onClick={() => openNew({ kind: 'agent' })} data-testid="v2-agents-new">
          {AGENTS_WORDS.newButton}
        </Button>
      </div>
    </div>
  );

  return (
    <AgentsPageProvider value={pageApi}>
      <div className="v2-page" data-wide="" style={{ maxWidth: 1400 }} data-testid={showClosed ? 'v2-page-agents-closed' : 'v2-page-agents'} data-area="agents" data-view={phone ? 'phone' : view}>
        {header}
        {showClosed ? (
          <ClosedView />
        ) : !data.loaded ? (
          <LoadingList />
        ) : phone ? (
          <PhoneAgents agents={data.agents} tree={data.tree} newDraft={newDraft} />
        ) : (
          <div className="v2-ag2" {...(treeHidden ? { 'data-tree-off': '' } : {})}>
            <FolderTree tree={data.tree} selection={selection} onSelect={setSelection} draftCount={data.agents.filter((agent) => agent.draft !== null).length + (newDraft ? 1 : 0)} closedCount={null} shareText={shareText} />
            <div data-testid="v2-agents-pane">
              {selection === 'all' || selection === 'drafts' ? <DraftsCard agents={data.agents} newDraft={newDraft} onRemoveNew={removeNewDraft} onOpen={openAgent} /> : null}
              {selection === 'drafts' ? null : (
                <>
                  <Crumbs selection={selection} count={listed.length} data={data} onSelect={setSelection} />
                  {listed.length === 0 ? (
                    <EmptyState icon={selection.startsWith('folder:') ? 'folder' : 'agents'} tone="grey" title={selection.startsWith('folder:') ? AGENTS_WORDS.emptyFolderTitle : AGENTS_WORDS.emptyTitle} text={selection.startsWith('folder:') ? AGENTS_WORDS.emptyFolderText : AGENTS_WORDS.emptyText} testId="v2-agents-empty" />
                  ) : view === 'list' ? (
                    <ListView agents={listed} />
                  ) : view === 'chats' ? (
                    <ChatsView agents={listed} />
                  ) : (
                    <BoardView agents={listed} plans={data.plans} layout={data.layout} groupBy={groupBy} onGroupBy={setGroupBy} closedLanes={closedLanes} onToggleLane={toggleLane} />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <MoveDialog agent={moving} layout={data.layout} tree={data.tree} actions={actions} onClose={() => setMoving(null)} />
      <FolderDialog request={folderRequest} tree={data.tree} actions={actions} onClose={() => setFolderRequest(null)} onCreated={(id) => setSelection(`folder:${id}`)} />
      <RenameDialog agent={renaming} onClose={() => setRenaming(null)} onRename={(agent, title) => void rename(agent, title)} />
      <Dialog
        open={confirmClose !== null}
        onClose={() => setConfirmClose(null)}
        icon="trash"
        title={AGENTS_WORDS.closeAgent}
        width={480}
        testId="v2-close-confirm"
        footer={
          <>
            <Button onClick={() => setConfirmClose(null)}>{AGENTS_WORDS.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const agent = confirmClose;
                setConfirmClose(null);
                if (agent) void close(agent, true);
              }}
            >
              {AGENTS_WORDS.closeAgent}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{confirmClose ? AGENTS_WORDS.closeRunning(confirmClose.name) : ''}</p>
      </Dialog>
    </AgentsPageProvider>
  );
}

function LoadingList() {
  return (
    <Card data-testid="v2-agents-loading">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="v2-plain-row">
          <Skeleton width={44} height={44} style={{ borderRadius: '50%' }} />
          <div className="v2-grow">
            <Skeleton width="45%" />
            <Skeleton width="70%" height={9} style={{ marginTop: 8 }} />
          </div>
          <Skeleton width={90} height={22} />
        </div>
      ))}
    </Card>
  );
}

function Crumbs({ selection, count, data, onSelect }: { readonly selection: Selection; readonly count: number; readonly data: ReturnType<typeof useAgentsData>; readonly onSelect: (selection: Selection) => void }) {
  const folderId = selection.startsWith('folder:') ? selection.slice('folder:'.length) : null;
  const folder = folderId ? findFolder(data.tree, folderId) : null;
  const path = folderId ? pathOf(data.tree, folderId) : [];
  const planId = folder?.plan ? (agentsOf(selection, data.tree, data.agents).find((agent) => agent.plan)?.plan?.id ?? null) : null;
  const { navigate } = useV2Router();
  const label = selection === 'all' ? AGENTS_WORDS.allAgents : selection === 'needs' ? AGENTS_WORDS.needsYou : selection === 'pinned' ? AGENTS_WORDS.pinned : selection === 'loose' ? AGENTS_WORDS.notInFolder : null;
  return (
    <div className="v2-crumbs" data-testid="v2-crumbs">
      {label ? (
        <b>{label}</b>
      ) : (
        path.map((step, i) => (
          <span key={step.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 ? <Icon name="chev" size="s" /> : null}
            {i === path.length - 1 ? (
              <b>{step.name}</b>
            ) : (
              <button type="button" className="v2-crumb-btn" onClick={() => onSelect(`folder:${step.id}`)}>
                {step.name}
              </button>
            )}
          </span>
        ))
      )}
      <span>{`· ${AGENTS_WORDS.agentsCount(count)}`}</span>
      {planId ? (
        <Button size="sm" icon="projects" onClick={() => navigate(`/projects/${encodeURIComponent(planId)}`)}>
          {AGENTS_WORDS.openProject}
        </Button>
      ) : null}
      <span className="v2-drag-hint">
        <Icon name="grip" size="s" />
        {AGENTS_WORDS.dragHint}
      </span>
    </div>
  );
}
