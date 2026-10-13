import { NAV_ICON_GLYPHS, type NavIconName } from './nav-icon-glyphs.ts';

export type { NavIconName } from './nav-icon-glyphs.ts';

/**
 * D101 · one icon of the sidebar's navigation grid (`nav-icon-glyphs.ts` holds the
 * strokes): 18 px, one 1.6 stroke in `currentColor`, hidden from assistive technology
 * (the cell carries the name).
 */
export function NavIcon({ name }: { readonly name: NavIconName }) {
  return (
    <svg className="sb-nav-icon" data-icon={name} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {NAV_ICON_GLYPHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
