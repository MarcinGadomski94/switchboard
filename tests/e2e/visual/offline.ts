import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { REPO_ROOT } from '../../helpers/net.ts';

/**
 * Offline loading of the design prototype (D10 visual oracle).
 *
 * `docs/handoff/prototype/Switchboard App.dc.html` pulls its runtime from unpkg
 * (React / ReactDOM 18.3.1 UMD, @babel/standalone 7.29.0, all with SRI) and its
 * fonts from Google Fonts. The same files are pinned as devDependencies
 * (`prototype-react`, `prototype-react-dom`, `@babel/standalone`) and the fonts as
 * `@fontsource/geist` / `@fontsource/geist-mono`, which the app itself bundles
 * (gap #19). Every request the prototype makes is answered from those local files
 * through `page.route`, so the harness never touches the network, and the
 * prototype and the app render with byte-identical font files.
 */

/** Absolute path of the primary prototype file. */
export const PROTOTYPE_FILE = path.join(REPO_ROOT, 'docs', 'handoff', 'prototype', 'Switchboard App.dc.html');

/** `file://` URL of {@link PROTOTYPE_FILE}. */
export const PROTOTYPE_URL = pathToFileURL(PROTOTYPE_FILE).href;

const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');

/** unpkg URL → local file (byte-identical: the SRI hashes in support.js match). */
const CDN_FILES: Readonly<Record<string, string>> = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': path.join(NODE_MODULES, 'prototype-react', 'umd', 'react.production.min.js'),
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': path.join(
    NODE_MODULES,
    'prototype-react-dom',
    'umd',
    'react-dom.production.min.js',
  ),
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': path.join(NODE_MODULES, '@babel', 'standalone', 'babel.min.js'),
};

/** Google Fonts stylesheet the prototype links (families and weights it asks for). */
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com/css2';

/** Fake gstatic prefix the generated stylesheet points at; answered from node_modules. */
const FONT_FILE_PREFIX = 'https://fonts.gstatic.com/switchboard-local/';

/** The weights the prototype requests: Geist 400/500/600, Geist Mono 400/500. */
const FONT_SHEETS: ReadonlyArray<readonly [pkg: string, weight: number]> = [
  ['geist', 400],
  ['geist', 500],
  ['geist', 600],
  ['geist-mono', 400],
  ['geist-mono', 500],
];

/** Cross-origin script loads with `integrity` need CORS; the page is file:// (origin "null"). */
const CORS = { 'access-control-allow-origin': '*' };

let fontCss: Promise<string> | null = null;

/**
 * The @fontsource stylesheets for the requested weights, with their relative
 * `./files/…` URLs rewritten to {@link FONT_FILE_PREFIX}.
 */
function buildFontCss(): Promise<string> {
  fontCss ??= (async () => {
    const parts: string[] = [];
    for (const [pkg, weight] of FONT_SHEETS) {
      const css = await readFile(path.join(NODE_MODULES, '@fontsource', pkg, `${weight}.css`), 'utf8');
      parts.push(css.replaceAll('url(./files/', `url(${FONT_FILE_PREFIX}${pkg}/files/`));
    }
    return parts.join('\n');
  })();
  return fontCss;
}

async function fulfillFile(route: Route, file: string, contentType: string): Promise<void> {
  await route.fulfill({ status: 200, contentType, headers: CORS, body: await readFile(file) });
}

/** Everything a prototype page may request, answered offline. Unknown http(s) requests are aborted. */
async function handle(route: Route): Promise<void> {
  const url = route.request().url();
  const cdn = CDN_FILES[url];
  if (cdn) return fulfillFile(route, cdn, 'application/javascript; charset=utf-8');
  if (url.startsWith(GOOGLE_FONTS_CSS)) {
    return route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', headers: CORS, body: await buildFontCss() });
  }
  if (url.startsWith(FONT_FILE_PREFIX)) {
    const rel = url.slice(FONT_FILE_PREFIX.length).split('?')[0] ?? '';
    const [pkg, dir, name] = rel.split('/');
    if ((pkg === 'geist' || pkg === 'geist-mono') && dir === 'files' && name && /^[a-z0-9-]+\.woff2?$/.test(name)) {
      return fulfillFile(route, path.join(NODE_MODULES, '@fontsource', pkg, 'files', name), name.endsWith('.woff2') ? 'font/woff2' : 'font/woff');
    }
  }
  // Includes the prototype's live probe of the Codebase Memory tool (http://localhost:13000):
  // aborted, so the tool shows "down" deterministically.
  return route.abort('internetdisconnected');
}

/** Installs the offline routes on `page` (call before navigating). */
export async function routePrototypeOffline(page: Page): Promise<void> {
  await page.route(/^https?:\/\//, handle);
}

/** Props of the prototype's root component (its `data-props` defaults). */
export interface PrototypeProps {
  /** The fake incoming question + toast after 9 s. Default here: off (LOOP.md visual oracle). */
  readonly simulateIncoming?: boolean;
  /** Opens the setup wizard on load. Default: off. */
  readonly showSetupOnLoad?: boolean;
}

/**
 * Opens the prototype offline with the given props. The props are applied by
 * rewriting the `data-props` defaults of the root script before the runtime
 * boots, so `componentDidMount` already sees them (the 9 s timer is never set).
 * Resolves once the shell has rendered and the fonts are loaded.
 */
export async function openPrototype(page: Page, props: PrototypeProps = {}): Promise<void> {
  const wanted = { simulateIncoming: props.simulateIncoming ?? false, showSetupOnLoad: props.showSetupOnLoad ?? false };
  await routePrototypeOffline(page);
  await page.addInitScript((defaults: Record<string, boolean>) => {
    document.addEventListener('DOMContentLoaded', () => {
      const script = document.querySelector('script[data-dc-script]');
      const raw = script?.getAttribute('data-props');
      if (!script || !raw) return;
      const meta = JSON.parse(raw) as Record<string, { default?: unknown }>;
      for (const [key, value] of Object.entries(defaults)) {
        const entry = meta[key];
        if (entry) entry.default = value;
      }
      script.setAttribute('data-props', JSON.stringify(meta));
    });
  }, wanted);
  await page.goto(PROTOTYPE_URL);
  await page.getByText('+ New session', { exact: true }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}
