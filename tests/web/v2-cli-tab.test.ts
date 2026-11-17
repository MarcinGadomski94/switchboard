import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/core/api.ts';
import { cliTabState } from '../../src/web/v2/agent/cli-tab-model.ts';
import { CLI_MODE_WORDS } from '../../src/web/v2/glossary.ts';
import { parseV2Route } from '../../src/web/v2/routes.ts';

const session = (patch: Record<string, unknown> = {}): Session => ({ id: 's1', status: 'idle', kind: 'agent', provider: 'claude', ...patch }) as unknown as Session;

describe('D171 the agent CLI tab', () => {
  it('is a route of its own', () => {
    expect(parseV2Route('/agents/s1/cli')).toMatchObject({ area: 'agent', id: 's1', tab: 'cli' });
  });

  it('shows the terminal in CLI mode, here or on a paired computer', () => {
    expect(cliTabState(session({ cliMode: { terminalId: 't1' } }))).toEqual({ kind: 'cli', terminalId: 't1', machine: null });
    expect(cliTabState(session({ cliMode: { terminalId: 't2' }, machine: { id: 'm1', state: 'online' } }))).toEqual({ kind: 'cli', terminalId: 't2', machine: 'm1' });
  });

  it('switches an idle agent, and asks first while a turn runs', () => {
    expect(cliTabState(session())).toEqual({ kind: 'enter', running: false });
    expect(cliTabState(session({ status: 'run' }))).toEqual({ kind: 'enter', running: true });
  });

  it('says why it cannot switch', () => {
    expect(cliTabState(session({ provider: 'codex' }))).toEqual({ kind: 'unavailable', text: CLI_MODE_WORDS.notClaude('Codex CLI') });
    expect(cliTabState(session({ kind: 'chat' }))).toEqual({ kind: 'unavailable', text: CLI_MODE_WORDS.chat });
    expect(cliTabState(session({ hooked: true }))).toEqual({ kind: 'unavailable', text: CLI_MODE_WORDS.hooked });
    expect(cliTabState(session({ closedAt: '2026-01-01T00:00:00Z' }))).toEqual({ kind: 'unavailable', text: CLI_MODE_WORDS.archived });
    expect(cliTabState(session({ movedTo: { machineName: 'Laptop' } }))).toEqual({ kind: 'unavailable', text: CLI_MODE_WORDS.moved('Laptop') });
    expect(cliTabState(session({ machine: { id: 'm1', state: 'offline' } }))).toEqual({ kind: 'unavailable', text: CLI_MODE_WORDS.offline });
    expect(cliTabState(null)).toBeNull();
  });
});
