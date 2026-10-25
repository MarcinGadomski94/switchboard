import { type AnchorHTMLAttributes, type MouseEvent, useCallback, useMemo } from 'react';
import { useRouter } from '../router.tsx';
import { type V2Route, parseV2Route, toV2Path, v2Path } from './routes.ts';

/**
 * D131 · the v2 UI's router hook and link (`docs/v2.md` → *Routes*). The history
 * itself is the app's one router (`src/web/router.tsx`, mounted by the v2 root);
 * this reads its path with the v2 routes and navigates by v2 route or path. A
 * classic path given to `navigate` is turned into its v2 one (`toV2Path`).
 */
export interface V2Router {
  readonly route: V2Route;
  readonly pathname: string;
  /** The address's query (`?q=…`), `''` without one. */
  readonly search: string;
  readonly navigate: (to: V2Route | string, options?: { readonly replace?: boolean }) => void;
}

/** The current v2 route and `navigate`. */
export function useV2Router(): V2Router {
  const { pathname, search, navigate: go } = useRouter();
  const navigate = useCallback((to: V2Route | string, options?: { readonly replace?: boolean }) => go(typeof to === 'string' ? toV2Path(to) : v2Path(to), options), [go]);
  return useMemo(() => ({ route: parseV2Route(pathname), pathname, search, navigate }), [pathname, search, navigate]);
}

/** An `<a>` to a v2 route or path: a plain left click navigates in the page; a modifier click opens a new tab. */
export function V2Link({ to, onClick, ...rest }: { readonly to: V2Route | string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const { navigate } = useV2Router();
  const href = typeof to === 'string' ? toV2Path(to) : v2Path(to);
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return <a {...rest} href={href} onClick={handle} />;
}
