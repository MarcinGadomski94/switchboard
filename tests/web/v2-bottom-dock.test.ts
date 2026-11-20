import { describe, expect, it } from 'vitest';
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  DOCK_SETTINGS_KEY,
  agentTerminalRefusal,
  clampDockHeight,
  dockModes,
  loadDock,
  saveDock,
  shownDockMode,
  showsTerminal,
  toggledDockMode,
} from '../../src/web/v2/agent/bottom-dock.ts';

/** D182 (`docs/terminals.md` → *The agent's terminal*): the bottom of an agent's conversation, its pure rules. */

function memory(): { getItem(key: string): string | null; setItem(key: string, value: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

describe('D182 · the bottom dock', () => {
  it('remembers the mode and the height in this browser; unreadable or out-of-range values fall back', () => {
    const storage = memory();
    expect(loadDock(storage)).toEqual({ mode: 'message', height: DOCK_DEFAULT_HEIGHT });
    saveDock(storage, { mode: 'both', height: 300 });
    expect(loadDock(storage)).toEqual({ mode: 'both', height: 300 });
    storage.setItem(DOCK_SETTINGS_KEY, JSON.stringify({ mode: 'sideways', height: 5 }));
    expect(loadDock(storage)).toEqual({ mode: 'message', height: DOCK_DEFAULT_HEIGHT });
    storage.setItem(DOCK_SETTINGS_KEY, '{nope');
    expect(loadDock(storage)).toEqual({ mode: 'message', height: DOCK_DEFAULT_HEIGHT });
    expect(loadDock(null)).toEqual({ mode: 'message', height: DOCK_DEFAULT_HEIGHT });
  });

  it('shows Message while the terminal can’t open; a phone shows Terminal for Both and offers no Both', () => {
    expect(shownDockMode('both', { phone: false, terminalRefusal: null })).toBe('both');
    expect(shownDockMode('both', { phone: true, terminalRefusal: null })).toBe('terminal');
    expect(shownDockMode('terminal', { phone: false, terminalRefusal: 'remote' })).toBe('message');
    expect(dockModes(false)).toEqual(['message', 'terminal', 'both']);
    expect(dockModes(true)).toEqual(['message', 'terminal']);
  });

  it('Ctrl+` shows the terminal when it isn’t shown and the message box when it is; Message alone starts no terminal', () => {
    expect(toggledDockMode('message')).toBe('terminal');
    expect(toggledDockMode('terminal')).toBe('message');
    expect(toggledDockMode('both')).toBe('message');
    expect(showsTerminal('message')).toBe(false);
    expect(showsTerminal('terminal')).toBe(true);
    expect(showsTerminal('both')).toBe(true);
  });

  it('keeps the terminal’s height between the minimum and the room the conversation leaves', () => {
    expect(clampDockHeight(50, 600)).toBe(DOCK_MIN_HEIGHT);
    expect(clampDockHeight(900, 600)).toBe(600);
    expect(clampDockHeight(333.4, 600)).toBe(333);
    expect(clampDockHeight(Number.NaN, 600)).toBe(DOCK_DEFAULT_HEIGHT);
    expect(clampDockHeight(400, 40)).toBe(DOCK_MIN_HEIGHT);
  });

  it('refuses the terminal for a paired computer’s agent, an archived one, and until the agent has loaded', () => {
    expect(agentTerminalRefusal({ remote: false, closed: false, missing: false })).toBeNull();
    expect(agentTerminalRefusal({ remote: true, closed: false, missing: false })).toContain('another computer');
    expect(agentTerminalRefusal({ remote: false, closed: true, missing: false })).toContain('archived');
    expect(agentTerminalRefusal({ remote: false, closed: false, missing: true })).not.toBeNull();
  });
});
