import { useMemo, useState } from 'react';
import type { SessionListItem } from '../../core/api.ts';
import { displayTitle } from '../../core/session-title.ts';
import { captureTargets, sharedCapture } from '../../core/todo-capture.ts';
import { checkTodoTitle } from '../../core/todos.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { useRouter } from '../router.tsx';
import { modeLine } from '../shell/format.ts';
import { todoRefusal } from '../views/session/TodoStrip.tsx';
import { captureTodo } from './capture.ts';
import './capture.css';

/** The shared fields of the page's address (`/share?title=…&text=…&url=…`). */
function sharedFromLocation(): { readonly title: string; readonly note: string | null } {
  const query = new URLSearchParams(window.location.search);
  return sharedCapture({ title: query.get('title'), text: query.get('text'), url: query.get('url') });
}

/**
 * D81 · the phone's share sheet (`docs/devices.md` → *Share to Switchboard (D81)*): the page a
 * share opens (`/share?title=…&text=…&url=…`, from the device origin's share target). It shows
 * what was shared (the title, editable; the text and link as the note) and asks **Add to which
 * session?**: the open sessions, this machine's and the paired machines', most recently active
 * first. A tap captures it there (`from: share`), saved bare and marked for the agent to fill
 * in; then **Open session** or **Done**.
 */
export function SharePage() {
  const { navigate } = useRouter();
  const shared = useMemo(sharedFromLocation, []);
  const sessions = useApi(api.listSessions);
  const [title, setTitle] = useState(shared.title);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SessionListItem | null>(null);
  const targets = useMemo(() => captureTargets(sessions.data ?? []), [sessions.data]);
  const checked = checkTodoTitle(title.replace(/[\r\n]+/g, ' '));

  const pick = async (session: SessionListItem): Promise<void> => {
    if (!checked.ok || saving) return;
    setSaving(session.id);
    setError(null);
    try {
      await captureTodo(session.id, { title: checked.value, note: shared.note, from: 'share' });
      setSaved(session);
      // Back does not offer the share again.
      window.history.replaceState(window.history.state, '', '/share');
    } catch (refused) {
      setError(todoRefusal(refused));
    } finally {
      setSaving(null);
    }
  };

  if (saved) {
    return (
      <section className="sb-view sb-share" data-view="share" data-testid="view-share">
        <div className="sb-share-done" data-testid="share-saved" role="status">
          <h1 className="sb-share-heading">Added to {displayTitle(saved)}</h1>
          <div>{checked.ok ? checked.value : title}</div>
          <div className="sb-capture-hint">The agent fills in the plan, priority and estimate when it is idle.</div>
          <div className="sb-capture-buttons">
            <button type="button" className="sb-button" data-testid="share-open" onClick={() => navigate({ view: 'session', id: saved.id, tab: 'chat' }, { replace: true })}>
              Open session
            </button>
            <button type="button" className="sb-button" data-testid="share-done" onClick={() => navigate({ view: 'inbox' }, { replace: true })}>
              Done
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="sb-view sb-share" data-view="share" data-testid="view-share">
      <h1 className="sb-share-heading">Add to which session?</h1>
      <label className="sb-share-label" htmlFor="sb-share-title">
        Todo
      </label>
      <input id="sb-share-title" className="sb-share-title" data-testid="share-title" value={title} maxLength={240} placeholder="Title" onChange={(event) => setTitle(event.target.value)} />
      {shared.note ? (
        <p className="sb-share-note" data-testid="share-note">
          {shared.note}
        </p>
      ) : null}
      {!checked.ok ? (
        <div className="sb-capture-error" role="alert" data-testid="share-title-error">
          {title.trim() === '' ? 'Nothing was shared: type a title.' : checked.message}
        </div>
      ) : null}
      {error ? (
        <div className="sb-capture-error" role="alert" data-testid="share-error">
          {error}
        </div>
      ) : null}
      <div className="sb-share-label">Sessions, recent first</div>
      {sessions.data === null ? (
        <div className="sb-capture-hint">{sessions.error ? 'The sessions could not be loaded.' : 'Loading the sessions…'}</div>
      ) : targets.length === 0 ? (
        <div className="sb-capture-hint" data-testid="share-no-sessions">
          No open session to add it to.
        </div>
      ) : (
        <ul className="sb-share-sessions" data-testid="share-sessions">
          {targets.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="sb-share-session"
                data-testid="share-session"
                data-session-id={session.id}
                disabled={!checked.ok || saving !== null}
                aria-busy={saving === session.id}
                onClick={() => void pick(session)}
              >
                <span className="sb-share-session-title">
                  {displayTitle(session)} <MachineTag machine={session.machine} />
                </span>
                {modeLine(session) ? <span className="sb-share-session-hint">{modeLine(session)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
