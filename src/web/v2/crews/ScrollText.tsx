import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fix after 2.0 (2.4.4) · a long text in a short scrollable box (the compact teammate
 * card's job description): at most three lines tall, the rest scrolls. While more is
 * below it fades out at the bottom; while it overflows it takes keyboard focus (a
 * labelled region, so the arrow keys scroll it), and it takes none when it all fits.
 */
export function ScrollText({ label, children, testId, className }: { readonly label: string; readonly children: ReactNode; readonly testId?: string; readonly className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const measure = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    const more = box.scrollHeight - box.clientHeight > 1;
    setOverflow(more);
    setAtEnd(!more || box.scrollTop + box.clientHeight >= box.scrollHeight - 1);
  }, []);
  useEffect(() => {
    measure();
    const box = ref.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [measure, children]);
  return (
    <div className={`v2-c-scrollwrap${className ? ` ${className}` : ''}`} data-overflow={overflow || undefined} data-end={atEnd || undefined}>
      <div ref={ref} className="v2-c-scroll" onScroll={measure} {...(overflow ? { tabIndex: 0, role: 'region', 'aria-label': label } : {})} data-testid={testId}>
        {children}
      </div>
    </div>
  );
}
