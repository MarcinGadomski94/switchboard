/**
 * D139 · the account needs the developer (`docs/accounts.md` → *The account needs you*): the pure
 * reader of the CLIs' "needs you" texts (the incident's text VERIFIED → `terms`), the titles and
 * commands, the stored blocks, and D138's precedence with a blocked account.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  type ProfileSnapshot,
  accountFixCommand,
  accountNeedsYouTitle,
  accountStoppedLabel,
  accountWaitReason,
  decideAccountSwitch,
  hasAllowance,
  parseAccountAction,
  parseLimitError,
  pickProfileForNewSession,
  readAccountBlocks,
} from '../../src/core/accounts.ts';

/** The incident's stderr, verbatim (2026-10-27): newlines around it as the CLI printed it. */
const INCIDENT = '\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.\n\n';

const now = Date.UTC(2026, 9, 27, 12);

function profile(id: string, position: number, extra: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return { id, name: id === 'w' ? 'Work' : id === 'p' ? 'Personal' : id, enabled: true, position, signedIn: true, exhaustedUntil: null, usage: null, ...extra };
}

describe('D139 · parseAccountAction', () => {
  it('the incident text (VERIFIED) → terms, the CLI\'s line kept', () => {
    expect(parseAccountAction(INCIDENT, 'claude')).toEqual({
      kind: 'terms',
      text: '[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.',
    });
  });

  it('other Claude Code wordings from its binary (VERIFIED) → login; another [ACTION REQUIRED] → action', () => {
    expect(parseAccountAction('API Error: 401 Invalid API key · Please run /login', 'claude')).toMatchObject({ kind: 'login', text: 'API Error: 401 Invalid API key · Please run /login' });
    expect(parseAccountAction('OAuth token has expired. Please obtain a new token or refresh your existing token. (run /login to renew)', 'claude')?.kind).toBe('login');
    expect(parseAccountAction('Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.', 'claude')?.kind).toBe('login');
    expect(parseAccountAction('Not logged in. Run claude auth login to authenticate.', 'claude')?.kind).toBe('login');
    expect(parseAccountAction('[ACTION REQUIRED] Your organization requires you to verify your account.', 'claude')?.kind).toBe('action');
    // Only the matching line is kept from a longer stderr.
    expect(parseAccountAction('some log line\nAPI Error: 401 Invalid API key · Please run /login\nmore', 'claude')?.text).toBe('API Error: 401 Invalid API key · Please run /login');
  });

  it('Codex CLI wordings from its binary (VERIFIED) → login; OpenCode: none read, never', () => {
    expect(parseAccountAction('Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.', 'codex')?.kind).toBe('login');
    expect(parseAccountAction('ChatGPT account ID not available, please re-run `codex login`', 'codex')?.kind).toBe('login');
    expect(parseAccountAction(INCIDENT, 'codex')).toBeNull();
    expect(parseAccountAction('Please run /login', 'opencode')).toBeNull();
  });

  it('no false positives: ordinary errors, limits, the advance terms notice, a settings mistake', () => {
    expect(parseAccountAction('', 'claude')).toBeNull();
    expect(parseAccountAction('claude exited unexpectedly (code 1)', 'claude')).toBeNull();
    expect(parseAccountAction('error_during_execution: tool failed', 'claude')).toBeNull();
    expect(parseAccountAction('API Error: 500 Internal server error', 'claude')).toBeNull();
    expect(parseAccountAction("You've hit your session limit · resets 2pm", 'claude')).toBeNull();
    // A limit text that also mentions /login stays a limit (parseLimitError wins).
    const both = "You've hit your session limit · resets 2pm · Please run /login to switch";
    expect(parseLimitError(both, 'claude')).not.toBeNull();
    expect(parseAccountAction(both, 'claude')).toBeNull();
    // The notice before the date is not a refusal (no "[ACTION REQUIRED]").
    expect(parseAccountAction('An update to our Consumer Terms and Privacy Policy will take effect on October 8, 2025. Run `claude` to review the updated terms.', 'claude')).toBeNull();
    expect(parseAccountAction('Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.', 'claude')).toBeNull();
    expect(parseAccountAction('The agent said: I am not logged in to that website', 'claude')).toBeNull();
  });
});

describe('D139 · words and commands', () => {
  it('titles, dividers and the Project wait reason', () => {
    expect(accountNeedsYouTitle('Work', 'claude', 'Claude Code', 'terms')).toBe("Work (Claude Code) needs you: accept Anthropic's updated terms");
    expect(accountNeedsYouTitle('Work', 'claude', 'Claude Code', 'login')).toBe('Work (Claude Code) needs you: sign in again');
    expect(accountStoppedLabel('Work', 'claude', 'terms')).toBe("Stopped: the account Work needs you — accept Anthropic's updated terms");
    expect(accountWaitReason('Work')).toBe('the account Work needs you');
  });

  it('the command: the CLI with the profile\'s folder; just the CLI for the Default; Codex / OpenCode only for a login', () => {
    expect(accountFixCommand('claude', 'terms', '/data/profiles/claude/w1')).toBe('CLAUDE_CONFIG_DIR="/data/profiles/claude/w1" claude');
    expect(accountFixCommand('claude', 'terms', null)).toBe('claude');
    expect(accountFixCommand('claude', 'login', '/a b/$x')).toBe('CLAUDE_CONFIG_DIR="/a b/\\$x" claude');
    expect(accountFixCommand('codex', 'login', '/d')).toBe('CODEX_HOME="/d" codex login');
    expect(accountFixCommand('codex', 'action', '/d')).toBeNull();
    expect(accountFixCommand('opencode', 'login', null)).toBe('opencode auth login');
  });

  it('the stored blocks are read defensively', () => {
    expect(readAccountBlocks(null)).toEqual({});
    expect(readAccountBlocks({ w: { kind: 'terms', text: 't', since: 's', command: 'c', sessionIds: ['s1', 3] }, bad: { kind: 'nope' }, worse: 'x' })).toEqual({
      w: { kind: 'terms', text: 't', since: 's', command: 'c', sessionIds: ['s1'] },
    });
  });
});

describe('D139 · a blocked account and D138 precedence', () => {
  const settings = DEFAULT_ACCOUNT_SETTINGS;
  const work = profile('w', 0, { blocked: true });
  const personal = profile('p', 1);

  it('a blocked account has no allowance (like a spent one)', () => {
    expect(hasAllowance(work, settings, 'hard', now)).toBe(false);
    expect(hasAllowance(personal, settings, 'hard', now)).toBe(true);
  });

  it('Automatic and the overall choice: another account with allowance is used; none: the blocked one (nothing better)', () => {
    expect(pickProfileForNewSession(settings, 'claude', [work, personal], now)).toBe('p');
    expect(pickProfileForNewSession({ ...settings, choice: { claude: 'w' } }, 'claude', [work, personal], now)).toBe('p');
    // Also with automatic switching off: a blocked choice gives way when another can take the session.
    expect(pickProfileForNewSession({ ...settings, enabled: false, choice: { claude: 'w' } }, 'claude', [work, personal], now)).toBe('p');
    expect(pickProfileForNewSession({ ...settings, choice: { claude: 'w' } }, 'claude', [work, profile('p', 1, { blocked: true })], now)).toBe('w');
  });

  it('a blocked account is never a switch target; a pinned session stays', () => {
    const limit = { kind: 'limit' as const, hit: { window: 'session' as const, resetsAt: null, text: 'x' } };
    const decided = decideAccountSwitch({ settings, cli: 'claude', trigger: limit, profiles: [personal, work], currentId: 'p', pinned: false, idle: true, lastSwitchAt: null, now });
    expect(decided.to).not.toBe('w');
    const pinned = decideAccountSwitch({ settings, cli: 'claude', trigger: limit, profiles: [work, personal], currentId: 'w', pinned: true, idle: true, lastSwitchAt: null, now });
    expect(pinned.action).not.toBe('switch');
  });
});
