import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useState } from 'react';
import { WORDS } from '../glossary.ts';
import { RAIL_WIDTH_DEFAULT, RAIL_WIDTH_KEY, RAIL_WIDTH_MAX, RAIL_WIDTH_MIN, clampRailWidth, railWidthByKey, readRailWidth } from './rail-model.ts';

function remembered(): number {
  try {
    return readRailWidth(window.localStorage.getItem(RAIL_WIDTH_KEY));
  } catch {
    return RAIL_WIDTH_DEFAULT;
  }
}

function remember(width: number): void {
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    // Storage blocked: the width lasts this page.
  }
}

/**
 * D181 (2026-11-20) · the desktop sidebar's width, remembered in this browser
 * (`switchboard.v2.railWidth`, 200–400 px, 232 by default). `null` off the desktop
 * layout: the tablet rail and the phone keep their own widths.
 */
export function useRailWidth(desktop: boolean): { readonly width: number | null; readonly set: (width: number) => void } {
  const [width, setWidth] = useState<number>(remembered);
  const set = useCallback((next: number): void => {
    const clamped = clampRailWidth(next);
    setWidth(clamped);
    remember(clamped);
  }, []);
  return { width: desktop ? width : null, set };
}

/**
 * D181 (2026-11-20) · the sidebar's resize handle on its right edge (desktop only): drag it,
 * ← / → by 16 px (Home / End to the ends), double-click to go back to 232 px. While dragging
 * only the CSS variable of the shell moves (no render per pointer move); the width is
 * remembered on release.
 */
export function RailResize({ width, onChange, shell }: { readonly width: number; readonly onChange: (width: number) => void; readonly shell: RefObject<HTMLDivElement | null> }) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    document.body.classList.toggle('v2-rail-resizing', dragging);
    return () => document.body.classList.remove('v2-rail-resizing');
  }, [dragging]);
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = shell.current;
    if (event.button !== 0 || !element) return;
    event.preventDefault();
    const left = element.getBoundingClientRect().left;
    let latest = width;
    const move = (moved: PointerEvent): void => {
      latest = clampRailWidth(moved.clientX - left);
      element.style.setProperty('--v2-rail', `${latest}px`);
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      setDragging(false);
      onChange(latest);
    };
    setDragging(true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };
  const byKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = railWidthByKey(width, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };
  return (
    <div
      className="v2-rail-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={WORDS.resizeSidebar}
      aria-valuenow={width}
      aria-valuemin={RAIL_WIDTH_MIN}
      aria-valuemax={RAIL_WIDTH_MAX}
      tabIndex={0}
      title={WORDS.resizeSidebarTip}
      data-testid="v2-rail-handle"
      data-tour="v2-rail-handle"
      onPointerDown={start}
      onKeyDown={byKey}
      onDoubleClick={() => onChange(RAIL_WIDTH_DEFAULT)}
    />
  );
}
