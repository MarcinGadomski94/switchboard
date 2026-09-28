import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { useRouter } from '../router.tsx';
import { requestSolutionFocus } from '../views/solution-focus.ts';
import { useModals } from './ModalHost.tsx';
import { PALETTE_PLACEHOLDER, type PaletteEntry, clampIndex, filterPalette, moveIndex, paletteEntries } from './palette.ts';
import './palette.css';

/** `sessionUpdated` comes in bursts; the session results reload at most this often. */
const SESSIONS_RELOAD_MS = 1_000;

/** Id of the results list (the input's `aria-controls`). */
const RESULTS_ID = 'sb-palette-results';

/**
 * ⌘K / Ctrl+K palette (SPEC → Modals → Palette, M8.3): a 620px panel 110px from
 * the top with a 15px input and up to 10 results (kind label + label + hint).
 * It lists the views, "New session", the embedded tools, the sessions and the
 * solutions (`palette.ts`), the last three from `GET /api/tools`,
 * `GET /api/sessions` and `GET /api/solutions`. Typing filters and highlights
 * the first result, ↑ ↓ move the highlight, Enter or a click picks a result
 * (navigate, open the New-session modal, or open Solutions with that solution
 * selected) and closes the palette. Esc and a click on the overlay close it
 * (`ModalHost`); ⌘K / Ctrl+K while it is open clears the query, as reopening
 * does in the prototype.
 */
export function Palette({ onClose }: { readonly onClose: () => void }) {
  const { navigate } = useRouter();
  const { open } = useModals();
  const sessions = useApi(api.listSessions);
  const tools = useApi(api.tools);
  const solutions = useApi(api.solutions);
  useHubEvent('sessionUpdated', useThrottled(sessions.reload, SESSIONS_RELOAD_MS));

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(
    () => paletteEntries({ sessions: sessions.data, tools: tools.data, solutions: solutions.data }),
    [sessions.data, tools.data, solutions.data],
  );
  const results = useMemo(() => filterPalette(entries, query), [entries, query]);
  const selected = clampIndex(index, results.length);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        setQuery('');
        setIndex(0);
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const row = listRef.current?.children[selected];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
  }, [selected, results]);

  const pick = (entry: PaletteEntry): void => {
    const { target } = entry;
    if (target.type === 'new-session') {
      open('new-session');
      return;
    }
    onClose();
    if (target.type === 'solution') {
      requestSolutionFocus(target.path);
      navigate({ view: 'solutions' });
    } else {
      navigate(target.route);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex(moveIndex(selected, results.length, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      const entry = results[selected];
      if (entry) {
        event.preventDefault();
        pick(entry);
      }
    }
  };

  const optionId = (i: number): string => `sb-palette-option-${i}`;

  return (
    <div className="sb-overlay" data-modal="palette" onClick={onClose}>
      <div
        className="sb-modal-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Palette"
        data-testid="modal-palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="sb-palette-input"
          data-testid="palette-input"
          value={query}
          placeholder={PALETTE_PLACEHOLDER}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-label="Jump to"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={RESULTS_ID}
          aria-activedescendant={results.length ? optionId(selected) : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="sb-palette-results" id={RESULTS_ID} role="listbox" aria-label="Results" data-testid="palette-results" ref={listRef}>
          {results.map((entry, i) => (
            <div
              key={entry.key}
              id={optionId(i)}
              className="sb-palette-row"
              role="option"
              aria-selected={i === selected}
              data-testid="palette-row"
              data-kind={entry.kind}
              data-selected={i === selected || undefined}
              onClick={() => pick(entry)}
            >
              <span className="sb-palette-kind">{entry.kind}</span>
              <span className="sb-palette-label">{entry.label}</span>
              <span className="sb-palette-hint">{entry.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
