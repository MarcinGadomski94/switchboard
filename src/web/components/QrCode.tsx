import { useMemo } from 'react';
import { qrPath } from './qr.ts';

/**
 * A QR code as SVG (D24, the Remote popover): dark modules on the light primary
 * token, with its quiet zone, so a phone camera reads it on the dark UI.
 */
export function QrCode({ text, size = 168, label }: { readonly text: string; readonly size?: number; readonly label: string }) {
  const qr = useMemo(() => qrPath(text), [text]);
  return (
    <svg
      className="sb-qr"
      data-testid="remote-qr"
      data-text={text}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      <rect width={qr.size} height={qr.size} fill="var(--primary-bg)" />
      <path d={qr.path} fill="var(--primary-fg)" />
    </svg>
  );
}
