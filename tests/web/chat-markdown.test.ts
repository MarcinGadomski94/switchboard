import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { LINK_REL, type HastNode, chatUrlTransform, rehypeChatText, safeLinkUrl } from '../../src/web/views/session/markdown.ts';

/**
 * D20: chat messages as GitHub-flavored Markdown (src/web/views/session/ChatMarkdown.tsx
 * + markdown.ts, docs/chat.md → *Markdown*): the mapping to HTML, raw HTML shown as
 * text, link rules (new tab, http(s) / mailto only, bare URLs: developer addition
 * 2026-09-28), images as links, tables, task lists, syntax colors, box-drawing
 * tables kept verbatim, and plain text rendering as one paragraph per block.
 */

/** The component module, imported at run time (the server tsconfig has no JSX; Vitest transforms it). */
const COMPONENT = '../../src/web/views/session/ChatMarkdown.tsx';

let render: (text: string) => string;

/** D92: a fenced block as rendered: the wrapper, the `<pre>`, the Copy tool (no Save without a handler), the status line. */
const CODE_BLOCK =
  /<div class="sb-md-code">(<pre>[\s\S]*?<\/pre>)<div class="sb-md-code-tools"><button type="button" class="sb-button sb-md-code-copy" data-testid="chat-code-copy" data-state="idle" aria-label="Copy code" title="Copy code"><\/button><\/div><span class="sb-visually-hidden" role="status" aria-live="polite"><\/span><\/div>/g;

beforeAll(async () => {
  const { ChatMarkdown } = (await import(/* @vite-ignore */ COMPONENT)) as { ChatMarkdown: (props: object) => unknown };
  render = (text) => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown as never, { text }));
    const open = '<div class="sb-md" data-testid="chat-markdown">';
    expect(html.startsWith(open) && html.endsWith('</div>')).toBe(true);
    // D92: each fenced block sits in `.sb-md-code` with its tools (Copy) and a status line; the content checks below
    // read the block itself, so the wrapper is checked once here and taken off.
    return html.slice(open.length, -'</div>'.length).replace(CODE_BLOCK, (_all, pre: string) => pre);
  };
});

/** `html`'s text with the entities React escapes decoded. */
function decode(html: string): string {
  return html.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
}

/** A new-tab link as the chat renders it. */
function link(href: string, text: string): string {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

describe('safeLinkUrl / chatUrlTransform (only http, https and mailto are kept)', () => {
  it('keeps absolute http(s) and mailto URLs, drops every other scheme and relative URLs', () => {
    expect(LINK_REL).toBe('noopener noreferrer');
    for (const url of ['https://example.com/a?b=1#c', 'http://localhost:4870/x', 'mailto:dev@example.com', 'HTTPS://EXAMPLE.COM']) {
      expect(safeLinkUrl(url)).toBe(url);
    }
    expect(safeLinkUrl('  https://example.com  ')).toBe('https://example.com');
    for (const url of [
      'javascript:alert(1)',
      'JAVA\tSCRIPT:alert(1)',
      ' javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.com',
      'docs/chat.md',
      '/sessions/x',
      '#section',
      '//example.com/a',
      '',
    ]) {
      expect(safeLinkUrl(url), url).toBeNull();
      expect(chatUrlTransform(url), url).toBeNull();
    }
  });
});

describe('ChatMarkdown · plain text looks as before', () => {
  it('one paragraph per block, soft line breaks kept as newlines (the bubble keeps pre-wrap), no newline nodes between blocks', () => {
    expect(render('Hello world')).toBe('<p>Hello world</p>');
    expect(render('First line\nsecond line')).toBe('<p>First line\nsecond line</p>');
    expect(render('One.\n\nTwo.\n\nThree.')).toBe('<p>One.</p><p>Two.</p><p>Three.</p>');
    // A hard break is one <br>, not <br> + the source's newline (pre-wrap would break twice).
    expect(render('a  \nb')).toBe('<p>a<br/>b</p>');
    expect(render('a\\\nb')).toBe('<p>a<br/>b</p>');
    // The demo seed's texts and the fake CLI's tokens stay plain.
    expect(render('Contract locked from Figma node 2231:884 and written to contracts/free-talk.md.')).toBe(
      '<p>Contract locked from Figma node 2231:884 and written to contracts/free-talk.md.</p>',
    );
    expect(render('[fake:ask-2q] Ask me two questions.')).toBe('<p>[fake:ask-2q] Ask me two questions.</p>');
  });
});

describe('ChatMarkdown · raw HTML is never rendered', () => {
  it('shows a <script> block and an <img onerror> as their source text', () => {
    const script = render('<script>alert(1)</script>');
    expect(script).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    const img = render('Look: <img src=x onerror="alert(1)"> and <b>bold</b>');
    expect(img).not.toMatch(/<img|<b>|onerror="/);
    expect(decode(img)).toBe('<p>Look: <img src=x onerror="alert(1)"> and <b>bold</b></p>');
    const block = render('Before\n\n<div onclick="x()">\ninside\n</div>\n\nAfter');
    expect(block).not.toMatch(/<div/);
    expect(decode(block)).toBe('<p>Before</p><p><div onclick="x()">\ninside\n</div></p><p>After</p>');
    expect(decode(render('- item <iframe src="https://example.com"></iframe>'))).toBe('<ul><li>item <iframe src="https://example.com"></iframe></li></ul>');
    expect(render('<!-- hidden? -->')).toBe('<p>&lt;!-- hidden? --&gt;</p>');
  });
});

describe('ChatMarkdown · links', () => {
  it('open in a new tab with rel="noopener noreferrer"; other schemes and relative links render as their text', () => {
    expect(render('[the docs](https://example.com/docs "Docs")')).toBe(
      '<p><a href="https://example.com/docs" title="Docs" target="_blank" rel="noopener noreferrer">the docs</a></p>',
    );
    expect(render('[mail](mailto:dev@example.com)')).toBe(`<p>${link('mailto:dev@example.com', 'mail')}</p>`);
    expect(render('[click](javascript:alert(1))')).toBe('<p><span data-md-link="blocked">click</span></p>');
    expect(render('[notes](docs/chat.md) [top](#top)')).toBe('<p><span data-md-link="blocked">notes</span> <span data-md-link="blocked">top</span></p>');
    expect(render('<javascript:alert(2)>')).toBe('<p><span data-md-link="blocked">javascript:alert(2)</span></p>');
  });

  it('developer addition 2026-09-28: bare URLs and www links become links; trailing punctuation stays outside; code stays text; javascript: is not linked', () => {
    expect(render('See https://example.com/a.')).toBe(`<p>See ${link('https://example.com/a', 'https://example.com/a')}.</p>`);
    expect(render('Open https://example.com/a?b=1, then (https://example.com/c)!')).toBe(
      `<p>Open ${link('https://example.com/a?b=1', 'https://example.com/a?b=1')}, then (${link('https://example.com/c', 'https://example.com/c')})!</p>`,
    );
    expect(render('Go to www.example.org.')).toBe(`<p>Go to ${link('http://www.example.org', 'www.example.org')}.</p>`);
    expect(render('http://localhost:4870/sessions/x')).toBe(`<p>${link('http://localhost:4870/sessions/x', 'http://localhost:4870/sessions/x')}</p>`);
    expect(render('Mail dev@example.com')).toBe(`<p>Mail ${link('mailto:dev@example.com', 'dev@example.com')}</p>`);
    // Inside inline code and code blocks a URL stays text.
    expect(render('Run `curl https://example.com/a`')).toBe('<p>Run <code>curl https://example.com/a</code></p>');
    expect(render('```\nhttps://example.com/a\n```')).toBe('<pre><code>https://example.com/a\n</code></pre>');
    // Not a link: a bare javascript: URL.
    expect(render('javascript:alert(1)')).toBe('<p>javascript:alert(1)</p>');
  });

  it('images are never loaded: a link to the image, labelled with its alt text (or its URL)', () => {
    expect(render('![Figma frame](https://example.com/frame.png)')).toBe(`<p>${link('https://example.com/frame.png', '<span data-md-image="">Figma frame</span>')}</p>`);
    expect(render('![](https://example.com/x.png)')).toBe(`<p>${link('https://example.com/x.png', '<span data-md-image="">https://example.com/x.png</span>')}</p>`);
    // Inside a link: only the label (links do not nest).
    expect(render('[![logo](https://example.com/l.png)](https://example.com)')).toBe(`<p>${link('https://example.com', '<span data-md-image="">logo</span>')}</p>`);
    expect(render('![x](javascript:alert(1)) ![y](data:image/png;base64,AAAA)')).toBe(
      '<p><span data-md-link="blocked"><span data-md-image="">x</span></span> <span data-md-link="blocked"><span data-md-image="">y</span></span></p>',
    );
    expect(render('![a](https://example.com/a.png)')).not.toContain('<img');
  });
});

describe('ChatMarkdown · GFM blocks', () => {
  it('headings, emphasis, strikethrough, inline code, block quotes, rules, ordered and nested lists', () => {
    expect(render('# Title\n\n## Part\n\n### Step\n\n#### Note')).toBe('<h1>Title</h1><h2>Part</h2><h3>Step</h3><h4>Note</h4>');
    expect(render('*em* **strong** ~~gone~~ `code`')).toBe('<p><em>em</em> <strong>strong</strong> <del>gone</del> <code>code</code></p>');
    expect(render('> quoted\n> text')).toBe('<blockquote><p>quoted\ntext</p></blockquote>');
    expect(render('above\n\n---\n\nbelow')).toBe('<p>above</p><hr/><p>below</p>');
    expect(render('1. one\n2. two\n   - a\n   - b')).toBe('<ol><li>one</li><li>two<ul><li>a</li><li>b</li></ul></li></ol>');
    expect(render('- loose\n\n- items')).toBe('<ul><li><p>loose</p></li><li><p>items</p></li></ul>');
  });

  it('a table (column alignment from the delimiter row)', () => {
    expect(render('| Agent | Status |\n|:--|--:|\n| web | done |\n| mobile | running |')).toBe(
      '<table><thead><tr><th style="text-align:left">Agent</th><th style="text-align:right">Status</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left">web</td><td style="text-align:right">done</td></tr>' +
        '<tr><td style="text-align:left">mobile</td><td style="text-align:right">running</td></tr></tbody></table>',
    );
  });

  it('a task list with read-only checkboxes', () => {
    expect(render('- [x] build\n- [ ] ship')).toBe(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled="" checked=""/> build</li>' +
        '<li class="task-list-item"><input type="checkbox" disabled=""/> ship</li></ul>',
    );
  });

  it('a fenced block with a language gets highlight classes; without one it is left as it is', () => {
    expect(render('```ts\nconst answer: number = 42;\n```')).toBe(
      '<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> <span class="hljs-attr">answer</span>: ' +
        '<span class="hljs-built_in">number</span> = <span class="hljs-number">42</span>;\n</code></pre>',
    );
    expect(render('```json\n{"a": "b"}\n```')).toContain('<span class="hljs-string">&quot;b&quot;</span>');
    expect(render('```bash\necho "hi" # greet\n```')).toContain('<span class="hljs-comment"># greet</span>');
    expect(render('```\nconst x = 1;\n```')).toBe('<pre><code>const x = 1;\n</code></pre>');
    // An unknown language is not an error: the block stays plain text (no highlight spans).
    expect(render('```nosuchlang\nx\n```')).toBe('<pre><code class="hljs language-nosuchlang">x\n</code></pre>');
  });

  it('a box-drawing status table in a code fence keeps every character and space', () => {
    const table = [
      '┌─────────────────┬──────────────────────────┬────────────┐',
      '│ Agent           │ Description              │ Status     │',
      '├─────────────────┼──────────────────────────┼────────────┤',
      '│ 1. web          │ Free talk at 360         │ running    │',
      '├─────────────────┼──────────────────────────┼────────────┤',
      '│ 2. mobile       │   indented   cells  kept │ done       │',
      '└─────────────────┴──────────────────────────┴────────────┘',
    ].join('\n');
    for (const fence of ['```', '```text']) {
      const html = render(`Status:\n\n${fence}\n${table}\n\`\`\``);
      const code = /<pre><code(?: class="[^"]*")?>([\s\S]*)<\/code><\/pre>$/.exec(html)?.[1];
      expect(code, fence).toBeDefined();
      expect(decode(code ?? ''), fence).toBe(`${table}\n`);
      expect(html.startsWith('<p>Status:</p><pre>'), fence).toBe(true);
    }
  });
});

describe('rehypeChatText (the hast step on its own)', () => {
  it('drops newline nodes between blocks and after <br>, keeps soft breaks between inline nodes, turns raw into text', () => {
    const text = (value: string): HastNode => ({ type: 'text', value });
    const el = (tagName: string, children: HastNode[]): HastNode => ({ type: 'element', tagName, properties: {}, children });
    const tree: HastNode = {
      type: 'root',
      children: [
        el('p', [el('em', [text('a')]), text('\n'), el('em', [text('b')]), el('br', []), text('\n'), text('c')]),
        text('\n'),
        { type: 'raw', value: '<div>x</div>' },
        text('\n'),
        el('ul', [text('\n'), el('li', [text('item'), text('\n'), el('ul', [text('\n'), el('li', [text('sub')]), text('\n')]), text('\n')]), text('\n')]),
        el('pre', [el('code', [text('\n  keep\n')])]),
      ],
    };
    rehypeChatText()(tree);
    expect(tree).toEqual({
      type: 'root',
      children: [
        el('p', [el('em', [text('a')]), text('\n'), el('em', [text('b')]), el('br', []), text('c')]),
        el('p', [text('<div>x</div>')]),
        el('ul', [el('li', [text('item'), el('ul', [el('li', [text('sub')])])])]),
        el('pre', [el('code', [text('\n  keep\n')])]),
      ],
    });
  });
});
