import { Button, Chip, Icon, IconButton, Kbd } from '../components/index.ts';
import { WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { openNew } from '../new/index.tsx';
import { openPalette } from '../palette/index.tsx';
import { StatusPill } from './StatusPill.tsx';
import { openShortcuts } from './ShortcutsDialog.tsx';
import { APPLE, modKey } from './shortcuts.ts';
import type { StatusPill as Pill } from './status-model.ts';

/**
 * D131 · the top bar (the prototype's `.topbar`): Search (⌘K: the palette; the
 * magnifier: the Search page, ⌘⇧F), the shortcuts list, a computer that is
 * offline or reconnecting, the status pill, Needs you with its count, + New. On a
 * phone: the brand, the pill (usage only), the palette (⌘K), Search and + New
 * (the tabs hold the rest).
 */
export function TopBar({ pill, needs, phone }: { readonly pill: Pill; readonly needs: number; readonly phone: boolean }) {
  const { navigate } = useV2Router();
  const away = pill.away[0];
  if (phone) {
    return (
      <header className="v2-topbar" data-phone="" data-testid="v2-topbar">
        <div className="v2-brand" style={{ padding: 0 }}>
          <div className="v2-brand-mark" aria-hidden="true">
            <Icon name="sparkle" size="s" />
          </div>
          <span>Switchboard</span>
        </div>
        <span className="v2-grow" />
        <StatusPill pill={pill} compact />
        <IconButton icon="cmd" label={`${WORDS.quickOpen} (${modKey('K')})`} size="l" onClick={() => openPalette()} data-testid="v2-palette-open" />
        <IconButton icon="search" label={WORDS.searchEverything} size="l" onClick={() => navigate('/search')} data-testid="v2-search-open" />
        <IconButton icon="plus" label="New" size="l" onClick={() => openNew({ kind: 'agent' })} data-testid="v2-new" />
      </header>
    );
  }
  return (
    <header className="v2-topbar" data-testid="v2-topbar">
      <button type="button" className="v2-search-btn" onClick={() => openPalette()} aria-label={`${WORDS.searchPlaceholder} (${modKey('K')})`} data-testid="v2-palette-open">
        <Icon name="search" size="s" />
        <span className="v2-search-text">{WORDS.searchPlaceholder}</span>
        <Kbd>{modKey('K')}</Kbd>
      </button>
      <IconButton icon="search" iconSize="s" label={`${WORDS.searchEverything} (${APPLE ? '⌘⇧F' : 'Ctrl Shift F'})`} onClick={() => navigate('/search')} data-testid="v2-search-open" />
      <IconButton icon="cmd" iconSize="s" label={`${WORDS.shortcuts} (?)`} onClick={() => openShortcuts()} data-testid="v2-shortcuts-open" />
      <span className="v2-grow" />
      {away ? (
        <Chip tone={away.state === 'offline' ? 'grey' : 'amber'} icon={away.state === 'offline' ? 'offline' : 'refresh'} className="v2-away" title={away.detail}>
          {away.state === 'offline' ? `${away.name} offline` : `Reconnecting to ${away.name}…`}
        </Chip>
      ) : null}
      <StatusPill pill={pill} />
      <IconButton icon="bell" label={needs > 0 ? `${WORDS.needsYou}: ${needs}` : WORDS.needsYou} badge={needs} onClick={() => navigate('/needs-you')} data-testid="v2-needs-button" data-tour="v2-needs" />
      <Button variant="primary" icon="plus" onClick={() => openNew({ kind: 'agent' })} data-testid="v2-new">
        {WORDS.newThing}
      </Button>
    </header>
  );
}
