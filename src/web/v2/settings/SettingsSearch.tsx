import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Icon, IconButton } from '../components/index.ts';
import { SETTINGS_WORDS as W } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { type SettingHit, helpExcerpt, markParts, searchSettings, settingById, settingPath, settingPlace } from './settings-index.ts';

/** How long a found row stays highlighted. */
export const SETTING_FLASH_MS = 2000;
/** How long the page waits for a row that loads late (a classic section reading its data). */
const FIND_ROW_MS = 6000;

/** The `?q=` of a Settings address (`''` without one). */
export function settingsQuery(search: string): string {
  return new URLSearchParams(search).get('q') ?? '';
}

/** Text with the query's words marked (plain text, never HTML). */
function Marked({ text, query }: { readonly text: string; readonly query: string }) {
  return (
    <>
      {markParts(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className="v2-set-mark">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Fix after 2.0 · the search at the top of v2 Settings: it finds single settings
 * (`settings-index.ts`) by their label, help text and other words. The query lives in
 * the address (`?q=`, replaced while typing, so Back returns to the results); ↑ / ↓
 * move, ↩ opens, Esc clears. Choosing a result opens its page with `?setting=<id>`
 * ({@link useSettingFlash} scrolls to the row and highlights it).
 */
export function SettingsSearch() {
  const { pathname, search, navigate } = useV2Router();
  const urlQuery = settingsQuery(search);
  const [text, setText] = useState(urlQuery);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Back / forward (or a link) changed the address: show its query.
  useEffect(() => {
    setText((current) => (current.trim() === urlQuery.trim() ? current : urlQuery));
  }, [urlQuery]);

  const query = text.trim();
  const hits = useMemo(() => searchSettings(query), [query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const write = (next: string): void => {
    setText(next);
    const q = next.trim();
    navigate(q ? `${pathname}?q=${encodeURIComponent(q)}` : pathname, { replace: true });
  };
  const open = (hit: SettingHit | undefined): void => {
    if (!hit) return;
    navigate(settingPath(hit.entry));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(hits.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open(hits[active]);
    } else if (event.key === 'Escape' && text !== '') {
      event.preventDefault();
      event.stopPropagation();
      write('');
    }
  };

  return (
    <div className="v2-set-search" data-testid="v2-settings-search">
      <div className="v2-set-search-box">
        <Icon name="search" size="s" />
        <input
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          className="v2-set-search-input"
          data-testid="v2-settings-search-input"
          aria-label={W.searchLabel}
          placeholder={W.searchPlaceholder}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={query !== ''}
          aria-controls="v2-settings-search-list"
          aria-activedescendant={query !== '' && hits[active] ? `v2-set-hit-${active}` : undefined}
          value={text}
          onChange={(event) => write(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {text !== '' ? (
          <IconButton
            icon="x"
            label={W.searchClear}
            data-testid="v2-settings-search-clear"
            onClick={() => {
              write('');
              inputRef.current?.focus();
            }}
          />
        ) : null}
      </div>
      {query !== '' ? (
        <div className="v2-set-results" data-testid="v2-settings-results">
          {hits.length === 0 ? (
            <EmptyState icon="search" tone="grey" title={W.searchNone(query)} text={W.searchNoneSub} testId="v2-settings-search-empty" />
          ) : (
            <>
              <p className="v2-muted v2-set-small v2-set-results-head" aria-live="polite">
                <span className="v2-grow">{W.searchCount(hits.length)}</span>
                <span className="v2-set-results-keys" aria-hidden="true">
                  {W.searchHint}
                </span>
              </p>
              <div id="v2-settings-search-list" role="listbox" aria-label={W.searchResults} ref={listRef} className="v2-set-hits">
                {hits.map((hit, index) => (
                  <div
                    key={hit.entry.id}
                    id={`v2-set-hit-${index}`}
                    role="option"
                    aria-selected={index === active}
                    className="v2-set-hit"
                    data-testid="v2-settings-hit"
                    data-setting={hit.entry.id}
                    onMouseMove={() => setActive(index)}
                    onClick={() => open(hit)}
                  >
                    <span className="v2-set-hit-label">
                      <Marked text={hit.entry.label} query={query} />
                    </span>
                    <span className="v2-set-hit-crumbs" data-testid="v2-settings-hit-crumbs">
                      {[...settingPlace(hit.entry), hit.entry.label].join(W.crumbSep)}
                    </span>
                    {hit.entry.help ? (
                      <span className="v2-muted v2-set-hit-help">
                        <Marked text={helpExcerpt(hit.entry.help, query)} query={query} />
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Fix after 2.0 · `?setting=<id>` on a Settings page (from the search or ⌘K): waits for
 * the row (classic sections load their data first), scrolls it into view and highlights
 * it for {@link SETTING_FLASH_MS} (no smooth scroll and no fade with reduced motion), then
 * drops `setting` from the address (Back still returns to the search).
 */
export function useSettingFlash(): void {
  const { pathname, search, navigate } = useV2Router();
  const id = new URLSearchParams(search).get('setting');
  useEffect(() => {
    const entry = settingById(id);
    if (!id) return undefined;
    const rest = new URLSearchParams(search);
    rest.delete('setting');
    const left = rest.toString();
    const done = (): void => navigate(left ? `${pathname}?${left}` : pathname, { replace: true });
    if (!entry) {
      done();
      return undefined;
    }
    const started = Date.now();
    let timer = 0;
    const find = (): void => {
      const element = document.querySelector<HTMLElement>(`[data-testid="v2-page-settings"] ${entry.anchor}`);
      if (element) {
        element.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        element.setAttribute('data-v2-flash', '');
        window.setTimeout(() => element.removeAttribute('data-v2-flash'), SETTING_FLASH_MS);
        done();
        return;
      }
      if (Date.now() - started > FIND_ROW_MS) {
        done();
        return;
      }
      timer = window.setTimeout(find, 100);
    };
    timer = window.setTimeout(find, 0);
    return () => window.clearTimeout(timer);
    // The address's `setting` starts it; the rest is read when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}
