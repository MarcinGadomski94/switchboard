import { useLayoutEffect, useRef, useState } from 'react';
import { ChatMarkdown } from '../../views/session/ChatMarkdown.tsx';
import { CLAMP_LINES } from './card-markdown.ts';

/**
 * Fix after 2.0 · an answer card's text as Markdown: the chat's renderer
 * (`ChatMarkdown`: GitHub-flavored Markdown, raw HTML shown as text, no images,
 * links in a new tab with `rel="noopener noreferrer"`, http(s) / mailto only), in
 * the card's compact styles (`shared.css` → `.v2-qi-md`). With `clamp`, text past
 * {@link CLAMP_LINES} lines folds behind Show more / Show less.
 */
export function CardMarkdown({ text, className, clamp = false, testId }: { readonly text: string; readonly className: string; readonly clamp?: boolean; readonly testId?: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!clamp || open || !el) return undefined;
    const measure = (): void => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clamp, open, text]);
  const folded = clamp && !open;
  return (
    <div className={`${className} v2-qi-md`} data-testid={testId}>
      <div ref={box} className="v2-qi-md-box" data-clamped={folded ? 'true' : undefined} style={folded ? { maxHeight: `${CLAMP_LINES * 1.5}em` } : undefined}>
        <ChatMarkdown text={text} testId={testId ? `${testId}-md` : 'v2-answer-md'} />
      </div>
      {clamp && (long || open) ? (
        <button type="button" className="v2-qi-more" data-testid="v2-answer-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
