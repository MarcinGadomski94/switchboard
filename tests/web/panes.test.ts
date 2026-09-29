import { describe, expect, it } from 'vitest';
import {
  PANES_SHOWN,
  type PanePress,
  type PaneShortcutContext,
  isHidden,
  isTextEntry,
  loadPaneStateFrom,
  paneControlCopy,
  paneForShortcut,
  panePatch,
  paneShortcutLabel,
  paneStateFromSettings,
  withPane,
} from '../../src/web/shell/panes.ts';

/** D41 (docs/panes.md): the pane state, its settings, the controls' copy and the shortcut rules. */

function press(key: string, init: Partial<PanePress> = {}): PanePress {
  return {
    key,
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    ...init,
  };
}

const IN_SESSION: PaneShortcutContext = { typing: false, modalOpen: false, rightPanel: true };
const ELSEWHERE: PaneShortcutContext = { typing: false, modalOpen: false, rightPanel: false };

describe('pane state (D41)', () => {
  it('both panes are shown by default and when the settings store nothing or a mistyped value', () => {
    expect(PANES_SHOWN).toEqual({ sidebarHidden: false, rightPanelHidden: false });
    expect(paneStateFromSettings(null)).toEqual(PANES_SHOWN);
    expect(paneStateFromSettings({})).toEqual(PANES_SHOWN);
    expect(paneStateFromSettings({ 'ui.sidebarHidden': 'yes', 'ui.rightPanelHidden': 1 })).toEqual(PANES_SHOWN);
  });

  it('reads the stored state of each pane', () => {
    expect(paneStateFromSettings({ 'ui.sidebarHidden': true, 'ui.rightPanelHidden': false, 'sessions.worktrees': true })).toEqual({ sidebarHidden: true, rightPanelHidden: false });
    expect(paneStateFromSettings({ 'ui.rightPanelHidden': true })).toEqual({ sidebarHidden: false, rightPanelHidden: true });
  });

  it('withPane changes one pane and keeps the object when nothing changes', () => {
    const hidden = withPane(PANES_SHOWN, 'sidebar', true);
    expect(hidden).toEqual({ sidebarHidden: true, rightPanelHidden: false });
    expect(isHidden(hidden, 'sidebar')).toBe(true);
    expect(isHidden(hidden, 'rightPanel')).toBe(false);
    expect(withPane(hidden, 'sidebar', true)).toBe(hidden);
    expect(withPane(hidden, 'rightPanel', true)).toEqual({ sidebarHidden: true, rightPanelHidden: true });
    expect(withPane(hidden, 'sidebar', false)).toEqual(PANES_SHOWN);
  });

  it('the first paint waits for the stored state; a failed or late answer shows both panes', async () => {
    expect(await loadPaneStateFrom(async () => ({ 'ui.sidebarHidden': true, 'ui.rightPanelHidden': true }))).toEqual({ sidebarHidden: true, rightPanelHidden: true });
    expect(await loadPaneStateFrom(() => Promise.reject(new Error('401')))).toEqual(PANES_SHOWN);
    const started = Date.now();
    const never = () => new Promise<Record<string, unknown>>(() => undefined);
    expect(await loadPaneStateFrom(never, 30)).toEqual(PANES_SHOWN);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('panePatch stores one pane under its own setting', () => {
    expect(panePatch('sidebar', true)).toEqual({ 'ui.sidebarHidden': true });
    expect(panePatch('rightPanel', false)).toEqual({ 'ui.rightPanelHidden': false });
  });
});

describe('pane controls copy (D41)', () => {
  it('names the shortcut the platform way', () => {
    expect(paneShortcutLabel('sidebar', true)).toBe('⌘B');
    expect(paneShortcutLabel('rightPanel', true)).toBe('⌥⌘B');
    expect(paneShortcutLabel('sidebar', false)).toBe('Ctrl+B');
    expect(paneShortcutLabel('rightPanel', false)).toBe('Ctrl+Alt+B');
  });

  it('labels and tooltips of the hide buttons and the reveal handles', () => {
    expect(paneControlCopy('sidebar', 'hide', true)).toEqual({ label: 'Hide sidebar', tooltip: 'Hide sidebar (⌘B)' });
    expect(paneControlCopy('sidebar', 'show', true)).toEqual({ label: 'Show sidebar', tooltip: 'Show sidebar (⌘B)' });
    expect(paneControlCopy('rightPanel', 'hide', true)).toEqual({ label: 'Hide panel', tooltip: 'Hide panel (⌥⌘B)' });
    expect(paneControlCopy('rightPanel', 'show', false)).toEqual({ label: 'Show panel', tooltip: 'Show panel (Ctrl+Alt+B)' });
  });
});

describe('pane shortcuts (D41)', () => {
  it('⌘B and Ctrl+B toggle the sidebar, in any view', () => {
    expect(paneForShortcut(press('b', { metaKey: true }), ELSEWHERE)).toBe('sidebar');
    expect(paneForShortcut(press('b', { ctrlKey: true }), ELSEWHERE)).toBe('sidebar');
    expect(paneForShortcut(press('B', { metaKey: true }), IN_SESSION)).toBe('sidebar');
  });

  it('⌥⌘B and Ctrl+Alt+B toggle the right panel, only in the session view', () => {
    expect(paneForShortcut(press('b', { metaKey: true, altKey: true }), IN_SESSION)).toBe('rightPanel');
    expect(paneForShortcut(press('b', { ctrlKey: true, altKey: true }), IN_SESSION)).toBe('rightPanel');
    // macOS: ⌥ turns B into ∫; the physical key still counts.
    expect(paneForShortcut(press('∫', { metaKey: true, altKey: true, code: 'KeyB' }), IN_SESSION)).toBe('rightPanel');
    expect(paneForShortcut(press('b', { metaKey: true, altKey: true }), ELSEWHERE)).toBeNull();
  });

  it('never while typing in a text field or while a modal is open', () => {
    expect(paneForShortcut(press('b', { metaKey: true }), { ...IN_SESSION, typing: true })).toBeNull();
    expect(paneForShortcut(press('b', { metaKey: true, altKey: true }), { ...IN_SESSION, typing: true })).toBeNull();
    expect(paneForShortcut(press('b', { ctrlKey: true }), { ...ELSEWHERE, modalOpen: true })).toBeNull();
  });

  it('ignores other keys and modifiers, repeats, IME composition and keys another handler took', () => {
    expect(paneForShortcut(press('b'), IN_SESSION)).toBeNull();
    expect(paneForShortcut(press('b', { altKey: true }), IN_SESSION)).toBeNull();
    expect(paneForShortcut(press('b', { metaKey: true, shiftKey: true }), IN_SESSION)).toBeNull();
    expect(paneForShortcut(press('k', { metaKey: true }), IN_SESSION)).toBeNull();
    expect(paneForShortcut(press('b', { metaKey: true, repeat: true }), IN_SESSION)).toBeNull();
    expect(paneForShortcut(press('b', { metaKey: true, isComposing: true }), IN_SESSION)).toBeNull();
    expect(paneForShortcut(press('b', { metaKey: true, defaultPrevented: true }), IN_SESSION)).toBeNull();
    // Another layout puts a different letter on the physical B key: that letter is not B.
    expect(paneForShortcut(press('x', { metaKey: true, code: 'KeyB' }), IN_SESSION)).toBeNull();
    expect(paneForShortcut(press('x', { metaKey: true, altKey: true, code: 'KeyB' }), IN_SESSION)).toBeNull();
  });

  it('a text field is a textarea, a text-like input or editable content; checkboxes, buttons and selects are not', () => {
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'url' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: null })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntry({ tagName: 'SELECT' })).toBe(false);
    expect(isTextEntry({ tagName: 'BODY' })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
