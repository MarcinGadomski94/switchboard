/**
 * A small phone outline (D24: Remote Control is on; the sidebar row and the
 * header's Remote toggle). `currentColor`, so it takes the text color around it.
 */
export function PhoneGlyph({ className, testId, title }: { readonly className?: string; readonly testId?: string; readonly title?: string }) {
  return (
    <svg
      className={className}
      data-testid={testId}
      width="8"
      height="12"
      viewBox="0 0 8 12"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <rect x="0.6" y="0.6" width="6.8" height="10.8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="3" y1="9.2" x2="5" y2="9.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
