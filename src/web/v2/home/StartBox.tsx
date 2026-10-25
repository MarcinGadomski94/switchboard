import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import type { Folder, ModelSettings, Session } from '../../../core/api.ts';
import { ApiError, api, machineApi } from '../../api/client.ts';
import { useMachines } from '../../api/useMachines.ts';
import { startErrorText } from '../../modals/new-session.ts';
import { Button, Icon, Segmented, useToast } from '../components/index.ts';
import { HOME_WORDS, WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { type NewKind, openNew } from '../new/index.tsx';
import { START_PREFS_KEY, type Speed, type StartPrefs, canStartFrom, machineKey, readStartPrefs, speedModel, startBody, startFolder } from './home-model.ts';

/**
 * D131 · Home's start box (lane H; the prototype's `#startbox`): "What should an
 * agent do?", the folder (the last one used), the computer, Smart / Fast, More
 * options (the + New sheet with the text) and Start agent. Enter (or ⌘↩) starts
 * an agent with the text as its first message through `POST /api/sessions` (the
 * simple form's body, D56), on the chosen computer (D48). Shift+Enter is a new line.
 */

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function savePrefs(prefs: StartPrefs): void {
  try {
    storage()?.setItem(START_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Remembered for this page only.
  }
}

/** What Home is told while an agent starts (the skeleton card, then the live one). */
export interface StartEvents {
  readonly onStarting: (title: string) => void;
  readonly onStarted: (session: Session) => void;
  readonly onFailed: () => void;
}

const MORE: ReadonlyArray<readonly [NewKind, string, string]> = [
  ['conversation', 'chat', HOME_WORDS.justAsk],
  ['task', 'task', HOME_WORDS.addTask],
  ['project', 'projects', HOME_WORDS.newProject],
  ['routine', 'routine', HOME_WORDS.newRoutine],
];

export function StartBox({ phone, takenNames, events }: { readonly phone: boolean; readonly takenNames: readonly string[]; readonly events: StartEvents }) {
  const toast = useToast();
  const { navigate } = useV2Router();
  const machines = useMachines();
  const [prefs, setPrefs] = useState<StartPrefs>(() => readStartPrefs(storage()?.getItem(START_PREFS_KEY) ?? null));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selfName, setSelfName] = useState<string>('This computer');
  const machine = prefs.machine && machines.some((m) => m.id === prefs.machine) ? prefs.machine : null;
  const [folders, setFolders] = useState<{ readonly machine: string | null; readonly list: readonly Folder[] } | null>(null);
  const [models, setModels] = useState<{ readonly machine: string | null; readonly settings: ModelSettings | null } | null>(null);
  const [folder, setFolder] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .machines()
      .then((view) => live && setSelfName(view.self.name))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // The chosen computer's saved folders and models (D48: a paired computer's own).
  useEffect(() => {
    let live = true;
    const on = machineApi(machine);
    on.savedFolders()
      .then((list) => {
        if (!live) return;
        setFolders({ machine, list });
        setFolder(startFolder(list, prefs.folders[machineKey(machine)]));
      })
      .catch(() => live && setFolders({ machine, list: [] }));
    on.models()
      .then((settings) => live && setModels({ machine, settings }))
      .catch(() => live && setModels({ machine, settings: null }));
    return () => {
      live = false;
    };
    // prefs.folders is read once per computer: a later pick is the user's.
  }, [machine]);

  const list = folders?.machine === machine ? folders.list : null;
  const chosen = list?.find((f) => f.id === folder) ?? null;
  const offline = machine !== null && machines.find((m) => m.id === machine)?.state !== 'online';
  const ready = canStartFrom(text) && !busy && !offline && list !== null;
  // Why Start agent is disabled (its tooltip); none while it starts.
  const why = ready || busy ? undefined : offline ? HOME_WORDS.startComputerOffline : !canStartFrom(text) ? HOME_WORDS.startNeedsText : HOME_WORDS.startLoadingFolders;

  const computers = useMemo(
    () => [
      { value: '', label: selfName, disabled: false },
      ...machines.map((m) => ({ value: m.id, label: m.state === 'online' ? m.name : `${m.name} · ${m.state === 'reconnecting' ? 'reconnecting' : 'offline'}`, disabled: m.state !== 'online' })),
    ],
    [machines, selfName],
  );

  const choose = (next: Partial<StartPrefs>): void => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    savePrefs(merged);
  };

  const start = async (): Promise<void> => {
    if (!ready) return;
    const task = text.trim();
    setBusy(true);
    setError(null);
    const body = startBody(task, folder, speedModel(prefs.speed, models?.machine === machine ? (models.settings?.options ?? null) : null), takenNames);
    events.onStarting(body.title ?? task);
    try {
      const session = await machineApi(machine).createSession(body);
      setText('');
      choose({ machine, folders: folder ? { ...prefs.folders, [machineKey(machine)]: folder } : prefs.folders });
      events.onStarted(session);
      toast({ text: chosen ? HOME_WORDS.started(chosen.displayName) : HOME_WORDS.startedHere, actionLabel: HOME_WORDS.open, undo: () => navigate(`/agents/${encodeURIComponent(session.id)}`) });
    } catch (caught) {
      events.onFailed();
      setError(caught instanceof ApiError ? startErrorText(caught.status, caught.body) : startErrorText(0, null));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (event.shiftKey && !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void start();
  };

  const more = (kind: NewKind): void => openNew({ kind, text: text.trim() || undefined, machine });

  if (phone) {
    return (
      <form
        className="v2-home-pstart"
        data-testid="v2-start-box" data-tour="v2-start"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label className="v2-sr" htmlFor="v2-start-text">
          {HOME_WORDS.startLabel}
        </label>
        <textarea id="v2-start-text" rows={1} value={text} placeholder={HOME_WORDS.startPhonePlaceholder} onChange={(event) => setText(event.currentTarget.value)} onKeyDown={onKey} data-testid="v2-start-text" />
        <Button type="submit" variant="primary" aria-label={HOME_WORDS.startAgent} disabled={!ready} title={why} data-testid="v2-start-go" className="v2-home-pstart-go">
          <Icon name="sparkle" />
        </Button>
        {error ? (
          <p className="v2-home-start-error" role="alert" data-testid="v2-start-error">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <div className="v2-home-start" data-testid="v2-start-box" data-tour="v2-start">
      <label className="v2-sr" htmlFor="v2-start-text">
        {HOME_WORDS.startLabel}
      </label>
      <textarea id="v2-start-text" rows={2} value={text} placeholder={HOME_WORDS.startPlaceholder} onChange={(event) => setText(event.currentTarget.value)} onKeyDown={onKey} data-testid="v2-start-text" />
      <div className="v2-home-start-row">
        <label className="v2-home-picker" title={chosen?.path ?? HOME_WORDS.folder}>
          <Icon name="folder" size="s" />
          <span className="v2-sr">{HOME_WORDS.folder}</span>
          <select value={folder ?? ''} onChange={(event) => setFolder(event.currentTarget.value || null)} disabled={list === null || list.length === 0} data-testid="v2-start-folder">
            {list === null ? <option value="">…</option> : null}
            {list !== null && list.length === 0 ? <option value="">{HOME_WORDS.noFolder}</option> : null}
            {(list ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.displayName}
              </option>
            ))}
          </select>
          <Icon name="chev-down" size="s" />
        </label>
        {machines.length > 0 ? (
          <label className="v2-home-picker" title={HOME_WORDS.computer}>
            <Icon name="laptop" size="s" />
            <span className="v2-sr">{HOME_WORDS.computer}</span>
            <select value={machine ?? ''} onChange={(event) => choose({ machine: event.currentTarget.value || null })} data-testid="v2-start-computer">
              {computers.map((c) => (
                <option key={c.value} value={c.value} disabled={c.disabled}>
                  {c.label}
                </option>
              ))}
            </select>
            <Icon name="chev-down" size="s" />
          </label>
        ) : (
          <span className="v2-home-picker" title={HOME_WORDS.computer} data-testid="v2-start-computer-name">
            <Icon name="laptop" size="s" />
            {selfName}
          </span>
        )}
        <Segmented<Speed>
          label={HOME_WORDS.speed}
          size="s"
          value={prefs.speed}
          onChange={(speed) => choose({ speed })}
          options={[
            { value: 'smart', label: WORDS.modelSmart },
            { value: 'fast', label: WORDS.modelFast },
          ]}
          testId="v2-start-speed"
        />
        <span className="v2-grow" />
        <Button variant="ghost" size="sm" onClick={() => more('agent')} data-testid="v2-start-more">
          {HOME_WORDS.moreOptions}
        </Button>
        <Button variant="primary" icon="sparkle" kbd="⌘↩" disabled={!ready} title={why} onClick={() => void start()} data-testid="v2-start-go">
          {busy ? HOME_WORDS.starting : HOME_WORDS.startAgent}
        </Button>
      </div>
      {error ? (
        <p className="v2-home-start-error" role="alert" data-testid="v2-start-error">
          {error}
        </p>
      ) : null}
      <div className="v2-home-start-more" role="group" aria-label={HOME_WORDS.startSomethingElse}>
        {MORE.map(([kind, icon, label]) => (
          <button key={kind} type="button" className="v2-fchip" onClick={() => more(kind)} data-testid={`v2-start-${kind}`}>
            <Icon name={icon} size="s" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
