import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/net.ts';
import { pngSize } from '../helpers/png.ts';

/**
 * D34 (docs/install-app.md): the web app manifest, the page head that links it
 * (and gives Safari's Add to Dock its name and icon), and the offline page, as
 * committed in `src/web` (Vite copies `public/` as-is and keeps the head).
 */
const WEB_DIR = path.join(REPO_ROOT, 'src', 'web');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: string;
}

interface Manifest {
  readonly [key: string]: unknown;
  readonly icons: readonly ManifestIcon[];
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8')) as Manifest;
}

/** A SPEC color token's value from src/web/styles/tokens.css. */
async function token(name: string): Promise<string> {
  const css = await readFile(path.join(WEB_DIR, 'styles', 'tokens.css'), 'utf8');
  const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`).exec(css)?.[1];
  if (!value) throw new Error(`no --${name} token`);
  return value;
}

/** A root-relative URL of the site → its file in `public/`. */
function publicFile(url: string): string {
  return path.join(PUBLIC_DIR, ...url.split('/').filter(Boolean));
}

/** Attribute `name` of the first `<tag …>` in `html` whose attributes match `where`. */
function attribute(html: string, tag: string, where: RegExp, name: string): string | null {
  for (const [element] of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))) {
    if (where.test(element)) return new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1] ?? null;
  }
  return null;
}

describe('manifest.webmanifest', () => {
  it('names the app and opens it standalone at /', async () => {
    expect(await manifest()).toMatchObject({
      id: '/',
      name: 'Switchboard',
      short_name: 'Switchboard',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect((await manifest())['description']).toMatch(/Claude Code sessions/);
  });

  it('takes its colors from the SPEC tokens: background --bg-app, theme --bg-sidebar (the shell)', async () => {
    const m = await manifest();
    expect(m['background_color']).toBe(await token('bg-app'));
    expect(m['theme_color']).toBe(await token('bg-sidebar'));
  });

  it('lists the 192 / 512 PNGs (any), the maskable 512 and the SVG (any), each on disk at its size', async () => {
    const { icons } = await manifest();
    expect(icons.map((icon) => [icon.src, icon.sizes, icon.type, icon.purpose])).toEqual([
      ['/icons/icon-192.png', '192x192', 'image/png', 'any'],
      ['/icons/icon-512.png', '512x512', 'image/png', 'any'],
      ['/icons/icon-maskable-512.png', '512x512', 'image/png', 'maskable'],
      ['/icons/icon.svg', 'any', 'image/svg+xml', 'any'],
    ]);
    for (const icon of icons) {
      if (icon.type !== 'image/png') {
        await access(publicFile(icon.src));
        continue;
      }
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(pngSize(await readFile(publicFile(icon.src))), icon.src).toEqual({ width, height });
    }
  });
});

describe('index.html head', () => {
  it('links the manifest and sets the theme color of the manifest', async () => {
    const html = await readFile(path.join(WEB_DIR, 'index.html'), 'utf8');
    expect(attribute(html, 'link', /rel="manifest"/, 'href')).toBe('/manifest.webmanifest');
    expect(attribute(html, 'meta', /name="theme-color"/, 'content')).toBe((await manifest())['theme_color']);
  });

  it("gives Safari's Add to Dock its icon (180 px apple-touch-icon), name and web-app metas", async () => {
    const html = await readFile(path.join(WEB_DIR, 'index.html'), 'utf8');
    const touch = attribute(html, 'link', /rel="apple-touch-icon"/, 'href');
    expect(touch).toBe('/icons/apple-touch-icon.png');
    expect(pngSize(await readFile(publicFile(touch!)))).toEqual({ width: 180, height: 180 });
    expect(attribute(html, 'meta', /name="apple-mobile-web-app-capable"/, 'content')).toBe('yes');
    expect(attribute(html, 'meta', /name="apple-mobile-web-app-title"/, 'content')).toBe('Switchboard');
    expect(attribute(html, 'meta', /name="apple-mobile-web-app-status-bar-style"/, 'content')).toBe('black');
    expect(html).toContain('<title>Switchboard</title>');
  });

  it('has favicons (SVG + 32 px PNG) that exist', async () => {
    const html = await readFile(path.join(WEB_DIR, 'index.html'), 'utf8');
    const svg = attribute(html, 'link', /rel="icon"[^>]*image\/svg\+xml/, 'href');
    const png = attribute(html, 'link', /rel="icon"[^>]*image\/png/, 'href');
    expect(svg).toBe('/icons/favicon.svg');
    await access(publicFile(svg!));
    expect(png).toBe('/icons/favicon-32.png');
    expect(pngSize(await readFile(publicFile(png!)))).toEqual({ width: 32, height: 32 });
  });
});

describe('offline.html', () => {
  it('says where Switchboard is not running, how to start it, and offers Retry (a reload)', async () => {
    const html = await readFile(path.join(PUBLIC_DIR, 'offline.html'), 'utf8');
    expect(html).toContain(`Switchboard isn't running on <span id="host">`);
    expect(html).toContain("document.getElementById('host').textContent = location.host;");
    expect(html).toContain('Start it with <code>npm start</code> in the repo, or turn on Settings → Start at login.');
    expect(html).toMatch(/<button type="button" id="retry"[^>]*>Retry<\/button>/);
    expect(html).toContain('location.reload()');
  });

  it('is self-contained and uses only SPEC colors', async () => {
    const html = await readFile(path.join(PUBLIC_DIR, 'offline.html'), 'utf8');
    // Nothing loads from the stopped service.
    expect(html).not.toMatch(/<link\b|\bsrc=|url\(|@import/);
    const css = await readFile(path.join(WEB_DIR, 'styles', 'tokens.css'), 'utf8');
    const tokens = new Set([...css.matchAll(/#[0-9a-f]{6}\b/g)].map(([hex]) => hex));
    const used = [...html.matchAll(/#[0-9a-f]{6}\b/gi)].map(([hex]) => hex.toLowerCase());
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((hex) => !tokens.has(hex))).toEqual([]);
  });
});
