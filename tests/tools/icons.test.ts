import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICONS_DIR, ICON_RENDERS } from '../../tools/icons/render.ts';
import { REPO_ROOT } from '../helpers/net.ts';
import { pngSize } from '../helpers/png.ts';

/**
 * D34: the committed app icons (`npm run icons`, docs/install-app.md). Every PNG the
 * script makes is on disk at its size, and its SVG source is one a browser can load.
 */
const DIR = path.join(REPO_ROOT, ICONS_DIR);

describe('app icons', () => {
  it.each(ICON_RENDERS.map((render) => [render.output, render] as const))('%s is a committed PNG of its size', async (_name, render) => {
    const size = pngSize(await readFile(path.join(DIR, render.output)));
    expect(size).toEqual({ width: render.size, height: render.size });
  });

  it.each([...new Set(ICON_RENDERS.map((render) => render.source))])('%s is a square SVG a browser can load', async (source) => {
    const svg = await readFile(path.join(DIR, source), 'utf8');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ')).toBe(true);
    const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg) ?? [];
    expect(width).toBe(height);
    // An XML comment may not contain "--" (a CSS token name in one made the SVG unloadable).
    for (const [, body] of svg.matchAll(/<!--([\s\S]*?)-->/g)) expect(body).not.toContain('--');
    // Self-contained: no external references, no text that would depend on installed fonts.
    expect(svg).not.toMatch(/href=|<text|<image|@import|url\(/);
  });

  it('draws on the SPEC colors: --bg-app behind the app icons, the brand mark in --primary-bg / --primary-fg', async () => {
    const tokens = await readFile(path.join(REPO_ROOT, 'src', 'web', 'styles', 'tokens.css'), 'utf8');
    const token = (name: string): string => new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`).exec(tokens)?.[1] ?? 'missing';
    for (const source of ['icon.svg', 'icon-maskable.svg']) {
      const svg = await readFile(path.join(DIR, source), 'utf8');
      expect(svg, source).toContain(`<rect width="512" height="512" fill="${token('bg-app')}"/>`);
      expect(svg, source).toContain(`fill="${token('primary-bg')}"/>`);
      expect(svg, source).toContain(`<path fill="${token('primary-fg')}"`);
    }
  });
});
