import { describe, expect, it } from 'vitest';
import {
  CLI_CAPABILITIES,
  CLI_PROVIDERS,
  type CliFeature,
  isCliProviderId,
  readCliProvider,
  supports,
  switchDividerLabel,
  terminalResumeCommand,
  unavailableText,
} from '../../src/core/cli-providers.ts';

describe('D62 CLI providers (core)', () => {
  it('knows the three CLIs and reads anything else as Claude Code', () => {
    expect(CLI_PROVIDERS).toEqual(['claude', 'codex', 'opencode']);
    expect(isCliProviderId('codex')).toBe(true);
    expect(isCliProviderId('gpt')).toBe(false);
    expect(readCliProvider('opencode')).toBe('opencode');
    expect(readCliProvider(null)).toBe('claude');
    expect(readCliProvider('bogus')).toBe('claude');
  });

  it('Claude Code has every feature but the supervised "always allow"; every gap has a reason', () => {
    const features = Object.keys(CLI_CAPABILITIES.claude) as CliFeature[];
    for (const feature of features) {
      if (feature === 'permission-always') continue;
      expect(supports('claude', feature), feature).toBe(true);
    }
    for (const provider of CLI_PROVIDERS) {
      expect(Object.keys(CLI_CAPABILITIES[provider]).sort()).toEqual([...features].sort());
      for (const feature of features) {
        const capability = CLI_CAPABILITIES[provider][feature];
        if (!capability.available) expect(capability.reason, `${provider} ${feature}`).toBeTruthy();
      }
    }
  });

  it('marks Claude-only features with the exact reason', () => {
    expect(unavailableText('codex', 'remote-control')).toBe('Not available in Codex CLI: Remote Control (claude.ai on the phone) is a Claude Code feature');
    expect(unavailableText('opencode', 'workflow-agents')).toBe('Not available in OpenCode: Workflow agents are a Claude Code feature');
    expect(unavailableText('claude', 'remote-control')).toBeNull();
    expect(supports('codex', 'pdfs')).toBe(false);
    expect(supports('opencode', 'usage-footer')).toBe(false);
  });

  it('names the terminal command and the switch divider', () => {
    expect(terminalResumeCommand('claude', 'abc')).toBe('claude --resume abc');
    expect(terminalResumeCommand('codex', 't-1')).toBe('codex resume t-1');
    expect(terminalResumeCommand('opencode', 'ses_1')).toBe('opencode --session ses_1');
    expect(terminalResumeCommand('codex', null)).toBeNull();
    expect(switchDividerLabel('claude', 'codex', 'outgoing')).toBe('Switched from Claude Code to Codex CLI · handover by Claude Code (outgoing agent)');
    expect(switchDividerLabel('codex', 'opencode', 'history')).toBe('Switched from Codex CLI to OpenCode · handover by OpenCode from the history');
  });
});
