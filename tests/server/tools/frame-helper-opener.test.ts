import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXTENSIONS_URL,
  FRAME_HELPER_DIR,
  OpenFailedError,
  createFrameHelperOpener,
  extensionsCommands,
  launch,
  readFrameHelperInfo,
  revealCommand,
  windowsChromePaths,
} from '../../../src/server/tools/frame-helper.ts';
import { fakeOpenerCommand } from '../../../tools/fake-opener/command.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * D35 (docs/frame-helper.md → Guided setup): the setup's OS commands per platform
 * (fixed argv, the platform injected), the detached launcher, and the opener run
 * through tools/fake-opener, which records its argv and never opens anything.
 */

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
};
const WIN_DIR = 'C:\\Users\\dev\\Acme Corp\\switchboard\\tools\\frame-helper';

let tmp: string;
let log: string;

beforeEach(async () => {
  tmp = await makeTempDir('frame-helper-opener');
  log = path.join(tmp, 'opener.log');
});

afterEach(async () => {
  await removeTempDir(tmp);
});

/** The argv of every fake-opener call so far. */
async function calls(): Promise<string[][]> {
  let text = '';
  try {
    text = await readFile(log, 'utf8');
  } catch {
    return [];
  }
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

describe('the folder and its version', () => {
  it('is tools/frame-helper of this checkout, with the manifest version', async () => {
    const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'tools', 'frame-helper', 'manifest.json'), 'utf8')) as { version: string };
    expect(FRAME_HELPER_DIR).toBe(path.join(REPO_ROOT, 'tools', 'frame-helper'));
    expect(path.isAbsolute(FRAME_HELPER_DIR)).toBe(true);
    expect(await readFrameHelperInfo()).toEqual({ path: FRAME_HELPER_DIR, version: manifest.version });
  });

  it('refuses a manifest without a version', async () => {
    await writeFile(path.join(tmp, 'manifest.json'), '{"name":"x"}');
    await expect(readFrameHelperInfo(tmp)).rejects.toThrow('has no version');
  });
});

describe('commands per platform (fixed argv)', () => {
  it('reveal: open -R on macOS, explorer /select, on Windows, xdg-open elsewhere', () => {
    expect(revealCommand('darwin', '/Users/dev/sb/tools/frame-helper')).toEqual({ argv: ['open', '-R', '/Users/dev/sb/tools/frame-helper/manifest.json'] });
    expect(revealCommand('win32', WIN_DIR)).toEqual({ argv: ['explorer', '/select,', `${WIN_DIR}\\manifest.json`], anyExitCode: true });
    expect(revealCommand('linux', '/home/dev/sb/tools/frame-helper')).toEqual({ argv: ['xdg-open', '/home/dev/sb/tools/frame-helper'] });
    expect(revealCommand('freebsd', '/home/dev/sb/tools/frame-helper')).toEqual({ argv: ['xdg-open', '/home/dev/sb/tools/frame-helper'] });
  });

  it('extensions page: open -a "Google Chrome" on macOS; google-chrome then chromium on Linux', async () => {
    expect(await extensionsCommands('darwin', {})).toEqual([{ argv: ['open', '-a', 'Google Chrome', 'chrome://extensions'] }]);
    expect(await extensionsCommands('linux', {})).toEqual([{ argv: ['google-chrome', 'chrome://extensions'] }, { argv: ['chromium', 'chrome://extensions'] }]);
    expect(EXTENSIONS_URL).toBe('chrome://extensions');
  });

  it('extensions page on Windows: each chrome.exe that exists, then cmd /c start (an argv array)', async () => {
    expect(windowsChromePaths(WIN_ENV)).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
    // Relative or missing variables are skipped; the same path (any case) is listed once, in the first form seen.
    expect(windowsChromePaths({ ProgramFiles: 'relative', 'ProgramFiles(x86)': 'c:\\l\\..\\L', LOCALAPPDATA: 'C:\\L' })).toEqual([
      'c:\\L\\Google\\Chrome\\Application\\chrome.exe',
    ]);
    const asked: string[] = [];
    const commands = await extensionsCommands('win32', WIN_ENV, async (file) => {
      asked.push(file);
      return file.startsWith('C:\\Users');
    });
    expect(asked).toHaveLength(3);
    expect(commands).toEqual([
      { argv: ['C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe', 'chrome://extensions'] },
      { argv: ['cmd', '/c', 'start', '', 'chrome', 'chrome://extensions'] },
    ]);
    expect(await extensionsCommands('win32', {}, async () => true)).toEqual([{ argv: ['cmd', '/c', 'start', '', 'chrome', 'chrome://extensions'] }]);
  });
});

describe('launch', () => {
  const node = (script: string): readonly string[] => [process.execPath, '-e', script];

  it('works when the command exits 0; fails with its stderr otherwise; anyExitCode accepts any exit', async () => {
    expect(await launch({ argv: ['open', '-R', 'x'] }, { prefix: node('process.exit(0)') })).toEqual({ ok: true, error: null });
    expect(await launch({ argv: ['open', '-R', 'x'] }, { prefix: node("process.stderr.write('no such app\\n'); process.exit(1)") })).toEqual({
      ok: false,
      error: 'open -R x: no such app',
    });
    expect(await launch({ argv: ['open', '-R', 'x'] }, { prefix: node('process.exit(3)') })).toEqual({ ok: false, error: 'open -R x: exit code 3' });
    expect(await launch({ argv: ['explorer', '/select,', 'x'], anyExitCode: true }, { prefix: node('process.exit(1)') })).toEqual({ ok: true, error: null });
  });

  it('fails when the command cannot start (not found)', async () => {
    const outcome = await launch({ argv: [path.join(tmp, 'no-such-opener'), 'chrome://extensions'] });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain(`${path.join(tmp, 'no-such-opener')} chrome://extensions: `);
    expect(outcome.error).toContain('ENOENT');
  });

  it('counts a command still running after the grace time as started (a browser that was not open yet)', async () => {
    const started = Date.now();
    expect(await launch({ argv: ['google-chrome', 'chrome://extensions'] }, { prefix: node('setTimeout(() => {}, 1500)'), graceMs: 150 })).toEqual({ ok: true, error: null });
    expect(Date.now() - started).toBeLessThan(1_400);
  });
});

describe('createFrameHelperOpener through tools/fake-opener', () => {
  const opener = (platform: NodeJS.Platform, extra: NodeJS.ProcessEnv = {}, exists?: (file: string) => Promise<boolean>) =>
    createFrameHelperOpener({
      dir: platform === 'win32' ? WIN_DIR : '/Users/dev/Acme Corp/sb/tools/frame-helper',
      platform,
      prefix: fakeOpenerCommand(),
      env: { ...process.env, ...(platform === 'win32' ? WIN_ENV : {}), FAKE_OPENER_LOG: log, ...extra },
      ...(exists ? { exists } : {}),
    });

  it('runs the exact argv of each platform', async () => {
    await opener('darwin').reveal();
    await opener('darwin').openExtensions();
    await opener('linux').reveal();
    await opener('linux').openExtensions();
    await opener('win32', {}, async (file) => file.startsWith('C:\\Program Files\\')).reveal();
    await opener('win32', {}, async (file) => file.startsWith('C:\\Program Files\\')).openExtensions();
    expect(await calls()).toEqual([
      ['open', '-R', '/Users/dev/Acme Corp/sb/tools/frame-helper/manifest.json'],
      ['open', '-a', 'Google Chrome', 'chrome://extensions'],
      ['xdg-open', '/Users/dev/Acme Corp/sb/tools/frame-helper'],
      ['google-chrome', 'chrome://extensions'],
      ['explorer', '/select,', `${WIN_DIR}\\manifest.json`],
      ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'chrome://extensions'],
    ]);
  });

  it('tries the next command when one fails, and rejects with every failure when all do', async () => {
    await opener('linux', { FAKE_OPENER_FAIL: 'google-chrome' }).openExtensions();
    await opener('win32', { FAKE_OPENER_FAIL: 'chrome.exe' }, async () => true).openExtensions();
    expect(await calls()).toEqual([
      ['google-chrome', 'chrome://extensions'],
      ['chromium', 'chrome://extensions'],
      ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'chrome://extensions'],
      ['C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'chrome://extensions'],
      ['C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe', 'chrome://extensions'],
      ['cmd', '/c', 'start', '', 'chrome', 'chrome://extensions'],
    ]);

    const failing = opener('linux', { FAKE_OPENER_FAIL: 'chrome://extensions' }).openExtensions();
    await expect(failing).rejects.toBeInstanceOf(OpenFailedError);
    await expect(failing).rejects.toThrow(
      'google-chrome chrome://extensions: fake-opener: google-chrome chrome://extensions failed; chromium chrome://extensions: fake-opener: chromium chrome://extensions failed',
    );
    await expect(opener('darwin', { FAKE_OPENER_FAIL: '-R' }).reveal()).rejects.toThrow(
      'open -R /Users/dev/Acme Corp/sb/tools/frame-helper/manifest.json: fake-opener: open -R /Users/dev/Acme Corp/sb/tools/frame-helper/manifest.json failed',
    );
  });
});
