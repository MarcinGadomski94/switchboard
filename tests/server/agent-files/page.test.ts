import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { dataUrl, pageFrame, pageMetaTag, pagePolicy, pageRefs, refTarget, scanPage, withEdits } from '../../../src/server/agent-files/page.ts';

/**
 * SPIKE · side panel Files: an HTML file shown as a page. The pure parts: what a
 * page points at (read as a browser reads the page), which of that is a file next to
 * it, the rules the page runs under, and the frame it is served in.
 */

const refsOf = (html: string, scripts = true): string[] => scanPage(html, { scripts }).refs.map((ref) => ref.ref);

describe('what a page points at', () => {
  it("finds its stylesheets, scripts and pictures in the page's order, with the place of each address, whatever the case of the tags", () => {
    const html = [
      '<!doctype html>',
      '<html><head>',
      '<link rel="stylesheet" href="styles.css">',
      "<LINK REL='icon' HREF='favicon.ico'>",
      '<link href=print.css rel="alternate STYLESHEET" media="print">',
      '<LINK REL=STYLESHEET HREF=upper.css>',
      '</head><body>',
      "<img alt=\"a > b\" src='img/logo.png'>",
      '<IMG SRC="shout.png">',
      '<image src="old.png">',
      '<script async src=app.js></script>',
      '<SCRIPT SRC="loud.js"></SCRIPT>',
      '</body></html>',
    ].join('\n');
    expect(pageRefs(html).map((ref) => [ref.kind, ref.ref, html.slice(ref.start, ref.end)])).toEqual([
      ['style', 'styles.css', '"styles.css"'],
      ['style', 'print.css', 'print.css'],
      ['style', 'upper.css', 'upper.css'],
      ['image', 'img/logo.png', "'img/logo.png'"],
      ['image', 'shout.png', '"shout.png"'],
      ['image', 'old.png', '"old.png"'],
      ['script', 'app.js', 'app.js'],
      ['script', 'loud.js', '"loud.js"'],
    ]);
  });

  it('skips what a browser never reads as tags: comments, and the text of scripts, styles, text boxes, the title and the like', () => {
    const inert = [
      '<!-- <img src="a.png"> -->',
      '<!-- ends with a bang --!>',
      '<!--><!--->',
      "<script>const s = '<img src=\"b.png\">';</script>",
      '<style>/* <img src="c.png"> */</style>',
      '<textarea><img src="d.png"></textarea>',
      '<noscript><img src="e.png"></noscript>',
      '<title><img src="f.png"></title>',
      '<xmp><img src="g.png"></xmp>',
      '<iframe><img src="h.png"></iframe>',
      '<noembed><img src="i.png"></noembed>',
      '<noframes><img src="j.png"></noframes>',
      // An end tag is one only when its name ends there.
      '<style>a{} </stylesheet><img src="k.png"> </style>',
    ];
    expect(refsOf(`${inert.join('')}<img src="real.png">`)).toEqual(['real.png']);
    // Each one alone, so that none hides behind another.
    for (const piece of inert) expect(refsOf(`${piece}<img src="real.png">`), piece).toEqual(['real.png']);
  });

  it('reads a noscript block as part of the page when the page is shown without its scripts', () => {
    const html = '<noscript><img src="fallback.png"></noscript><img src="real.png">';
    expect(refsOf(html, true)).toEqual(['real.png']);
    expect(refsOf(html, false)).toEqual(['fallback.png', 'real.png']);
  });

  it("takes a script's own address and not what stands inside it; the first of a repeated attribute counts", () => {
    const html = '<script src="a.js">document.write(\'<img src="x.png">\')</script><img src="y.png" src="z.png">';
    expect(pageRefs(html).map((ref) => [ref.kind, ref.ref])).toEqual([
      ['script', 'a.js'],
      ['image', 'y.png'],
    ]);
  });

  it('knows where an old-style script really ends (a comment in it may hold a script tag of its own)', () => {
    // `<!--` then `<script`: the first `</script>` closes only that inner one.
    expect(refsOf('<script><!--\ndocument.write("<script></script><img src=\'x.png\'>");\n//--></script><img src="after.png">')).toEqual(['after.png']);
    // A comment alone: the first `</script>` ends the script.
    expect(refsOf('<script><!-- x --></script><img src="a.png">')).toEqual(['a.png']);
    // The comment is over before the script ends.
    expect(refsOf('<script><!--<script>--></script><img src="b.png">')).toEqual(['b.png']);
    // `<!-->` is a comment that ends at once.
    expect(refsOf('<script><!--><script></script><img src="c.png">')).toEqual(['c.png']);
    // `<scripty` is no script tag.
    expect(refsOf('<script><!-- <scripty></script><img src="d.png">')).toEqual(['d.png']);
  });

  it('reads a drawing (SVG, MathML) by its own rules: no raw text in it, its own CDATA, and HTML that breaks out of it', () => {
    // In a drawing `<style/>` is a whole element: what follows is still the page.
    expect(refsOf('<svg><style/></svg><p>body</p><script src="app.js"></script><img src="logo.png">')).toEqual(['app.js', 'logo.png']);
    expect(refsOf('<svg><script/><title/></svg><img src="a.png">')).toEqual(['a.png']);
    // CDATA is text there.
    expect(refsOf('<svg><text><![CDATA[ x > y <img src="no.png"> ]]></text></svg><img src="b.png">')).toEqual(['b.png']);
    // Outside a drawing `<![CDATA[` is a comment that ends at the first `>`.
    expect(refsOf('<![CDATA[ x > <img src="c.png"> ]]>')).toEqual(['c.png']);
    // The drawing's own picture element is not the page's.
    expect(refsOf('<svg><image src="no.png"/><img src="out.png"></svg>')).toEqual(['out.png']);
    // A title, a description and a foreignObject hold HTML again, with its rules (a text box in one is text) ...
    expect(refsOf('<svg><title>T <img src="t.png"></title><desc>x</desc></svg>')).toEqual(['t.png']);
    expect(refsOf('<svg><title><textarea><img src="no.png"></textarea></title><desc><textarea><img src="no.png"></textarea></desc></svg><img src="h.png">')).toEqual(['h.png']);
    // ... until it ends: after it the drawing's rules are back (a `<style>` there is no raw text, and the picture in it ends the drawing).
    expect(refsOf('<svg><desc>d</desc><style><img src="x.png"></style></svg>')).toEqual(['x.png']);
    // The drawing is over at its end tag: a title after it is the page's again.
    expect(refsOf('<svg></svg><title><img src="no.png"></title><img src="k.png">')).toEqual(['k.png']);
    // `</p>` and `</br>` end a drawing as an HTML tag does; so does a `<font>` that sets a colour, a face or a size, and only that one.
    expect(refsOf('<svg></p><title><img src="no.png"></title><img src="p.png">')).toEqual(['p.png']);
    expect(refsOf('<svg><font color="red"><title><img src="no.png"></title></font></svg><img src="q.png">')).toEqual(['q.png']);
    expect(refsOf('<svg><font><title><img src="r.png"></title></font></svg>')).toEqual(['r.png']);
    expect(refsOf('<svg><foreignObject><script>var s = "</svg><img src=\'no.png\'>";</script><img src="f.png"></foreignObject></svg><img src="g.png">')).toEqual(['f.png', 'g.png']);
    expect(refsOf('<math><mi><img src="m.png"></mi><annotation-xml><textarea><img src="no.png"></textarea></annotation-xml></math><img src="n.png">')).toEqual(['m.png', 'n.png']);
    // Each of a formula's HTML-holding elements alone (a text box in it is text only because it is HTML there).
    for (const holder of ['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']) {
      expect(refsOf(`<math><${holder}><textarea><img src="no.png"></textarea></${holder}></math><img src="n.png">`), holder).toEqual(['n.png']);
    }
    // Not a drawing: `<svg/>` is over at once, so the title is the page's title, which is text.
    expect(refsOf('<svg/><title><img src="no.png"></title><img src="d.png">')).toEqual(['d.png']);
    // A drawing inside a drawing ends with its own end tag.
    expect(refsOf('<svg><svg><style/></svg><style/></svg><img src="e.png">')).toEqual(['e.png']);
  });

  it('reads an end tag whole, also one with a quoted `>` in it', () => {
    expect(refsOf('<p>x</p title="><img src=no.png>">tail<img src="b.png">')).toEqual(['b.png']);
  });

  it('names films, sounds and framed pages too, as something a page view never loads', () => {
    const html = '<video src="film.mp4"></video><audio src="talk.mp3"></audio><video><source src="film.webm"></video><iframe src="other.html"></iframe><embed src="doc.pdf">';
    expect(pageRefs(html).map((ref) => [ref.kind, ref.ref])).toEqual([
      ['other', 'film.mp4'],
      ['other', 'talk.mp3'],
      ['other', 'film.webm'],
      ['other', 'other.html'],
      ['other', 'doc.pdf'],
    ]);
  });

  it('reads an address as the browser does: character references decoded, the spaces around it dropped', () => {
    const html = '<link rel="stylesheet" href=" a.css?x=1&amp;y=2 "><img src="caf&#233;.png"><img src="t&#x65;a.png"><img src="\n\tb.png\t\n">';
    expect(pageRefs(html).map((ref) => ref.ref)).toEqual(['a.css?x=1&y=2', 'café.png', 'tea.png', 'b.png']);
  });

  it('takes no longer for a long run of spaces inside an address (a crafted file must not hold the server)', () => {
    const spaces = ' '.repeat(400_000);
    const html = `<script src="a${spaces}b.js"></script><img src="${spaces}c.png${spaces}"><link rel="stylesheet" href="${'\n'.repeat(400_000)}">`;
    const started = performance.now();
    expect(pageRefs(html).map((ref) => ref.ref.length)).toEqual([400_005, 5]);
    // Linear work is a few milliseconds here; the squared kind was minutes.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('says which attributes must be set aside once a file is put in, and which are set aside in any case', () => {
    const html =
      '<img srcset="a.png 1x, b.png 2x" src="a.png" SRCSET="c.png 3x"><img src="c.png">' +
      '<script src="app.js" integrity="sha256-x" crossorigin></script><link integrity="sha256-y" rel="stylesheet" href="a.css">' +
      '<picture><source srcset="big.webp" type="image/webp"><img src="small.png"></picture>' +
      '<link rel="preconnect" href="https://example.com"><link rel="icon" href="favicon.ico" href="other.ico">';
    const scan = scanPage(html);
    const names = (positions: readonly number[]): string[] => positions.map((position) => html.slice(position, position + 9).replace(/=.*$/, ''));
    expect(scan.refs.map((ref) => [ref.ref, names(ref.aside)])).toEqual([
      ['a.png', ['srcset', 'SRCSET']],
      ['c.png', []],
      ['app.js', ['integrity']],
      ['a.css', ['integrity']],
      ['small.png', []],
    ]);
    // A picture's other sources could never load here and the browser would not fall back; a hint such as preconnect would still open a connection.
    expect(names(scan.aside)).toEqual(['srcset', 'href', 'href', 'href']);
  });

  it('finds the place just after the doctype (where the page view puts its own rules), and whether the page has scripts', () => {
    const plain = '\n<!-- note -->\n<!DOCTYPE html>\n<html><body><p>hi</p></body></html>';
    expect(scanPage(plain)).toMatchObject({ head: plain.indexOf('>\n<html>') + 1, scripted: false });
    expect(scanPage('<p>no doctype</p>')).toMatchObject({ head: 0, scripted: false });
    // A doctype after anything else is not one; after what a browser takes for a comment it still is, and only the first counts.
    expect(scanPage('<p>x</p><!doctype html>').head).toBe(0);
    expect(scanPage('text<!doctype html>').head).toBe(0);
    expect(scanPage('a < b<!doctype html>').head).toBe(0);
    expect(scanPage('<?xml version="1.0"?><!x></><!doctype html><p>').head).toBe('<?xml version="1.0"?><!x></><!doctype html>'.length);
    expect(scanPage('<!doctype html><!doctype html><p>').head).toBe(15);
    expect(scanPage('<!doctype html><script>1</script>').scripted).toBe(true);
    expect(scanPage('<!doctype html><button onclick="go()">Go</button>').scripted).toBe(true);
    expect(scanPage('<!doctype html><p once="x" on="y">not a handler</p>').scripted).toBe(false);
  });

  it('does not fail on a page that ends in the middle of a tag, a comment or a script', () => {
    expect(refsOf('<img src="a.png"><img src="b.png')).toEqual(['a.png']);
    expect(refsOf('<!-- never closed <img src="a.png">')).toEqual([]);
    expect(refsOf('<script>never closed <img src="a.png">')).toEqual([]);
    expect(refsOf('<svg><![CDATA[ never closed <img src="a.png">')).toEqual([]);
    expect(refsOf('a < b and <3 and <> and </> <img src="ok.png">')).toEqual(['ok.png']);
    expect(refsOf('')).toEqual([]);
  });
});

describe('which address is a file next to the page', () => {
  it("takes a relative address as a path from the page's folder, without its query and fragment, decoded", () => {
    expect(refTarget('styles.css')).toEqual({ kind: 'file', relative: 'styles.css' });
    expect(refTarget('./css/a.css?v=3#x')).toEqual({ kind: 'file', relative: './css/a.css' });
    expect(refTarget('my%20file.css')).toEqual({ kind: 'file', relative: 'my file.css' });
    expect(refTarget('css\\site.css')).toEqual({ kind: 'file', relative: 'css/site.css' });
    // Where it leads is the server's check (the real path must be inside the page's own folders), not this one's.
    expect(refTarget('../up/a.js')).toEqual({ kind: 'file', relative: '../up/a.js' });
    expect(refTarget('100%.css')).toEqual({ kind: 'file', relative: '100%.css' });
    // A tab or a line break inside an address is dropped, as a browser does.
    expect(refTarget('ap\tp.js')).toEqual({ kind: 'file', relative: 'app.js' });
    expect(refTarget(' sty\r\nles.css ')).toEqual({ kind: 'file', relative: 'styles.css' });
  });

  it('never takes another address, a drive or a network path for a file', () => {
    const remotes = [
      'https://cdn.example.com/x.js',
      'HTTP://example.com/a.css',
      '//cdn.example.com/x.js',
      'file:///C:/work/a.css',
      'mailto:dev@example.com',
      'ftp://example.com/a.png',
      'ht\ttps://example.com/a.js',
      // A drive: as written, and when it only shows once the address is decoded.
      'C:\\work\\a.css',
      'c:/work/a.css',
      'C%3A%5Cwork%5Ca.css',
      // Another stream of a file.
      'notes.txt:hidden.css',
      'css/notes.txt%3Ahidden.css',
      // A network path (opening one makes Windows sign in to that host): as written, mixed, and encoded.
      '\\\\host\\share\\a.css',
      '/\\host\\share\\a.css',
      '%5C%5Chost%5Cshare%5Ca.css',
      '%2F%2Fhost%2Fshare%2Fa.css',
    ];
    for (const remote of remotes) expect(refTarget(remote), remote).toEqual({ kind: 'remote' });
  });

  it("cannot place an address that starts at the site's root (a file alone does not say where that is)", () => {
    expect(refTarget('/css/site.css')).toEqual({ kind: 'site-root' });
    expect(refTarget('\\css\\site.css')).toEqual({ kind: 'site-root' });
    expect(refTarget('%2Fcss%2Fsite.css')).toEqual({ kind: 'site-root' });
  });

  it('has nothing to load for what is already in the page or is no file', () => {
    for (const none of ['', '   ', '#top', 'data:text/css,body{}', 'DATA:image/png;base64,AAAA', 'blob:null/1', 'about:blank', 'javascript:void(0)', '?x=1']) {
      expect(refTarget(none), none).toEqual({ kind: 'none' });
    }
  });
});

describe('putting files into the page', () => {
  it('replaces and inserts only at the places it is given, whatever their order', () => {
    const html = '<img src="a.png"><img src="b.png">';
    const refs = pageRefs(html);
    const edits = refs.map((ref, index) => ({ start: ref.start, end: ref.end, text: `"${index}"` })).reverse();
    expect(withEdits(html, edits)).toBe('<img src="0"><img src="1">');
    expect(withEdits(html, [{ start: 5, end: 5, text: 'data-' }, { start: 0, end: 0, text: '<!-- top -->' }])).toBe('<!-- top --><img data-src="a.png"><img src="b.png">');
    expect(withEdits(html, [])).toBe(html);
  });

  it('never lets one replacement cut into another', () => {
    expect(withEdits('abcdef', [{ start: 1, end: 4, text: 'X' }, { start: 2, end: 5, text: 'Y' }])).toBe('aXef');
  });

  it('writes a file as a data: address', () => {
    expect(dataUrl('text/css;charset=utf-8', Buffer.from('body{}'))).toBe('data:text/css;charset=utf-8;base64,Ym9keXt9');
  });
});

/** The parts of a `Content-Security-Policy`, by directive. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .map(([name, ...values]) => [name ?? '', values] as const),
  );
}

/** The script the frame document runs (not the data block before it). */
function frameScript(frame: string): string {
  const scripts = [...frame.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  return scripts[0]?.[1] ?? '';
}

describe('the rules a page runs under', () => {
  it('fetch nothing from any address, with or without scripts, and let the frame hold nothing but the page', () => {
    for (const scripts of [false, true]) {
      const policy = pagePolicy(scripts);
      const header = directives(policy.header);
      // Sandboxed without the app's origin: the frame document needs its own script in both cases.
      expect(header.get('sandbox')).toEqual(['allow-scripts']);
      expect(header.get('frame-ancestors')).toEqual(["'self'"]);
      for (const rules of [header, directives(policy.frameMeta), directives(policy.pageMeta)]) {
        expect(rules.get('default-src')).toEqual(["'none'"]);
        expect(rules.get('form-action')).toEqual(["'none'"]);
        expect(rules.get('base-uri')).toEqual(["'none'"]);
        for (const [name, values] of rules) {
          if (name === 'sandbox' || name === 'frame-ancestors') continue;
          // Every source is the page's own text or data: never `'self'`, a scheme with a host, or a wildcard.
          expect(values.every((value) => ["'none'", "'unsafe-inline'", 'data:', 'blob:'].includes(value) || /^'sha256-[A-Za-z0-9+/]+=*'$/.test(value)), `${name}: ${values.join(' ')}`).toBe(true);
        }
      }
      // The page is a blob: of the frame document: no other address may be framed, so the page cannot send itself away. The page itself frames nothing.
      expect(header.get('frame-src')).toEqual(['blob:']);
      expect(directives(policy.frameMeta).get('frame-src')).toEqual(['blob:']);
      expect(directives(policy.pageMeta).get('frame-src')).toEqual(["'none'"]);
      // A `<meta>` cannot carry these two, and browsers warn about them.
      expect(policy.frameMeta).not.toMatch(/sandbox|frame-ancestors/);
      expect(policy.pageMeta).not.toMatch(/sandbox|frame-ancestors/);
      // The header's rules are the frame document's own, word for word.
      expect(policy.header).toBe(`sandbox allow-scripts; ${policy.frameMeta}; frame-ancestors 'self'`);
    }
  });

  it("leave the page's scripts off unless they were asked for: only the frame document's own script may run", () => {
    const off = pagePolicy(false);
    const script = frameScript(pageFrame('<p>hi</p>', 'index.html', false));
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    // That one script by its hash: no `'unsafe-inline'` (which a hash would switch off anyway) and no data: scripts.
    expect(directives(off.header).get('script-src')).toEqual([`'sha256-${hash}'`]);
    expect(directives(off.frameMeta).get('script-src')).toEqual([`'sha256-${hash}'`]);
    expect(directives(off.pageMeta).get('script-src')).toEqual(["'none'"]);
    const on = pagePolicy(true);
    for (const rules of [on.header, on.frameMeta, on.pageMeta]) expect(directives(rules).get('script-src')).toEqual(["'unsafe-inline'", 'data:']);
    // The same script either way (one hash).
    expect(frameScript(pageFrame('<p>hi</p>', 'index.html', true))).toBe(script);
  });

  it("are written into the page as well, so they hold without the frame document's", () => {
    expect(pageMetaTag(false)).toBe(`<meta http-equiv="Content-Security-Policy" content="${pagePolicy(false).pageMeta}">`);
    expect(pageMetaTag(true)).toBe(`<meta http-equiv="Content-Security-Policy" content="${pagePolicy(true).pageMeta}">`);
  });
});

describe('the frame document a page is served in', () => {
  it('carries the page as data that cannot end its own block, whatever the page holds', () => {
    const hostile = '<!doctype html><title>x</title></script><script>parent.location = "https://example.com/"</script><!-- <script> --> é \u2028 "quoted" \\ back';
    const frame = pageFrame(hostile, 'index.html', true);
    const block = /<script type="application\/json" id="page" data-scripts="1">([^<]*)<\/script>/.exec(frame);
    expect(block).not.toBeNull();
    expect(JSON.parse(block?.[1] ?? 'null')).toBe(hostile);
    // The page's text stands in that block only.
    expect(frame.split('example.com').length).toBe(2);
    expect(pageFrame(hostile, 'index.html', false)).toContain('<script type="application/json" id="page" data-scripts="0">');
  });

  it("shows the file's name as text, never as markup", () => {
    const frame = pageFrame('<p>hi</p>', '</title><script>alert(1)</script>.html', false);
    expect(frame).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;.html</title>');
    expect(frame).not.toContain('<script>alert(1)</script>');
  });

  it('states its rules itself too, before anything in it runs (a header can be taken off on the way)', () => {
    for (const scripts of [false, true]) {
      const frame = pageFrame('<p>hi</p>', 'index.html', scripts);
      const meta = `<meta http-equiv="Content-Security-Policy" content="${pagePolicy(scripts).frameMeta}">`;
      expect(frame).toMatch(/^<!doctype html>/);
      expect(frame.indexOf(meta)).toBeGreaterThan(0);
      expect(frame.indexOf(meta)).toBeLessThan(frame.indexOf('<script'));
    }
  });

  /** Runs the frame document's script against a stand-in for the browser's document. */
  function run(frame: string) {
    const block = /<script type="application\/json" id="page" data-scripts="([01])">([^<]*)<\/script>/.exec(frame);
    interface Made {
      readonly tag: string;
      readonly attributes: Record<string, string>;
      readonly children: Made[];
      readonly listeners: Record<string, () => void>;
      textContent: string;
      focused: boolean;
    }
    const make = (tag: string): Made & Record<string, unknown> => {
      const made: Made & Record<string, unknown> = {
        tag,
        attributes: {},
        children: [],
        listeners: {},
        textContent: '',
        focused: false,
        setAttribute(name: string, value: string) {
          made.attributes[name] = value;
        },
        addEventListener(type: string, listener: () => void) {
          made.listeners[type] = listener;
        },
        append(...nodes: Made[]) {
          made.children.push(...nodes);
        },
        focus() {
          made.focused = true;
        },
      };
      return made;
    };
    const body = { shown: [] as Made[], replaceChildren: (...nodes: Made[]) => void (body.shown = nodes) };
    const blobs: Array<{ parts: unknown[]; type: string }> = [];
    const document = {
      title: 'index.html',
      body,
      createElement: make,
      getElementById: (id: string) => (id === 'page' ? { textContent: block?.[2] ?? '', getAttribute: (name: string) => (name === 'data-scripts' ? (block?.[1] ?? null) : null) } : null),
    };
    class Blob {
      constructor(parts: unknown[], options: { type: string }) {
        blobs.push({ parts, type: options.type });
      }
    }
    vm.runInNewContext(frameScript(frame), { document, Blob, URL: { createObjectURL: () => `blob:null/${blobs.length}` }, JSON });
    return { body, blobs };
  }

  it('shows the page from a blob in a frame of its own, sandboxed again: without scripts unless they were asked for', () => {
    const page = '<!doctype html><p>hi</p>';
    const off = run(pageFrame(page, 'index.html', false));
    expect(off.blobs).toEqual([{ parts: [page], type: 'text/html;charset=utf-8' }]);
    expect(off.body.shown.map((node) => [node.tag, node.attributes])).toEqual([['iframe', { sandbox: '', title: 'index.html', src: 'blob:null/1' }]]);
    const on = run(pageFrame(page, 'index.html', true));
    expect(on.body.shown[0]?.attributes['sandbox']).toBe('allow-scripts');
  });

  it('keeps the page while it stays, says so when it leaves, and shows it again when asked', () => {
    const { body } = run(pageFrame('<p>hi</p>', 'index.html', true));
    const first = body.shown[0];
    first?.listeners['load']?.();
    // Loaded once: that is the page itself.
    expect(body.shown).toEqual([first]);
    first?.listeners['load']?.();
    // Loaded again: it left (the other address was refused) or loaded itself anew.
    const note = body.shown[0];
    expect([body.shown.length, note?.tag, note?.attributes['role']]).toEqual([1, 'div', 'status']);
    expect(note?.children.map((child) => [child.tag, child.textContent])).toEqual([
      ['p', 'The page left this view: a link, a redirect, or it loaded itself again. Other pages are not opened here.'],
      ['button', 'Show the page again'],
    ]);
    const again = note?.children[1];
    expect(again?.focused).toBe(true);
    again?.listeners['click']?.();
    const second = body.shown[0];
    expect([second?.tag, second === first, second?.attributes['src']]).toEqual(['iframe', false, 'blob:null/1']);
    // The new frame counts its own loads.
    second?.listeners['load']?.();
    expect(body.shown).toEqual([second]);
  });
});
