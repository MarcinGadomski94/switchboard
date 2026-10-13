import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect } from '@playwright/test';
import type { TeamMember } from '../../src/core/team.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { startServer } from '../helpers/server-process.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';

/**
 * D100 · the Team page's real-path world (D13: no demo seed; demo mode never starts
 * Team): the question world (fake-claude, fake gh, a temp workspace with one git
 * repo) plus helpers that switch Team on, start sessions, put them in a sidebar
 * folder and adopt them through the API, as the page would.
 */
export interface TeamWorld extends QuestionWorld {
  /** Calls the local API from the page (same origin, the sb_token cookie). */
  call(page: Page, method: string, url: string, body?: unknown): Promise<{ readonly status: number; readonly body: any }>;
  /** Settings → Experimental → Team through `PUT /api/settings`. */
  setTeam(page: Page, on: boolean): Promise<void>;
  /** A sidebar folder named `name` (made once), and `sessionId` placed in it. */
  placeInFolder(page: Page, sessionId: string, name: string): Promise<string>;
  /** Adopts `sessionId` as `name` through `POST /api/team/members`. */
  adopt(page: Page, sessionId: string, name: string, extra?: Record<string, unknown>): Promise<TeamMember>;
  /** Waits until the session's first turn is over (its status is no longer starting / running). */
  settle(page: Page, sessionId: string): Promise<void>;
}

/**
 * A plain world: a workspace folder without a git repo, so sessions raise no review
 * cards (the visual spec wants only the Needs-you items it makes itself).
 */
async function startPlainWorld(label: string, env: Record<string, string>): Promise<QuestionWorld> {
  const tmp = await realpath(await makeTempDir(label));
  const workspace = path.join(tmp, 'work space');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  const serverEnv = { SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'), ...env };
  let server = await startServer(serverEnv);
  return {
    get server() {
      return server;
    },
    get baseUrl() {
      return server.baseUrl;
    },
    workspace,
    configDir: path.join(tmp, 'claude-config'),
    dataDir: path.join(tmp, 'data'),
    async restart() {
      await server.stop();
      server = await startServer(serverEnv);
    },
    async startSession(page, name, task) {
      const result = await page.evaluate(async (body) => {
        const response = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: (await response.json()) as { id: string } };
      }, { name, task, workType: 'feature', mode: 'single', solutions: [], phase: 'ui-first', coordination: 'none', qa: null, worktrees: false, ultracode: false });
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
}

export async function startTeamWorld(label: string, options: { readonly env?: Record<string, string>; readonly plain?: boolean } = {}): Promise<TeamWorld> {
  const env = { SWITCHBOARD_TUTORIAL: 'off', ...options.env };
  const world = options.plain ? await startPlainWorld(label, env) : await startQuestionWorld(label, { env });
  const call: TeamWorld['call'] = (page, method, url, body) =>
    page.evaluate(
      async ({ method: m, url: u, body: b }) => {
        const response = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      },
      { method, url, body },
    );
  const folders = new Map<string, string>();
  return Object.assign(world, {
    call,
    async setTeam(page: Page, on: boolean) {
      const answer = await call(page, 'PUT', '/api/settings', { 'experimental.team': on });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    },
    async placeInFolder(page: Page, sessionId: string, name: string) {
      let id = folders.get(name);
      if (!id) {
        const made = await call(page, 'POST', '/api/sidebar/folders', { name });
        expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
        id = (made.body.folders as Array<{ id: string; name: string }>).find((folder) => folder.name === name)?.id as string;
        folders.set(name, id);
      }
      const placed = await call(page, 'POST', '/api/sidebar/place', { sessionId, place: 'folder', folderId: id });
      expect(placed.status, JSON.stringify(placed.body)).toBe(200);
      return id;
    },
    async adopt(page: Page, sessionId: string, name: string, extra: Record<string, unknown> = {}) {
      const answer = await call(page, 'POST', '/api/team/members', { sessionId, name, ...extra });
      expect(answer.status, JSON.stringify(answer.body)).toBe(201);
      return answer.body as TeamMember;
    },
    async settle(page: Page, sessionId: string) {
      await expect
        .poll(async () => (await call(page, 'GET', `/api/sessions/${sessionId}`)).body?.status as string, { timeout: 20_000 })
        .toMatch(/^(idle|done|need)$/);
    },
  });
}
