import { useEffect, useRef, useState } from 'react';
import { QrCode } from '../../components/QrCode.tsx';
import { REMOTE_NOTE } from './session-header.ts';

/** How long "Copied" shows after a copy (ms). */
const COPIED_MS = 1500;

/**
 * The Remote popover (D24): while Remote Control is on, the claude.ai link (opens
 * in a new tab, `rel="noopener noreferrer"`; Copy), its QR code for the phone, and
 * the ruling's note that the transcript is stored on Anthropic's servers. Esc, a
 * click outside it or Close closes it.
 */
export function RemotePopover({ url, onClose }: { readonly url: string; readonly onClose: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const box = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close.current();
    };
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      // The toggle and the Link & QR button handle their own clicks (they sit next to the popover, inside `.sb-sv-remote`).
      const owner = box.current?.parentElement;
      if (target && owner && !owner.contains(target)) close.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  useEffect(() => {
    if (copy !== 'copied') return undefined;
    const timer = setTimeout(() => setCopy('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copy]);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  return (
    <div ref={box} className="sb-sv-remote-pop" role="dialog" aria-label="Remote Control" data-testid="remote-popover">
      <div className="sb-sv-remote-pop-head">
        <span className="sb-sv-remote-pop-label">Remote Control</span>
        <button type="button" className="sb-button sb-sv-remote-pop-close" data-testid="remote-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="sb-sv-remote-pop-qr">
        <QrCode text={url} label="QR code of the claude.ai link" />
      </div>
      <a className="sb-sv-remote-pop-url" data-testid="remote-link" href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
      <div className="sb-sv-remote-pop-actions">
        <a className="sb-button sb-sv-primary" data-testid="remote-open" href={url} target="_blank" rel="noopener noreferrer">
          Open
        </a>
        <button type="button" className="sb-button sb-sv-outlined" data-testid="remote-copy" onClick={() => void onCopy()}>
          {copy === 'copied' ? 'Copied' : 'Copy link'}
        </button>
      </div>
      {copy === 'failed' ? (
        <div className="sb-sv-error" role="alert" data-testid="remote-copy-error">
          Could not copy: select the link and copy it.
        </div>
      ) : null}
      <div className="sb-sv-remote-pop-note" data-testid="remote-note">
        {REMOTE_NOTE}
      </div>
    </div>
  );
}
