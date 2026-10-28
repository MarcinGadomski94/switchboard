import { useMemo, useRef, useState } from 'react';
import type { Folder, HistoryItem } from '../../../core/api.ts';
import type { MachinesView } from '../../../core/peers.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import { api } from '../../api/client.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { useApi } from '../../api/useApi.ts';
import { resumeNameProblem, resumeNames } from '../../modals/resume-conversation.ts';
import { addFolderLabel, moveStateText } from '../../views/history-move.ts';
import { useConversationMoves } from '../../views/useConversationMoves.ts';
import { Button, Chip, Dialog, EmptyState, Field, Icon, Select, Skeleton, Switch, useToast } from '../components/index.ts';
import { BRING_IN_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { timeAgo } from '../shared/time.ts';
import { bringInEntry, bringInFolder, bringInList, bringInRows, bringInStage } from './bring-in-model.ts';
import './new.css';

const W = BRING_IN_WORDS;

/**
 * D16 in v2 · + New › From a terminal: this computer's terminal conversations that are not
 * in Switchboard yet (the classic History's rows, `GET /api/history`, `?cli=1` adds Codex CLI
 * and OpenCode), newest first, with a search over folder, first message, name and id. Picking
 * one opens the confirm step: an optional name (the classic resume rules), the sidebar folder it
 * goes into, then **Continue in Switchboard**, the classic move (`useConversationMoves`:
 * `POST /api/history/{id}/continue`, the terminal-open warning with Continue anyway, Add the
 * folder and continue). The moved agent opens. This computer only: classic offers no peer
 * terminal conversations either.
 */
export function BringInSheet({ onClose }: { readonly onClose: () => void }) {
  const toast = useToast();
  const { navigate } = useV2Router();
  const [withCli, setWithCli] = useState(false);
  const history = useApi((): Promise<HistoryItem[]> => api.history(undefined, withCli), [withCli]);
  const folders = useApi((): Promise<Folder[]> => api.savedFolders().catch(() => []), []);
  const layout = useApi((): Promise<SidebarLayout | null> => api.sidebarLayout().catch(() => null), []);
  const machines = useApi((): Promise<MachinesView | null> => api.machines().catch(() => null), []);
  const sessions = useSessionListOf();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<HistoryItem | null>(null);
  const [typed, setTyped] = useState('');
  const [sidebarFolder, setSidebarFolder] = useState('');
  // What the move's end needs (it is reported once, after the last render of the confirm step).
  const landing = useRef<{ readonly folder: string; readonly name: string }>({ folder: '', name: '' });

  const moves = useConversationMoves((sessionId) => {
    const { folder, name } = landing.current;
    void (folder ? api.placeSidebarSession({ sessionId, place: 'folder', folderId: folder }).catch(() => undefined) : Promise.resolve()).then(() => {
      onClose();
      navigate(`/agents/${encodeURIComponent(sessionId)}`);
      toast({ text: W.brought(name) });
    });
  });

  const all = useMemo(() => bringInRows(history.data ?? []), [history.data]);
  const list = useMemo(() => bringInList(history.data ?? [], query), [history.data, query]);
  const takenNames = (sessions.data ?? []).filter((session) => !session.machine).map((session) => session.name);
  const id = picked?.claudeSessionId ?? null;
  const stage = bringInStage(moves.items, id);
  const state = moves.items?.find((item) => item.claudeSessionId === id)?.state ?? null;
  const problem = resumeNameProblem(typed);
  const names = picked ? resumeNames(picked, typed, takenNames) : null;
  const selfName = machines.data?.self.name ?? 'this computer';

  const go = (): void => {
    if (!picked || problem !== null || moves.busy) return;
    landing.current = { folder: sidebarFolder, name: typed.trim() !== '' ? typed.trim() : bringInEntry(picked).title };
    moves.start([picked], typed);
  };
  const back = (): void => {
    if (moves.busy) return;
    moves.close();
    setPicked(null);
    setTyped('');
  };

  const footer =
    picked === null ? (
      <>
        <span className="v2-grow" />
        <Button onClick={onClose}>{W.cancel}</Button>
      </>
    ) : stage === 'pick' || stage === 'moving' ? (
      <>
        <Button variant="ghost" icon="back" onClick={back} disabled={moves.busy} data-testid="v2-bring-in-back">
          {W.back}
        </Button>
        <span className="v2-grow" />
        <Button onClick={onClose} disabled={moves.busy}>
          {W.cancel}
        </Button>
        <Button variant="primary" icon="download" onClick={go} disabled={problem !== null || moves.busy} data-testid="v2-bring-in-go">
          {stage === 'moving' ? W.moving : W.go}
        </Button>
      </>
    ) : stage === 'terminal-open' || stage === 'needs-folder' ? (
      <>
        <span className="v2-grow" />
        <Button onClick={() => moves.cancel()} data-testid="v2-bring-in-cancel-move">
          {W.cancel}
        </Button>
        {stage === 'terminal-open' ? (
          <Button variant="primary" onClick={() => id && moves.confirm(id)} data-testid="v2-bring-in-confirm">
            {W.continueAnyway}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => id && moves.addFolder(id)} data-testid="v2-bring-in-add-folder">
            {state?.kind === 'needs-folder' ? addFolderLabel(state.check) : W.go}
          </Button>
        )}
      </>
    ) : (
      <>
        <Button variant="ghost" icon="back" onClick={back} data-testid="v2-bring-in-back">
          {W.back}
        </Button>
        <span className="v2-grow" />
        {state?.kind === 'refused' && state.sessionId ? (
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              navigate(`/agents/${encodeURIComponent(state.sessionId as string)}`);
            }}
            data-testid="v2-bring-in-open"
          >
            {W.openIt}
          </Button>
        ) : null}
      </>
    );

  return (
    <Dialog
      open
      onClose={moves.busy ? () => undefined : onClose}
      testId="v2-bring-in"
      icon="download"
      width={720}
      title={
        <span className="v2-new-title">
          {W.title}
          <span className="v2-muted">{W.sub}</span>
        </span>
      }
      footer={footer}
    >
      <div className="v2-bring" data-stage={picked === null ? 'list' : stage}>
        {picked === null ? (
          <>
            <Field
              label={W.searchLabel}
              placeholder={W.search}
              value={query}
              type="search"
              data-autofocus=""
              data-testid="v2-bring-in-search"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <div className="v2-row v2-bring-meta">
              <span className="v2-muted" data-testid="v2-bring-in-where">
                <Icon name="laptop" size="s" /> {W.thisComputer(selfName)} {withCli ? '' : W.claudeOnly}
              </span>
            </div>
            <div className="v2-row v2-new-switch-row">
              <Switch label={W.withCli} checked={withCli} onChange={setWithCli} testId="v2-bring-in-cli" />
              <span>{W.withCli}</span>
            </div>
            {history.data === null && history.error === null ? (
              <div className="v2-bring-list" aria-busy="true" data-testid="v2-bring-in-loading">
                <span className="v2-muted">{W.loading}</span>
                <Skeleton lines={3} height={44} />
              </div>
            ) : history.data === null ? (
              <EmptyState icon="alert" tone="grey" title={W.failed} action={<Button onClick={history.reload}>{W.retry}</Button>} testId="v2-bring-in-failed" />
            ) : all.length === 0 ? (
              <EmptyState icon="download" tone="grey" title={W.emptyTitle} text={W.emptyText} testId="v2-bring-in-empty" />
            ) : (
              <>
                <div className="v2-muted v2-bring-count" data-testid="v2-bring-in-count">
                  {list.length === all.length ? W.count(all.length) : W.countOf(list.length, all.length)}
                </div>
                <div className="v2-bring-list" role="list" data-testid="v2-bring-in-list">
                  {list.map((row) => {
                    const entry = bringInEntry(row);
                    return (
                      <button
                        key={row.claudeSessionId}
                        type="button"
                        role="listitem"
                        className="v2-bring-row"
                        data-testid="v2-bring-in-row"
                        data-claude-session-id={row.claudeSessionId}
                        onClick={() => {
                          setPicked(row);
                          setTyped('');
                        }}
                      >
                        <span className="v2-bring-title">{entry.title}</span>
                        {entry.prompt ? <span className="v2-bring-prompt">{entry.prompt}</span> : null}
                        <span className="v2-bring-line">
                          {entry.where ? (
                            <span title={entry.wherePath ?? undefined}>
                              <Icon name="folder" size="s" /> {entry.where}
                            </span>
                          ) : null}
                          <span>{W.started(timeAgo(entry.startedAt))}</span>
                          {entry.cli ? <Chip size="s">{entry.cli}</Chip> : null}
                        </span>
                      </button>
                    );
                  })}
                  {list.length === 0 ? (
                    <p className="v2-muted" data-testid="v2-bring-in-nomatch">
                      {W.noMatch}
                    </p>
                  ) : null}
                </div>
              </>
            )}
          </>
        ) : (
          <Picked
            row={picked}
            typed={typed}
            onTyped={setTyped}
            preview={names?.name ?? ''}
            problem={problem}
            folders={folders.data ?? []}
            layout={layout.data}
            sidebarFolder={sidebarFolder}
            onSidebarFolder={setSidebarFolder}
            locked={stage !== 'pick'}
            onSubmit={go}
          />
        )}
        {picked !== null && state && (stage === 'terminal-open' || stage === 'needs-folder' || stage === 'refused') ? (
          <div className="v2-bring-warn" role="alert" data-testid="v2-bring-in-warning" data-state={stage}>
            <b>{stage === 'terminal-open' ? W.openTitle : stage === 'refused' ? W.refusedTitle : W.projectFolder}</b>
            <span data-testid="v2-bring-in-warning-text">{moveStateText(state)}</span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function Picked({
  row,
  typed,
  onTyped,
  preview,
  problem,
  folders,
  layout,
  sidebarFolder,
  onSidebarFolder,
  locked,
  onSubmit,
}: {
  readonly row: HistoryItem;
  readonly typed: string;
  readonly onTyped: (value: string) => void;
  readonly preview: string;
  readonly problem: string | null;
  readonly folders: readonly Folder[];
  readonly layout: SidebarLayout | null;
  readonly sidebarFolder: string;
  readonly onSidebarFolder: (id: string) => void;
  readonly locked: boolean;
  readonly onSubmit: () => void;
}) {
  const entry = bringInEntry(row);
  const saved = bringInFolder(row, folders);
  return (
    <div className="v2-bring-picked" data-testid="v2-bring-in-picked" data-claude-session-id={row.claudeSessionId}>
      <div className="v2-bring-card">
        <span className="v2-bring-title">{entry.title}</span>
        {entry.prompt ? <span className="v2-bring-prompt">{entry.prompt}</span> : null}
        <span className="v2-bring-line">
          <span>{W.started(timeAgo(entry.startedAt))}</span>
          {entry.cli ? <Chip size="s">{entry.cli}</Chip> : null}
        </span>
      </div>
      <dl className="v2-bring-facts">
        <dt>{W.continuesIn}</dt>
        <dd data-testid="v2-bring-in-cwd">{row.cwd ?? row.folderPath ?? '—'}</dd>
        <dt>{W.projectFolder}</dt>
        <dd data-testid="v2-bring-in-folder">{saved ? saved.displayName : W.notSaved}</dd>
      </dl>
      <Field
        label={W.name}
        placeholder={W.namePlaceholder(preview)}
        hint={W.nameHint}
        value={typed}
        error={problem}
        disabled={locked}
        data-autofocus=""
        data-testid="v2-bring-in-name"
        onChange={(event) => onTyped(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {layout && layout.folders.length > 0 ? (
        <div className="v2-row v2-new-put">
          <Icon name="folder" size="s" />
          <Select
            label={W.putItIn}
            value={sidebarFolder}
            disabled={locked}
            onChange={(event) => onSidebarFolder(event.currentTarget.value)}
            options={[{ value: '', label: W.notInFolder }, ...layout.folders.map((f) => ({ value: f.id, label: f.name }))]}
            data-testid="v2-bring-in-put"
          />
        </div>
      ) : null}
      <p className="v2-new-note">{W.whatHappens}</p>
    </div>
  );
}
