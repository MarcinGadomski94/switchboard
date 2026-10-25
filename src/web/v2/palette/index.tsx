import { useMemo, useState } from 'react';
import { themeStore } from '../../theme.ts';
import { Dialog, Icon, Kbd } from '../components/index.ts';
import { RAIL_LABELS, WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { openStore } from '../shared/open-store.ts';
import { openShortcuts } from '../shell/ShortcutsDialog.tsx';
import { modKey } from '../shell/shortcuts.ts';

const palette = openStore<{ readonly query: string }>();

/** D131 · opens the ⌘K palette (the shell binds ⌘K; the top bar's button too). */
export function openPalette(query = ''): void {
  palette.open({ query });
}

/** D131 · closes it. */
export function closePalette(): void {
  palette.close();
}

interface Command {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly hint?: string;
  readonly run: () => void;
}

/**
 * D131 · the ⌘K palette — a **stub** (lane R completes it: agents, messages,
 * results, settings, actions). It already goes to every page, searches
 * everything, lists the shortcuts and switches the theme. See `README.md`.
 */
export function Palette() {
  const state = palette.use();
  const { navigate } = useV2Router();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const go = (path: string) => () => navigate(path);
  const commands = useMemo<Command[]>(
    () => [
      { id: 'home', label: RAIL_LABELS.home, icon: 'home', run: go('/') },
      { id: 'needs', label: WORDS.needsYou, icon: 'hand', run: go('/needs-you') },
      { id: 'agents', label: RAIL_LABELS.agents, icon: 'agents', run: go('/agents') },
      { id: 'projects', label: RAIL_LABELS.projects, icon: 'projects', run: go('/projects') },
      { id: 'crews', label: RAIL_LABELS.crews, icon: 'crew', run: go('/crews') },
      { id: 'results', label: RAIL_LABELS.results, icon: 'results', run: go('/results') },
      { id: 'insights', label: WORDS.insights, icon: 'insights', run: go('/insights') },
      { id: 'settings', label: RAIL_LABELS.settings, icon: 'settings', run: go('/settings') },
      { id: 'shortcuts', label: WORDS.shortcuts, icon: 'cmd', hint: '?', run: () => openShortcuts() },
      { id: 'classic', label: 'Switch to the classic theme', icon: 'sliders', run: () => themeStore.choose('classic') },
    ],
    [navigate],
  );
  const q = query.trim().toLowerCase();
  const shown = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  const searchRow: Command | null = q ? { id: 'search', label: `Search everything for “${query.trim()}”`, icon: 'search', hint: modKey('⇧F'), run: () => navigate(`/search?q=${encodeURIComponent(query.trim())}`) } : null;
  const rows = searchRow ? [...shown, searchRow] : shown;
  const close = (): void => {
    palette.close();
    setQuery('');
    setSelected(0);
  };
  const run = (command: Command | undefined): void => {
    if (!command) return;
    close();
    command.run();
  };
  return (
    <Dialog open={state !== null} onClose={close} testId="v2-palette" labelledBy="v2-palette-input" width={620}>
      <input
        id="v2-palette-input"
        className="v2-field"
        data-autofocus=""
        aria-label="Search agents, messages, results, settings"
        placeholder="Search agents, messages, results, settings…"
        value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls="v2-palette-list"
        aria-activedescendant={rows[selected] ? `v2-cmd-${rows[selected].id}` : undefined}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelected((i) => Math.min(rows.length - 1, i + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelected((i) => Math.max(0, i - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            run(rows[selected]);
          }
        }}
        style={{ fontSize: 17, marginBottom: 8 }}
      />
      <div id="v2-palette-list" role="listbox" aria-label="Commands">
        {rows.map((command, index) => (
          <button
            key={command.id}
            id={`v2-cmd-${command.id}`}
            type="button"
            role="option"
            aria-selected={index === selected}
            className="v2-cmd"
            data-command={command.id}
            onMouseEnter={() => setSelected(index)}
            onClick={() => run(command)}
          >
            <Icon name={command.icon} size="s" />
            <span className="v2-grow">{command.label}</span>
            {command.hint ? <Kbd>{command.hint}</Kbd> : null}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
