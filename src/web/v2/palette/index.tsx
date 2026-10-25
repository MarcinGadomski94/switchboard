import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactListItem } from '../../../core/api.ts';
import type { Plan } from '../../../core/plans.ts';
import type { SearchAnswer } from '../../../core/search.ts';
import type { TeamSummary } from '../../../core/team.ts';
import { api } from '../../api/client.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { plansApi } from '../../plans/api.ts';
import { teamApi } from '../../team/api.ts';
import { themeStore } from '../../theme.ts';
import { SEARCH_DEBOUNCE_MS, plainText } from '../../views/search-view.ts';
import { Dialog, Icon, Kbd, useToast } from '../components/index.ts';
import { PALETTE_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { openNew, type NewKind } from '../new/index.tsx';
import { setScheme } from '../scheme.ts';
import { openStore } from '../shared/open-store.ts';
import { timeAgo } from '../shared/time.ts';
import { openShortcuts } from '../shell/ShortcutsDialog.tsx';
import { replayV2Tours } from '../tour/TourHost.tsx';
import { modKey } from '../shell/shortcuts.ts';
import { type PaletteRow, actionRows, agentRow, hitPath, isTaskPrefix, pageRows, quickTaskAgent, quickTaskTitle, rankRows, resultPath, searchRow } from './palette-model.ts';
import './palette.css';

const palette = openStore<{ readonly query: string }>();
const P = PALETTE_WORDS;

/** D131 · opens the ⌘K palette (the shell binds ⌘K; the top bar's button too). */
export function openPalette(query = ''): void {
  palette.open({ query });
}

/** D131 · closes it. */
export function closePalette(): void {
  palette.close();
}

/**
 * D131 · lane R · the ⌘K palette (`docs/design/v2-prototype.html` → `#m-cmdk`):
 * jump to any page, agent (this computer's and the paired ones'), project, crew or
 * result; the messages that match (D97 search); actions (New …, `task …` quick
 * capture, Search everything for "…", the theme and light / dark, shortcuts,
 * tours, routines). ↑↓ move, ↩ opens, Esc closes. Ranking is `palette-model.ts`.
 */
export function Palette() {
  const state = palette.use();
  if (state === null) return null;
  return <PaletteBody initial={state.query} />;
}

function PaletteBody({ initial }: { readonly initial: string }) {
  const { navigate, route } = useV2Router();
  const toast = useToast();
  const [query, setQuery] = useState(initial);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sessions = useSessionListOf();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [crews, setCrews] = useState<TeamSummary[]>([]);
  const [results, setResults] = useState<ArtifactListItem[]>([]);
  const [found, setFound] = useState<{ readonly q: string; readonly answer: SearchAnswer } | null>(null);

  useEffect(() => {
    let live = true;
    plansApi.list().then((list) => live && setPlans(list), () => undefined);
    teamApi.teams().then((list) => live && setCrews(list), () => undefined);
    api.artifacts().then((list) => live && setResults(list), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  const q = query.trim();
  const taskTitle = quickTaskTitle(query);
  // D97: the messages that match, once the query has two characters (not while capturing a task).
  useEffect(() => {
    if (q.length < 2 || taskTitle !== null) return undefined;
    let live = true;
    const timer = window.setTimeout(() => {
      api.search({ q, scope: 'conversations', limit: 5 }).then(
        (answer) => live && setFound({ q, answer }),
        () => undefined,
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q, taskTitle]);

  const currentAgent = route.area === 'agent' ? route.id : null;
  const taskAgent = quickTaskAgent(sessions.data, currentAgent);
  const taskAgentName = taskAgent ? (taskAgent.displayTitle ?? taskAgent.title ?? taskAgent.name) : '';

  const rows = useMemo<PaletteRow[]>(() => {
    if (taskTitle !== null) {
      return [{ id: 'quick-task', group: 'quick', icon: 'task', label: P.addTask(taskTitle), hint: taskAgent ? P.addTaskTo(taskAgentName) : P.noAgentForTask, action: { run: 'quick-task', arg: taskTitle } }];
    }
    const agents = (sessions.data ?? []).filter((s) => !s.closedAt).map(agentRow);
    const actions = actionRows();
    if (isTaskPrefix(query)) return actions.filter((row) => row.id === 'action:task-prefix');
    if (q === '') {
      const recent = [...agents].sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0)).slice(0, 4);
      return rankRows([...recent, ...actions], '');
    }
    const projectRows: PaletteRow[] = plans.map((plan) => ({ id: `project:${plan.id}`, group: 'agents', icon: 'projects', label: plan.title, hint: P.project, keywords: 'project plan', action: { go: `/projects/${encodeURIComponent(plan.id)}` } }));
    const crewRows: PaletteRow[] = crews.map((crew) => ({ id: `crew:${crew.id}`, group: 'agents', icon: 'crew', label: crew.name, hint: P.crew, keywords: 'crew team', action: { go: `/crews/${encodeURIComponent(crew.id)}` } }));
    const resultRows: PaletteRow[] = results.map((item) => ({
      id: `result:${item.machine?.id ?? ''}:${item.id}`,
      group: 'results',
      icon: 'results',
      label: item.title,
      hint: [item.sessionTitle ?? item.sessionName, item.machine?.name].filter(Boolean).join(' · ') || P.result,
      keywords: `result file ${item.kind}`,
      recency: Date.parse(item.updatedAt) || 0,
      action: { go: resultPath(item.id, item.sessionId, item.machine?.id) },
    }));
    const messages: PaletteRow[] =
      found && found.q === q
        ? found.answer.groups.flatMap((group) =>
            group.results
              .filter((hit) => hit.target.type === 'event')
              .map((hit) => ({
                id: `message:${hit.id}`,
                group: 'messages' as const,
                icon: 'chat',
                label: `“${plainText(hit.snippet).trim()}”`,
                hint: [hit.sessionTitle, hit.detail, timeAgo(hit.ts), hit.machine?.name].filter(Boolean).join(' · '),
                keywords: q,
                action: { go: hitPath(hit.target, hit.machine?.id) },
              })),
          )
        : [];
    const ranked = rankRows([...messages.slice(0, 3), ...agents, ...projectRows, ...crewRows, ...resultRows, ...pageRows(), ...actions], q, 11);
    return [...ranked, searchRow(q)];
  }, [taskTitle, taskAgent, taskAgentName, sessions.data, q, query, plans, crews, results, found]);

  useEffect(() => {
    setSelected((index) => Math.min(index, Math.max(0, rows.length - 1)));
  }, [rows.length]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = (): void => palette.close();

  const run = async (row: PaletteRow | undefined): Promise<void> => {
    if (!row || busy) return;
    const action = row.action;
    if ('go' in action) {
      close();
      navigate(action.go);
      return;
    }
    switch (action.run) {
      case 'quick-task': {
        if (!taskAgent || !action.arg) return;
        const title = action.arg;
        setBusy(true);
        try {
          await api.captureTodo(taskAgent.id, { title, from: 'palette' });
          close();
          toast({ text: P.taskAdded(title, taskAgentName), undo: () => navigate('/tasks'), actionLabel: 'Show' });
        } catch (error) {
          toast({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
        } finally {
          setBusy(false);
        }
        return;
      }
      case 'task-prefix':
        setQuery('task ');
        setSelected(0);
        return;
      case 'new':
        close();
        openNew({ kind: (action.arg ?? 'agent') as NewKind });
        return;
      case 'search':
        close();
        navigate('/search');
        return;
      case 'theme-classic':
        close();
        themeStore.choose('classic');
        return;
      case 'scheme':
        close();
        setScheme((action.arg ?? 'system') as Parameters<typeof setScheme>[0]);
        return;
      case 'shortcuts':
        close();
        openShortcuts();
        return;
      case 'replay-tour':
        close();
        if (action.arg) replayV2Tours([action.arg]);
        return;
      default:
        close();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((i) => Math.min(rows.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void run(rows[selected]);
    }
  };

  let lastGroup: string | null = null;
  return (
    <Dialog open onClose={close} testId="v2-palette" labelledBy="v2-palette-input" width={620}>
      <div className="v2-cmdk">
        <input
          id="v2-palette-input"
          className="v2-cmdk-input"
          data-autofocus=""
          aria-label={P.label}
          placeholder={P.placeholder}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="v2-palette-list"
          aria-activedescendant={rows[selected] ? `v2-cmd-${selected}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div id="v2-palette-list" role="listbox" aria-label={P.commands} ref={listRef} className="v2-cmdk-list">
          {rows.length === 0 ? (
            <p className="v2-muted v2-cmdk-empty" data-testid="v2-palette-empty">
              {P.nothing}
            </p>
          ) : null}
          {rows.map((row, index) => {
            const heading = row.group !== lastGroup ? P.groups[row.group] : null;
            lastGroup = row.group;
            return (
              <div key={row.id} role="presentation">
                {heading ? (
                  <h4 className="v2-cmdk-group" role="presentation">
                    {heading}
                  </h4>
                ) : null}
                <button
                  id={`v2-cmd-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  className="v2-cmd"
                  data-command={row.id}
                  data-group={row.group}
                  aria-disabled={row.id === 'quick-task' && !taskAgent ? true : undefined}
                  onMouseMove={() => setSelected(index)}
                  onClick={() => void run(row)}
                >
                  <Icon name={row.icon} size="s" />
                  <span className="v2-grow v2-cmd-label">{row.label}</span>
                  {row.hint ? <small className="v2-cmd-hint">{row.hint}</small> : null}
                </button>
              </div>
            );
          })}
        </div>
        <div className="v2-cmdk-foot" aria-hidden="true">
          <span>
            <Kbd>↑↓</Kbd> {P.hintMove}
          </span>
          <span>
            <Kbd>↩</Kbd> {P.hintOpen}
          </span>
          <span>
            <Kbd>{modKey('⇧F')}</Kbd> {P.hintSearch}
          </span>
          <span>
            <Kbd>Esc</Kbd> {P.hintClose}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
