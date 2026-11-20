import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PAGE_BYTES, AGENT_PAGE_LEFT_MAX, type AgentPageLeftWhy } from '../../../src/core/agent-files.ts';
import { pageMetaTag } from '../../../src/server/agent-files/page.ts';
import { AgentFileService, type AgentFileSession } from '../../../src/server/agent-files/service.ts';
import { fakeOpenerCommand } from '../../../tools/fake-opener/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * SPIKE · side panel Files (`src/core/agent-files.ts`): which files may be read, what
 * browsing lists, the secrets gate, text in pages, and handing a file to the OS
 * (through tools/fake-opener: nothing is ever opened on the machine running the tests).
 */

/** Every path the code under test asked the file system to resolve or describe, and every file it read whole (the real calls still happen). */
const asked = vi.hoisted(() => ({ paths: [] as string[], read: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const noting = <T,>(call: T, into: string[] = asked.paths): T =>
    ((...args: unknown[]) => {
      into.push(String(args[0]));
      return (call as (...all: unknown[]) => unknown)(...args);
    }) as T;
  return { ...real, realpath: noting(real.realpath), stat: noting(real.stat), lstat: noting(real.lstat), open: noting(real.open), readFile: noting(real.readFile, asked.read) };
});

let tmp: string;
let root: string;
let outside: string;
let session: AgentFileSession;
let openerLog: string;
let savedLog: string | undefined;

/** What the conversation did, as the server's stores would answer. */
let wrote: string[];
let read: string[];
let replies: string[];

function service(platform: NodeJS.Platform = process.platform): AgentFileService {
  return new AgentFileService({
    worksIn: async () => ({ repos: [] }),
    toolPaths: async (_id, names) => (names.includes('Write') ? wrote : names.includes('Read') ? read : []),
    replyTexts: async () => replies,
    platform,
    openPrefix: fakeOpenerCommand(),
  });
}

async function put(file: string, content: string | Buffer): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** The opener calls logged so far, once there are `count` of them. */
async function openerCalls(count: number): Promise<string[][]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = await readFile(openerLog, 'utf8').catch(() => '');
    const calls = text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
    if (calls.length >= count || Date.now() > deadline) return calls;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('agent-files'));
  root = path.join(tmp, 'work');
  outside = path.join(tmp, 'elsewhere');
  await put(path.join(root, 'README.md'), '# Acme\n\nSecond line\n');
  await put(path.join(root, 'src', 'app.ts'), 'export const a = 1;\n');
  await put(path.join(root, '.git', 'config'), '[core]\n');
  await put(path.join(root, '.env'), 'PLACEHOLDER=not-a-real-value\n');
  await put(path.join(root, 'bin', 'tool.exe'), Buffer.from([0x4d, 0x5a, 0, 0]));
  await put(path.join(root, 'data.blob'), Buffer.from([1, 2, 0, 3]));
  await put(path.join(root, 'long.log'), `${Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n')}\n`);
  await put(path.join(outside, 'private.txt'), 'not for this agent\n');
  // A link inside the agent's folder that leaves it (a junction on Windows: no elevation needed).
  await symlink(outside, path.join(root, 'way-out'), process.platform === 'win32' ? 'junction' : 'dir');
  session = { id: 's1', cwd: root, root: null };
  wrote = [];
  read = [];
  replies = [];
  openerLog = path.join(tmp, 'opener.log');
  savedLog = process.env['FAKE_OPENER_LOG'];
  process.env['FAKE_OPENER_LOG'] = openerLog;
});

afterEach(async () => {
  if (savedLog === undefined) delete process.env['FAKE_OPENER_LOG'];
  else process.env['FAKE_OPENER_LOG'] = savedLog;
  await removeTempDir(tmp);
});

describe('which files an agent\'s panel may read', () => {
  it("refuses a file outside the agent's folders: by its path, through `..`, and through a link that leaves them", async () => {
    const files = service();
    await expect(files.allow(session, path.join(outside, 'private.txt'))).rejects.toMatchObject({ code: 'outside' });
    await expect(files.allow(session, '../elsewhere/private.txt')).rejects.toMatchObject({ code: 'outside' });
    await expect(files.allow(session, 'way-out/private.txt')).rejects.toMatchObject({ code: 'outside' });
    await expect(files.allow(session, 'no/such/file.txt')).rejects.toMatchObject({ code: 'missing' });
    await expect(files.allow(session, '')).rejects.toMatchObject({ code: 'invalid' });
  });

  it("never shows git's own files, also by their direct path", async () => {
    await expect(service().allow(session, '.git/config')).rejects.toMatchObject({ code: 'outside' });
    await expect(service().allow(session, path.join(root, '.git', 'config'))).rejects.toMatchObject({ code: 'outside' });
  });

  it('never touches a network path the agent named (opening one makes Windows sign in to that host)', async () => {
    const share = '\\\\sb-no-such-host.invalid\\share\\notes.md';
    read = [share, '//sb-no-such-host.invalid/share/other.md'];
    replies = ['See `//sb-no-such-host.invalid/share/third.md`.'];
    asked.paths.length = 0;
    await expect(service().allow(session, share)).rejects.toMatchObject({ code: 'outside' });
    const listed = await service().list(session);
    expect(listed.files).toEqual([]);
    // The file system was asked about the agent's own folder, and never about that host.
    expect(asked.paths.length).toBeGreaterThan(0);
    expect(asked.paths.filter((asking) => /sb-no-such-host/i.test(asking))).toEqual([]);
  });

  it('allows a file inside the folders by its relative or absolute path', async () => {
    const files = service();
    const real = path.join(root, 'src', 'app.ts');
    expect(await files.allow(session, 'src/app.ts')).toMatchObject({ real, allowedBy: 'root' });
    expect(await files.allow(session, real)).toMatchObject({ real, allowedBy: 'root' });
  });

  it("allows an outside file only once the agent's own tool calls touched it, and never lets its folder be browsed", async () => {
    const elsewhere = path.join(outside, 'private.txt');
    read = [elsewhere];
    const files = service();
    expect(await files.allow(session, elsewhere)).toMatchObject({ real: elsewhere, allowedBy: 'conversation' });
    await expect(files.dir(session, outside)).rejects.toMatchObject({ code: 'outside' });
  });

  it('lists what the conversation touched with why, the line the agent pointed at, and a file that is gone', async () => {
    wrote = ['notes/made.md'];
    replies = ['I read `README.md:2` and looked at docs/nothing-here.md.'];
    const listed = await service().list(session);
    expect(listed.files.map((file) => ({ name: file.name, sources: file.sources, line: file.line, exists: file.exists }))).toEqual([
      { name: 'README.md', sources: ['mentioned'], line: 2, exists: true },
      { name: 'made.md', sources: ['wrote'], line: null, exists: false },
    ]);
  });
});

describe('browsing an agent\'s folders', () => {
  it("lists folders first, then files, without git's own folder and without a link that leaves the folders", async () => {
    const listing = await service().dir(session, null);
    expect(listing.entries.map((entry) => `${entry.type}:${entry.name}`)).toEqual(['dir:bin', 'dir:src', 'file:.env', 'file:data.blob', 'file:long.log', 'file:README.md']);
    expect(listing.parent).toBeNull();
    expect((await service().dir(session, 'src')).parent).toBe(root);
  });
});

describe('reading a file', () => {
  it('shows nothing of a file that looks like it holds secrets until it is asked for again with a confirmation', async () => {
    const files = service();
    const { real, allowedBy } = await files.allow(session, '.env');
    const meta = await files.metaOf(real, allowedBy);
    expect(meta.secret).not.toBeNull();
    await expect(files.text(real, meta, 0, 100, false)).rejects.toMatchObject({ code: 'secret' });
    expect((await files.text(real, meta, 0, 100, true)).lines).toEqual(['PLACEHOLDER=not-a-real-value']);
  });

  it('gives text in pages with the total, and no text for a file that is not text', async () => {
    const files = service();
    const log = await files.allow(session, 'long.log');
    const meta = await files.metaOf(log.real, log.allowedBy);
    const first = await files.text(log.real, meta, 0, 2000, false);
    expect([first.lines.length, first.lines[0], first.lines[1999], first.totalLines, first.more]).toEqual([2000, 'line 1', 'line 2000', 5000, true]);
    const last = await files.text(log.real, meta, 4000, 2000, false);
    expect([last.offset, last.lines.length, last.lines[999], last.more]).toEqual([4000, 1000, 'line 5000', false]);

    const blob = await files.allow(session, 'data.blob');
    const blobMeta = await files.metaOf(blob.real, blob.allowedBy);
    expect(blobMeta.kind).toBe('binary');
    await expect(files.text(blob.real, blobMeta, 0, 100, false)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reads a big file as a stream: one enormous line is cut and never held whole, and a far page is found', async () => {
    const files = service();
    // 3 MiB on one line (a minified bundle, a data dump), then two ordinary lines.
    await put(path.join(root, 'dump.json'), `${'x'.repeat(3 * 1024 * 1024)}\nsecond\nthird\n`);
    const dump = await files.allow(session, 'dump.json');
    const dumpText = await files.text(dump.real, await files.metaOf(dump.real, dump.allowedBy), 0, 10, false);
    expect(dumpText.lines.length).toBe(3);
    expect(dumpText.lines[0]?.length).toBeLessThan(6000);
    expect(dumpText.lines[0]?.startsWith('xxxxxxxx')).toBe(true);
    expect([dumpText.lines[1], dumpText.lines[2], dumpText.more, dumpText.totalLines]).toEqual(['second', 'third', false, null]);

    // 300,000 lines (over 2 MiB, CRLF): a page far down, and whether more follows.
    await put(path.join(root, 'server.log'), Array.from({ length: 300_000 }, (_, i) => `row ${i + 1}\r\n`).join(''));
    const log = await files.allow(session, 'server.log');
    const meta = await files.metaOf(log.real, log.allowedBy);
    const page = await files.text(log.real, meta, 250_000, 3, false);
    expect([page.offset, page.lines, page.more]).toEqual([250_000, ['row 250001', 'row 250002', 'row 250003'], true]);
    const end = await files.text(log.real, meta, 299_998, 10, false);
    expect([end.lines, end.more]).toEqual([['row 299999', 'row 300000'], false]);
  });
});

describe('handing a file to the operating system', () => {
  it('opens a document with the OS opener of each system, and shows it in its folder', async () => {
    const readme = path.join(root, 'README.md');
    await service('win32').open(readme, 'app');
    await service('win32').open(readme, 'folder');
    await service('darwin').open(readme, 'app');
    await service('darwin').open(readme, 'folder');
    await service('linux').open(readme, 'app');
    await service('linux').open(readme, 'folder');
    const calls = await openerCalls(6);
    // The six calls are started one after another, but each is its own process: compare as a set.
    expect(calls.map((argv) => argv.join(' ')).sort()).toEqual(
      [`explorer ${readme}`, `explorer /select, ${readme}`, `open ${readme}`, `open -R ${readme}`, `xdg-open ${readme}`, `xdg-open ${root}`].sort(),
    );
  });

  it('opens only documents, pictures, sound and film in their app: nothing the system could run, on any system', async () => {
    // What a file's app is, is the system's choice (on Windows a `.py` runs, a `.url` or `.chm` launches, `.html` and `.svg` run script in the browser).
    const never = ['bin/tool.exe', 'run.ps1', 'build.sh', 'report.py', 'link.url', 'help.chm', 'page.html', 'logo.svg', 'setup.msi', 'macro.docm', 'Makefile', 'trailing.exe.', 'picture.png '];
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const name of never) await expect(service(platform).open(path.join(root, name), 'app'), `${platform} ${name}`).rejects.toMatchObject({ code: 'invalid' });
    }
    // Showing one of them in its folder is still allowed (nothing runs).
    const tool = path.join(root, 'bin', 'tool.exe');
    await service('win32').open(tool, 'folder');
    const picture = path.join(root, 'shot.PNG');
    const paper = path.join(root, 'paper.pdf');
    await service('linux').open(picture, 'app');
    await service('linux').open(paper, 'app');
    expect((await openerCalls(3)).map((argv) => argv.join(' ')).sort()).toEqual([`explorer /select, ${tool}`, `xdg-open ${paper}`, `xdg-open ${picture}`].sort());
  });

  it('refuses a Windows path with a comma (Explorer splits its arguments at commas)', async () => {
    await expect(service('win32').open(path.join(root, 'a,b.png'), 'app')).rejects.toMatchObject({ code: 'invalid' });
    await expect(service('win32').open(path.join(root, 'a,b.png'), 'folder')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('showing an HTML file as a page', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  /** The page's own statement of its rules, as it is put into the page. */
  const META = { off: pageMetaTag(false), on: pageMetaTag(true) };
  /** A built page with every file that was put into it written as `"…"`. */
  const shape = (html: string): string => html.replace(/"data:[^"]+"/g, '"…"');

  /** The page of a file of the agent, built (without its scripts unless asked). */
  async function built(files: AgentFileService, name: string, options: { confirm?: boolean; scripts?: boolean; version?: string } = {}) {
    const allowed = await files.allow(session, name);
    const meta = await files.metaOf(allowed.real, allowed.allowedBy);
    return files.page(session, allowed.real, meta, { confirm: options.confirm ?? false, scripts: options.scripts ?? false, version: options.version });
  }

  const SITE = '<!doctype html>\n<html><head>\n<link rel="stylesheet" href="styles.css">\n</head><body>\n<h1>Acme</h1>\n<img src="img/logo.png" alt="Acme">\n<script src="./app.js?v=2" defer></script>\n</body></html>\n';

  async function site(): Promise<void> {
    await put(path.join(root, 'site', 'styles.css'), 'body { color: #222; }\n');
    await put(path.join(root, 'site', 'app.js'), "document.title = 'Acme é';\n");
    await put(path.join(root, 'site', 'img', 'logo.png'), PNG);
    await put(path.join(root, 'site', 'index.html'), SITE);
  }

  it("shows a page without its scripts unless they are asked for: its stylesheet and picture are put into it, its script is left alone", async () => {
    await site();
    asked.read.length = 0;
    const page = await built(service(), 'site/index.html');
    expect(page.info).toEqual({ loaded: 2, left: [], leftMore: 0, scripted: true });
    const css = /<link rel="stylesheet" href="data:text\/css;charset=utf-8;base64,([^"]+)">/.exec(page.html);
    const png = /<img src="data:image\/png;base64,([^"]+)" alt="Acme">/.exec(page.html);
    expect(Buffer.from(css?.[1] ?? '', 'base64').toString('utf8')).toBe('body { color: #222; }\n');
    expect(Buffer.from(png?.[1] ?? '', 'base64').equals(PNG)).toBe(true);
    // Its rules stand right after the doctype (no scripts at all); nothing else of the page changed, and the script was not even read.
    expect(shape(page.html)).toBe(SITE.replace('<!doctype html>', `<!doctype html>${META.off}`).replace('"styles.css"', '"…"').replace('"img/logo.png"', '"…"'));
    expect(META.off).toContain("script-src 'none'");
    expect(asked.read.filter((file) => /app\.js$/.test(file))).toEqual([]);
  });

  it('with its scripts, puts its script into it as well, and states the rules that let scripts run', async () => {
    await site();
    const page = await built(service(), 'site/index.html', { scripts: true });
    expect(page.info).toEqual({ loaded: 3, left: [], leftMore: 0, scripted: true });
    const js = /<script src="data:text\/javascript;charset=utf-8;base64,([^"]+)" defer><\/script>/.exec(page.html);
    expect(Buffer.from(js?.[1] ?? '', 'base64').toString('utf8')).toBe("document.title = 'Acme é';\n");
    expect(shape(page.html)).toBe(SITE.replace('<!doctype html>', `<!doctype html>${META.on}`).replace('"styles.css"', '"…"').replace('"img/logo.png"', '"…"').replace('"./app.js?v=2"', '"…"'));
    expect(META.on).not.toBe(META.off);
  });

  it("loads nothing from another address, from outside the page's own folders, or that is not a stylesheet, a script or a picture, and says what it left out", async () => {
    const second = path.join(tmp, 'second');
    await put(path.join(second, 'lib.js'), 'export const lib = 1;\n');
    await put(path.join(second, 'linked.js'), 'export const linked = 1;\n');
    // The agent works in two folders: a page of one is given no file of the other, also not through a link that leads there.
    session = { ...session, root: second };
    await mkdir(path.join(root, 'site'), { recursive: true });
    await symlink(second, path.join(root, 'site', 'other'), process.platform === 'win32' ? 'junction' : 'dir');
    await put(path.join(root, 'site', 'secrets.png'), PNG);
    await put(path.join(outside, 'private.css'), 'body { color: red; }\n');
    await put(path.join(outside, 'linked.css'), 'body { color: red; }\n');
    await put(path.join(root, '.git', 'config.css'), 'body {}\n');
    // The shape of a key block only (a placeholder, no key).
    await put(path.join(root, 'site', 'key.js'), 'const block = "-----BEGIN PRIVATE KEY-----";\n');
    await put(path.join(root, 'site', 'film.mp4'), Buffer.from([0, 0, 0, 0]));
    const refs: Array<readonly [string, string, AgentPageLeftWhy]> = [
      ['<script src="{}"></script>', 'https://cdn.example.com/lib.js', 'remote'],
      ['<link rel="stylesheet" href="{}">', '//cdn.example.com/a.css', 'remote'],
      ['<link rel="stylesheet" href="{}">', '\\\\sb-no-such-host.invalid\\share\\a.css', 'remote'],
      ['<link rel="stylesheet" href="{}">', '%5C%5Csb-no-such-host.invalid%5Cshare%5Cb.css', 'remote'],
      ['<link rel="stylesheet" href="{}">', '/css/site.css', 'site-root'],
      ['<link rel="stylesheet" href="{}">', 'missing.css', 'missing'],
      ['<link rel="stylesheet" href="{}">', 'bad%00name.css', 'missing'],
      ['<link rel="stylesheet" href="{}">', '../../elsewhere/private.css', 'outside'],
      ['<link rel="stylesheet" href="{}">', '../way-out/linked.css', 'outside'],
      ['<script src="{}"></script>', '../../second/lib.js', 'outside'],
      ['<script src="{}"></script>', 'other/linked.js', 'outside'],
      ['<link rel="stylesheet" href="{}">', '../.git/config.css', 'outside'],
      ['<link rel="stylesheet" href="{}">', '../.env', 'kind'],
      ['<script src="{}"></script>', '../README.md', 'kind'],
      ['<img src="{}">', '../src/app.ts', 'kind'],
      ['<script src="{}"></script>', 'key.js', 'secret'],
      // A picture is judged by its name alone.
      ['<img src="{}">', 'secrets.png', 'secret'],
      ['<video src="{}"></video>', 'film.mp4', 'kind'],
    ];
    const source = `<!doctype html><html><body>\n${refs.map(([tag, ref]) => tag.replace('{}', ref)).join('\n')}\n</body></html>\n`;
    await put(path.join(root, 'site', 'index.html'), source);
    asked.paths.length = 0;
    const page = await built(service(), 'site/index.html', { scripts: true });
    expect(page.info).toEqual({ loaded: 0, left: refs.map(([, ref, why]) => ({ ref, why })), leftMore: 0, scripted: true });
    // The page is as it was written but for its rules: nothing was put into it.
    expect(page.html).toBe(source.replace('<!doctype html>', `<!doctype html>${META.on}`));
    // What is never loaded is not looked at either: no other host, no file outside the page's own folders, none that is not a stylesheet, a script or a picture.
    expect(asked.paths.length).toBeGreaterThan(0);
    expect(asked.paths.filter((asking) => /sb-no-such-host|\.env$|README\.md$|app\.ts$|film\.mp4$|private\.css$|lib\.js$/i.test(asking))).toEqual([]);
  });

  it("gives nothing to a page that is outside the agent's folders, even a file the conversation touched", async () => {
    const elsewhere = await put(path.join(outside, 'page.html'), '<!doctype html><link rel="stylesheet" href="private.css"><p>hi</p>');
    const css = await put(path.join(outside, 'private.css'), 'body { color: red; }\n');
    read = [elsewhere, css];
    const page = await built(service(), elsewhere);
    expect(page.info).toEqual({ loaded: 0, left: [{ ref: 'private.css', why: 'outside' }], leftMore: 0, scripted: false });
    // As it was written but for its rules: the stylesheet next to it was not put in.
    expect(page.html).toBe(`<!doctype html>${META.off}<link rel="stylesheet" href="private.css"><p>hi</p>`);
  });

  it('sets aside what would undo it: a srcset and an integrity once the file is in the page, a picture\'s other sources and a link that only hints in any case', async () => {
    await put(path.join(root, 'site', 'logo.png'), PNG);
    await put(path.join(root, 'site', 'a.css'), 'p{}');
    const source =
      '<img srcset="logo.png 1x, big.png 2x" src="logo.png"><img srcset="gone.png 2x" src="gone.png">' +
      '<picture><source srcset="big.webp" type="image/webp"><img src="logo.png"></picture>' +
      '<link rel="stylesheet" href="a.css" integrity="sha256-x"><link rel="preconnect" href="https://example.com"><img src="gone.png">';
    await put(path.join(root, 'site', 'index.html'), source);
    const page = await built(service(), 'site/index.html');
    expect(shape(page.html)).toBe(
      `${META.off}<img data-srcset="logo.png 1x, big.png 2x" src="…"><img srcset="gone.png 2x" src="gone.png">` +
        '<picture><source data-srcset="big.webp" type="image/webp"><img src="…"></picture>' +
        '<link rel="stylesheet" href="…" data-integrity="sha256-x"><link rel="preconnect" data-href="https://example.com"><img src="gone.png">',
    );
    // One picture used twice is one file; an address left out twice is said once.
    expect(page.info).toEqual({ loaded: 2, left: [{ ref: 'gone.png', why: 'missing' }], leftMore: 0, scripted: false });
  });

  it('stops putting files in once they are too much together, lists only the first of many left out, and looks up only so many', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    await put(path.join(root, 'site', 'one.js'), big);
    await put(path.join(root, 'site', 'two.js'), big);
    await put(path.join(root, 'site', 'small.css'), 'p{}');
    await put(path.join(root, 'site', 'index.html'), '<script src="one.js"></script><script src="two.js"></script><link rel="stylesheet" href="small.css">');
    const page = await built(service(), 'site/index.html', { scripts: true });
    expect(page.info).toEqual({ loaded: 2, left: [{ ref: 'two.js', why: 'too-large' }], leftMore: 0, scripted: true });
    expect(page.html).toContain('<script src="two.js"></script>');
    // Each use of a file puts it in again and counts: the second use of a big one no longer fits.
    await put(path.join(root, 'site', 'twice.html'), '<script src="one.js"></script><script src="one.js"></script>');
    const twice = await built(service(), 'site/twice.html', { scripts: true });
    expect(twice.info).toEqual({ loaded: 1, left: [{ ref: 'one.js', why: 'too-large' }], leftMore: 0, scripted: true });
    expect(shape(twice.html)).toBe(`${META.on}<script src="…"></script><script src="one.js"></script>`);

    const many = Array.from({ length: AGENT_PAGE_LEFT_MAX + 7 }, (_, index) => `<img src="https://example.com/${index}.png">`).join('');
    await put(path.join(root, 'site', 'many.html'), many);
    const listed = (await built(service(), 'site/many.html')).info;
    expect([listed.left.length, listed.left[0], listed.leftMore]).toEqual([AGENT_PAGE_LEFT_MAX, { ref: 'https://example.com/0.png', why: 'remote' }, 7]);

    // 405 files that are not there: the disk is asked about 400 of them.
    await put(path.join(root, 'site', 'gone.html'), Array.from({ length: 405 }, (_, index) => `<link rel="stylesheet" href="m${index}.css">`).join(''));
    asked.paths.length = 0;
    const gone = (await built(service(), 'site/gone.html')).info;
    expect([gone.loaded, gone.left.length + gone.leftMore]).toEqual([0, 405]);
    expect(new Set(asked.paths.filter((asking) => /[\\/]m\d+\.css$/.test(asking))).size).toBe(400);
  });

  it('does not show a page that is too big, also one that grew after its size was read', async () => {
    const files = service();
    await put(path.join(root, 'site', 'huge.html'), `<!doctype html><p>${'x'.repeat(AGENT_PAGE_BYTES)}</p>`);
    await expect(built(files, 'site/huge.html')).rejects.toMatchObject({ code: 'too-large' });
    const grows = await put(path.join(root, 'site', 'grows.html'), '<p>small</p>');
    const allowed = await files.allow(session, grows);
    const meta = await files.metaOf(allowed.real, allowed.allowedBy);
    await put(grows, `<p>${'x'.repeat(AGENT_PAGE_BYTES)}</p>`);
    await expect(files.page(session, allowed.real, meta, { confirm: false, scripts: false })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('shows only an HTML file as a page, and one that looks like it holds secrets only when asked again', async () => {
    const files = service();
    await expect(built(files, 'README.md')).rejects.toMatchObject({ code: 'invalid' });
    // Other text is no page either.
    await expect(built(files, 'src/app.ts')).rejects.toMatchObject({ code: 'invalid' });
    await put(path.join(root, 'site', 'old.htm'), '<p>old</p>');
    expect((await built(files, 'site/old.htm')).html).toBe(`${META.off}<p>old</p>`);
    // The shape of a key block only (a placeholder, no key).
    await put(path.join(root, 'site', 'keys.html'), '<!doctype html><pre>-----BEGIN PRIVATE KEY-----</pre>');
    await expect(built(files, 'site/keys.html')).rejects.toMatchObject({ code: 'secret' });
    expect((await built(files, 'site/keys.html', { confirm: true })).html).toContain('<pre>');
  });

  it('reads the whole of a file before putting it in: what looks like a secret far down keeps it out', async () => {
    // Past the 64 KiB the file's facts are read from. The shape of a key block only (a placeholder, no key).
    await put(path.join(root, 'site', 'late.js'), `${'// filler line\n'.repeat(6000)}const block = "-----BEGIN PRIVATE KEY-----";\n`);
    await put(path.join(root, 'site', 'index.html'), '<script src="late.js"></script>');
    expect((await built(service(), 'site/index.html', { scripts: true })).info).toEqual({ loaded: 0, left: [{ ref: 'late.js', why: 'secret' }], leftMore: 0, scripted: true });
  });

  it("puts a text file in as UTF-8, whatever its own encoding and mark", async () => {
    await put(path.join(root, 'site', 'bom.css'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('p::after { content: "é"; }\n', 'utf8')]));
    await put(path.join(root, 'site', 'wide.js'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("document.title = 'é';\n", 'utf16le')]));
    await put(path.join(root, 'site', 'index.html'), '<link rel="stylesheet" href="bom.css"><script src="wide.js"></script>');
    const page = await built(service(), 'site/index.html', { scripts: true });
    const css = /href="data:text\/css;charset=utf-8;base64,([^"]+)"/.exec(page.html);
    const js = /src="data:text\/javascript;charset=utf-8;base64,([^"]+)"/.exec(page.html);
    expect(Buffer.from(css?.[1] ?? '', 'base64').toString('hex')).toBe(Buffer.from('p::after { content: "é"; }\n', 'utf8').toString('hex'));
    expect(Buffer.from(js?.[1] ?? '', 'base64').toString('utf8')).toBe("document.title = 'é';\n");
  });

  it('builds a page once for what is said about it and for the page itself, and again when it is asked for anew', async () => {
    await site();
    const files = service();
    const allowed = await files.allow(session, 'site/index.html');
    const meta = await files.metaOf(allowed.real, allowed.allowedBy);
    const styles = (): number => asked.read.filter((file) => /styles\.css$/.test(file)).length;
    asked.read.length = 0;
    const info = await files.pageInfo(session, allowed.real, meta, { confirm: false, scripts: false });
    const page = await files.page(session, allowed.real, meta, { confirm: false, scripts: false });
    expect(page.info).toEqual(info);
    expect(styles()).toBe(1);
    // Reload (another version), and the page with its scripts, are other builds.
    await files.page(session, allowed.real, meta, { confirm: false, scripts: false, version: '2' });
    expect(styles()).toBe(2);
    expect((await files.pageInfo(session, allowed.real, meta, { confirm: false, scripts: true, version: '2' })).loaded).toBe(3);
    expect(styles()).toBe(3);
  });

  it('answers that the file is gone when it went between its facts and its reading', async () => {
    const files = service();
    const gone = await put(path.join(root, 'site', 'gone.html'), '<p>here</p>');
    const allowed = await files.allow(session, gone);
    const meta = await files.metaOf(allowed.real, allowed.allowedBy);
    await rm(gone);
    await expect(files.page(session, allowed.real, meta, { confirm: false, scripts: false })).rejects.toMatchObject({ code: 'missing' });
  });

  it('checks the kind of a file again where a link leads', async (context) => {
    await put(path.join(root, 'site', 'notes.txt'), 'not a stylesheet\n');
    try {
      await symlink(path.join(root, 'site', 'notes.txt'), path.join(root, 'site', 'styles.css'), 'file');
    } catch {
      // This system does not let the tests make a link to a file (Windows without the right): nothing to check here.
      context.skip();
      return;
    }
    await put(path.join(root, 'site', 'index.html'), '<link rel="stylesheet" href="styles.css">');
    expect((await built(service(), 'site/index.html')).info.left).toEqual([{ ref: 'styles.css', why: 'kind' }]);
  });
});
