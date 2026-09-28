import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect } from '@playwright/test';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * A real-path world for the notification specs (M3.4, D13): `node src/server/main.ts`
 * with fake-claude as the CLI, fake gh, and a temp workspace holding one real git
 * repo (`microfrontends/acme-app-front`), so a session started with worktrees gets
 * a branch chip (`acme-app-front ⎇ session/<name>`, gap #1). No demo seed.
 */
export interface QuestionWorld {
  readonly server: ServerProcess;
  readonly baseUrl: string;
  /** Starts a session in `acme-app-front` through `POST /api/sessions` from the page (same origin, the sb_token cookie). */
  startSession(page: Page, name: string, task: string, worktrees?: boolean): Promise<{ id: string }>;
  stop(): Promise<void>;
}

/** Starts the world (the server is stopped and the temp folder removed by `stop()`). */
export async function startQuestionWorld(label: string): Promise<QuestionWorld> {
  const tmp = await realpath(await makeTempDir(label));
  try {
    const workspace = path.join(tmp, 'work space');
    const repo = path.join(workspace, 'microfrontends', 'acme-app-front');
    const gitConfig = path.join(tmp, 'gitconfig');
    const prsFile = path.join(tmp, 'fake-gh-prs.json');
    await mkdir(repo, { recursive: true });
    await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
    await writeFile(gitConfig, '');
    await writeFile(prsFile, '{}');
    const gitEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Switchboard Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Switchboard Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    const git = async (...args: string[]): Promise<void> => {
      const result = await runCommand(['git'], args, { cwd: repo, env: { ...process.env, ...gitEnv } });
      if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
    };
    await git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'README.md'), 'hello\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'init');

    const server = await startServer({
      ...gitEnv,
      SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
      SWITCHBOARD_WORKSPACE_ROOT: workspace,
      SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
      SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
      FAKE_GH_PRS: prsFile,
    });
    return {
      server,
      baseUrl: server.baseUrl,
      async startSession(page, name, task, worktrees = false) {
        const result = await page.evaluate(
          async (body) => {
            const response = await fetch('/api/sessions', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as { id: string } };
          },
          {
            name,
            task,
            workType: 'feature',
            mode: 'single',
            solutions: ['acme-app-front'],
            phase: 'ui-first',
            coordination: 'none',
            qa: null,
            worktrees,
            ultracode: false,
          },
        );
        expect(result.status).toBe(201);
        return result.body;
      },
      async stop() {
        try {
          expect(await server.stop()).toBe(0);
        } finally {
          await removeTempDir(tmp);
        }
      },
    };
  } catch (error) {
    await removeTempDir(tmp);
    throw error;
  }
}

/** Opens `route` and waits until the page's `/hub` stream is open, so no `questionBatch` is missed. */
export async function openWithHub(page: Page, url: string): Promise<void> {
  const hub = page.waitForResponse((response) => new URL(response.url()).pathname === '/hub');
  await page.goto(url);
  expect((await hub).status()).toBe(200);
}

/** What the mocked Web Audio and Web Notifications APIs recorded in the page. */
export interface MockRecord {
  /** `new AudioContext()` calls. */
  readonly contexts: number;
  /** `close()` calls. */
  readonly closed: number;
  /** One entry per oscillator: frequency, start and stop (seconds of context time). */
  readonly tones: ReadonlyArray<{ readonly hz: number; readonly start: number; readonly stop: number; readonly toDestination: boolean }>;
  /** Gain automation, in call order: `set <value> @<t>` / `ramp <value> @<t>`. */
  readonly gains: readonly string[];
  readonly notifications: ReadonlyArray<{ readonly title: string; readonly body: string; readonly tag: string; readonly closed: boolean }>;
  /** `Notification.requestPermission()` calls. */
  readonly permissionRequests: number;
  /** `window.focus()` calls. */
  readonly focus: number;
}

interface MockState {
  contexts: number;
  closed: number;
  tones: Array<{ hz: number; start: number; stop: number; toDestination: boolean }>;
  gains: string[];
  notifications: Array<{ title: string; body: string; tag: string; closed: boolean; onclick: (() => unknown) | null; close(): void }>;
  permissionRequests: number;
  focus: number;
}

/**
 * Replaces `window.Notification` (with `permission`) and `window.AudioContext`
 * with recording doubles before the app loads (M3.4 oracle: "E2E with a mocked
 * Notification"); `window.focus` is counted. Read them with {@link readMocks}.
 */
export async function installNotificationMocks(page: Page, permission: 'granted' | 'default' | 'denied'): Promise<void> {
  await page.addInitScript((perm: string) => {
    const state: MockState = { contexts: 0, closed: 0, tones: [], gains: [], notifications: [], permissionRequests: 0, focus: 0 };
    (window as unknown as { __sbMocks: MockState }).__sbMocks = state;
    const round = (value: number): number => Math.round(value * 1000) / 1000;

    class MockNotification {
      static permission = perm;
      static requestPermission(): Promise<string> {
        state.permissionRequests += 1;
        return Promise.resolve(perm);
      }
      readonly title: string;
      readonly body: string;
      readonly tag: string;
      closed = false;
      onclick: (() => unknown) | null = null;
      constructor(title: string, options?: { body?: string; tag?: string }) {
        this.title = title;
        this.body = options?.body ?? '';
        this.tag = options?.tag ?? '';
        state.notifications.push(this);
      }
      close(): void {
        this.closed = true;
      }
    }

    class MockParam {
      value = 0;
      setValueAtTime(value: number, time: number): void {
        state.gains.push(`set ${value} @${round(time)}`);
      }
      exponentialRampToValueAtTime(value: number, time: number): void {
        state.gains.push(`ramp ${value} @${round(time)}`);
      }
    }

    class MockAudioContext {
      readonly state = 'running';
      readonly currentTime = 0;
      readonly destination = { kind: 'destination' };
      constructor() {
        state.contexts += 1;
      }
      createOscillator() {
        const tone = { hz: 0, start: -1, stop: -1, toDestination: false };
        const frequency = new MockParam();
        state.tones.push(tone);
        return {
          frequency,
          // oscillator → gain: the gain node remembers its tone, so gain → destination can mark it.
          connect: (gain: { tone?: typeof tone }) => {
            tone.hz = frequency.value;
            gain.tone = tone;
            return gain;
          },
          start: (when = 0) => {
            tone.start = round(when);
          },
          stop: (when = 0) => {
            tone.stop = round(when);
          },
        };
      }
      createGain() {
        const node: { gain: MockParam; tone?: { toDestination: boolean }; connect: (target: unknown) => unknown } = {
          gain: new MockParam(),
          connect: (target: unknown) => {
            if (node.tone && target === this.destination) node.tone.toDestination = true;
            return target;
          },
        };
        return node;
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        state.closed += 1;
        return Promise.resolve();
      }
    }

    Object.defineProperty(window, 'Notification', { value: MockNotification, configurable: true, writable: true });
    Object.defineProperty(window, 'AudioContext', { value: MockAudioContext, configurable: true, writable: true });
    window.focus = () => {
      state.focus += 1;
    };
  }, permission);
}

/** The mocks' record (see {@link installNotificationMocks}). */
export async function readMocks(page: Page): Promise<MockRecord> {
  return page.evaluate(() => {
    const state = (window as unknown as { __sbMocks: MockState }).__sbMocks;
    return {
      contexts: state.contexts,
      closed: state.closed,
      tones: state.tones.map((tone) => ({ ...tone })),
      gains: [...state.gains],
      notifications: state.notifications.map((n) => ({ title: n.title, body: n.body, tag: n.tag, closed: n.closed })),
      permissionRequests: state.permissionRequests,
      focus: state.focus,
    };
  });
}

/** Clicks the `index`-th OS notification (runs its `onclick`, as the OS does). */
export async function clickNotification(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    const notification = (window as unknown as { __sbMocks: MockState }).__sbMocks.notifications[i];
    if (!notification?.onclick) throw new Error(`notification ${i} has no click handler`);
    notification.onclick();
  }, index);
}
