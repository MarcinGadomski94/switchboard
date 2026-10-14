import { useCallback, useEffect, useState } from 'react';
import { MEMORY_CAP_DEFAULT, MEMORY_CAP_MAX, MEMORY_CAP_MIN, MEMORY_TEXT_MAX, MEMORY_TITLE_MAX, type MemoryEntry, type MemoryScope } from '../../core/memory.ts';
import type { Machine } from '../../core/peers.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { Link, useRouter } from '../router.tsx';
import { formatAge } from '../shell/format.ts';
import { type MemoryFields, memoryApi, refusalText } from './api.ts';
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

/** The title / text / tags form (add, edit, edit-then-approve). */
function EntryForm({
  initial,
  submitLabel,
  submitTestId,
  withPin,
  onSubmit,
  onCancel,
}: {
  readonly initial: Pick<MemoryEntry, 'title' | 'text' | 'tags'> | null;
  readonly submitLabel: string;
  readonly submitTestId: string;
  readonly withPin?: boolean;
  readonly onSubmit: (fields: MemoryFields) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (): void => {
    setBusy(true);
    setError(null);
    onSubmit({ title, text, tags: parseTags(tags), ...(withPin ? { pinned } : {}) })
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
        if (cancelled) return;
        setCap(settings.cap);
        setCapText(String(settings.cap));
        setEntries(chosen ? await memory.entries(chosen) : []);
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
        <div className="sb-mem-empty" data-testid="memory-off">
          Project memory is off. Switch it on in{' '}
          <Link to={{ view: 'settings', section: 'experimental' }}>Settings → Experimental</Link>.
        </div>
      </div>
    );
  }

  const proposed = entries.filter((entry) => entry.status === 'proposed');
  const approved = entries.filter((entry) => entry.status === 'approved');
  const rejected = entries.filter((entry) => entry.status === 'rejected');
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
        </div>
        {current ? (
          <div className="sb-mem-path" data-testid="memory-folder-path">
            {current.scope}
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="sb-mem-error sb-mem-error--page" role="alert" data-testid="memory-error">
          {error}
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
            {proposed.length === 0 ? <div className="sb-mem-none">No proposals. Agents propose with the memory_propose tool.</div> : null}
            {proposed.map((entry) => (
              <article key={entry.id} className="sb-mem-card sb-mem-card--proposed" data-testid="memory-proposal" data-entry-id={entry.id}>
                {editing === entry.id ? (
                  <EntryForm
                    initial={entry}
                    submitLabel="Approve"
                    submitTestId="memory-form-approve"
                    onSubmit={async (fields) => {
                      await memory.approve(entry.id, fields);
                      setEditing(null);
                      reload();
                      void reloadMemory();
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
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
                    <div className="sb-mem-card-foot">
                      <Author entry={entry} machineId={machineId} />
                      <span className="sb-mem-actions">
                        <button type="button" className="sb-button sb-mem-btn sb-mem-btn--primary" data-testid="memory-approve" onClick={() => act(() => memory.approve(entry.id))}>
                          Approve
                        </button>
                        <button type="button" className="sb-button sb-mem-btn" data-testid="memory-edit" onClick={() => setEditing(entry.id)}>
                          Edit…
                        </button>
                        <button type="button" className="sb-button sb-mem-btn" data-testid="memory-reject" onClick={() => act(() => memory.reject(entry.id))}>
                          Reject
                        </button>
                      </span>
                    </div>
                  </>
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
                <EntryForm
                  initial={null}
                  submitLabel="Save"
                  submitTestId="memory-form-save"
                  withPin
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
                  <EntryForm
                    initial={entry}
                    submitLabel="Save"
                    submitTestId="memory-form-save"
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
