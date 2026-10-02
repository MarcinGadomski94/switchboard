import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import type { MachinesView } from '../../src/core/peers.ts';
import { remoteId } from '../../src/core/peers.ts';
import { type PeerNode, enableListener, machineOn, pairedNodes, startPeerNode, waitFor } from '../helpers/peers.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../helpers/transcripts.ts';
import { rememberNewSessionMode } from '../helpers/new-session-mode.ts';

/**
 * D48 "Switchboard peers" oracle (`docs/peers.md`): two real Switchboard
 * processes on loopback test ports act as peers (the peer listener may bind
 * 127.0.0.1 only under SWITCHBOARD_PEER_TEST_LOOPBACK=1; `tailscale ip -4` is the
 * fake CLI; the sessions run fake-claude). Each machine's UI is its own browser
 * context: the `sb_token` cookies of two ports on one host would overwrite each
 * other in one context.
 */

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-peers');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function node(label: string, env: Record<string, string> = {}): Promise<PeerNode> {
  const started = await startPeerNode(tmp, label, { env });
  nodes.push(started);
  return started;
}

async function pageOf(browser: Browser, target: PeerNode, path: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${target.baseUrl}${path}`);
  return page;
}

test('P1: pair two machines from Settings → Machines; both see each other online', async ({ browser }) => {
  const a = await node('a');
  const b = await node('b');
  // The listener's port: a free test port (13002 is the real default), then switched on from the UI.
  const port = (await freeTestPorts()).at(-1) as number;
  expect((await a.call('PUT', '/api/machines/listener', { port })).status).toBe(200);

  const pageA = await pageOf(browser, a, '/settings/machines');
  await expect(pageA.getByTestId('settings-title')).toHaveText('Machines');
  await expect(pageA.getByTestId('machines-listener')).toHaveText('off');
  await expect(pageA.getByTestId('machines-empty')).toBeVisible();
  await pageA.getByTestId('machines-listener').click();
  await expect(pageA.getByTestId('machines-listener')).toHaveText('on');
  await expect(pageA.getByTestId('machines-listener-desc')).toContainText(`127.0.0.1:${port}`);
  await pageA.getByTestId('machines-allow').click();
  const code = (await pageA.getByTestId('machines-code').textContent()) as string;
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await expect(pageA.getByTestId('machines-code-left')).toHaveText(/^(9|10):\d\d$/);

  const pageB = await pageOf(browser, b, '/settings/machines');
  await pageB.getByTestId('machines-add-address').fill(`127.0.0.1:${port}`);
  await pageB.getByTestId('machines-add-code').fill(code.toLowerCase());
  await pageB.getByTestId('machines-add').click();
  const onB = pageB.getByTestId('machine');
  await expect(onB).toHaveCount(1);
  await expect(onB.getByTestId('machine-state')).toHaveText('online', { timeout: 15_000 });

  // A lists B, without an address until B's own listener is on.
  await expect(pageA.getByTestId('machine')).toHaveCount(1, { timeout: 10_000 });
  await expect(pageA.getByTestId('machine-state')).toHaveText('no address');
  await enableListener(b);
  await expect(pageA.getByTestId('machine-state')).toHaveText('online', { timeout: 15_000 });

  // Rename on B (a local tag); a used code is refused.
  await onB.getByTestId('machine-rename').click();
  await onB.getByTestId('machine-rename-input').fill('pc-office');
  await onB.getByTestId('machine-rename-save').click();
  await expect(onB.getByTestId('machine-name')).toHaveText('pc-office');
  await pageB.getByTestId('machines-add-address').fill(`127.0.0.1:${port}`);
  await pageB.getByTestId('machines-add-code').fill(code);
  await pageB.getByTestId('machines-add').click();
  await expect(pageB.getByTestId('machines-error')).toContainText(/code/);

  // Remove on B: both forget the pairing.
  await onB.getByTestId('machine-remove').click();
  await expect(pageB.getByTestId('machines-empty')).toBeVisible();
  const bId = await b.machineId();
  await waitFor('A forgot B', async () => (await machineOn(a, bId)) === null);
  await expect(pageA.getByTestId('machines-empty')).toBeVisible({ timeout: 10_000 });
});


async function paired(): Promise<{ a: PeerNode; b: PeerNode; aId: string; aName: string }> {
  const world = await pairedNodes(tmp);
  nodes.push(world.a, world.b);
  const aName = ((await world.a.call('GET', '/api/machines')).body as MachinesView).self.name;
  return { a: world.a, b: world.b, aId: world.aId, aName };
}

test('P2: a peer\'s session in the sidebar with its tag; the full view drives it: question card, permission in the Inbox, message, pause; unreachable when the peer stops', async ({ browser }) => {
  const { a, b, aId, aName } = await paired();
  const page = await pageOf(browser, b, '/');
  await expect(page.getByTestId('view-inbox')).toBeVisible();
  const started = await a.call('POST', '/api/sessions', { name: 'on-a', task: '[fake:ask-2q] Ask me two questions.', folder: a.folderId, worktrees: false, ultracode: false });
  expect(started.status).toBe(201);
  const id = remoteId(aId, started.body.id as string);

  const row = page.locator('.sb-session', { hasText: 'on-a' });
  await expect(row.getByTestId('machine-tag')).toHaveText(aName, { timeout: 15_000 });
  await expect(row.getByTestId('machine-tag')).toHaveAttribute('data-state', 'online');
  // The question batch is in B's Inbox with the machine tag, and raised a toast here.
  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 10_000 });
  const questions = page.getByTestId('inbox-item').filter({ hasText: 'on-a' });
  await expect(questions.getByTestId('machine-tag')).toHaveText(aName);

  // The full session view, from the sidebar.
  await row.click();
  await expect(page).toHaveURL(`${b.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('session-machine')).toHaveText(aName);
  await expect(page.getByTestId('session-handoff')).toHaveCount(0);
  const view = page.getByTestId('view-session');
  const card = view.getByTestId('question-card');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Green' }).click();
  await card.getByRole('button', { name: 'Small' }).click();
  const answered = page.waitForResponse((r) => /\/api\/questions\/batch\/[^/]+\/answers$/.test(r.url()));
  await card.getByTestId('question-send').click();
  expect((await answered).status()).toBe(204);
  await expect(view.getByTestId('question-card')).toHaveCount(0);
  await expect(view.getByTestId('chat-answer')).toHaveCount(2);
  expect(((await a.call('GET', '/api/inbox')).body as unknown[]).length).toBe(0);

  // A message from B; its permission request is answered in B's Inbox.
  const input = page.getByTestId('chat-input');
  await input.fill('[fake:perm-allow] Run the command.');
  const posted = page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${id}/messages`) && r.request().method() === 'POST');
  await input.press('Enter');
  expect((await posted).status()).toBe(202);
  await page.getByTestId('nav-inbox').click();
  const permission = page.getByTestId('inbox-item').filter({ hasText: 'on-a' });
  await expect(permission).toHaveAttribute('data-kind', 'permission', { timeout: 15_000 });
  await permission.click();
  await expect(page.getByTestId('inbox-machine')).toHaveText(aName);
  await expect(page.getByTestId('permission-request')).toBeVisible();
  const allowed = page.waitForResponse((r) => r.url().includes('/actions/allow-once'));
  await page.getByTestId('inbox-action').filter({ hasText: 'Allow once' }).click();
  expect((await allowed).status()).toBe(204);
  await waitFor('A\'s permission decided', async () => ((await a.call('GET', '/api/inbox')).body as unknown[]).length === 0);

  // Pause from B's header; the session on A is paused.
  await row.click();
  const pause = page.getByTestId('session-pause');
  await expect(pause).toHaveAttribute('data-action', 'pause', { timeout: 15_000 });
  await pause.click();
  await expect(pause).toHaveAttribute('data-action', 'resume', { timeout: 15_000 });
  expect((await a.call('GET', `/api/sessions/${started.body.id as string}`)).body.status).toBe('paused');

  // A stops: its session stays listed, tagged unreachable.
  await a.server.stop();
  await expect(row.getByTestId('machine-tag')).toHaveText(`${aName} · unreachable`, { timeout: 15_000 });
  // Ruling D48-cache-persist: its last known state stays readable; nothing can be done until A is back.
  await row.click();
  // Fix · peer reconnects: after the grace period: unreachable, retrying, with the last error and Reconnect now.
  await expect(page.getByTestId('session-offline-note-text')).toHaveText(new RegExp(`^${aName} is unreachable( · (retrying in \\d+ s|trying now…))?$`), { timeout: 15_000 });
  await expect(page.getByTestId('session-offline-note-reconnect')).toBeVisible();
  await expect(page.getByTestId('view-session').getByTestId('chat-text').first()).toBeVisible();
  await expect(page.getByTestId('chat-input')).toBeDisabled();
  await expect(page.getByTestId('chat-send')).toBeDisabled();
  await expect(page.getByTestId('chat-blocked-text')).toHaveText(new RegExp(`^${aName} is unreachable`));
  await expect(page.getByTestId('chat-blocked-reconnect')).toBeVisible();
  await expect(page.getByTestId('session-pause')).toBeDisabled();
  await expect(page.getByTestId('session-close')).toBeDisabled();
});

test('P3: the New-session form starts a session on a peer: its folders and models, then the remote session opens', async ({ browser }) => {
  const { a, b, aId, aName } = await paired();
  const page = await pageOf(browser, b, '/');
  // D56: this test exercises the Full New-session form (Simple is the fresh-install default).
  await rememberNewSessionMode(page, 'full');
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  const machine = modal.getByTestId('ns-machine');
  await expect(machine).toBeVisible();
  await expect(machine.locator('option')).toHaveText([/^This machine/, aName]);
  // This machine first: its own repo folder.
  await expect(modal.getByTestId('ns-folder').locator('option:checked')).toHaveText(/repo-b/);
  await machine.selectOption(aId);
  await expect(modal.getByTestId('ns-machine-note')).toBeVisible();
  await expect(modal.getByTestId('ns-folder').locator('option:checked')).toHaveText(/repo-a/);
  await expect(modal.getByTestId('ns-folder-browse')).toHaveCount(0);
  await expect(modal.getByTestId('ns-remote')).toHaveCount(0);
  await expect(modal.getByTestId('ns-resume')).toHaveCount(0);
  await modal.getByTestId('ns-name').fill('Started from B');
  await modal.getByTestId('ns-task').fill('Say OK.');
  // In place (no worktree), so no ticket branch is needed.
  const worktree = modal.getByTestId('ns-switch-worktrees');
  await expect(worktree).toHaveAttribute('aria-checked', 'true');
  await worktree.click();
  await expect(worktree).toHaveAttribute('aria-checked', 'false');
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/machines/${aId}/api/sessions`) && r.request().method() === 'POST');
  await modal.getByTestId('ns-start').click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(new RegExp(`/sessions/r~${aId}~`));
  await expect(page.getByTestId('session-machine')).toHaveText(aName);
  await expect(page.getByTestId('session-name')).toHaveText('Started from B');
  const onA = (await a.call('GET', '/api/sessions')).body as Array<{ title: string; folder: string }>;
  expect(onA).toMatchObject([{ title: 'Started from B', folder: a.folderId }]);
  expect(((await b.call('GET', '/api/sessions')).body as Array<{ machine: unknown }>).every((session) => session.machine !== null)).toBe(true);
});

/** A hand-started terminal session on `node` (a live pid in its registry + its transcript), as `claude agents --json` (fake-claude) lists it. */
async function fakeTerminal(target: PeerNode, id: string): Promise<{ cwd: string; transcript: string; lines: Record<string, unknown>[] }> {
  const cwd = target.repo as string;
  await mkdir(path.join(target.configDir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(target.configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: id, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() - 60_000, name: 'pc-terminal', status: 'idle' }),
  );
  const lines = [terminalUserLine({ sessionId: id, cwd, content: 'Refactor the parser.', parentUuid: null, timestamp: '2026-09-29T10:00:00.000Z' })];
  lines.push(assistantTextLine({ sessionId: id, cwd, text: 'Parser split in two.', parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:30.000Z' }));
  return { cwd, transcript: await writeTranscript(target.configDir, cwd, id, lines), lines };
}

/** A call of the hook script against `target` (its hook token), as the CLI would make it. */
async function hookCall(target: PeerNode, kind: 'event' | 'permission' | 'waiter', event: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const token = (await readFile(path.join(target.dataDir, 'hook-token'), 'utf8')).trim();
  const response = await fetch(`${target.baseUrl}/hook/v1/${kind}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event, claudePid: process.pid, entrypoint: 'cli' }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('Fix · hook waiter expiring: hooks installed by 1.5.0 show outdated in Settings → Machines; Update hooks rewrites them with a backup', async ({ browser }) => {
  const { a, b, aId } = await paired();
  const page = await pageOf(browser, b, '/settings/machines');
  const machine = page.locator(`[data-testid="machine"][data-machine-id="${aId}"]`);
  const hooks = machine.getByTestId('machine-hooks');
  await expect(hooks.getByTestId('hooks-state')).toHaveAttribute('data-state', 'none', { timeout: 15_000 });
  await hooks.getByTestId('hooks-install').click();
  await expect(hooks.getByTestId('hooks-state')).toHaveAttribute('data-state', 'installed');

  // The 1.5.0 entries: the waiter without a `timeout`.
  const file = path.join(a.configDir, 'settings.json');
  const old = JSON.parse(await readFile(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
  for (const groups of Object.values(old.hooks)) for (const group of groups) for (const hook of group.hooks) if (hook['asyncRewake'] === true) delete hook['timeout'];
  await writeFile(file, JSON.stringify(old, null, 2));

  await page.reload();
  await expect(hooks.getByTestId('hooks-state')).toHaveAttribute('data-state', 'outdated', { timeout: 15_000 });
  await expect(hooks.getByTestId('hooks-state')).toContainText('outdated');
  await expect(hooks.getByTestId('hooks-update')).toHaveText('Update hooks');
  await hooks.getByTestId('hooks-update').click();
  await expect(hooks.getByTestId('hooks-state')).toHaveAttribute('data-state', 'installed');
  await expect(hooks.getByTestId('hooks-backup')).toContainText('settings.json.switchboard-backup-');
  const updated = JSON.parse(await readFile(file, 'utf8')) as typeof old;
  expect(updated.hooks['Stop']?.some((group) => group.hooks.some((hook) => hook['asyncRewake'] === true && hook['timeout'] === 604_800))).toBe(true);
});

test('P4: hook into a terminal session on the peer from Settings → Machines; chat, a message that wakes it, Deny with a message', async ({ browser }) => {
  const { a, b, aId, aName } = await paired();
  const id = '7b6d7a38-aaaa-4bbb-8ccc-0123456789ab';
  const { cwd, transcript, lines } = await fakeTerminal(a, id);
  const base = { session_id: id, cwd, transcript_path: transcript };

  const page = await pageOf(browser, b, '/settings/machines');
  const machine = page.locator(`[data-testid="machine"][data-machine-id="${aId}"]`);
  const hooks = machine.getByTestId('machine-hooks');
  await expect(hooks.getByTestId('hooks-state')).toHaveAttribute('data-state', 'none', { timeout: 15_000 });
  await hooks.getByTestId('hooks-install').click();
  await expect(hooks.getByTestId('hooks-state')).toHaveAttribute('data-state', 'installed');
  expect(JSON.parse(await readFile(path.join(a.configDir, 'settings.json'), 'utf8')).hooks.PermissionRequest).toHaveLength(1);

  await hooks.getByTestId('hook-into').click();
  const terminal = hooks.getByTestId('terminal-session');
  await expect(terminal).toHaveCount(1);
  await expect(terminal).toContainText('pc-terminal');
  await expect(terminal).toContainText(cwd);
  await terminal.getByTestId('terminal-hook').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/r~${aId}~`));
  await expect(page.getByTestId('session-machine')).toHaveText(aName);
  await expect(page.getByTestId('session-hooked-note')).toContainText('stay in the terminal');
  await expect(page.getByTestId('session-pause')).toHaveCount(0);
  const view = page.getByTestId('view-session');
  await expect(view.getByTestId('chat-text')).toHaveText(['Refactor the parser.', 'Parser split in two.']);
  await expect(page.locator('.sb-session', { hasText: 'pc-terminal' }).getByTestId('machine-tag')).toHaveText(aName);

  // A message: queued (the clock) until the terminal's waiter takes it and the transcript shows it.
  await page.getByTestId('chat-input').fill('Also add a test for empty input.');
  await page.getByTestId('chat-input').press('Enter');
  const bubble = view.getByTestId('chat-message').filter({ hasText: 'Also add a test for empty input.' });
  await expect(bubble.getByTestId('chat-queued')).toBeVisible();
  const waiter = await hookCall(a, 'waiter', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  expect(waiter.status).toBe(200);
  expect(waiter.body.message).toContain('Also add a test for empty input.');
  const woken = {
    type: 'user',
    uuid: 'wake-e2e',
    parentUuid: lastUuid(lines),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: `<task-notification>\n<summary>Message from Switchboard</summary>\n</task-notification>\n<system-reminder>\nThe developer sent this message from Switchboard: Also add a test for empty input.\n</system-reminder>` },
    origin: { kind: 'task-notification', producer: 'session-task' },
  };
  const reply = assistantTextLine({ sessionId: id, cwd, text: 'Added the empty-input test.', parentUuid: 'wake-e2e', timestamp: new Date().toISOString() });
  await appendFile(transcript, `${JSON.stringify(woken)}\n${JSON.stringify(reply)}\n`);
  await hookCall(a, 'event', { ...base, hook_event_name: 'UserPromptSubmit' });
  await hookCall(a, 'event', { ...base, hook_event_name: 'Stop' });
  await expect(view.getByTestId('chat-text')).toHaveText(['Refactor the parser.', 'Parser split in two.', 'Also add a test for empty input.', 'Added the empty-input test.'], { timeout: 15_000 });
  await expect(bubble.getByTestId('chat-queued')).toHaveCount(0);

  // A permission request in A's terminal: B's Inbox, Deny with a message.
  const asked = hookCall(a, 'permission', { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  await page.getByTestId('nav-inbox').click();
  const item = page.getByTestId('inbox-item').filter({ hasText: 'pc-terminal' });
  await expect(item).toHaveAttribute('data-kind', 'permission', { timeout: 15_000 });
  await item.click();
  await expect(page.getByTestId('inbox-action')).toHaveText(['Allow once', 'Deny']);
  await page.getByTestId('permission-deny-message').fill('Keep dist, it is the release.');
  await page.getByTestId('inbox-action').filter({ hasText: 'Deny' }).click();
  expect((await asked).body).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Keep dist, it is the release.' } } });

  // Ruling D48-hooked-subagents: the session's subagent (its own transcript + meta) shows with its chat.
  const subDir = path.join(path.dirname(transcript), id, 'subagents');
  await mkdir(subDir, { recursive: true });
  await writeFile(path.join(subDir, 'agent-a015af7abcb52ccc2.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the parser tests', toolUseId: 'toolu_agent_e2e' }));
  const brief: Record<string, unknown> = { ...terminalUserLine({ sessionId: id, cwd, content: 'List the parser tests.', parentUuid: null, timestamp: new Date().toISOString() }), isSidechain: true };
  const found: Record<string, unknown> = { ...assistantTextLine({ sessionId: id, cwd, text: 'parser.test.ts and lexer.test.ts.', parentUuid: brief['uuid'] as string, timestamp: new Date().toISOString() }), isSidechain: true };
  await writeFile(path.join(subDir, 'agent-a015af7abcb52ccc2.jsonl'), `${JSON.stringify(brief)}\n${JSON.stringify(found)}\n`);
  await hookCall(a, 'event', { ...base, hook_event_name: 'Stop' });
  const sessionUrl = new URL(page.url());
  const hookedId = decodeURIComponent((await b.call('GET', '/api/sessions')).body.find((entry: { hooked?: boolean }) => entry.hooked).id as string);
  const agent = await waitFor('the subagent on B', async () =>
    (((await b.call('GET', `/api/sessions/${encodeURIComponent(hookedId)}`)).body as { agents: Array<{ id: string; kind: string }> }).agents.find((entry) => entry.kind === 'subagent') ?? null),
  );
  await page.goto(`${sessionUrl.origin}/sessions/${encodeURIComponent(hookedId)}/agents/${encodeURIComponent(agent.id)}`);
  await expect(page.getByTestId('subagent-bar').getByTestId('subagent-title')).toHaveText('Explore: Find the parser tests');
  await expect(page.getByTestId('subagent-chat')).toContainText('List the parser tests.');
  await expect(page.getByTestId('subagent-chat')).toContainText('parser.test.ts and lexer.test.ts.');
});
