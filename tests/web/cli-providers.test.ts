import { describe, expect, it } from 'vitest';
import type { CliInfo, CliOverview } from '../../src/core/api.ts';
import { CLI_INSTALL, missingFeaturesText } from '../../src/core/cli-providers.ts';
import { cliChoices, effectiveCli } from '../../src/web/components/cli.ts';
import { DEFAULT_FORM, cliFallbackModels, formFromPrefill, formModelOptions, modelSummaryLine, toNewSession } from '../../src/web/modals/new-session.ts';
import { toSimpleBody } from '../../src/web/modals/simple-session.ts';
import { cliStateText, cliStateTone, commandSourceText, commandText, modelsText, parseCommandText } from '../../src/web/views/settings/clis.ts';

function cli(patch: Partial<CliInfo> & Pick<CliInfo, 'provider'>): CliInfo {
  return {
    label: patch.provider === 'claude' ? 'Claude Code' : patch.provider === 'codex' ? 'Codex CLI' : 'OpenCode',
    command: [patch.provider],
    commandSource: 'default',
    envVar: 'SWITCHBOARD_X_BIN',
    path: null,
    installed: true,
    version: '1.0',
    signedIn: true,
    account: null,
    supported: true,
    available: true,
    reason: null,
    models: null,
    checkedAt: '2026-10-01T00:00:00.000Z',
    install: CLI_INSTALL[patch.provider],
    ...patch,
  };
}

const OVERVIEW: CliOverview = {
  default: 'codex',
  clis: [cli({ provider: 'claude' }), cli({ provider: 'codex' }), cli({ provider: 'opencode', installed: false, available: false, reason: 'OpenCode is not installed' })],
};

describe('D62 CLI pickers (web)', () => {
  it('lists every CLI; an unavailable one is disabled with its state and reason', () => {
    expect(cliChoices(OVERVIEW)).toEqual([
      { provider: 'claude', label: 'Claude Code', disabled: false, reason: null },
      // An available CLI's tooltip names what it lacks here (D62 "equivalent or marked").
      { provider: 'codex', label: 'Codex CLI', disabled: false, reason: missingFeaturesText('codex') },
      { provider: 'opencode', label: 'OpenCode (not installed)', disabled: true, reason: 'OpenCode is not installed' },
    ]);
    // Before the overview loads, only Claude Code can be chosen.
    expect(cliChoices(null).map((choice) => choice.disabled)).toEqual([false, true, true]);
  });

  it('a form starts on its pick, else the default CLI when it can be chosen, else Claude Code', () => {
    expect(effectiveCli(null, OVERVIEW)).toBe('codex');
    expect(effectiveCli('opencode', OVERVIEW)).toBe('opencode');
    expect(effectiveCli(null, { ...OVERVIEW, default: 'opencode' })).toBe('claude');
    expect(effectiveCli(null, null)).toBe('claude');
  });

  it('the bodies carry the provider; a prefill names one; the fallback models are per CLI', () => {
    expect(toNewSession({ ...DEFAULT_FORM, name: 'x', task: 't', provider: 'codex' }).provider).toBe('codex');
    expect('provider' in toNewSession({ ...DEFAULT_FORM, name: 'x', task: 't' })).toBe(false);
    expect(toSimpleBody({ form: { ...DEFAULT_FORM, task: 'hi', provider: 'opencode' }, folder: null, branch: null, takenNames: [] }).provider).toBe('opencode');
    expect(formFromPrefill({ provider: 'opencode' }).provider).toBe('opencode');
    expect(formFromPrefill({ provider: 'gpt' as never }).provider).toBeNull();
    expect(formModelOptions(null, 'claude').map((m) => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(formModelOptions(null, 'codex')).toEqual(cliFallbackModels('codex'));
    expect(cliFallbackModels('codex')).toEqual([{ value: 'default', label: 'Default', description: "Codex CLI's default model" }]);
    expect(modelSummaryLine({ model: null, effort: null }, cliFallbackModels('codex'), 'codex').text).toBe('model     Codex CLI · Default');
    expect(modelSummaryLine({ model: null, effort: null }, cliFallbackModels('claude'), 'claude').text).toBe('model     Default');
  });
});

describe('D62 Settings → CLIs (web)', () => {
  it('reads and writes the command field like SWITCHBOARD_<X>_BIN', () => {
    expect(commandText(['codex'])).toBe('codex');
    expect(commandText(['node', '/x/cli.js'])).toBe('["node","/x/cli.js"]');
    expect(parseCommandText(' /opt/codex ')).toEqual({ ok: true, command: ['/opt/codex'] });
    expect(parseCommandText('["node","/x/cli.js"]')).toEqual({ ok: true, command: ['node', '/x/cli.js'] });
    expect(parseCommandText('')).toMatchObject({ ok: false });
    expect(parseCommandText('[1]')).toMatchObject({ ok: false });
    expect(parseCommandText('["a"')).toMatchObject({ ok: false });
  });

  it('says where the command comes from and the state of each CLI', () => {
    expect(commandSourceText(cli({ provider: 'codex', commandSource: 'settings' }))).toBe('set here (overrides the environment)');
    expect(commandSourceText(cli({ provider: 'codex', commandSource: 'env', envVar: 'SWITCHBOARD_CODEX_BIN' }))).toBe('from SWITCHBOARD_CODEX_BIN');
    expect(commandSourceText(cli({ provider: 'claude', envVar: 'SWITCHBOARD_CLAUDE_BIN' }))).toBe('looked up on PATH (set SWITCHBOARD_CLAUDE_BIN)');
    expect(cliStateText(cli({ provider: 'codex', version: 'codex-cli 0.159.3', account: 'Logged in using ChatGPT' }))).toBe('✓ codex-cli 0.159.3 · signed in (Logged in using ChatGPT)');
    expect(cliStateText(cli({ provider: 'codex', signedIn: false }))).toBe('✓ 1.0 · signed out');
    expect(cliStateText(cli({ provider: 'opencode', installed: false }))).toBe('Not installed');
    expect(cliStateText(cli({ provider: 'opencode', signedIn: null, account: '0 credentials' }))).toBe('✓ 1.0 · 0 credentials');
    expect(cliStateTone(cli({ provider: 'codex', signedIn: false }))).toBe('warn');
    expect(cliStateTone(cli({ provider: 'codex', installed: false }))).toBe('off');
    expect(modelsText(cli({ provider: 'codex', models: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }))).toBe('A, B');
    expect(modelsText(cli({ provider: 'codex' }))).toBe('Reported by its first session (or Check)');
  });
});

describe('D62 marking (web)', () => {
  it('names the missing features per CLI', () => {
    expect(missingFeaturesText('claude')).toBeNull();
    expect(missingFeaturesText('codex')).toBe('Not in Codex CLI: PDFs inline, background tasks, stopping background tasks, Workflow agents, Remote Control, teleport, hooked terminal sessions');
    expect(missingFeaturesText('opencode')).toBe('Not in OpenCode: usage limits, background tasks, stopping background tasks, Workflow agents, Remote Control, teleport, hooked terminal sessions');
  });
});

