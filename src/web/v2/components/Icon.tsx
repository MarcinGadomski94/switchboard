import { ICON_PATHS, type IconName } from './icon-paths.ts';

export { ICON_NAMES, type IconName } from './icon-paths.ts';

/** The v2 icon sizes: `s` 15 px, `m` 18 px (default), `l` 22 px. */
export type IconSize = 's' | 'm' | 'l';

/**
 * D131 · one icon of the prototype's set (`icon-paths.ts`). Decorative by default
 * (`aria-hidden`); pass `label` when the icon alone carries meaning (it then gets
 * `role="img"`). An unknown name renders nothing.
 */
export function Icon({ name, size = 'm', label, className }: { readonly name: IconName | string; readonly size?: IconSize; readonly label?: string; readonly className?: string }) {
  const body = (ICON_PATHS as Readonly<Record<string, string>>)[name];
  if (body === undefined) return null;
  return (
    <svg
      className={className ? `v2-i ${className}` : 'v2-i'}
      data-size={size === 'm' ? undefined : size}
      data-icon={name}
      viewBox="0 0 24 24"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      // The prototype's own static markup (no user data).
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
