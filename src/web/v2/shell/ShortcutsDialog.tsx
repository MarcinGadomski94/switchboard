import { Dialog, Kbd } from '../components/index.ts';
import { WORDS } from '../glossary.ts';
import { openStore } from '../shared/open-store.ts';
import { shortcutList } from './shortcuts.ts';

const shortcuts = openStore<true>();

/** D131 · opens the shortcuts list (`?`, the top bar's ⌘ button, the palette). */
export function openShortcuts(): void {
  shortcuts.open(true);
}

/** D131 · the keyboard shortcuts list (the prototype's). The shell renders it once. */
export function ShortcutsDialog() {
  const open = shortcuts.use() !== null;
  return (
    <Dialog open={open} onClose={shortcuts.close} title={WORDS.shortcuts} icon="cmd" testId="v2-shortcuts" width={520}>
      <div className="v2-card" role="list">
        {shortcutList().map((line) => (
          <div key={line.what} role="listitem" className="v2-shortcut-row">
            <Kbd className="v2-shortcut-keys">{line.keys}</Kbd>
            <span className="v2-grow">{line.what}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
