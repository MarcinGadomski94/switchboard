/**
 * D180 · side panel Files: an HTML file shown as a page (contract and limits:
 * `src/core/agent-files.ts` → "A page"). The pure parts: what a page points at, which
 * of that is a file next to it, the rules the page runs under, and the frame document
 * it is served in.
 */
import { createHash } from 'node:crypto';

// ── What a page points at ────────────────────────────────────────────────────

/** What a tag points at. `other`: something a page view never loads (a film, a sound, a framed page). */
export type PageRefKind = 'style' | 'script' | 'image' | 'other';

/** One address a page loads something from. */
export interface PageRef {
  readonly kind: PageRefKind;
  /** The address as a browser reads it: character references decoded, the spaces around it dropped. */
  readonly ref: string;
  /** Where the attribute's value stands in the page, its quotes included. */
  readonly start: number;
  readonly end: number;
  /**
   * Attribute names to set aside (prefixed `data-`) once the file is put in, by where
   * each stands: a picture's `srcset` (the browser would take it instead of `src`) and
   * an `integrity` (the file is put in as UTF-8, which may not be its bytes on disk).
   */
  readonly aside: readonly number[];
}

/** What {@link scanPage} reads from a page. */
export interface PageScan {
  readonly refs: readonly PageRef[];
  /**
   * Attribute names to set aside whenever the page is shown: the `srcset` of a
   * `<source>` (its files can never load here, and a `<picture>` would not fall back
   * to its `<img>`), and the `href` of a `<link>` that is no stylesheet (nothing of it
   * can load, and a hint such as `preconnect` would still open a connection).
   */
  readonly aside: readonly number[];
  /** Where the page view's own `<meta>` goes: just after the doctype, 0 without one. */
  readonly head: number;
  /** The page has scripts of its own: a `<script>` or an `on…` attribute. */
  readonly scripted: boolean;
}

interface Attribute {
  readonly name: string;
  readonly nameStart: number;
  /** `null` for an attribute without a value. */
  readonly value: string | null;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface Tag {
  readonly name: string;
  readonly attributes: readonly Attribute[];
  /** Just after its `>`. */
  readonly end: number;
  /** It ends with `/>`. */
  readonly selfClosing: boolean;
}

/** Where the scan stands inside a drawing: in its own markup, or in HTML again (a title, a description, a foreignObject) until that element ends. */
type Frame = { readonly foreign: true; readonly root: 'svg' | 'math' } | { readonly foreign: false; readonly until: string };

/** HTML elements whose content is text: nothing in it is a tag (`noscript` only while scripts run). */
const RAW_TEXT: ReadonlySet<string> = new Set(['style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']);
/** Elements whose `src` a page view never loads. */
const NEVER_LOADED: ReadonlySet<string> = new Set(['video', 'audio', 'source', 'track', 'iframe', 'embed']);
/** HTML tags that end a drawing they stand in (the HTML standard's list). */
const BREAKS_OUT: ReadonlySet<string> = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr',
  'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);
/** Elements of a drawing that hold HTML again. */
const HOLDS_HTML: Readonly<Record<'svg' | 'math', ReadonlySet<string>>> = {
  svg: new Set(['foreignobject', 'desc', 'title']),
  math: new Set(['annotation-xml', 'mi', 'mo', 'mn', 'ms', 'mtext']),
};
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
}

/** Lower case as HTML means it: ASCII letters only (`toLowerCase` would also turn a Kelvin sign into `k`). */
function lower(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Without the HTML white space around it. Walks in from both ends: a pattern with `+$` takes squared time on a long run of spaces. */
function trimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text[start])) start += 1;
  while (end > start && isSpace(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `&amp;`, `&#233;`, `&#xE9;` and the few named ones an address may hold. */
function decodeReferences(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (whole: string, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named !== undefined) return NAMED[named] ?? whole;
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? '', 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  });
}

/**
 * The tag whose name begins at `open + 1` (`open` is the `<` of a start tag, or the
 * `/` of an end tag); `null` when the page ends inside it (a browser drops it).
 */
function readTag(html: string, open: number): Tag | null {
  const length = html.length;
  let at = open + 1;
  while (at < length && !isSpace(html[at]) && html[at] !== '/' && html[at] !== '>') at += 1;
  const name = lower(html.slice(open + 1, at));
  const attributes: Attribute[] = [];
  for (;;) {
    let slash = false;
    while (at < length && (isSpace(html[at]) || html[at] === '/')) {
      slash = html[at] === '/';
      at += 1;
    }
    if (at >= length) return null;
    if (html[at] === '>') return { name, attributes, end: at + 1, selfClosing: slash };
    const nameStart = at;
    // A name may begin with `=` (an error a browser accepts): its first character is always part of it.
    at += 1;
    while (at < length && !isSpace(html[at]) && html[at] !== '/' && html[at] !== '>' && html[at] !== '=') at += 1;
    const nameEnd = at;
    while (at < length && isSpace(html[at])) at += 1;
    let value: string | null = null;
    let valueStart = nameEnd;
    let valueEnd = nameEnd;
    if (html[at] === '=') {
      at += 1;
      while (at < length && isSpace(html[at])) at += 1;
      if (at >= length) return null;
      const quote = html[at];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, at + 1);
        if (close === -1) return null;
        value = html.slice(at + 1, close);
        valueStart = at;
        valueEnd = close + 1;
        at = close + 1;
      } else {
        valueStart = at;
        while (at < length && !isSpace(html[at]) && html[at] !== '>') at += 1;
        value = html.slice(valueStart, at);
        valueEnd = at;
      }
    }
    attributes.push({ name: lower(html.slice(nameStart, nameEnd)), nameStart, value, valueStart, valueEnd });
  }
}

/** Just after the comment that opens at `open` (it ends at `-->` or `--!>`; `<!-->` is a whole one); -1 when it never ends. */
function commentEnd(html: string, open: number): number {
  const close = /--!?>/g;
  close.lastIndex = open + 2;
  const match = close.exec(html);
  return match ? match.index + match[0].length : -1;
}

/** Where the end tag of a raw-text element begins at or after `from`; -1 when the page ends first. */
function rawTextEnd(html: string, name: string, from: number): number {
  // `name` is one of RAW_TEXT. Without the `u` flag `i` folds ASCII letters only.
  const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
  close.lastIndex = from;
  const match = close.exec(html);
  return match ? match.index : -1;
}

/**
 * Where a script's end tag begins at or after `from`; -1 when the page ends first.
 * A script's text may hold `<!--`, and after that a `<script` of its own: the next
 * `</script` then closes only that inner one (the HTML standard's "escaped" script
 * text, which old pages use around `document.write`).
 */
function scriptEnd(html: string, from: number): number {
  const token = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;
  token.lastIndex = from;
  /** 0: script text · 1: after `<!--` · 2: after a `<script` in that. */
  let state = 0;
  for (;;) {
    const match = token.exec(html);
    if (!match) return -1;
    const text = match[0];
    if (text === '<!--') {
      if (state === 0) state = 1;
      // `<!-->` ends it at once: its dashes are also those of the `-->`.
      token.lastIndex = match.index + 2;
    } else if (text === '-->') state = 0;
    else if (text.charAt(1) === '/') {
      if (state !== 2) return match.index;
      state = 1;
    } else if (state === 1) state = 2;
  }
}

/**
 * What a page loads and where, in the page's order: its stylesheets
 * (`<link rel="stylesheet" href>`), scripts (`<script src>`), pictures (`<img src>`)
 * and, as `other`, films, sounds and framed pages. Read as a browser reads the page:
 * comments, the text of scripts (with their old-style escapes), styles, text boxes and
 * the title, and drawings (SVG, MathML: their own rules, their CDATA, the HTML that
 * ends them or stands inside a title or a foreignObject). `scripts: false` reads the
 * page as it is shown without its scripts (a `noscript` block is then part of it).
 *
 * It is not the browser's parser: it keeps no tree of the open HTML elements, so in
 * markup that is broken (an end tag missing, a table's content out of place) it can
 * read a tag where the browser reads text, or the reverse. What that can cost is a
 * file left out of the page, or an address rewritten inside text; never more than the
 * page's sandbox allows.
 */
export function scanPage(html: string, options: { readonly scripts?: boolean } = {}): PageScan {
  const scripts = options.scripts ?? true;
  const refs: PageRef[] = [];
  const aside: number[] = [];
  const frames: Frame[] = [];
  const length = html.length;
  let head = 0;
  let scripted = false;
  /** Only white space and comments so far: a doctype may still come. */
  let early = true;
  let at = 0;
  while (at < length) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    if (early) for (let index = at; index < open && early; index += 1) early = isSpace(html[index]);
    const next = html[open + 1];
    const frame = frames[frames.length - 1];
    if (next === '!' || next === '?') {
      if (html.startsWith('<!--', open)) {
        const end = commentEnd(html, open);
        if (end === -1) break;
        at = end;
        continue;
      }
      // In a drawing CDATA is text; anywhere else it is a comment that ends at the next `>`, like `<?…>` and a doctype.
      const cdata = frame !== undefined && frame.foreign && html.startsWith('<![CDATA[', open);
      const end = html.indexOf(cdata ? ']]>' : '>', open + 2);
      if (end === -1) break;
      // The first doctype counts, and only before anything but white space and comments (these are comments too).
      if (early && lower(html.slice(open, open + 9)) === '<!doctype') {
        head = end + 1;
        early = false;
      }
      at = end + (cdata ? 3 : 1);
      continue;
    }
    if (next === '/') {
      if (!isLetter(html[open + 2])) {
        // `</>` is nothing; `</` and anything else is a comment up to the next `>`.
        const end = html.indexOf('>', open + 2);
        if (end === -1) break;
        at = end + 1;
        continue;
      }
      early = false;
      const tag = readTag(html, open + 1);
      if (tag === null) break;
      at = tag.end;
      if (frame === undefined) continue;
      if (!frame.foreign) {
        // HTML inside a drawing ends with the end tag of the element that holds it.
        if (frame.until === tag.name) frames.pop();
      } else if (tag.name === 'p' || tag.name === 'br') {
        while (frames[frames.length - 1]?.foreign) frames.pop();
      } else if (frame.root === tag.name) frames.pop();
      continue;
    }
    if (!isLetter(next)) {
      // A `<` that begins no tag is text.
      early = false;
      at = open + 1;
      continue;
    }
    early = false;
    const tag = readTag(html, open);
    if (tag === null) break;
    at = tag.end;
    if (frame !== undefined && frame.foreign) {
      const breaksOut = BREAKS_OUT.has(tag.name) || (tag.name === 'font' && tag.attributes.some((attribute) => attribute.name === 'color' || attribute.name === 'face' || attribute.name === 'size'));
      if (!breaksOut) {
        if (!tag.selfClosing) {
          if (HOLDS_HTML[frame.root].has(tag.name)) frames.push({ foreign: false, until: tag.name });
          else if (tag.name === frame.root) frames.push({ foreign: true, root: frame.root });
        }
        continue;
      }
      // An HTML tag in a drawing: the browser ends the drawing and reads the tag as HTML.
      while (frames[frames.length - 1]?.foreign) frames.pop();
    }
    if (tag.name === 'svg' || tag.name === 'math') {
      if (!tag.selfClosing) frames.push({ foreign: true, root: tag.name });
      continue;
    }
    // HTML's old name for a picture.
    const name = tag.name === 'image' ? 'img' : tag.name;
    const first = (wanted: string): Attribute | undefined => tag.attributes.find((candidate) => candidate.name === wanted);
    const every = (wanted: string): number[] => tag.attributes.filter((candidate) => candidate.name === wanted).map((candidate) => candidate.nameStart);
    if (name === 'script' || (!scripted && tag.attributes.some((attribute) => /^on[a-z]{3,}$/.test(attribute.name)))) scripted = true;
    let kind: PageRefKind | null = null;
    let source: Attribute | undefined;
    let set: number[] = [];
    if (name === 'link') {
      const rel = lower(first('rel')?.value ?? '').split(/[\t\n\f\r ]+/);
      if (rel.includes('stylesheet')) {
        kind = 'style';
        source = first('href');
        set = every('integrity');
      } else aside.push(...every('href'));
    } else if (name === 'script') {
      kind = 'script';
      source = first('src');
      set = every('integrity');
    } else if (name === 'img') {
      kind = 'image';
      source = first('src');
      set = every('srcset');
    } else if (NEVER_LOADED.has(name)) {
      kind = 'other';
      source = first('src');
      if (name === 'source') aside.push(...every('srcset'));
    }
    if (kind !== null && source && source.value !== null) {
      const ref = trimSpace(decodeReferences(source.value));
      if (ref !== '') refs.push({ kind, ref, start: source.valueStart, end: source.valueEnd, aside: set });
    }
    if (name === 'plaintext') break;
    let end = at;
    if (name === 'script') end = scriptEnd(html, at);
    else if (RAW_TEXT.has(name) && (scripts || name !== 'noscript')) end = rawTextEnd(html, name, at);
    if (end === -1) break;
    at = end;
  }
  return { refs, aside, head, scripted };
}

/** {@link scanPage}'s addresses alone, for a page read with its scripts. */
export function pageRefs(html: string): PageRef[] {
  return [...scanPage(html).refs];
}

// ── Which address is a file next to the page ─────────────────────────────────

/**
 * How an address written in a page is treated: `file` a path from the page's folder
 * (where it leads is checked by the server, on the real path); `none` nothing to
 * load (it is in the page already, or no file); `remote` another address, a drive, a
 * file's other stream or a network path (never touched); `site-root` it starts at the
 * site's root, which a file alone does not tell. The page's own `<base>` is not used:
 * the page view does not honour one either (`base-uri 'none'`).
 */
export type RefTarget = { readonly kind: 'file'; readonly relative: string } | { readonly kind: 'none' } | { readonly kind: 'remote' } | { readonly kind: 'site-root' };

const NONE: RefTarget = { kind: 'none' };
const REMOTE: RefTarget = { kind: 'remote' };
const SITE_ROOT: RefTarget = { kind: 'site-root' };
/** Schemes that load nothing from a file or an address. */
const IN_PAGE_SCHEMES: ReadonlySet<string> = new Set(['data', 'blob', 'about', 'javascript']);

/** Two leading slashes of either kind are a network path, one is the site's root; `null` for neither. */
function rooted(text: string): RefTarget | null {
  if (/^[\\/]{2}/.test(text)) return REMOTE;
  return /^[\\/]/.test(text) ? SITE_ROOT : null;
}

export function refTarget(ref: string): RefTarget {
  // A browser drops tabs and line breaks inside an address, and the spaces around it.
  const text = ref.replace(/[\t\n\r]/g, '').trim();
  if (text === '' || text.startsWith('#')) return NONE;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text);
  // A drive letter reads as a scheme too: `C:\work\a.css` is never a file next to the page.
  if (scheme) return IN_PAGE_SCHEMES.has((scheme[1] ?? '').toLowerCase()) ? NONE : REMOTE;
  const written = rooted(text);
  if (written) return written;
  const bare = text.replace(/[?#][\s\S]*$/, '');
  if (bare === '') return NONE;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // Not an encoded address: taken as written.
  }
  // What only shows once it is decoded is still a drive (or a file's other stream), a network path or the site's root.
  if (decoded.includes(':')) return REMOTE;
  return rooted(decoded) ?? { kind: 'file', relative: decoded.replace(/\\/g, '/') };
}

// ── Putting files into the page ──────────────────────────────────────────────

/** One replacement in a page's text (`start` = `end`: an insertion). */
export interface PageEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** `html` with every edit made (given in any order; one that cuts into an earlier one is dropped). */
export function withEdits(html: string, edits: readonly PageEdit[]): string {
  if (edits.length === 0) return html;
  const parts: string[] = [];
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < at) continue;
    parts.push(html.slice(at, edit.start), edit.text);
    at = edit.end;
  }
  parts.push(html.slice(at));
  return parts.join('');
}

/** A file's bytes as a `data:` address. */
export function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

// ── The rules a page runs under, and the frame document it is served in ──────

/**
 * What the frame document does: it shows the page from a `blob:` in a frame of its
 * own, sandboxed again (with scripts only when they were asked for), and says so when
 * that frame loads a second time (the page left, to an address the rules refused, or
 * loaded itself again). Its text is fixed: the rules name it by its hash.
 */
const FRAME_SCRIPT = `
(() => {
  const data = document.getElementById('page');
  const url = URL.createObjectURL(new Blob([JSON.parse(data.textContent)], { type: 'text/html;charset=utf-8' }));
  const scripts = data.getAttribute('data-scripts') === '1';
  const show = () => {
    let loads = 0;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', scripts ? 'allow-scripts' : '');
    frame.setAttribute('title', document.title);
    frame.addEventListener('load', () => {
      loads += 1;
      if (loads > 1) left();
    });
    frame.setAttribute('src', url);
    document.body.replaceChildren(frame);
  };
  const left = () => {
    const note = document.createElement('div');
    note.setAttribute('id', 'left');
    note.setAttribute('role', 'status');
    const text = document.createElement('p');
    text.textContent = 'The page left this view: a link, a redirect, or it loaded itself again. Other pages are not opened here.';
    const again = document.createElement('button');
    again.setAttribute('type', 'button');
    again.textContent = 'Show the page again';
    again.addEventListener('click', show);
    note.append(text, again);
    document.body.replaceChildren(note);
    again.focus();
  };
  show();
})();
`;
const FRAME_SCRIPT_HASH = createHash('sha256').update(FRAME_SCRIPT, 'utf8').digest('base64');

/** What may load: the page's own text and data, nothing from an address. */
function fetchRules(scriptSrc: string, frameSrc: string): string {
  return `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; frame-src ${frameSrc}; form-action 'none'; base-uri 'none'`;
}

/** The rules of a page view, in the three places they are stated. */
export interface PagePolicy {
  /** The `Content-Security-Policy` header of the frame document. */
  readonly header: string;
  /** The same rules as a `<meta>` in the frame document: a header can be taken off on the way (the product's own frame helper does that for this app's host, `docs/frame-helper.md`). */
  readonly frameMeta: string;
  /** The rules as a `<meta>` in the page itself: they hold whether or not a browser hands the frame document's rules on to a `blob:` page. */
  readonly pageMeta: string;
}

/**
 * The rules of a page view. As an HTML result's (`HTML_ARTIFACT_CSP`,
 * `api/artifacts.ts`): `sandbox allow-scripts` without `allow-same-origin` (an opaque
 * origin, also when the answer is opened on its own) and `default-src 'none'`
 * (nothing is fetched from an address). What differs:
 * - `frame-src blob:` on the frame document. The page is a `blob:` in a frame of that
 *   document, so every other address the page's scripts, a link or a redirect send it
 *   to is refused. A sandboxed page may otherwise always send its own frame anywhere
 *   (measured in Chrome: an HTML result can), and only the document that frames it can
 *   refuse that; this app's own page states no rules.
 * - `data:` stylesheets, and `data:` scripts when scripts run: how the page's own
 *   files are put into it, each staying the element it was.
 * - `scripts: false` (the default of the view): the page's scripts do not run. The
 *   inner frame is sandboxed without `allow-scripts`, the frame document allows only
 *   its own script (by hash: `'unsafe-inline'` is left out), and the page's own
 *   `<meta>` says `script-src 'none'`.
 *
 * What these rules cannot do while scripts run (a browser limit, the same for an HTML
 * result): a script may still open connections that carry what the page holds. Chrome
 * does not know the `webrtc` directive, so `RTCPeerConnection` reaches any host, and a
 * `<link rel="preconnect">` a script adds makes a name lookup and a connection to a
 * host of its choosing.
 */
export function pagePolicy(scripts: boolean): PagePolicy {
  const frame = fetchRules(scripts ? "'unsafe-inline' data:" : `'sha256-${FRAME_SCRIPT_HASH}'`, 'blob:');
  return {
    header: `sandbox allow-scripts; ${frame}; frame-ancestors 'self'`,
    frameMeta: frame,
    pageMeta: fetchRules(scripts ? "'unsafe-inline' data:" : "'none'", "'none'"),
  };
}

/**
 * D180: `meta` put into `html` just after its doctype (before everything else when it has
 * none), as {@link PageScan.head} places it for a page view: an HTML result states its own
 * rules too.
 */
export function withPageMeta(html: string, meta: string): string {
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${html.slice(0, doctype[0].length)}${meta}${html.slice(doctype[0].length)}` : `${meta}${html}`;
}

/** The page's own statement of its rules: put just after its doctype ({@link PageScan.head}). */
export function pageMetaTag(scripts: boolean): string {
  return `<meta http-equiv="Content-Security-Policy" content="${pagePolicy(scripts).pageMeta}">`;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The document `…/files/page` answers with (under {@link pagePolicy}): it holds the
 * page as data and shows it in a second sandboxed frame, from a `blob:`. Why not the
 * page itself: see `frame-src` in {@link pagePolicy}. Why a `blob:`: the page keeps an
 * address of its own (a link to `#part` stays in it, a page without a doctype is read
 * as a browser reads it), and it has no size limit (a frame cannot be sent to a
 * `data:` address longer than about 2 MB; in a `srcdoc` frame a link to `#part` leaves
 * the page).
 */
export function pageFrame(html: string, title: string, scripts: boolean): string {
  // JSON with every `<` written as an escape: nothing the page holds can end the block or begin a tag in it.
  const data = JSON.stringify(html).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${pagePolicy(scripts).frameMeta}">
<title>${escapeText(title)}</title>
<style>
html, body { height: 100%; margin: 0; background: #fff; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
#left { box-sizing: border-box; padding: 24px; font: 14px/1.5 system-ui, sans-serif; color: #333; }
#left p { margin: 0 0 12px; }
#left button { padding: 6px 12px; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<script type="application/json" id="page" data-scripts="${scripts ? '1' : '0'}">${data}</script>
<script>${FRAME_SCRIPT}</script>
</body>
</html>
`;
}
