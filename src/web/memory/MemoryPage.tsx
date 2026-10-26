import { useCallback, useEffect, useState } from 'react';
import {
  MEMORY_CAP_DEFAULT,
  MEMORY_CAP_MAX,
  MEMORY_CAP_MIN,
  MEMORY_TEXT_MAX,
  MEMORY_TITLE_MAX,
  type MemoryEntry,
  type MemoryScope,
  type MemoryScopeKind,
  type MemoryScopeOption,
  changeKindOf,
  isMemoryChange,
  memoryWordDiff,
} from '../../core/memory.ts';
import { APPROVE_REPLACE_LABEL, type MemoryCheckStatus, type MemoryRemovedEntry, checkFindingText, memoryCheckLine, removedLine } from '../../core/memory-check.ts';
import type { Machine } from '../../core/peers.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { Link, useRouter } from '../router.tsx';
import { formatAge } from '../shell/format.ts';
import { type MemoryFields, memoryApi, refusalText } from './api.ts';
import { DRAFT_ALL_LABEL, draftAllText } from './draft.ts';
import { reloadMemory, useMemory } from './store.ts';
import './memory.css';

/** Tags as typed in a form: comma separated. */
function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** The session id the page links to: this machine's as it is, a paired machine's as its remote id. */
function sessionRouteId(machineId: string | null, sessionId: string): string {
  return machineId ? `r~${machineId}~${sessionId}` : sessionId;
}

/** A scope as the selector keeps it: `kind:key`. */
type ScopeValue = string;

function scopeValue(scope: { readonly kind: MemoryScopeKind; readonly key: string | null }): ScopeValue {
  return `${scope.kind}:${scope.key ?? ''}`;
}

function entryScopeValue(entry: Pick<MemoryEntry, 'scopeKind' | 'scopeKey'>): ScopeValue {
  return scopeValue({ kind: entry.scopeKind, key: entry.scopeKey });
}

/** The fields a chosen scope sends (`{}` when it is the entry's own). */
function scopeFields(value: ScopeValue, entry: Pick<MemoryEntry, 'scopeKind' | 'scopeKey'> | null): MemoryFields {
  if (entry && value === entryScopeValue(entry)) return {};
  const cut = value.indexOf(':');
  const kind = value.slice(0, cut) as MemoryScopeKind;
  const key = value.slice(cut + 1);
  return kind === 'workspace' ? { scopeKind: 'workspace' } : { scopeKind: kind, scopeKey: key };
}

const KIND_NAMES: Readonly<Record<MemoryScopeKind, string>> = { member: 'Member', repo: 'Repo', workspace: 'Workspace' };

/** An entry's scope chip: Workspace / the repository's name / the member's role (D107 follow-up 2026-10-15). */
function ScopeChip({ entry }: { readonly entry: Pick<MemoryEntry, 'scopeKind' | 'scopeLabel'> }) {
  const label = entry.scopeKind === 'workspace' ? 'Workspace' : (entry.scopeLabel ?? KIND_NAMES[entry.scopeKind]);
  const title = entry.scopeKind === 'workspace' ? 'Every session in this folder' : entry.scopeKind === 'repo' ? `Sessions working in the repository ${label}` : `Only the team member ${label}`;
  return (
    <span className={`sb-mem-scope sb-mem-scope--${entry.scopeKind}`} data-testid="memory-entry-scope" data-scope-kind={entry.scopeKind} title={title}>
      {entry.scopeKind === 'repo' ? '⎇ ' : entry.scopeKind === 'member' ? '⚑ ' : ''}
      {label}
    </span>
  );
}

/** The scopes an entry can be given (loaded once per entry / folder). */
function useScopeOptions(machineId: string | null, folder: string, entryId: string | null): readonly MemoryScopeOption[] {
  const [options, setOptions] = useState<readonly MemoryScopeOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    memoryApi(machineId)
      .scopeOptions(folder, entryId ?? undefined)
      .then(
        (list) => {
          if (!cancelled) setOptions(list);
        },
        () => {
          if (!cancelled) setOptions([]);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [machineId, folder, entryId]);
  return options;
}

/** The scope selector (the review queue and the edit form): Workspace, the repositories, the members. */
function ScopeSelect({ options, value, onChange, testId }: { readonly options: readonly MemoryScopeOption[]; readonly value: ScopeValue; readonly onChange: (value: ScopeValue) => void; readonly testId: string }) {
  const known = options.some((option) => scopeValue(option) === value);
  return (
    <select className="sb-mem-select sb-mem-scope-select" data-testid={testId} aria-label="Scope" value={value} onChange={(event) => onChange(event.target.value)}>
      {known ? null : <option value={value}>{value.startsWith('workspace') ? 'Workspace' : value}</option>}
      {options.map((option) => (
        <option key={scopeValue(option)} value={scopeValue(option)} data-kind={option.kind}>
          {option.kind === 'workspace' ? `Workspace · everyone in ${option.label}` : option.kind === 'repo' ? `Repo · ${option.label}` : `Member · ${option.label}`}
        </option>
      ))}
    </select>
  );
}

/** The title / text / tags (and scope) form (add, edit, edit-then-approve). */
function EntryForm({
  initial,
  submitLabel,
  submitTestId,
  withPin,
  scopeOptions,
  stored,
  onSubmit,
  onCancel,
}: {
  readonly initial: Pick<MemoryEntry, 'title' | 'text' | 'tags' | 'scopeKind' | 'scopeKey'> | null;
  /** The entry as stored (a scope equal to it is not sent); defaults to `initial`. */
  readonly stored?: Pick<MemoryEntry, 'scopeKind' | 'scopeKey'>;
  readonly submitLabel: string;
  readonly submitTestId: string;
  readonly withPin?: boolean;
  /** D107 follow-up 2026-10-15: the scopes it can be given. */
  readonly scopeOptions: readonly MemoryScopeOption[];
  readonly onSubmit: (fields: MemoryFields) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [pinned, setPinned] = useState(false);
  const [scope, setScope] = useState<ScopeValue>(initial ? entryScopeValue(initial) : 'workspace:');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (): void => {
    setBusy(true);
    setError(null);
    onSubmit({ title, text, tags: parseTags(tags), ...(withPin ? { pinned } : {}), ...scopeFields(scope, stored ?? initial) })
      .catch((failure: unknown) => setError(refusalText(failure)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="sb-mem-form"
      data-testid="memory-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input className="sb-mem-input" data-testid="memory-form-title" value={title} maxLength={MEMORY_TITLE_MAX} placeholder="Title: one short line" aria-label="Title" onChange={(event) => setTitle(event.target.value)} autoFocus />
      <textarea className="sb-mem-input sb-mem-textarea" data-testid="memory-form-text" value={text} maxLength={MEMORY_TEXT_MAX} placeholder="The fact itself, plain and brief" aria-label="Text" rows={4} onChange={(event) => setText(event.target.value)} />
      <input className="sb-mem-input" data-testid="memory-form-tags" value={tags} placeholder="Tags, comma separated (optional)" aria-label="Tags" onChange={(event) => setTags(event.target.value)} />
      <label className="sb-mem-check">
        For: <ScopeSelect options={scopeOptions} value={scope} onChange={setScope} testId="memory-form-scope" />
      </label>
      {withPin ? (
        <label className="sb-mem-check">
          <input type="checkbox" data-testid="memory-form-pinned" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> Pinned (always first in the block)
        </label>
      ) : null}
      {error ? (
        <div className="sb-mem-error" role="alert" data-testid="memory-form-error">
          {error}
        </div>
      ) : null}
      <div className="sb-mem-actions">
        <button type="submit" className="sb-button sb-mem-btn sb-mem-btn--primary" data-testid={submitTestId} disabled={busy || title.trim() === '' || text.trim() === ''}>
          {submitLabel}
        </button>
        <button type="button" className="sb-button sb-mem-btn" data-testid="memory-form-cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Tags({ tags }: { readonly tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="sb-mem-tags" data-testid="memory-entry-tags">
      {tags.map((tag) => (
        <span key={tag} className="sb-mem-tag">
          {tag}
        </span>
      ))}
    </span>
  );
}

/** Who wrote it: the proposing session (linked) or you, and whether you edited the agent's words. */
function Author({ entry, machineId }: { readonly entry: MemoryEntry; readonly machineId: string | null }) {
  const edited = entry.proposedTitle !== null || entry.proposedText !== null;
  return (
    <span className="sb-mem-meta" data-testid="memory-entry-meta">
      {entry.authorKind === 'developer' ? (
        'added by you'
      ) : (
        <>
          proposed by{' '}
          {entry.authorSessionId ? (
            <Link to={{ view: 'session', id: sessionRouteId(machineId, entry.authorSessionId), tab: 'chat' }} className="sb-mem-session" data-testid="memory-entry-session">
              {entry.authorLabel ?? 'a session'}
            </Link>
          ) : (
            (entry.authorLabel ?? 'an agent')
          )}
          {edited ? ' · edited by you' : ''}
        </>
      )}
      {' · '}
      {formatAge(entry.status === 'proposed' ? entry.createdAt : (entry.decidedAt ?? entry.updatedAt))}
    </span>
  );
}

/** + Add entry's form: the folder's scope options (Workspace by default). */
function AddForm({ machineId, folder, onSubmit, onCancel }: { readonly machineId: string | null; readonly folder: string; readonly onSubmit: (fields: MemoryFields) => Promise<void>; readonly onCancel: () => void }) {
  const options = useScopeOptions(machineId, folder, null);
  return <EntryForm initial={null} submitLabel="Save" submitTestId="memory-form-save" withPin scopeOptions={options} onSubmit={onSubmit} onCancel={onCancel} />;
}

/** An approved entry's Edit form (its scope can change too). */
function EditForm({ entry, machineId, folder, onSubmit, onCancel }: { readonly entry: MemoryEntry; readonly machineId: string | null; readonly folder: string; readonly onSubmit: (fields: MemoryFields) => Promise<void>; readonly onCancel: () => void }) {
  const options = useScopeOptions(machineId, folder, entry.id);
  return <EntryForm initial={entry} submitLabel="Save" submitTestId="memory-form-save" scopeOptions={options} onSubmit={onSubmit} onCancel={onCancel} />;
}

/**
 * A proposal in the review queue: its suggested scope in a selector the developer confirms or
 * changes (D107 follow-up 2026-10-15), Approve (with the chosen scope), Edit… (the form, scope
 * included) and Reject.
 */
function ProposalCard({
  entry,
  machineId,
  folder,
  editing,
  onEdit,
  onCancel,
  onApprove,
  onAct,
  onReject,
}: {
  readonly entry: MemoryEntry;
  readonly machineId: string | null;
  readonly folder: string;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onApprove: (fields: MemoryFields) => Promise<void>;
  readonly onAct: (work: () => Promise<unknown>) => void;
  readonly onReject: () => void;
}) {
  const options = useScopeOptions(machineId, folder, entry.id);
  const [scope, setScope] = useState<ScopeValue>(entryScopeValue(entry));
  if (editing) return <EntryForm initial={{ ...entry, ...scopeFieldsAsEntry(scope, entry) }} submitLabel="Approve" submitTestId="memory-form-approve" scopeOptions={options} stored={entry} onSubmit={onApprove} onCancel={onCancel} />;
  return (
    <>
      <div className="sb-mem-card-head">
        <span className="sb-mem-entry-title" data-testid="memory-entry-title">
          {entry.title}
        </span>
        <Tags tags={entry.tags} />
      </div>
      <div className="sb-mem-entry-text" data-testid="memory-entry-text">
        {entry.text}
      </div>
      {entry.check ? (
        // D136: the proposal check found a duplicate or a conflict with an approved note.
        <div className={`sb-mem-finding sb-mem-finding--${entry.check.verdict}`} data-testid="memory-finding" data-verdict={entry.check.verdict}>
          <b data-testid="memory-finding-title">{checkFindingText(entry.check)}</b>
          <span className="sb-mem-finding-reason" data-testid="memory-finding-reason">
            {entry.check.reason}
          </span>
        </div>
      ) : null}
      <div className="sb-mem-scope-row">
        <span className="sb-mem-meta">Suggested for</span> <ScopeSelect options={options} value={scope} onChange={setScope} testId="memory-proposal-scope" />
      </div>
      <div className="sb-mem-card-foot">
        <Author entry={entry} machineId={machineId} />
        <span className="sb-mem-actions">
          <button type="button" className="sb-button sb-mem-btn sb-mem-btn--primary" data-testid="memory-approve" onClick={() => onAct(() => onApprove(scopeFields(scope, entry)))}>
            Approve
          </button>
          {entry.check ? (
            <button type="button" className="sb-button sb-mem-btn" data-testid="memory-approve-replace" onClick={() => onAct(() => onApprove({ ...scopeFields(scope, entry), removeConflicting: true }))}>
              {APPROVE_REPLACE_LABEL}
            </button>
          ) : null}
          <button type="button" className="sb-button sb-mem-btn" data-testid="memory-edit" onClick={onEdit}>
            Edit…
          </button>
          <button type="button" className="sb-button sb-mem-btn" data-testid="memory-reject" onClick={onReject}>
            Reject
          </button>
        </span>
      </div>
    </>
  );
}

/**
 * D135 · one side of the review's comparison: `before` → `after` word by word; the "now" side marks
 * what goes (`del`), the "proposed" side what comes (`add`).
 */
function DiffText({ before, after, side, testId }: { readonly before: string; readonly after: string; readonly side: 'now' | 'proposed'; readonly testId: string }) {
  const parts = memoryWordDiff(before, after).filter((part) => part.kind === 'same' || part.kind === (side === 'now' ? 'del' : 'add'));
  return (
    <span data-testid={testId}>
      {parts.map((part, index) =>
        part.kind === 'same' ? (
          <span key={index}>{part.text}</span>
        ) : part.kind === 'del' ? (
          <del key={index} className="sb-mem-diff sb-mem-diff--del">
            {part.text}
          </del>
        ) : (
          <ins key={index} className="sb-mem-diff sb-mem-diff--add">
            {part.text}
          </ins>
        ),
      )}
    </span>
  );
}

/** D135 · Edit… of an edit proposal: its new title and text, then Approve (what is approved replaces the entry). */
function ChangeForm({ entry, onSubmit, onCancel }: { readonly entry: MemoryEntry; readonly onSubmit: (fields: MemoryFields) => Promise<void>; readonly onCancel: () => void }) {
  const [title, setTitle] = useState(entry.title);
  const [text, setText] = useState(entry.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="sb-mem-form"
      data-testid="memory-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        onSubmit({ title, text })
          .catch((failure: unknown) => setError(refusalText(failure)))
          .finally(() => setBusy(false));
      }}
    >
      <input className="sb-mem-input" data-testid="memory-form-title" value={title} maxLength={MEMORY_TITLE_MAX} aria-label="New title" onChange={(event) => setTitle(event.target.value)} autoFocus />
      <textarea className="sb-mem-input sb-mem-textarea" data-testid="memory-form-text" value={text} maxLength={MEMORY_TEXT_MAX} aria-label="New text" rows={4} onChange={(event) => setText(event.target.value)} />
      {error ? (
        <div className="sb-mem-error" role="alert" data-testid="memory-form-error">
          {error}
        </div>
      ) : null}
      <div className="sb-mem-actions">
        <button type="submit" className="sb-button sb-mem-btn sb-mem-btn--primary" data-testid="memory-form-approve" disabled={busy || title.trim() === '' || text.trim() === ''}>
          Approve
        </button>
        <button type="button" className="sb-button sb-mem-btn" data-testid="memory-form-cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * D135 · a proposal to change an approved entry: an **edit** shows the entry now and as proposed side
 * by side (removed words struck, added ones marked) with Approve (replaces it, same id), Edit… (then
 * Approve) and Reject; a **removal** shows the entry and the agent's reason with Approve removal
 * (deletes it) and Reject (keeps it).
 */
function ChangeCard({
  entry,
  machineId,
  editing,
  onEdit,
  onCancel,
  onApprove,
  onAct,
  onReject,
}: {
  readonly entry: MemoryEntry;
  readonly machineId: string | null;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onApprove: (fields: MemoryFields) => Promise<void>;
  readonly onAct: (work: () => Promise<unknown>) => void;
  readonly onReject: () => void;
}) {
  const kind = changeKindOf(entry);
  const target = entry.target ?? null;
  if (editing && kind === 'edit') return <ChangeForm entry={entry} onSubmit={onApprove} onCancel={onCancel} />;
  const now = target ?? { title: entry.targetTitle ?? entry.title, text: entry.targetText ?? entry.text };
  return (
    <>
      <div className="sb-mem-card-head">
        <span className={`sb-mem-change sb-mem-change--${kind}`} data-testid="memory-change-kind">
          {kind === 'edit' ? 'Edit' : 'Removal'}
        </span>
        <ScopeChip entry={entry} />
        <span className="sb-mem-meta">of the approved entry “{now.title}”</span>
      </div>
      {target === null ? (
        <div className="sb-mem-error" data-testid="memory-change-gone">
          That entry no longer exists: reject this proposal.
        </div>
      ) : null}
      {kind === 'edit' ? (
        <div className="sb-mem-compare" data-testid="memory-compare">
          <div className="sb-mem-compare-side" data-testid="memory-compare-now">
            <div className="sb-mem-compare-label">Now</div>
            <div className="sb-mem-entry-title">
              <DiffText before={now.title} after={entry.title} side="now" testId="memory-compare-now-title" />
            </div>
            <div className="sb-mem-entry-text">
              <DiffText before={now.text} after={entry.text} side="now" testId="memory-compare-now-text" />
            </div>
          </div>
          <div className="sb-mem-compare-side sb-mem-compare-side--proposed" data-testid="memory-compare-proposed">
            <div className="sb-mem-compare-label">Proposed</div>
            <div className="sb-mem-entry-title">
              <DiffText before={now.title} after={entry.title} side="proposed" testId="memory-compare-proposed-title" />
            </div>
            <div className="sb-mem-entry-text">
              <DiffText before={now.text} after={entry.text} side="proposed" testId="memory-compare-proposed-text" />
            </div>
          </div>
        </div>
      ) : (
        <div className="sb-mem-compare-side sb-mem-compare-side--removed" data-testid="memory-removal">
          <div className="sb-mem-compare-label">Would be removed</div>
          <div className="sb-mem-entry-title" data-testid="memory-entry-title">
            {now.title}
          </div>
          <div className="sb-mem-entry-text" data-testid="memory-entry-text">
            {now.text}
          </div>
        </div>
      )}
      <div className="sb-mem-reason" data-testid="memory-change-reason">
        <span className="sb-mem-meta">Why:</span> {entry.reason ?? 'no reason given'}
      </div>
      <div className="sb-mem-card-foot">
        <Author entry={entry} machineId={machineId} />
        <span className="sb-mem-actions">
          <button type="button" className={`sb-button sb-mem-btn ${kind === 'retract' ? 'sb-mem-btn--danger' : 'sb-mem-btn--primary'}`} data-testid="memory-approve" disabled={target === null} onClick={() => onAct(() => onApprove({}))}>
            {kind === 'retract' ? 'Approve removal' : 'Approve'}
          </button>
          {kind === 'edit' ? (
            <button type="button" className="sb-button sb-mem-btn" data-testid="memory-edit" disabled={target === null} onClick={onEdit}>
              Edit…
            </button>
          ) : null}
          <button type="button" className="sb-button sb-mem-btn" data-testid="memory-reject" onClick={onReject}>
            Reject
          </button>
        </span>
      </div>
    </>
  );
}

/** The scope a selector value names, as an entry's fields (the edit form starts from the queue's choice). */
function scopeFieldsAsEntry(value: ScopeValue, entry: Pick<MemoryEntry, 'scopeKind' | 'scopeKey'>): Pick<MemoryEntry, 'scopeKind' | 'scopeKey'> {
  const fields = scopeFields(value, entry);
  return fields.scopeKind ? { scopeKind: fields.scopeKind, scopeKey: fields.scopeKey ?? null } : { scopeKind: entry.scopeKind, scopeKey: entry.scopeKey };
}

/**
 * D107 · the Memory page (`/memory`, only while Project memory is on; `docs/memory.md` → *The
 * Memory page*): a folder picker (this machine's saved folders and every folder with entries; a
 * paired machine's through the D48 proxy), the **review queue** of the agents' proposals (Approve,
 * Edit… then approve, Reject; each with its proposing session linked), the approved entries
 * (pin, edit, delete), + Add entry, the rejected ones, and the block's size. `?scope=` picks the
 * folder (the Inbox item's Review and the session panel's link).
 */
export function MemoryPage() {
  const { on, loaded } = useMemory();
  const { search, navigate } = useRouter();
  const [machines, setMachines] = useState<readonly Machine[]>([]);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [scopes, setScopes] = useState<readonly MemoryScope[] | null>(null);
  const [scope, setScope] = useState<string | null>(() => new URLSearchParams(search).get('scope'));
  const [entries, setEntries] = useState<readonly MemoryEntry[]>([]);
  const [cap, setCap] = useState<number>(MEMORY_CAP_DEFAULT);
  const [capText, setCapText] = useState(String(MEMORY_CAP_DEFAULT));
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** D107 follow-up 2026-10-15: show one scope only (`all`: every entry). */
  const [kind, setKind] = useState<MemoryScopeKind | 'all'>('all');
  const [notice, setNotice] = useState<string | null>(null);
  const [members, setMembers] = useState(0);
  // D136: the folder's removed notes (Restore) and its check state.
  const [removed, setRemoved] = useState<readonly MemoryRemovedEntry[]>([]);
  const [check, setCheck] = useState<MemoryCheckStatus | null>(null);
  const memory = memoryApi(machineId);

  useEffect(() => {
    const wanted = new URLSearchParams(search).get('scope');
    if (wanted) setScope(wanted);
  }, [search]);

  useEffect(() => {
    api.machines().then(
      (view) => setMachines(view.machines),
      () => setMachines([]),
    );
  }, []);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  useHubEvent('memoryChanged', reload);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await memory.scopes();
        if (cancelled) return;
        setScopes(list);
        // The asked folder, else the one with proposals, else the first.
        const chosen = scope && list.some((candidate) => candidate.scope === scope) ? scope : scope && machineId === null ? scope : (list.find((candidate) => candidate.proposed > 0)?.scope ?? list[0]?.scope ?? null);
        if (chosen !== scope) setScope(chosen);
        const settings = await memory.settings();
        const state = await memory.state();
        if (cancelled) return;
        setMembers(state.members ?? 0);
        setCap(settings.cap);
        setCapText(String(settings.cap));
        setEntries(chosen ? await memory.entries(chosen) : []);
        // D136: an older paired machine has no checks (404): nothing of them shows.
        setRemoved(chosen ? await memory.removed(chosen).catch(() => []) : []);
        setCheck(chosen ? await memory.checkStatus(chosen).catch(() => null) : null);
        setError(null);
      } catch (failure) {
        if (!cancelled) setError(refusalText(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [on, machineId, scope, tick]);

  const act = (work: () => Promise<unknown>): void => {
    setError(null);
    work()
      .then(() => {
        reload();
        void reloadMemory();
      })
      .catch((failure: unknown) => setError(refusalText(failure)));
  };

  if (!loaded) return <div className="sb-mem-view" data-testid="memory-page" />;
  if (!on) {
    return (
      <div className="sb-mem-view" data-testid="memory-page">
        {/* D132: always on; only a memory.db that could not be opened lands here. */}
        <div className="sb-mem-empty" data-testid="memory-unavailable">
          Project memory is unavailable: its database (memory.db) could not be opened. Restart Switchboard; the log says why.
        </div>
      </div>
    );
  }

  const shown = kind === 'all' ? entries : entries.filter((entry) => entry.scopeKind === kind);
  const proposed = shown.filter((entry) => entry.status === 'proposed');
  const approved = shown.filter((entry) => entry.status === 'approved');
  const rejected = shown.filter((entry) => entry.status === 'rejected');
  const current = scopes?.find((candidate) => candidate.scope === scope) ?? null;

  return (
    <div className="sb-mem-view" data-testid="memory-page">
      <div className="sb-mem-head">
        <div className="sb-mem-title-row">
          <h1 className="sb-mem-title">Project memory</h1>
          <span className="sb-mem-hint">Only entries you approve reach sessions. Agents' proposals wait here.</span>
        </div>
        <div className="sb-mem-pickers">
          {machines.length > 0 ? (
            <select
              className="sb-mem-select"
              data-testid="memory-machine"
              aria-label="Machine"
              value={machineId ?? ''}
              onChange={(event) => {
                setMachineId(event.target.value === '' ? null : event.target.value);
                setScope(null);
              }}
            >
              <option value="">This machine</option>
              {machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name}
                </option>
              ))}
            </select>
          ) : null}
          <select
            className="sb-mem-select"
            data-testid="memory-folder"
            data-tour="memory-folder"
            aria-label="Folder"
            value={scope ?? ''}
            onChange={(event) => {
              setScope(event.target.value || null);
              setEditing(null);
              setAdding(false);
              navigate(`/memory?scope=${encodeURIComponent(event.target.value)}`, { replace: true });
            }}
          >
            {scope && !scopes?.some((candidate) => candidate.scope === scope) ? <option value={scope}>{scope}</option> : null}
            {(scopes ?? []).map((candidate) => (
              <option key={candidate.scope} value={candidate.scope} title={candidate.scope}>
                {candidate.label} · {candidate.approved} approved{candidate.proposed > 0 ? ` · ${candidate.proposed} to review` : ''}
              </option>
            ))}
          </select>
          <select className="sb-mem-select" data-testid="memory-kind" data-tour="memory-kind" aria-label="Scope" value={kind} onChange={(event) => setKind(event.target.value as MemoryScopeKind | 'all')}>
            <option value="all">Every scope</option>
            <option value="member">Member</option>
            <option value="repo">Repo</option>
            <option value="workspace">Workspace</option>
          </select>
          {members > 0 ? (
            <button
              type="button"
              className="sb-button sb-mem-btn"
              data-testid="memory-draft-all"
              data-tour="memory-draft-all"
              onClick={() => {
                setNotice(null);
                act(async () => setNotice(draftAllText(await memory.draftAll())));
              }}
            >
              {DRAFT_ALL_LABEL}
            </button>
          ) : null}
        </div>
        {current ? (
          <div className="sb-mem-path" data-testid="memory-folder-path">
            {current.scope}
          </div>
        ) : null}
        {check && scope ? (
          // D136: the folder's last check, quietly (no Inbox item, toast or push for a background run).
          <div className="sb-mem-check" data-testid="memory-check-status" data-tour="memory-check" data-running={check.running ? 'true' : undefined}>
            <span data-testid="memory-check-line">{memoryCheckLine(check, Date.now())}</span>
            <button type="button" className="sb-button sb-mem-btn" data-testid="memory-check-now" disabled={check.running || check.notes === 0} onClick={() => act(() => memory.checkNow(scope))}>
              Check now
            </button>
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="sb-mem-error sb-mem-error--page" role="alert" data-testid="memory-error">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="sb-mem-notice" role="status" data-testid="memory-notice">
          {notice}
        </div>
      ) : null}
      {scope === null ? (
        <div className="sb-mem-empty" data-testid="memory-no-folder">
          No folders yet: save one in Settings → Folders, or start a session.
        </div>
      ) : (
        <div className="sb-mem-body">
          <section className="sb-mem-section" data-testid="memory-queue" data-tour="memory-queue">
            <h2 className="sb-mem-h2">
              To review <span className="sb-mem-count">{proposed.length}</span>
            </h2>
            {proposed.length === 0 ? <div className="sb-mem-none">No proposals. Agents propose with the memory_propose tool (and changes to approved entries with memory_propose_edit / memory_propose_retract).</div> : null}
            {proposed.map((entry) => (
              <article key={entry.id} className="sb-mem-card sb-mem-card--proposed" data-testid="memory-proposal" data-entry-id={entry.id} data-change={changeKindOf(entry)}>
                {isMemoryChange(entry) ? (
                  <ChangeCard
                    entry={entry}
                    machineId={machineId}
                    editing={editing === entry.id}
                    onEdit={() => setEditing(entry.id)}
                    onCancel={() => setEditing(null)}
                    onApprove={async (fields) => {
                      await memory.approve(entry.id, fields);
                      setEditing(null);
                      reload();
                      void reloadMemory();
                    }}
                    onAct={act}
                    onReject={() => act(() => memory.reject(entry.id))}
                  />
                ) : (
                  <ProposalCard
                    entry={entry}
                    machineId={machineId}
                    folder={scope}
                    editing={editing === entry.id}
                    onEdit={() => setEditing(entry.id)}
                    onCancel={() => setEditing(null)}
                    onApprove={async (fields) => {
                      await memory.approve(entry.id, fields);
                      setEditing(null);
                      reload();
                      void reloadMemory();
                    }}
                    onAct={act}
                    onReject={() => act(() => memory.reject(entry.id))}
                  />
                )}
              </article>
            ))}
          </section>

          <section className="sb-mem-section" data-testid="memory-approved">
            <h2 className="sb-mem-h2">
              Approved <span className="sb-mem-count">{approved.length}</span>
              <button type="button" className="sb-button sb-mem-btn sb-mem-add" data-testid="memory-add" data-tour="memory-add" onClick={() => setAdding(true)} disabled={adding}>
                + Add entry
              </button>
            </h2>
            {adding ? (
              <div className="sb-mem-card">
                <AddForm
                  machineId={machineId}
                  folder={scope}
                  onSubmit={async (fields) => {
                    await memory.add(scope, fields);
                    setAdding(false);
                    reload();
                    void reloadMemory();
                  }}
                  onCancel={() => setAdding(false)}
                />
              </div>
            ) : null}
            {approved.length === 0 && !adding ? <div className="sb-mem-none">Nothing approved yet: sessions in this folder get no memory.</div> : null}
            {approved.map((entry) => (
              <article key={entry.id} className="sb-mem-card" data-testid="memory-entry" data-entry-id={entry.id} data-pinned={entry.pinned ? 'true' : undefined}>
                {editing === entry.id ? (
                  <EditForm
                    entry={entry}
                    machineId={machineId}
                    folder={scope}
                    onSubmit={async (fields) => {
                      await memory.update(entry.id, fields);
                      setEditing(null);
                      reload();
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <>
                    <div className="sb-mem-card-head">
                      <ScopeChip entry={entry} />
                      <button
                        type="button"
                        className="sb-mem-pin"
                        data-testid="memory-pin"
                        aria-pressed={entry.pinned}
                        title={entry.pinned ? 'Unpin' : 'Pin: always first in the block'}
                        onClick={() => act(() => memory.update(entry.id, { pinned: !entry.pinned }))}
                      >
                        {entry.pinned ? '★' : '☆'}
                      </button>
                      <span className="sb-mem-entry-title" data-testid="memory-entry-title">
                        {entry.title}
                      </span>
                      <Tags tags={entry.tags} />
                    </div>
                    <div className="sb-mem-entry-text" data-testid="memory-entry-text">
                      {entry.text}
                    </div>
                    <div className="sb-mem-card-foot">
                      <Author entry={entry} machineId={machineId} />
                      <span className="sb-mem-actions">
                        <button type="button" className="sb-button sb-mem-btn" data-testid="memory-edit" onClick={() => setEditing(entry.id)}>
                          Edit
                        </button>
                        {confirming === entry.id ? (
                          <button
                            type="button"
                            className="sb-button sb-mem-btn sb-mem-btn--danger"
                            data-testid="memory-delete-confirm"
                            onClick={() => {
                              setConfirming(null);
                              act(() => memory.remove(entry.id));
                            }}
                          >
                            Delete for good
                          </button>
                        ) : (
                          <button type="button" className="sb-button sb-mem-btn" data-testid="memory-delete" onClick={() => setConfirming(entry.id)}>
                            Delete…
                          </button>
                        )}
                      </span>
                    </div>
                  </>
                )}
              </article>
            ))}
          </section>

          {rejected.length > 0 ? (
            <section className="sb-mem-section" data-testid="memory-rejected">
              <h2 className="sb-mem-h2">
                <button type="button" className="sb-mem-toggle" aria-expanded={showRejected} data-testid="memory-rejected-toggle" onClick={() => setShowRejected(!showRejected)}>
                  {showRejected ? '▾' : '▸'} Rejected <span className="sb-mem-count">{rejected.length}</span>
                </button>
              </h2>
              {showRejected
                ? rejected.map((entry) => (
                    <article key={entry.id} className="sb-mem-card sb-mem-card--rejected" data-testid="memory-rejected-entry" data-entry-id={entry.id}>
                      <div className="sb-mem-card-head">
                        {isMemoryChange(entry) ? <span className={`sb-mem-change sb-mem-change--${changeKindOf(entry)}`}>{changeKindOf(entry) === 'edit' ? 'Edit' : 'Removal'}</span> : null}
                        <ScopeChip entry={entry} />
                        <span className="sb-mem-entry-title">{entry.title}</span>
                      </div>
                      <div className="sb-mem-entry-text">{entry.text}</div>
                      <div className="sb-mem-card-foot">
                        <Author entry={entry} machineId={machineId} />
                        <span className="sb-mem-actions">
                          <button type="button" className="sb-button sb-mem-btn" data-testid="memory-approve" onClick={() => act(() => memory.approve(entry.id))}>
                            Approve after all
                          </button>
                          <button type="button" className="sb-button sb-mem-btn" data-testid="memory-delete-rejected" onClick={() => act(() => memory.remove(entry.id))}>
                            Delete
                          </button>
                        </span>
                      </div>
                    </article>
                  ))
                : null}
            </section>
          ) : null}

          {removed.length > 0 ? (
            <section className="sb-mem-section" data-testid="memory-removed">
              <h2 className="sb-mem-h2">
                Removed by memory check <span className="sb-mem-count">{removed.length}</span>
              </h2>
              <div className="sb-mem-none">Kept 30 days, never given to agents. Restore puts a note back as it was.</div>
              {removed.map((row) => (
                <article key={row.id} className="sb-mem-card sb-mem-card--removed" data-testid="memory-removed-entry" data-entry-id={row.id}>
                  <div className="sb-mem-card-head">
                    <ScopeChip entry={row.entry} />
                    <span className="sb-mem-entry-title" data-testid="memory-entry-title">
                      {row.entry.title}
                    </span>
                  </div>
                  <div className="sb-mem-entry-text">{row.entry.text}</div>
                  <div className="sb-mem-card-foot">
                    <span className="sb-mem-meta" data-testid="memory-removed-reason">
                      {removedLine(row, Date.now())}
                    </span>
                    <span className="sb-mem-actions">
                      <button type="button" className="sb-button sb-mem-btn sb-mem-btn--primary" data-testid="memory-restore" onClick={() => act(() => memory.restore(row.id))}>
                        Restore
                      </button>
                    </span>
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          <section className="sb-mem-section sb-mem-settings" data-testid="memory-settings">
            <label className="sb-mem-cap">
              Block size per session:{' '}
              <input
                className="sb-mem-input sb-mem-cap-input"
                type="number"
                data-testid="memory-cap"
                min={MEMORY_CAP_MIN}
                max={MEMORY_CAP_MAX}
                step={100}
                value={capText}
                onChange={(event) => setCapText(event.target.value)}
              />{' '}
              characters (pinned first, then newest; the rest are named and read with memory_list)
            </label>
            <button type="button" className="sb-button sb-mem-btn" data-testid="memory-cap-save" disabled={Number(capText) === cap} onClick={() => act(() => memory.setSettings(Number(capText)))}>
              Save
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
