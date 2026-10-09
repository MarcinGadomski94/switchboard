import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDING_INSTRUCTION, STANDING_INSTRUCTION_MAX, SETTING_DEFAULTS, readKnownSettings } from '../../src/core/settings.ts';
import { STANDING_INSTRUCTION_DESCRIPTION, standingDraftState } from '../../src/web/views/settings/standing-instruction.ts';
import { INSTRUCTION_UPDATED_DIVIDER, applySummary, offersInstructionReload, staleInstructionCount, staleInstructionText } from '../../src/core/standing-instruction.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';

/** D64: the Settings field for the standing instruction. */
describe('standingDraftState', () => {
  it('Save only for a changed, bounded draft; Reset unless both stored and draft are the default', () => {
    expect(standingDraftState(DEFAULT_STANDING_INSTRUCTION, DEFAULT_STANDING_INSTRUCTION)).toEqual({ dirty: false, tooLong: false, canSave: false, canReset: false });
    expect(standingDraftState(DEFAULT_STANDING_INSTRUCTION, 'Mine')).toMatchObject({ dirty: true, canSave: true, canReset: true });
    expect(standingDraftState('Mine', 'Mine')).toMatchObject({ dirty: false, canSave: false, canReset: true });
    expect(standingDraftState('Mine', '')).toMatchObject({ canSave: true });
    expect(standingDraftState('Mine', 'x'.repeat(STANDING_INSTRUCTION_MAX + 1))).toMatchObject({ tooLong: true, canSave: false });
  });
});

describe('copy and defaults', () => {
  it('the note says a change applies to sessions started or resumed afterwards; on by default; the default text is short', () => {
    expect(STANDING_INSTRUCTION_DESCRIPTION).toContain('started or resumed afterwards');
    expect(readKnownSettings({})).toMatchObject({ 'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION, 'agents.standingInstruction.enabled': true });
    expect(SETTING_DEFAULTS['agents.standingInstruction.enabled']).toBe(true);
    // D68: the todo-list sentence made it longer (still short: it costs tokens in every session); D70: priority and estimate (502); D75: in progress when started, done when finished, always (550).
    // D89: the artifact sentence added; the bound moved up by that much only.
    expect(DEFAULT_STANDING_INSTRUCTION.length).toBeLessThan(740);
  });
});

/** D91: Apply to open sessions (the count, the result line) and a session's Reload instruction. */
describe('D91 · apply the standing instruction to open sessions', () => {
  it("counts this machine's open sessions on an older instruction (not a peer's, a closed or a hooked one)", () => {
    const sessions = [
      { instructionOutdated: true, closedAt: null, machine: null },
      { instructionOutdated: true },
      { instructionOutdated: false },
      { instructionOutdated: true, closedAt: '2026-10-09T10:00:00Z' },
      { instructionOutdated: true, machine: { id: 'peer', name: 'Laptop' } },
      { instructionOutdated: true, hooked: true },
    ];
    expect(staleInstructionCount(sessions)).toBe(2);
    expect(staleInstructionText(3)).toBe('3 open sessions use an older instruction');
    expect(staleInstructionText(1)).toBe('1 open session uses an older instruction');
    expect(staleInstructionText(0)).toBeNull();
  });

  it('the result line: applied (restarted + not running), after the turn, already current, failed', () => {
    expect(applySummary({ restarted: ['a', 'b'], notRunning: 1, pending: ['c'], current: 0, skipped: 2, failed: [{ sessionId: 'd', title: 'D', reason: 'gone' }] })).toBe(
      'Applied to 3 sessions (2 restarted, 1 not running: on their next start) · 1 after its turn · 1 failed',
    );
    expect(applySummary({ restarted: [], notRunning: 0, pending: [], current: 2, skipped: 0, failed: [] })).toBe('Applied to 0 sessions · 2 already current');
  });

  it("the ⋯ menu's Reload instruction: only this machine's open, Switchboard-run session on an older one", () => {
    expect(offersInstructionReload({ instructionOutdated: true, closedAt: null, machine: null, attached: true })).toBe(true);
    expect(offersInstructionReload({ instructionOutdated: false })).toBe(false);
    expect(offersInstructionReload({ instructionOutdated: true, machine: { id: 'p' } })).toBe(false);
    expect(offersInstructionReload({ instructionOutdated: true, hooked: true })).toBe(false);
    expect(offersInstructionReload({ instructionOutdated: true, attached: false })).toBe(false);
    expect(offersInstructionReload({ instructionOutdated: true, closedAt: '2026-10-09T10:00:00Z' })).toBe(false);
  });

  it('a restart for the instruction is a divider in the chat', () => {
    const events = [
      { id: 1, sessionId: 's', agentId: null, kind: 'text', label: INSTRUCTION_UPDATED_DIVIDER, ts: '2026-10-09T10:00:00Z', payload: { type: 'lifecycle', action: 'instruction-updated', pid: 42 } },
    ] as unknown as Parameters<typeof chatItems>[0];
    expect(chatItems(events, [], null, [])).toMatchObject([{ kind: 'divider', text: 'Standing instruction updated' }]);
  });
});
