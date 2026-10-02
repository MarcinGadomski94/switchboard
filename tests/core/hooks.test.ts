import { describe, expect, it } from 'vitest';
import {
  DeliveryLimiter,
  HOOK_MARKER,
  type HookCommand,
  REWAKE_MESSAGE,
  hookEntry,
  isSwitchboardHook,
  parseTerminalAgents,
  WAITER_HOOK_TIMEOUT_S,
  rewakeSupported,
  switchboardHooksState,
  switchboardMessageText,
  waiterText,
  withSwitchboardHooks,
  withoutSwitchboardHooks,
} from '../../src/core/hooks.ts';
import { transcriptItems } from '../../src/core/transcript-sync.ts';

const POSIX: HookCommand = {
  nodePath: '/Users/me/.nvm/versions/node/v24.21.0/bin/node',
  scriptPath: '/Users/me/switchboard/src/hook/sb-hook.ts',
  port: 13001,
  tokenFile: '/Users/me/Library/Application Support/Switchboard/hook-token',
  platform: 'darwin',
  rewake: true,
};
const WINDOWS: HookCommand = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  scriptPath: 'C:\\Users\\me\\switchboard\\src\\hook\\sb-hook.ts',
  port: 13001,
  tokenFile: 'C:\\Users\\me\\AppData\\Local\\Switchboard\\hook-token',
  platform: 'win32',
  rewake: false,
};

const OTHERS = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }],
  },
};

describe('D48 P4 hook entries', () => {
  it('POSIX: one quoted command string (no exec form); Windows: exec form, absolute node.exe + args, no shell', () => {
    const posix = hookEntry(POSIX, 'permission');
    expect(posix).toEqual({
      type: 'command',
      command: `'/Users/me/.nvm/versions/node/v24.21.0/bin/node' '/Users/me/switchboard/src/hook/sb-hook.ts' ${HOOK_MARKER} permission 13001 '/Users/me/Library/Application Support/Switchboard/hook-token'`,
      timeout: 3600,
    });
    const win = hookEntry(WINDOWS, 'event');
    expect(win).toEqual({
      type: 'command',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\me\\switchboard\\src\\hook\\sb-hook.ts', HOOK_MARKER, 'event', '13001', 'C:\\Users\\me\\AppData\\Local\\Switchboard\\hook-token'],
      async: true,
      timeout: 30,
    });
    expect(isSwitchboardHook(posix)).toBe(true);
    expect(isSwitchboardHook(win)).toBe(true);
    expect(isSwitchboardHook({ type: 'command', command: 'my-guard.sh' })).toBe(false);
  });

  it('waiters are asyncRewake with the internal fields only when the CLI version was tested', () => {
    expect(hookEntry(POSIX, 'waiter')).toMatchObject({ asyncRewake: true, rewakeMessage: REWAKE_MESSAGE, rewakeSummary: 'Message from Switchboard' });
    const fallback = hookEntry(WINDOWS, 'waiter');
    expect(fallback['asyncRewake']).toBe(true);
    expect(fallback).not.toHaveProperty('rewakeMessage');
    // Both forms carry the 7-day timeout (the CLI kills a waiter without one after 10 minutes).
    expect(fallback['timeout']).toBe(WAITER_HOOK_TIMEOUT_S);
    expect(hookEntry(POSIX, 'waiter')['timeout']).toBe(604_800);
    expect(rewakeSupported('2.1.284 (Claude Code)')).toBe(true);
    expect(rewakeSupported('2.1.299')).toBe(true);
    expect(rewakeSupported('2.1.283')).toBe(false);
    expect(rewakeSupported('2.2.0')).toBe(false);
    expect(rewakeSupported(null)).toBe(false);
  });

  it('install adds exactly its entries and keeps everything else; it is idempotent; remove restores the rest exactly', () => {
    const installed = withSwitchboardHooks(OTHERS, POSIX);
    expect(installed['model']).toBe('opus');
    expect(installed['permissions']).toEqual(OTHERS.permissions);
    const hooks = installed['hooks'] as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    expect(Object.keys(hooks)).toEqual(['Stop', 'PreToolUse', 'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd', 'PermissionRequest']);
    expect(hooks['Stop']?.[0]).toEqual(OTHERS.hooks.Stop[0]);
    expect(hooks['Stop']).toHaveLength(3);
    expect(hooks['PreToolUse']).toEqual(OTHERS.hooks.PreToolUse);
    expect(switchboardHooksState(installed, POSIX)).toBe('installed');
    expect(withSwitchboardHooks(installed, POSIX)).toEqual(installed);
    expect(switchboardHooksState(installed, { ...POSIX, port: 13009 })).toBe('outdated');
    const removed = withoutSwitchboardHooks(installed);
    expect(removed.removed).toBe(8);
    expect(removed.settings).toEqual(OTHERS);
    expect(switchboardHooksState(OTHERS, POSIX)).toBe('none');
    // A file with only Switchboard's hooks loses its `hooks` key, nothing else.
    expect(withoutSwitchboardHooks(withSwitchboardHooks({ theme: 'dark' }, WINDOWS)).settings).toEqual({ theme: 'dark' });
  });

  it('an old waiter entry (no timeout, as 1.5.0 wrote it) is outdated; the current plan is installed', () => {
    const current = withSwitchboardHooks({}, POSIX);
    const old = JSON.parse(JSON.stringify(current)) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
    for (const groups of Object.values(old.hooks)) for (const group of groups) for (const hook of group.hooks) if (hook['asyncRewake'] === true) delete hook['timeout'];
    expect(switchboardHooksState(current, POSIX)).toBe('installed');
    expect(switchboardHooksState(old, POSIX)).toBe('outdated');
    expect(withSwitchboardHooks(old, POSIX)).toEqual(current);
  });

  it('a group mixing a Switchboard hook with another keeps the other', () => {
    const mixed = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }, hookEntry(POSIX, 'event')] }] } };
    expect(withoutSwitchboardHooks(mixed).settings).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } });
  });
});

describe('D48 P4 wake-up messages', () => {
  const internal = '<task-notification>\n<summary>Message from Switchboard</summary>\n</task-notification>\n<system-reminder>\nThe developer sent this message from Switchboard: Also include the word MIDTURN in your reply.\n</system-reminder>';
  it('reads the developer\'s text from a wake-up (verified 2.1.284 format) and from the fallback wording', () => {
    expect(switchboardMessageText(internal)).toBe('Also include the word MIDTURN in your reply.');
    const fallback = `Stop hook blocking error from command "node sb-hook.ts": ${waiterText('Run the tests again.', false)}`;
    expect(switchboardMessageText(fallback)).toBe('Run the tests again.');
    expect(waiterText('x', true)).toBe('x');
    expect(switchboardMessageText('<task-notification>\n<summary>Background command done</summary>\n</task-notification>')).toBeNull();
    expect(switchboardMessageText('A normal prompt')).toBeNull();
  });

  it('the transcript shows a wake-up as the developer\'s message, from a user line or a queued_command attachment', () => {
    const items = transcriptItems([
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-09-29T11:50:00.000Z', message: { role: 'user', content: internal }, origin: { kind: 'task-notification' } },
      { type: 'attachment', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-29T11:50:01.000Z', attachment: { type: 'queued_command', prompt: internal, commandMode: 'task-notification' } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-09-29T11:50:02.000Z', message: { role: 'user', content: 'typed on the PC' } },
    ]);
    expect(items).toEqual([
      { kind: 'prompt', uuid: 'u1', ts: '2026-09-29T11:50:00.000Z', text: 'Also include the word MIDTURN in your reply.', from: 'switchboard' },
      { kind: 'prompt', uuid: 'a1', ts: '2026-09-29T11:50:01.000Z', text: 'Also include the word MIDTURN in your reply.', from: 'switchboard' },
      { kind: 'prompt', uuid: 'u2', ts: '2026-09-29T11:50:02.000Z', text: 'typed on the PC' },
    ]);
  });
});

describe('D48 P4 delivery limit', () => {
  it('lets at most 3 wake-ups a minute through (sliding window)', () => {
    const limiter = new DeliveryLimiter(3, 60_000);
    for (const at of [0, 1_000, 2_000]) {
      expect(limiter.allows(at)).toBe(true);
      limiter.record(at);
    }
    expect(limiter.allows(3_000)).toBe(false);
    expect(limiter.nextAt(3_000)).toBe(60_000);
    expect(limiter.allows(60_000)).toBe(true);
  });
});

describe('D48 P4 claude agents --json', () => {
  it('reads the rows, skipping malformed ones', () => {
    expect(parseTerminalAgents('[{"pid":1,"cwd":"/r","kind":"interactive","startedAt":5,"sessionId":"s","name":"n","status":"waiting","waitingFor":"permission prompt"},{"pid":"x"}]')).toEqual([
      { pid: 1, sessionId: 's', cwd: '/r', kind: 'interactive', name: 'n', status: 'waiting', waitingFor: 'permission prompt', startedAt: 5 },
    ]);
    expect(parseTerminalAgents('nope')).toBeNull();
    expect(parseTerminalAgents('{}')).toBeNull();
  });
});
