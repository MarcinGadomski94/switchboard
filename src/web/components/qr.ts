import { encode } from 'uqr';

/**
 * QR codes for the Remote popover (D24): `uqr` (MIT, no dependencies, pinned in
 * package.json) encodes the text; the modules become one SVG path so the code is
 * drawn with React elements (no HTML string is injected). Pure, so `tests/web`
 * can check it without a browser.
 */

/** Quiet zone around the code, in modules (the QR standard's 4). */
export const QR_BORDER = 4;

/** An encoded QR code: `size` × `size` modules (quiet zone included) and the path of its dark modules. */
export interface QrPath {
  readonly size: number;
  /** `M x y h n v1 h -n z` per run of dark modules in a row, in module units. */
  readonly path: string;
  /** The modules, `true` = dark (row by row), for tests. */
  readonly modules: readonly (readonly boolean[])[];
}

/** Encodes `text` (error correction M: a phone camera reads it from a screen at a glance). */
export function qrPath(text: string): QrPath {
  const { size, data } = encode(text, { ecc: 'M', border: QR_BORDER });
  const parts: string[] = [];
  data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      const run = x - start;
      parts.push(`M${start} ${y}h${run}v1h-${run}z`);
    }
  });
  return { size, path: parts.join(''), modules: data };
}
