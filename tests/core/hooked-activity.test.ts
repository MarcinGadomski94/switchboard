import { describe, expect, it } from 'vitest';
import { type HookSignals, NO_TURN, hookedActivity, transcriptTurn } from '../../src/core/derive/hooked-activity.ts';
import { HOOK_DELIVERY_TEXT, STALE_AFTER_MS, hookDelivery, hooksOutdatedText, staleFor } from '../../src/core/derive/hooked-status.ts';
import { REWAKE_MESSAGE } from '../../src/core/hooks.ts';
import { assistantBlockLines, assistantToolLine, lastUuid, terminalUserLine, toolResultLine } from '../helpers/transcripts.ts';

/**
 * D53 (`docs/derivations.md` → *Live activity* → *Hooked terminal sessions*): a
 * hooked session's live activity from its transcript's tail and its hook calls,
 * and what a message to it waits on. Pure.
 */

const CS = 'c0ffee00-1111-4222-8333-944455556666';
const cwd = '/work/project';
type Line = Record<string, unknown>;

function t(seconds: number): string {
  return new Date(Date.parse('2026-09-29T10:00:00.000Z') + seconds * 1000).toISOString();
}

function prompt(lines: Line[], text: string, at: number): Line[] {
  return [...lines, terminalUserLine({ sessionId: CS, cwd, content: text, parentUuid: lastUuid(lines), timestamp: t(at) })];
}

function tool(lines: Line[], id: string, name: string, input: Record<string, unknown>, at: number): Line[] {
  return [...lines, assistantToolLine({ sessionId: CS, cwd, toolUseId: id, name, input, parentUuid: lastUuid(lines), timestamp: t(at) })];
}

function result(lines: Line[], id: string, at: number): Line[] {
  return [...lines, toolResultLine({ sessionId: CS, cwd, toolUseId: id, text: 'ok', parentUuid: lastUuid(lines), timestamp: t(at) })];
}

function reply(lines: Line[], text: string, at: number, stopReason = 'end_turn'): Line[] {
  return [...lines, ...assistantBlockLines({ sessionId: CS, cwd, text, parentUuid: lastUuid(lines), timestamp: t(at), stopReason })];
}

function system(lines: Line[], subtype: string, at: number): Line[] {
  return [...lines, { type: 'system', subtype, uuid: `sys-${at}`, parentUuid: lastUuid(lines), timestamp: t(at), isSidechain: false }];
}

const NO_HOOKS: HookSignals = { startedAt: null, stoppedAt: null, ended: false, permission: null, lastHookAt: null };

describe('transcriptTurn (D53)', () => {
  it('a prompt opens a turn: thinking since the prompt', () => {
    const turn = transcriptTurn(prompt([], 'Fix the flaky test.', 0));
    expect(turn).toMatchObject({ running: true, turnStartedAt: t(0), state: 'thinking', since: t(0), tool: null, lastAt: t(0) });
  });

  it('a tool_use line runs that tool (its summary) until its tool_result; then thinking again', () => {
    let lines = prompt([], 'Run the tests.', 0);
    lines = tool(lines, 'toolu_1', 'Bash', { command: 'npm test\n--watch' }, 4);
    expect(transcriptTurn(lines)).toMatchObject({ running: true, state: 'tool', since: t(4), tool: 'Bash', summary: 'npm test', turnStartedAt: t(0) });
    lines = result(lines, 'toolu_1', 46);
    expect(transcriptTurn(lines)).toMatchObject({ running: true, state: 'thinking', since: t(46), tool: null });
  });

  it('the newest of several open tools shows', () => {
    let lines = prompt([], 'Look around.', 0);
    lines = tool(lines, 'toolu_1', 'Read', { file_path: '/work/project/src/a.ts' }, 2);
    lines = tool(lines, 'toolu_2', 'Grep', { pattern: 'TODO' }, 3);
    expect(transcriptTurn(lines)).toMatchObject({ state: 'tool', tool: 'Grep', summary: 'TODO', since: t(3) });
    lines = result(lines, 'toolu_2', 5);
    expect(transcriptTurn(lines)).toMatchObject({ state: 'tool', tool: 'Read', summary: 'a.ts', since: t(2) });
  });

  it('text mid-turn is writing; end_turn, stop_hook_summary / turn_duration and interrupts end the turn', () => {
    let lines = prompt([], 'Explain.', 0);
    lines = reply(lines, 'First, the parser…', 5, 'tool_use');
    expect(transcriptTurn(lines)).toMatchObject({ running: true, state: 'writing', since: t(5) });
    const ended = reply(lines, 'Done.', 9);
    expect(transcriptTurn(ended)).toMatchObject({ running: false, endedAt: t(9), turnStartedAt: null });
    expect(transcriptTurn(system(lines, 'stop_hook_summary', 10))).toMatchObject({ running: false, endedAt: t(10) });
    expect(transcriptTurn(system(lines, 'turn_duration', 11))).toMatchObject({ running: false, endedAt: t(11) });
    const interrupted = [...lines, terminalUserLine({ sessionId: CS, cwd, content: '[Request interrupted by user for tool use]', parentUuid: lastUuid(lines), timestamp: t(12) })];
    expect(transcriptTurn(interrupted)).toMatchObject({ running: false, endedAt: t(12) });
  });

  it('a tail that starts mid-turn opens the turn at its first line; a message that ended its turn does not reopen one', () => {
    const tail = tool([], 'toolu_9', 'Bash', { command: 'sleep 30' }, 100);
    expect(transcriptTurn(tail)).toMatchObject({ running: true, turnStartedAt: t(100), state: 'tool', tool: 'Bash' });
    const afterEnd = reply([], 'All done.', 50);
    expect(transcriptTurn(afterEnd)).toMatchObject({ running: false });
  });

  it("a Switchboard wake-up's line and a scheduled firing's meta line open a turn; other meta lines do not", () => {
    const woken = [{ ...terminalUserLine({ sessionId: CS, cwd, content: `<system-reminder>\n${REWAKE_MESSAGE} Also add a test.\n</system-reminder>`, parentUuid: null, timestamp: t(0) }), isMeta: true }];
    expect(transcriptTurn(woken)).toMatchObject({ running: true, turnStartedAt: t(0) });
    const fired = [{ ...terminalUserLine({ sessionId: CS, cwd, content: 'check the build', parentUuid: null, timestamp: t(0) }), isMeta: true, turnOrigin: 'scheduled' }];
    expect(transcriptTurn(fired)).toMatchObject({ running: true });
    const meta = [{ ...terminalUserLine({ sessionId: CS, cwd, content: 'Caveat: …', parentUuid: null, timestamp: t(0) }), isMeta: true }];
    expect(transcriptTurn(meta)).toMatchObject({ running: false });
  });

  it('a slash command\'s own lines open no turn (a local command runs none; a prompt command opens at its first assistant line)', () => {
    let lines = prompt([], '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>', 0);
    lines = prompt(lines, '<local-command-stdout>Set model to opus</local-command-stdout>', 1);
    expect(transcriptTurn(lines)).toMatchObject({ running: false });
    expect(transcriptTurn(tool(lines, 'toolu_1', 'Read', { file_path: 'a.ts' }, 3))).toMatchObject({ running: true, turnStartedAt: t(3) });
  });

  it('sidechain lines are skipped in the main file; a subagent file reads its own', () => {
    const side = tool([], 'toolu_s', 'Grep', { pattern: 'x' }, 1).map((line) => ({ ...line, isSidechain: true }));
    expect(transcriptTurn(side)).toMatchObject({ running: false });
    expect(transcriptTurn(side, { sidechain: true })).toMatchObject({ running: true, state: 'tool', tool: 'Grep' });
  });
});

describe('hookedActivity (D53)', () => {
  const main = 'agent-main';

  it('no turn: null; a transcript turn: its state, with quietSince the newest sign of life', () => {
    expect(hookedActivity({ mainAgentId: main, transcript: NO_TURN, transcriptChangedAt: null, hooks: NO_HOOKS })).toBeNull();
    const turn = transcriptTurn(tool(prompt([], 'Test it.', 0), 'toolu_1', 'Bash', { command: 'npm test' }, 3));
    const activity = hookedActivity({ mainAgentId: main, transcript: turn, transcriptChangedAt: t(3), hooks: { ...NO_HOOKS, lastHookAt: t(2) } });
    expect(activity).toMatchObject({ turnStartedAt: t(0), state: 'tool', since: t(3), tool: 'Bash', summary: 'npm test', thinkingTokens: null, background: [], quietSince: t(3) });
    expect(activity?.agents[main]).toMatchObject({ state: 'tool', tool: 'Bash', startedAt: t(0) });
  });

  it('UserPromptSubmit before the transcript shows the prompt: thinking since the hook', () => {
    const idle = transcriptTurn(reply(prompt([], 'First.', 0), 'Done.', 5));
    const activity = hookedActivity({ mainAgentId: main, transcript: idle, transcriptChangedAt: t(5), hooks: { ...NO_HOOKS, startedAt: t(20), lastHookAt: t(20) } });
    expect(activity).toMatchObject({ state: 'thinking', turnStartedAt: t(20), since: t(20), quietSince: t(20) });
  });

  it('a Stop after the turn started ends it even before the end line is written', () => {
    const running = transcriptTurn(reply(prompt([], 'Go.', 0), 'Working…', 3, 'tool_use'));
    expect(hookedActivity({ mainAgentId: main, transcript: running, transcriptChangedAt: t(3), hooks: { ...NO_HOOKS, startedAt: t(0), stoppedAt: t(8), lastHookAt: t(8) } })).toBeNull();
    // A later prompt runs again.
    const next = transcriptTurn(prompt(reply(prompt([], 'Go.', 0), 'Done.', 3), 'Again.', 10));
    expect(hookedActivity({ mainAgentId: main, transcript: next, transcriptChangedAt: t(10), hooks: { ...NO_HOOKS, stoppedAt: t(8) } })).toMatchObject({ turnStartedAt: t(10) });
  });

  it('SessionEnd: null whatever the transcript says', () => {
    const running = transcriptTurn(prompt([], 'Go.', 0));
    expect(hookedActivity({ mainAgentId: main, transcript: running, transcriptChangedAt: t(0), hooks: { ...NO_HOOKS, ended: true } })).toBeNull();
  });

  it('a held PermissionRequest: waiting with its tool (the main agent too)', () => {
    const running = transcriptTurn(tool(prompt([], 'Clean.', 0), 'toolu_1', 'Bash', { command: 'rm -rf dist' }, 2));
    const activity = hookedActivity({
      mainAgentId: main,
      transcript: running,
      transcriptChangedAt: t(2),
      hooks: { ...NO_HOOKS, permission: { tool: 'Bash', summary: 'rm -rf dist', since: t(3) }, lastHookAt: t(3) },
    });
    expect(activity).toMatchObject({ state: 'waiting', since: t(3), tool: 'Bash', summary: 'rm -rf dist', turnStartedAt: t(0) });
    expect(activity?.agents[main]).toMatchObject({ state: 'waiting', tool: 'Bash' });
  });

  it('running subagents get their own entries', () => {
    const running = transcriptTurn(tool(prompt([], 'Explore.', 0), 'toolu_a', 'Agent', { description: 'Find the tests' }, 1));
    const sub = transcriptTurn(tool([], 'toolu_s', 'Grep', { pattern: 'describe' }, 4).map((line) => ({ ...line, isSidechain: true })), { sidechain: true });
    const activity = hookedActivity({ mainAgentId: main, transcript: running, transcriptChangedAt: t(4), hooks: NO_HOOKS, subagents: { 'agent-sub': sub, 'agent-done': NO_TURN } });
    expect(activity).toMatchObject({ state: 'tool', tool: 'Agent', summary: 'Find the tests' });
    expect(Object.keys(activity?.agents ?? {})).toEqual([main, 'agent-sub']);
    expect(activity?.agents['agent-sub']).toMatchObject({ state: 'tool', tool: 'Grep', startedAt: t(4) });
  });
});

describe('staleFor (D53)', () => {
  const quiet = { state: 'thinking' as const, quietSince: t(0) };
  it('after STALE_AFTER_MS without a sign of life; never while waiting, never without quietSince', () => {
    const at = Date.parse(t(0));
    expect(staleFor(quiet, at + STALE_AFTER_MS - 1)).toBeNull();
    expect(staleFor(quiet, at + STALE_AFTER_MS)).toBe(STALE_AFTER_MS);
    expect(staleFor({ ...quiet, state: 'tool' }, at + 5 * 60_000)).toBe(5 * 60_000);
    expect(staleFor({ ...quiet, state: 'waiting' }, at + 5 * 60_000)).toBeNull();
    expect(staleFor({ state: 'thinking' }, at + 5 * 60_000)).toBeNull();
  });
});

describe('hookDelivery (D53)', () => {
  const base = { ended: false, waiter: true, running: false, released: false, queued: 0 };
  it('says what a message waits on', () => {
    expect(hookDelivery({ ...base, ended: true, released: true })).toBe('ended');
    expect(hookDelivery({ ...base, waiter: false, released: true })).toBe('handed');
    expect(hookDelivery({ ...base, waiter: false, released: true, running: true })).toBe('turn');
    expect(hookDelivery({ ...base, queued: 1 })).toBe('turn');
    expect(hookDelivery({ ...base, waiter: false, running: true, queued: 1 })).toBe('turn');
    expect(hookDelivery({ ...base, waiter: false, queued: 1 })).toBe('no-waiter');
    expect(hookDelivery({ ...base, waiter: false })).toBe('no-waiter');
    expect(hookDelivery(base)).toBeNull();
    // A waiter that was there and is gone is "stopped", not "never armed".
    expect(hookDelivery({ ...base, waiter: false, waiterSeen: true })).toBe('waiter-stopped');
    expect(hookDelivery({ ...base, waiter: false, waiterSeen: true, queued: 1 })).toBe('waiter-stopped');
    expect(hookDelivery({ ...base, waiter: false, waiterSeen: false })).toBe('no-waiter');
    expect(hookDelivery({ ...base, waiter: false, waiterSeen: true, running: true })).toBeNull();
    expect(hookDelivery({ ...base, waiter: false, running: true })).toBeNull();
  });

  it("the words are the developer's", () => {
    expect(HOOK_DELIVERY_TEXT).toEqual({
      handed: 'Waiting for the session to take it up (delivered to its hook)',
      turn: 'Waiting for the next turn boundary',
      'no-waiter': 'No hook listening yet — type anything in that terminal once (the hooks were installed after this session started)',
      'waiter-stopped': 'The hook stopped listening (it expired or Switchboard restarted) — it re-arms at the next turn; update the hooks to prevent this',
      ended: 'Session ended',
    });
    expect(hooksOutdatedText('Studio PC')).toBe('Hooks are outdated on Studio PC — Update hooks so idle sessions stay reachable');
    expect(hooksOutdatedText(null)).toBe('Hooks are outdated on this machine — Update hooks so idle sessions stay reachable');
  });
});
