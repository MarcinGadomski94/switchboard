/**
 * D20: the chat's Markdown rules that are not React (`docs/chat.md` → *Markdown*),
 * kept here so they can be unit-tested: which URLs may become links, and a rehype
 * step that shows raw HTML as text and keeps plain text looking as it did before
 * D20 (the bubble keeps `white-space: pre-wrap`).
 */

/** The only URL schemes a chat link (or an image shown as a link) may point to. */
export const LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

/** `rel` of every chat link (they open in a new tab). */
export const LINK_REL = 'noopener noreferrer';

/**
 * `url` when it is an absolute `http:`, `https:` or `mailto:` URL, else `null`
 * (relative, `#fragment`, `javascript:`, `data:`, … URLs are never linked). The
 * scheme is read the way the browser reads an `href` (WHATWG URL parsing, so
 * `JAVA\tSCRIPT:` counts as `javascript:`).
 */
export function safeLinkUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  let protocol: string;
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    return null;
  }
  return LINK_PROTOCOLS.includes(protocol) ? trimmed : null;
}

/** `react-markdown`'s `urlTransform`: an unsafe URL is removed (the link then renders as text). */
export function chatUrlTransform(url: string): string | null {
  return safeLinkUrl(url);
}

/** A hast node, as far as {@link rehypeChatText} needs one (the `hast` types are not a dependency of their own). */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Elements that are blocks, so the newline text between them is not content. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'blockquote',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Parents whose children are blocks (in a tight list item: text, then maybe a nested list). */
const FLOW_PARENTS: ReadonlySet<string> = new Set(['blockquote', 'li', 'ol', 'section', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul']);

/** Parents where a raw HTML block becomes a paragraph of its own (else it stays inline text). */
const PARAGRAPH_PARENTS: ReadonlySet<string> = new Set(['blockquote', 'section']);

/** A block element, or no node at all (the edge of its parent). */
function isBlockOrEdge(node: HastNode | undefined): boolean {
  return node === undefined || (node.type === 'element' && BLOCK_TAGS.has(node.tagName ?? ''));
}

function isNewlineText(node: HastNode | undefined): boolean {
  return node?.type === 'text' && /^\s*$/.test(node.value ?? '') && (node.value ?? '').includes('\n');
}

function isFlowParent(node: HastNode): boolean {
  return node.type === 'root' || (node.type === 'element' && FLOW_PARENTS.has(node.tagName ?? ''));
}

function stringProperty(node: HastNode, name: string): string {
  const value = node.properties?.[name];
  return typeof value === 'string' ? value : '';
}

/**
 * An image, never loaded: a link to it labelled with its alt text (or its URL),
 * or the label alone inside another link (links do not nest).
 */
function imageAsLink(image: HastNode, insideLink: boolean): HastNode {
  const src = stringProperty(image, 'src');
  const label: HastNode = {
    type: 'element',
    tagName: 'span',
    properties: { dataMdImage: '' },
    children: [{ type: 'text', value: stringProperty(image, 'alt') || src }],
  };
  if (insideLink) return label;
  const title = stringProperty(image, 'title');
  return { type: 'element', tagName: 'a', properties: title ? { href: src, title } : { href: src }, children: [label] };
}

function tidy(parent: HastNode, insideLink: boolean): void {
  const children = parent.children;
  if (!children || (parent.type === 'element' && (parent.tagName === 'pre' || parent.tagName === 'code'))) return;
  const flow = isFlowParent(parent);
  const asParagraph = parent.type === 'root' || PARAGRAPH_PARENTS.has(parent.tagName ?? '');
  const mapped = children.map((child): HastNode => {
    if (child.type === 'element' && child.tagName === 'img') return imageAsLink(child, insideLink);
    if (child.type !== 'raw') return child;
    // Raw HTML is never rendered: its source shows as text (a block of it as a paragraph).
    const text: HastNode = { type: 'text', value: child.value ?? '' };
    return asParagraph ? { type: 'element', tagName: 'p', properties: {}, children: [text] } : text;
  });
  const kept = mapped.filter((child, index) => {
    if (!isNewlineText(child)) return true;
    const before = mapped[index - 1];
    // A hard break is a <br> followed by the source's newline: under pre-wrap that would break twice.
    if (before?.type === 'element' && before.tagName === 'br') return false;
    // The newlines mdast-util-to-hast puts between blocks would show as empty lines under pre-wrap.
    return !(flow && (isBlockOrEdge(before) || isBlockOrEdge(mapped[index + 1])));
  });
  parent.children = kept;
  for (const child of kept) tidy(child, insideLink || (child.type === 'element' && child.tagName === 'a'));
}

/**
 * A rehype plugin for the chat bubbles, which keep the pre-D20 `white-space:
 * pre-wrap` so that a message without Markdown looks exactly as before:
 * - raw HTML (`raw` nodes) becomes its source as text, never markup; a raw HTML
 *   block at the top level or in a block quote becomes a paragraph of that text;
 * - the newline text nodes between blocks (and at the edges of block
 *   containers) are dropped, since pre-wrap would show them as empty lines;
 * - the newline after a hard break (`<br>`) is dropped for the same reason;
 * - an image becomes a link to it (never an `<img>`, so nothing is loaded),
 *   labelled with its alt text or its URL; inside a link, just that label;
 * - code (`pre`, `code`) is left exactly as it is.
 * Newlines inside a paragraph (soft breaks) stay, so they still break the line.
 * Runs before `react-markdown` checks URLs, so an image's link is checked like
 * any other ({@link chatUrlTransform}).
 */
export function rehypeChatText(): (tree: HastNode) => void {
  return (tree) => tidy(tree, false);
}
