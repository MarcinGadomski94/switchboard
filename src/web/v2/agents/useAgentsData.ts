import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionListItem } from '../../../core/api.ts';
import { type ComposerDraft, type NewSessionDraft, type SessionDraft, draftField } from '../../../core/drafts.ts';
import type { MachinesView } from '../../../core/peers.ts';
import { EMPTY_SIDEBAR_LAYOUT, type SidebarLayout } from '../../../core/sidebar-layout.ts';
import type { TeamSummary } from '../../../core/team.ts';
import { api } from '../../api/client.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { onHubEvent, useHubEvent } from '../../api/useHub.ts';
import { usePlans } from '../../plans/store.ts';
import { teamApi } from '../../team/api.ts';
import { untouchedTeams } from '../../team/sidebar-roster.ts';
import { useNeedsYou } from '../shared/needs-you.ts';
import { type AgentEntry, PREF_KEYS, buildAgents } from './agents-model.ts';
import { type AgentTree, buildTree } from './tree-model.ts';

/**
 * D131 · lane A · the Agents page's data, live: the shared session list (this
 * computer's and the paired ones', `/hub`), the sidebar layout (D54/D58/D71,
 * `sidebarLayoutChanged`), the crews (`/api/team/teams`, `teamChanged`), the
 * projects (the plans store, `planChanged`), the Needs-you store, the composer
 * drafts (D88, `draftChanged`) and this browser's "seen" marks (unread).
 */

/** Reads a per-browser preference. */
export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores a per-browser preference. */
export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // No storage: the choice lasts until the page closes.
  }
}

/** A remembered choice (localStorage), validated by `is`. */
export function usePref<T extends string>(key: string, fallback: T, is: (value: unknown) => value is T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = readPref(key);
    return is(stored) ? stored : fallback;
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writePref(key, next);
    },
    [key],
  );
  return [value, set];
}

/** The sidebar layout, live; `apply` sets the layout an action answered with (no wait for the hub). */
export function useLayoutState(): { readonly layout: SidebarLayout; readonly loaded: boolean; readonly apply: (layout: SidebarLayout) => void; readonly reload: () => void } {
  const [layout, setLayout] = useState<SidebarLayout>(EMPTY_SIDEBAR_LAYOUT);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(() => {
    api.sidebarLayout().then(
      (next) => {
        setLayout(next);
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, []);
  useEffect(reload, [reload]);
  useHubEvent('sidebarLayoutChanged', reload);
  return { layout, loaded, apply: setLayout, reload };
}

/** The crews (teams) with their rosters, live. */
export function useTeams(): readonly TeamSummary[] {
  const [teams, setTeams] = useState<readonly TeamSummary[]>([]);
  const reload = useCallback(() => {
    // G4: the untouched first crew (default name, no teammate) is left out, as in the classic sidebar.
    teamApi.teams().then((list) => setTeams(untouchedTeams(list) ? [] : list), () => undefined);
  }, []);
  useEffect(reload, [reload]);
  useHubEvent('teamChanged', reload);
  return teams;
}

function composerText(drafts: readonly SessionDraft[]): string | null {
  const composer = drafts.find((draft) => draft.field === draftField.composer);
  const text = (composer?.value as ComposerDraft | undefined)?.text?.trim();
  return text ? text : null;
}

/** The composer drafts of the listed agents (D88), by session id; refreshed per session on `draftChanged`. */
export function useComposerDrafts(sessions: readonly SessionListItem[]): Readonly<Record<string, string>> {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const asked = useRef(new Set<string>());
  const fetchOne = useCallback((id: string) => {
    api.sessionDrafts(id).then(
      (list) =>
        setDrafts((now) => {
          const text = composerText(list);
          if ((now[id] ?? null) === text) return now;
          const next = { ...now };
          if (text) next[id] = text;
          else delete next[id];
          return next;
        }),
      () => undefined,
    );
  }, []);
  const ids = useMemo(() => sessions.filter((session) => !session.closedAt && !(session.machine && session.machine.state !== 'online')).map((session) => session.id), [sessions]);
  useEffect(() => {
    const fresh = ids.filter((id) => !asked.current.has(id));
    for (const id of fresh) asked.current.add(id);
    // A few at a time: one small read per agent.
    let index = 0;
    let cancelled = false;
    const next = (): void => {
      if (cancelled) return;
      const id = fresh[index++];
      if (id === undefined) return;
      api.sessionDrafts(id).then(
        (list) => {
          const text = composerText(list);
          if (text) setDrafts((now) => ({ ...now, [id]: text }));
          next();
        },
        () => next(),
      );
    };
    for (let i = 0; i < 4; i += 1) next();
    return () => {
      cancelled = true;
    };
  }, [ids]);
  useEffect(
    () =>
      onHubEvent('draftChanged', (change) => {
        if (change.sessionId && change.field === draftField.composer) fetchOne(change.sessionId);
      }),
    [fetchOne],
  );
  return drafts;
}

/** A New-agent draft kept on this computer (the + New form's, D88 ruling). */
export interface NewDraft {
  readonly text: string;
  readonly name: string | null;
  readonly updatedAt: string;
}

/** This computer's own New-agent draft, live. */
export function useNewDraft(): { readonly draft: NewDraft | null; readonly remove: () => Promise<void> } {
  const [draft, setDraft] = useState<NewDraft | null>(null);
  const reload = useCallback(() => {
    api.machineDrafts().then(
      (list) => {
        const own = list.find((item) => item.field === draftField.newSession);
        const form = (own?.value as NewSessionDraft | undefined)?.form ?? null;
        const text = typeof form?.['task'] === 'string' ? form['task'].trim() : '';
        const name = typeof form?.['name'] === 'string' && form['name'].trim() ? form['name'].trim() : null;
        setDraft(own && (text || name) ? { text, name, updatedAt: own.updatedAt } : null);
      },
      () => undefined,
    );
  }, []);
  useEffect(reload, [reload]);
  useEffect(
    () =>
      onHubEvent('draftChanged', (change) => {
        if (change.sessionId === null) reload();
      }),
    [reload],
  );
  const remove = useCallback(async () => {
    await api.deleteMachineDraft(draftField.newSession);
    setDraft(null);
  }, []);
  return { draft, remove };
}

function readSeen(): Record<string, string> {
  try {
    const parsed = JSON.parse(readPref(PREF_KEYS.seen) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** This browser's "seen" marks (unread = new activity since), and `markSeen` (opening an agent from here marks it). */
export function useSeen(): { readonly seen: Readonly<Record<string, string>>; readonly baseline: string; readonly markSeen: (id: string) => void } {
  const [seen, setSeen] = useState<Record<string, string>>(readSeen);
  const [baseline] = useState(() => {
    const stored = readPref(PREF_KEYS.baseline);
    if (stored) return stored;
    const now = new Date().toISOString();
    writePref(PREF_KEYS.baseline, now);
    return now;
  });
  const markSeen = useCallback((id: string) => {
    setSeen((now) => {
      const next = { ...now, [id]: new Date().toISOString() };
      // Keep the newest 500 marks.
      const keys = Object.keys(next);
      if (keys.length > 500) for (const key of keys.sort((a, b) => Date.parse(next[a] ?? '') - Date.parse(next[b] ?? '')).slice(0, keys.length - 500)) delete next[key];
      writePref(PREF_KEYS.seen, JSON.stringify(next));
      return next;
    });
  }, []);
  return { seen, baseline, markSeen };
}

/** The paired computers' names and whether the layout is shared with them (D71). */
export function useSharing(): { readonly self: string; readonly shared: readonly string[]; readonly paired: number } {
  const [view, setView] = useState<MachinesView | null>(null);
  const reload = useCallback(() => {
    api.machines().then(setView, () => undefined);
  }, []);
  useEffect(reload, [reload]);
  useHubEvent('machineState', reload);
  return useMemo(() => {
    const machines = view?.machines ?? [];
    return { self: view?.self.name ?? 'This computer', shared: machines.filter((machine) => machine.sidebarSync?.enabled).map((machine) => machine.name), paired: machines.length };
  }, [view]);
}

/** Everything the Agents page shows, live. */
export interface AgentsData {
  readonly loaded: boolean;
  readonly agents: readonly AgentEntry[];
  readonly tree: AgentTree;
  readonly layout: SidebarLayout;
  readonly applyLayout: (layout: SidebarLayout) => void;
  readonly reloadLayout: () => void;
  readonly teams: readonly TeamSummary[];
  readonly plans: ReturnType<typeof usePlans>['plans'];
  readonly markSeen: (id: string) => void;
  readonly sessions: readonly SessionListItem[];
}

/** The Agents page's data hook. */
export function useAgentsData(): AgentsData {
  const sessions = useSessionListOf();
  const { layout, loaded: layoutLoaded, apply, reload } = useLayoutState();
  const teams = useTeams();
  const { plans } = usePlans();
  const { items } = useNeedsYou();
  const list = sessions.data ?? [];
  const drafts = useComposerDrafts(list);
  const { seen, baseline, markSeen } = useSeen();
  const agents = useMemo(() => buildAgents({ sessions: list, needs: items, teams, plans, drafts, seen, baseline }), [list, items, teams, plans, drafts, seen, baseline]);
  const tree = useMemo(() => buildTree(layout, agents, teams), [layout, agents, teams]);
  const loaded = sessions.data !== null && layoutLoaded;
  return { loaded, agents, tree, layout, applyLayout: apply, reloadLayout: reload, teams, plans, markSeen, sessions: list };
}
