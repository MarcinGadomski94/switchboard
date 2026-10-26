import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type MemoryEntry, changeKindOf, isMemoryChange } from '../../../../core/memory.ts';
import type { Machine } from '../../../../core/peers.ts';
import { onHubStatus, useHubEvent } from '../../../api/useHub.ts';
import { useMachineStateChange, useMachines } from '../../../api/useMachines.ts';
import { useSessionListOf } from '../../../api/session-list.ts';
import { memoryApi, refusalText } from '../../../memory/api.ts';
import { reloadMemory } from '../../../memory/store.ts';
// Project memory (D107) hook (docs/memory-removal.md): the imports above.
import { Button, Chip, ComputerTag, Dialog, EmptyState, Field, Icon, IconButton, Select, Skeleton, StatusBadge, TextArea, TOAST_MS, useToast } from '../../components/index.ts';
import { NOTES_WORDS } from '../../glossary.ts';
import { useV2Router } from '../../nav.tsx';
import { agentName } from '../../shared/agent-line.ts';
import { NoteChange } from '../../shared/NoteChange.tsx';
import { ALL_NOTES, type NoteComputer, type NoteRow, type NoteSource, approvedText, canDraftNotes, draftToast, filterFromQuery, filterOptions, inFilter, noteQuote, noteRows } from './notes-model.ts';
import './notes.css';

/** Read again at most this often while paired computers are listed (their changes do not reach this hub). */
const PEERS_RELOAD_MS = 30_000;

function computerOf(machine: Machine): NoteComputer {
  return { id: machine.id, name: machine.name, state: machine.state === 'online' ? 'online' : machine.state === 'reconnecting' ? 'reconnecting' : 'offline' };
}

type NotesData =
  | { readonly phase: 'loading' }
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'ready'; readonly sources: readonly NoteSource[]; readonly offline: readonly NoteComputer[] };

/** This computer's notes and every paired computer's (through the D48 proxy), live from `/hub`. */
function useNotesData(): { readonly data: NotesData; readonly reload: () => void } {
  const machines = useMachines();
  const [data, setData] = useState<NotesData>({ phase: 'loading' });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reload();
    }, 150);
  }, [reload]);
  useHubEvent('memoryChanged', soon);
  useMachineStateChange(reload);
  useEffect(
    () =>
      onHubStatus((status) => {
        if (status === 'open') reload();
      }),
    [reload],
  );
  useEffect(() => {
    if (machines.length === 0) return undefined;
    const every = window.setInterval(reload, PEERS_RELOAD_MS);
    return () => window.clearInterval(every);
  }, [machines.length, reload]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const machinesKey = machines.map((machine) => `${machine.id}:${machine.state}`).join(',');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = memoryApi(null);
      try {
        const state = await local.state();
        if (!state.available) {
          if (!cancelled) setData({ phase: 'unavailable' });
          return;
        }
        const [scopes, entries] = await Promise.all([local.scopes(), local.entries('')]);
        const sources: NoteSource[] = [{ computer: null, scopes, entries }];
        const offline: NoteComputer[] = [];
        const peers = machines.map(computerOf);
        const reachable = peers.filter((peer) => peer.state !== 'offline');
        const answers = await Promise.allSettled(
          reachable.map(async (peer): Promise<NoteSource> => {
            const api = memoryApi(peer.id);
            const [peerScopes, peerEntries] = await Promise.all([api.scopes(), api.entries('')]);
            return { computer: peer, scopes: peerScopes, entries: peerEntries };
          }),
        );
        for (const peer of peers) {
          if (peer.state === 'offline') {
            offline.push(peer);
            continue;
          }
          const answer = answers[reachable.indexOf(peer)];
          if (answer?.status === 'fulfilled') sources.push(answer.value);
          else offline.push({ ...peer, state: 'offline' });
        }
        if (!cancelled) setData({ phase: 'ready', sources, offline });
      } catch (error) {
        if (!cancelled) setData((prev) => (prev.phase === 'ready' ? prev : { phase: 'error', message: refusalText(error) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, machinesKey]);
  return { data, reload };
}

type Editing = { readonly row: NoteRow; readonly approve: boolean } | null;

/**
 * D131 · lane A · Notes (`/notes`, "What agents know"; prototype `notesHTML()`):
 * every computer's Project memory entries by scope (Folder / Code project /
 * Teammate), the scope filter (`?scope=` preselects), proposed notes first with
 * Approve / Edit first / Reject, approved ones with Edit / Delete (with Undo), the
 * rejected ones on request, and "Draft notes from this agent".
 */
export function NotesPage() {
  const { search, navigate } = useV2Router();
  const toast = useToast();
  const { data, reload } = useNotesData();
  const [filter, setFilter] = useState(() => filterFromQuery(search));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [drafting, setDrafting] = useState(false);
  const [showRejected, setShowRejected] = useState(false);

  useEffect(() => setFilter(filterFromQuery(search)), [search]);

  const rows = useMemo(() => (data.phase === 'ready' ? noteRows(data.sources).filter((row) => !hidden.has(row.key)) : []), [data, hidden]);
  const options = useMemo(() => filterOptions(rows, filter), [rows, filter]);
  const shown = rows.filter((row) => inFilter(row, filter));
  const proposed = shown.filter((row) => row.status === 'proposed');
  const approved = shown.filter((row) => row.status === 'approved');
  const rejected = shown.filter((row) => row.status === 'rejected');

  const pick = (key: string): void => {
    setFilter(key);
    navigate(key === ALL_NOTES ? '/notes' : `/notes?scope=${encodeURIComponent(key)}`, { replace: true });
  };

  const hide = (key: string, on: boolean): void =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const api = (row: NoteRow) => memoryApi(row.computer?.id ?? null);

  const act = async (row: NoteRow, work: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(row.key);
    try {
      await work();
      toast({ text: done });
      void reloadMemory();
      reload();
    } catch (error) {
      toast({ text: `Not done: ${refusalText(error)}`, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  // D135: a proposed edit replaces the note, a proposed removal deletes it; rejecting either keeps it as it was.
  const approvedWords = (row: NoteRow): string => (changeKindOf(row.entry) === 'edit' ? NOTES_WORDS.editApprovedToast : changeKindOf(row.entry) === 'retract' ? NOTES_WORDS.removalApprovedToast : approvedText(row.scope));
  const approve = (row: NoteRow): void => void act(row, () => api(row).approve(row.entry.id), approvedWords(row));
  const reject = (row: NoteRow): void => void act(row, () => api(row).reject(row.entry.id), isMemoryChange(row.entry) ? NOTES_WORDS.changeRejectedToast : NOTES_WORDS.rejectedToast);
  // Delete waits out the toast's Undo window, then deletes (the API cannot bring an entry back as it was).
  const remove = (row: NoteRow): void => {
    hide(row.key, true);
    const timer = setTimeout(() => {
      api(row)
        .remove(row.entry.id)
        .then(
          () => {
            void reloadMemory();
            reload();
          },
          (error: unknown) => {
            hide(row.key, false);
            toast({ text: `Not deleted: ${refusalText(error)}`, tone: 'error' });
          },
        );
    }, TOAST_MS);
    toast({
      text: NOTES_WORDS.deletedToast,
      undo: () => {
        clearTimeout(timer);
        hide(row.key, false);
      },
    });
  };

  const saveEdit = async (row: NoteRow, approveIt: boolean, fields: { title: string; text: string }): Promise<string | null> => {
    try {
      if (approveIt) await api(row).approve(row.entry.id, fields);
      else await api(row).update(row.entry.id, fields);
      toast({ text: approveIt ? (isMemoryChange(row.entry) ? NOTES_WORDS.editApprovedToast : NOTES_WORDS.editedApprovedToast) : NOTES_WORDS.savedToast });
      void reloadMemory();
      reload();
      return null;
    } catch (error) {
      return refusalText(error);
    }
  };

  const live = rows.filter((row) => row.status !== 'rejected').length;
  const nothing = proposed.length === 0 && approved.length === 0;

  return (
    <div className="v2-page v2-notes" data-testid="v2-page-notes" data-area="notes">
      <h1>{NOTES_WORDS.title}</h1>
      <p className="v2-page-sub">{NOTES_WORDS.sub}</p>
      <div className="v2-notes-crumbs">
        <b>{NOTES_WORDS.crumb}</b>
        <span data-testid="v2-notes-count">· {live === 1 ? '1 note' : `${live} notes`}</span>
        <span className="v2-grow" />
        <span className="v2-notes-hint">{NOTES_WORDS.scopedHint}</span>
        <Button size="sm" icon="book" onClick={() => setDrafting(true)} data-testid="v2-notes-draft-open">
          {NOTES_WORDS.draftButton}
        </Button>
      </div>

      {data.phase === 'ready' && options.length > 1 ? (
        <div className="v2-notes-filter" role="group" aria-label={NOTES_WORDS.filterLabel} data-testid="v2-notes-filter">
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              className="v2-notes-fchip"
              aria-pressed={filter === option.key}
              data-kind={option.kind}
              data-testid="v2-notes-filter-option"
              data-key={option.key}
              onClick={() => pick(option.key)}
            >
              <Icon name={option.kind === 'teammate' ? 'crew' : option.kind === 'codeProject' ? 'diagram' : option.kind === 'folder' ? 'folder' : 'book'} size="s" />
              <span>{option.label}</span>
              <span className="v2-notes-fcount">{option.count}</span>
              {option.proposed > 0 ? <span className="v2-sr">, {option.proposed} proposed</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {data.phase === 'ready' && data.offline.length > 0 ? (
        <div className="v2-notes-offline" data-testid="v2-notes-offline">
          {data.offline.map((computer) => (
            <span key={computer.id ?? ''} className="v2-notes-offline-line">
              <ComputerTag name={computer.name} state="offline" />
              <span>{NOTES_WORDS.offlineNote.replace('{name}', computer.name)}</span>
            </span>
          ))}
        </div>
      ) : null}

      {data.phase === 'loading' ? (
        <div className="v2-card v2-notes-list" data-testid="v2-notes-loading" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="v2-notes-row">
              <Skeleton width={38} height={38} />
              <Skeleton lines={2} style={{ flex: 1 }} />
            </div>
          ))}
        </div>
      ) : data.phase === 'unavailable' ? (
        <EmptyState icon="alert" tone="grey" title={NOTES_WORDS.title} text={NOTES_WORDS.unavailable} testId="v2-notes-unavailable" />
      ) : data.phase === 'error' ? (
        <EmptyState icon="alert" tone="grey" title="Couldn’t read the notes" text={data.message} testId="v2-notes-error" action={<Button onClick={reload}>Try again</Button>} />
      ) : (
        <>
          {nothing ? (
            <EmptyState
              icon="book"
              tone="grey"
              title={filter === ALL_NOTES ? NOTES_WORDS.emptyTitle : NOTES_WORDS.emptyFilteredTitle}
              text={filter === ALL_NOTES ? NOTES_WORDS.emptyText : NOTES_WORDS.emptyFilteredText}
              testId="v2-notes-empty"
            />
          ) : null}
          {proposed.length > 0 ? (
            <section className="v2-notes-section" aria-labelledby="v2-notes-proposed-h">
              <h2 id="v2-notes-proposed-h" className="v2-notes-h">
                {NOTES_WORDS.proposedHeading} <span className="v2-notes-hn">{proposed.length}</span>
              </h2>
              <div className="v2-card v2-notes-list" data-testid="v2-notes-proposed">
                {proposed.map((row) => (
                  <NoteLine key={row.key} row={row} busy={busy === row.key} onApprove={approve} onReject={reject} onEdit={(r) => setEditing({ row: r, approve: true })} />
                ))}
              </div>
            </section>
          ) : null}
          {approved.length > 0 ? (
            <section className="v2-notes-section" aria-labelledby="v2-notes-approved-h">
              <h2 id="v2-notes-approved-h" className={proposed.length > 0 ? 'v2-notes-h' : 'v2-sr'}>
                {NOTES_WORDS.approvedHeading} <span className="v2-notes-hn">{approved.length}</span>
              </h2>
              <div className="v2-card v2-notes-list" data-testid="v2-notes-approved">
                {approved.map((row) => (
                  <NoteLine key={row.key} row={row} busy={busy === row.key} onEdit={(r) => setEditing({ row: r, approve: false })} onDelete={remove} />
                ))}
              </div>
            </section>
          ) : null}
          {rejected.length > 0 ? (
            <section className="v2-notes-section">
              <Button variant="ghost" size="sm" icon={showRejected ? 'chev-down' : 'chev'} aria-expanded={showRejected} onClick={() => setShowRejected((on) => !on)} data-testid="v2-notes-show-rejected">
                {showRejected ? NOTES_WORDS.hideRejected : NOTES_WORDS.showRejected} ({rejected.length})
              </Button>
              {showRejected ? (
                <div className="v2-card v2-notes-list" data-testid="v2-notes-rejected" aria-label={NOTES_WORDS.rejectedHeading}>
                  {rejected.map((row) => (
                    <NoteLine key={row.key} row={row} busy={busy === row.key} onDelete={remove} />
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      <p className="v2-notes-tip" data-testid="v2-notes-tip">
        <Icon name="sparkle" size="s" />
        <span>{NOTES_WORDS.tip}</span>
      </p>

      {editing ? <EditDialog editing={editing} onClose={() => setEditing(null)} onSave={saveEdit} /> : null}
      <DraftDialog open={drafting} onClose={() => setDrafting(false)} />
    </div>
  );
}

const STATUS_BADGE = {
  proposed: { status: 'needs', label: NOTES_WORDS.proposed },
  approved: { status: 'done', label: NOTES_WORDS.approved },
  rejected: { status: 'userstop', label: NOTES_WORDS.rejected },
} as const;

function scopeIcon(kind: NoteRow['scope']['kind']): string {
  return kind === 'teammate' ? 'crew' : kind === 'codeProject' ? 'diagram' : 'folder';
}

/** One note (prototype `.lrow`): its title and text, status, scope tag, author, time, computer; its buttons. */
function NoteLine({ row, busy, onApprove, onReject, onEdit, onDelete }: { readonly row: NoteRow; readonly busy: boolean; readonly onApprove?: (row: NoteRow) => void; readonly onReject?: (row: NoteRow) => void; readonly onEdit?: (row: NoteRow) => void; readonly onDelete?: (row: NoteRow) => void }) {
  const entry: MemoryEntry = row.entry;
  // D135: a proposed edit or removal of an approved note.
  const change = changeKindOf(entry);
  const gone = change !== 'add' && (entry.target ?? null) === null;
  const disabled = busy || row.blocked !== null;
  const why = row.blocked ?? undefined;
  const badge = STATUS_BADGE[row.status];
  const current = entry.target?.title ?? entry.targetTitle ?? entry.title;
  return (
    <div className="v2-notes-row" data-testid="v2-notes-row" data-status={row.status} data-note-id={entry.id} data-scope={row.scope.key} data-change={change}>
      <div className="v2-notes-ficon" aria-hidden="true">
        <Icon name={change === 'edit' ? 'edit' : change === 'retract' ? 'trash' : 'book'} />
      </div>
      <div className="v2-grow v2-notes-body">
        <div className="v2-notes-title" data-testid="v2-notes-title">
          {change === 'edit' ? NOTES_WORDS.changeEditTitle(current) : change === 'retract' ? NOTES_WORDS.changeRemovalTitle(current) : entry.title}
        </div>
        {change !== 'add' ? (
          <NoteChange entry={entry} />
        ) : entry.text.trim() && entry.text.trim() !== entry.title.trim() ? (
          <div className="v2-notes-quote" data-testid="v2-notes-text">
            “{noteQuote(entry)}”
          </div>
        ) : null}
        <div className="v2-notes-sub">
          <StatusBadge status={badge.status} label={badge.label} size="s" />
          {change !== 'add' ? (
            <Chip tone="outline" size="s" icon={change === 'edit' ? 'edit' : 'trash'}>
              <span data-testid="v2-notes-change">{change === 'edit' ? NOTES_WORDS.changeEdit : NOTES_WORDS.changeRemoval}</span>
            </Chip>
          ) : null}
          <Chip tone="outline" size="s" icon={scopeIcon(row.scope.kind)}>
            <span data-testid="v2-notes-scope">{row.scope.label}</span>
          </Chip>
          <span>
            {NOTES_WORDS.by} {row.by}
            {row.when ? ` · ${row.when}` : ''}
          </span>
          {row.computer ? <ComputerTag name={row.computer.name} state={row.computer.state} short /> : null}
        </div>
        {row.blocked ? <div className="v2-notes-why">{row.blocked}: try again when it is back.</div> : null}
      </div>
      <div className="v2-notes-actions">
        {onApprove ? (
          <Button size="sm" variant="primary" icon={change === 'retract' ? 'trash' : 'check'} disabled={disabled || gone} title={why} onClick={() => onApprove(row)} data-testid="v2-notes-approve">
            {change === 'retract' ? NOTES_WORDS.approveRemoval : NOTES_WORDS.approve}
          </Button>
        ) : null}
        {onEdit && change !== 'retract' && !(change === 'edit' && row.status !== 'proposed') ? (
          <Button size="sm" icon="edit" disabled={disabled || gone} title={why} onClick={() => onEdit(row)} data-testid="v2-notes-edit">
            {row.status === 'proposed' ? NOTES_WORDS.editFirst : NOTES_WORDS.edit}
          </Button>
        ) : null}
        {onReject ? (
          <Button size="sm" variant="ghost" disabled={disabled} title={why} onClick={() => onReject(row)} data-testid="v2-notes-reject">
            {NOTES_WORDS.reject}
          </Button>
        ) : null}
        {onDelete ? <IconButton icon="trash" label={NOTES_WORDS.delete} title={why ?? NOTES_WORDS.delete} disabled={disabled} onClick={() => onDelete(row)} data-testid="v2-notes-delete" /> : null}
      </div>
    </div>
  );
}

/** Edit a note (approved: Save) or edit a proposal before approving it (Approve edited note). */
function EditDialog({ editing, onClose, onSave }: { readonly editing: NonNullable<Editing>; readonly onClose: () => void; readonly onSave: (row: NoteRow, approve: boolean, fields: { title: string; text: string }) => Promise<string | null> }) {
  const { row, approve } = editing;
  const [title, setTitle] = useState(row.entry.title);
  const [text, setText] = useState(row.entry.text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    if (title.trim() === '' || text.trim() === '') {
      setError('Write a short title and the note.');
      return;
    }
    setSaving(true);
    const problem = await onSave(row, approve, { title: title.trim(), text: text.trim() });
    setSaving(false);
    if (problem) setError(problem);
    else onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      icon="book"
      title={isMemoryChange(row.entry) ? NOTES_WORDS.editFirstChangeTitle : approve ? NOTES_WORDS.editFirstTitle : NOTES_WORDS.editTitle}
      testId="v2-notes-edit-dialog"
      footer={
        <>
          <span className="v2-grow" />
          <Button onClick={onClose}>{NOTES_WORDS.cancel}</Button>
          <Button variant="primary" icon="check" disabled={saving} onClick={() => void save()} data-testid="v2-notes-edit-save">
            {isMemoryChange(row.entry) ? NOTES_WORDS.approveEditedChange : approve ? NOTES_WORDS.approveEdited : NOTES_WORDS.save}
          </Button>
        </>
      }
    >
      <Field label={NOTES_WORDS.fieldTitle} value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} data-testid="v2-notes-edit-title" />
      <TextArea label={NOTES_WORDS.fieldText} value={text} maxLength={1000} onChange={(event) => setText(event.target.value)} data-testid="v2-notes-edit-text" style={{ minHeight: 110 }} />
      <p className="v2-muted v2-notes-dialog-note">Scope: {row.scope.label}</p>
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** "Draft notes from this agent": pick one of this computer's open agents; it proposes its notes (they wait in Needs you). */
function DraftDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const toast = useToast();
  const sessions = useSessionListOf('open');
  const agents = useMemo(() => (sessions.data ?? []).filter((session) => canDraftNotes(session)), [sessions.data]);
  const [picked, setPicked] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (open && !agents.some((agent) => agent.id === picked)) setPicked(agents[0]?.id ?? '');
  }, [open, agents, picked]);
  const go = async (): Promise<void> => {
    const agent = agents.find((candidate) => candidate.id === picked);
    if (!agent) return;
    setSending(true);
    try {
      const answer = await memoryApi(null).draft({ sessionId: agent.id });
      toast({ text: draftToast(answer, agentName(agent)) });
      onClose();
    } catch (error) {
      toast({ text: `Not asked: ${refusalText(error)}`, tone: 'error' });
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="book"
      title={NOTES_WORDS.draftTitle}
      testId="v2-notes-draft-dialog"
      footer={
        <>
          <span className="v2-grow" />
          <Button onClick={onClose}>{NOTES_WORDS.cancel}</Button>
          <Button variant="primary" icon="sparkle" disabled={sending || !picked} onClick={() => void go()} data-testid="v2-notes-draft-go">
            {NOTES_WORDS.draftGo}
          </Button>
        </>
      }
    >
      <p className="v2-notes-dialog-note" style={{ marginTop: 0 }}>
        {NOTES_WORDS.draftText}
      </p>
      {agents.length === 0 ? (
        <p className="v2-muted" data-testid="v2-notes-draft-none">
          {NOTES_WORDS.draftNone}
        </p>
      ) : (
        <Select label={NOTES_WORDS.draftPick} value={picked} onChange={(event) => setPicked(event.target.value)} options={agents.map((agent) => ({ value: agent.id, label: agentName(agent) }))} data-testid="v2-notes-draft-agent" />
      )}
    </Dialog>
  );
}
