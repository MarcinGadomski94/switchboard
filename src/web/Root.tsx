import { Suspense, lazy, useMemo } from 'react';
import { App } from './App.tsx';
import type { PaneState } from './shell/panes.ts';
import { type UiTheme, useThemeState } from './theme.ts';
import { toClassicPath, toV2Path } from './v2/routes.ts';

/** The v2 UI, loaded on demand (`main.tsx` loads it before the first render when v2 is the boot theme). */
export const loadV2 = (): Promise<typeof import('./v2/App.tsx')> => import('./v2/App.tsx');
const V2App = lazy(() => loadV2().then((module) => ({ default: module.V2App })));

/**
 * D131 · keeps the address where the other UI has the same page: before a UI
 * mounts, a path of the other UI is replaced by its own (`/sessions/a/diff` ⇄
 * `/agents/a/changes`), so deep links, push notifications and Back keep working.
 */
export function canonicalizeFor(theme: UiTheme): void {
  if (typeof window === 'undefined') return;
  const here = `${window.location.pathname}${window.location.search}`;
  const target = theme === 'v2' ? toV2Path(here) : toClassicPath(here);
  if (target !== here) window.history.replaceState(window.history.state, '', `${target}${window.location.hash}`);
}

/**
 * D131 · the page's root (`docs/v2.md` → *Two themes*): the classic UI or the v2
 * UI, whichever this browser shows (`theme.ts`). Switching swaps the whole tree at
 * once (no reload), keeping the page where both UIs have it.
 */
export function Root({ panes }: { readonly panes: PaneState }) {
  const { theme } = useThemeState();
  // Before the tree for `theme` mounts (its router reads the address once).
  useMemo(() => canonicalizeFor(theme), [theme]);
  if (theme === 'classic') return <App key="classic" panes={panes} />;
  return (
    <Suspense fallback={<div className="sb2-loading" aria-busy="true" />}>
      <V2App key="v2" />
    </Suspense>
  );
}
