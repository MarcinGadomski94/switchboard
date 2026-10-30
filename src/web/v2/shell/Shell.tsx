import { useEffect } from 'react';
import { TouchTooltip } from '../../shell/TouchTooltip.tsx';
import { useLayout, useVisualViewportHeight } from '../../shell/useLayout.ts';
import { Portal } from '../components/index.ts';
import { useV2Router } from '../nav.tsx';
import { PeekHost } from '../agent/index.tsx';
import { NewSheet } from '../new/index.tsx';
import { Palette, openPalette } from '../palette/index.tsx';
import { isClassicOnlyPath } from '../routes.ts';
import { useNeedsYouCount } from '../shared/needs-you.ts';
import { Outlet } from './Outlet.tsx';
import { PhoneTabs } from './PhoneTabs.tsx';
import { Rail } from './Rail.tsx';
import { ShortcutsDialog, openShortcuts } from './ShortcutsDialog.tsx';
import { TopBar } from './TopBar.tsx';
import { V2TourHost } from '../tour/TourHost.tsx';
import { emitShortcut, shellKeyOf } from './shortcuts.ts';
import { useRailCounts, useStatusPill } from './useShellData.ts';
import { useUsageWarningToasts } from './useUsageWarningToasts.ts';
import './shell.css';

/** `true` when the focus is in a text box (`?` is a character there, not the shortcuts list). */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"]):not([type="button"])');
}

/**
 * D131 · the v2 shell (`docs/v2.md` → *Shell*): the rail (desktop and tablet) or
 * the bottom tabs (phone, ≤ 767 px), the top bar, the page, and the global
 * overlays (⌘K palette, shortcuts list, + New sheet). It owns the global keys:
 * ⌘K, ⌘⇧F, `?`, and emits ⌘. / ⌘\ to the page on screen (`shortcuts.ts`).
 */
export function Shell() {
  const { route, pathname, search, navigate } = useV2Router();
  const layout = useLayout();
  const phone = layout === 'phone';
  useVisualViewportHeight(layout !== 'desktop');
  const { pill } = useStatusPill();
  const counts = useRailCounts();
  const needs = useNeedsYouCount();
  // Fix after 2.0: the Max usage warnings as toasts (once per window, like classic's).
  useUsageWarningToasts();

  // A classic address (a push notification, a paired computer, a bookmark) opens its v2 page.
  useEffect(() => {
    const here = `${pathname}${search}`;
    if (isClassicOnlyPath(here)) navigate(here, { replace: true });
  }, [pathname, search, navigate]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      // While a dialog is open only its own keys work (the palette's ⌘K excepted).
      const modal = document.querySelector('.sb2 [aria-modal="true"]');
      const key = shellKeyOf(event, inTextField(event.target));
      if (!key || (modal && key !== 'palette')) return;
      if (key === 'palette') {
        event.preventDefault();
        openPalette();
      } else if (key === 'search') {
        event.preventDefault();
        navigate('/search');
      } else if (key === 'shortcuts') {
        event.preventDefault();
        openShortcuts();
      } else if (emitShortcut(key)) {
        event.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);

  // `/projects/:id/graph`: the graph alone, filling the window (a second monitor): no rail, top bar or tabs.
  if (route.area === 'project-graph') {
    return (
      <div className="v2-app" data-layout={layout} data-testid="v2-shell" data-bare="">
        <main className="v2-content" id="v2-content" data-area={route.area}>
          <Outlet route={route} search={search} pill={pill} counts={counts} />
        </main>
        <Palette />
        <ShortcutsDialog />
        <PeekHost />
        <V2TouchTooltip />
      </div>
    );
  }

  return (
    <div className="v2-app" data-layout={layout} data-testid="v2-shell">
      {phone ? null : <Rail route={route} counts={counts} pill={pill} />}
      <div className="v2-main">
        <TopBar pill={pill} needs={needs} phone={phone} />
        <main className="v2-content" id="v2-content" data-area={route.area}>
          <Outlet route={route} search={search} pill={pill} counts={counts} />
        </main>
        {phone ? <PhoneTabs route={route} needs={needs} /> : null}
      </div>
      <Palette />
      <ShortcutsDialog />
      <NewSheet />
      {/* Lane S: the agent peek sheet and the agent view's dialogs (openPeek, Undo from here, Save as result). */}
      <PeekHost />
      {/* Lane X · tour: the v2 tours (Welcome to Switchboard 2) and their replays. */}
      <V2TourHost />
      <V2TouchTooltip />
    </div>
  );
}

/** Where a long press already means something else in v2: a draggable card (agents, board) and a Project graph step (its menu). */
const V2_NO_TOUCH_TOOLTIP = '[draggable="true"], [data-graph-node]';

/**
 * Fix after 2.4.12 · D74 in v2 (`docs/responsive.md` → *Touch*): classic's
 * long-press tooltip (`TouchTooltip`), so on a touch screen a long press on an
 * element with a `title` (an answer option's description) shows it. In the
 * overlay layer, so it sits above v2's sheets and popovers; nothing on a fine pointer.
 */
function V2TouchTooltip() {
  return (
    <Portal>
      <TouchTooltip skip={V2_NO_TOUCH_TOOLTIP} />
    </Portal>
  );
}
