import { useCallback, useEffect, useRef, useState } from 'react';
import type { Folder, FolderCheck, FolderListing, Session } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import { type ApiState, useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { type CheckLine, type FolderOption, type FolderOwned, folderCheckLine, folderRefusal, folderTag, selectedOption, switcherOptions } from './folders.ts';

/**
 * "The saved folders changed" inside this page (D14): Settings → Folders, the
 * New-session form's Browse… and the wizard add, remove or re-default folders and
 * announce it, so every list that reads `GET /api/folders` (tags, switchers,
 * dropdowns) reloads. `/hub` has no folders event (contract); other tabs pick the
 * change up on their next load.
 */
const EVENT = 'switchboard:folders-changed';

/** Tells the page's listeners that the saved folders changed. */
export function announceFoldersChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** `GET /api/folders`, reloaded whenever {@link announceFoldersChanged} runs. */
export function useSavedFolders(): ApiState<Folder[]> {
  const folders = useApi(api.savedFolders);
  const reload = folders.reload;
  useEffect(() => {
    const listener = (): void => reload();
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [reload]);
  return folders;
}

/**
 * The folder tag of rows in a list that mixes folders (D14): `tagOf(row)` is the
 * row's folder name when it is not the default folder, else `null`
 * (`folderTag`). Reloads with the saved folders.
 */
export function useFolderTags(): (item: FolderOwned) => string | null {
  const folders = useSavedFolders();
  const list = folders.data;
  return useCallback((item: FolderOwned) => folderTag(item, list), [list]);
}

/** `sessionUpdated` comes in bursts; the session list behind the switcher reloads at most this often. */
const SESSIONS_RELOAD_MS = 1_000;

/** The `?folder=` of the current URL (`null` without one). */
function readFolderParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('folder');
  } catch {
    return null;
  }
}

/** Writes `?folder=` into the current URL (replacing the entry, so Back leaves the view); `null` removes it. */
function writeFolderParam(value: string | null): void {
  const search = new URLSearchParams(window.location.search);
  if (value) search.set('folder', value);
  else search.delete('folder');
  const query = search.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

/** The sessions of the page (`GET /api/sessions`), reloaded on `sessionUpdated` at most once a second. */
export function useSessionList(): ApiState<Session[]> {
  const sessions = useApi(api.listSessions);
  useHubEvent('sessionUpdated', useThrottled(sessions.reload, SESSIONS_RELOAD_MS));
  return sessions;
}

/** State of {@link useFolderSwitch}. */
export interface FolderSwitch {
  /** The switcher's entries (default first, other saved folders, folders only sessions use). */
  readonly options: readonly FolderOption[];
  /** The selected entry, `null` while the lists load (or for a value nothing matches). */
  readonly selected: FolderOption | null;
  /** What the API calls get as `?folder=`: the URL's value, `undefined` for the default folder. */
  readonly param: string | undefined;
  /** Selects an entry (the default folder's removes `?folder=` from the URL). */
  readonly select: (value: string) => void;
}

/**
 * The folder switcher of a view that shows one folder at a time (D14: Solutions,
 * the Codebase Memory strip). The selection lives in the URL (`?folder=<id or
 * path>`), so a reload keeps it; the options come from the saved folders and the
 * sessions (`docs/folders.md` → *UI*).
 */
export function useFolderSwitch(): FolderSwitch {
  const folders = useSavedFolders();
  const sessions = useSessionList();
  const [param, setParam] = useState<string | null>(readFolderParam);
  const options = switcherOptions(folders.data, sessions.data);
  const selected = selectedOption(options, param);
  const select = useCallback(
    (value: string) => {
      const option = options.find((candidate) => candidate.value === value);
      const next = option?.isDefault ? null : value;
      writeFolderParam(next);
      setParam(next);
    },
    [options],
  );
  return { options, selected, param: param ?? undefined, select };
}

/** How long the path field waits after typing before it checks the folder (ms), as the wizard (M5.3). */
export const CHECK_DELAY_MS = 250;

/** State of {@link useFolderPicker}. */
export interface FolderPicker {
  /** The path field. */
  readonly input: string;
  readonly setInput: (value: string) => void;
  /** The live check of the typed folder (`null` for an empty field or before the first answer). */
  readonly check: FolderCheck | null;
  /** The check line of {@link check}. */
  readonly line: CheckLine | null;
  /** The Browse… listing on screen, `null` while hidden. */
  readonly listing: FolderListing | null;
  /** Shows the listing of the typed folder (else the default folder, else home), or hides it. */
  readonly toggleBrowse: () => void;
  /** Shows the listing of `target` and puts it in the field (a click on a folder, `../`). */
  readonly openFolder: (target?: string) => void;
  /** Adds the typed folder (`POST /api/folders`); the saved folder, or `null` when it was refused. */
  readonly add: () => Promise<Folder | null>;
  /** Why the last add or listing failed, the server's words; `null` when none did. */
  readonly error: string | null;
  readonly setError: (error: string | null) => void;
  readonly adding: boolean;
}

/**
 * The folder picker every "add a folder" place shares (D14): the setup wizard's
 * "Add your first folder", Settings → Folders → Add…, the New-session form's
 * Browse…. A path field checked live (`GET /api/folders/check`, 250 ms after
 * typing), Browse… over `GET /api/setup/folders` (the typed folder's listing,
 * else the default folder, else home; a click moves into a folder and puts it in
 * the field), and Add (`POST /api/folders`: a refused folder is not added and its
 * reason stays in {@link FolderPicker.error}). The markup is each place's own.
 */
export function useFolderPicker(options: { readonly initial?: string; readonly browseOnStart?: boolean } = {}): FolderPicker {
  const [input, setInputState] = useState(options.initial ?? '');
  const [check, setCheck] = useState<FolderCheck | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const setInput = useCallback((value: string) => {
    setInputState(value);
    setError(null);
  }, []);

  // The field is checked a moment after typing stops.
  useEffect(() => {
    const typed = input.trim();
    if (!typed) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.checkFolder(typed).then(
        (result) => {
          if (!cancelled) setCheck(result);
        },
        () => undefined,
      );
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input]);

  const openFolder = useCallback((target?: string): void => {
    api.folders(target).then(
      (result) => {
        if (!mounted.current) return;
        setListing(result);
        if (target !== undefined) {
          setInputState(result.path);
          setError(null);
        }
      },
      (caught: unknown) => {
        if (!mounted.current) return;
        // A typed folder that is not there: start from the default folder instead.
        if (target !== undefined && caught instanceof ApiError && caught.status === 404) openFolder(undefined);
        else setError(caught instanceof ApiError ? folderRefusal(caught.status, caught.body) : String(caught));
      },
    );
  }, []);

  const browseFrom = useCallback(
    (typed: string): void => {
      api.folders(typed || undefined).then(
        (result) => {
          if (mounted.current) setListing(result);
        },
        (caught: unknown) => {
          if (!mounted.current) return;
          if (typed && caught instanceof ApiError && caught.status === 404) openFolder(undefined);
          else setError(caught instanceof ApiError ? folderRefusal(caught.status, caught.body) : String(caught));
        },
      );
    },
    [openFolder],
  );

  const toggleBrowse = useCallback((): void => {
    if (listing) {
      setListing(null);
      return;
    }
    setError(null);
    browseFrom(input.trim());
  }, [listing, input, browseFrom]);

  useEffect(() => {
    if (options.browseOnStart) browseFrom((options.initial ?? '').trim());
    // Only when the picker opens.
  }, []);

  const add = useCallback(async (): Promise<Folder | null> => {
    const typed = input.trim();
    if (!typed) {
      setError('enter a folder path');
      return null;
    }
    setAdding(true);
    setError(null);
    try {
      const folder = await api.addFolder(typed);
      announceFoldersChanged();
      if (mounted.current) {
        setInputState(folder.path);
        setCheck(folder.check);
      }
      return folder;
    } catch (caught) {
      if (mounted.current) setError(caught instanceof ApiError ? folderRefusal(caught.status, caught.body) : String(caught));
      return null;
    } finally {
      if (mounted.current) setAdding(false);
    }
  }, [input]);

  return { input, setInput, check: input.trim() ? check : null, line: folderCheckLine(input.trim() ? check : null), listing, toggleBrowse, openFolder, add, error, setError, adding };
}
