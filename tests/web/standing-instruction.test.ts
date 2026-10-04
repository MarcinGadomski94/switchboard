import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDING_INSTRUCTION, STANDING_INSTRUCTION_MAX, SETTING_DEFAULTS, readKnownSettings } from '../../src/core/settings.ts';
import { STANDING_INSTRUCTION_DESCRIPTION, standingDraftState } from '../../src/web/views/settings/standing-instruction.ts';

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
    // D68: the todo-list sentence made it longer (still short: it costs tokens in every session).
    expect(DEFAULT_STANDING_INSTRUCTION.length).toBeLessThan(400);
  });
});
