import { describe, expect, it } from 'vitest';
import type { OwnedLoop } from '../../src/core/api.ts';
import { LOOP_TOOLS, checkLoopInput, everyText, followingDue, loopChipText, loopLine, loopListText, loopTitle, nextDue, scheduleText } from '../../src/core/owned-loops.ts';
import { DEFAULT_STANDING_INSTRUCTION, PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS, currentStandingInstruction } from '../../src/core/settings.ts';

/** D94: the pure rules of Switchboard loops (`src/core/owned-loops.ts`). */

const local = (day: number, hour: number, minute = 0): Date => new Date(2026, 9, day, hour, minute, 0, 0);
const NOW = local(9, 10);

describe('checkLoopInput', () => {
  it('a create needs a prompt and exactly one schedule; API and tool field names both work', () => {
    expect(checkLoopInput({ prompt: ' Go ', every_minutes: 5 }, NOW)).toEqual({ ok: true, value: { prompt: 'Go', schedule: { kind: 'every', minutes: 5 } } });
    expect(checkLoopInput({ prompt: 'Go', everyMinutes: 5, expiresAt: local(10, 0).toISOString(), maxRuns: 3, label: ' Hi ' }, NOW)).toEqual({
      ok: true,
      value: { prompt: 'Go', schedule: { kind: 'every', minutes: 5 }, expiresAt: local(10, 0).toISOString(), maxRuns: 3, label: 'Hi' },
    });
    expect(checkLoopInput({ prompt: 'Go', cron: ' */30  * * * * ' }, NOW)).toMatchObject({ ok: true, value: { schedule: { kind: 'cron', cron: '*/30 * * * *' } } });
    expect(checkLoopInput({ prompt: 'Go', at: '2026-10-09T15:00:00+00:00' }, NOW)).toMatchObject({ ok: true, value: { schedule: { kind: 'at', at: '2026-10-09T15:00:00.000Z' } } });
    const fields = (body: unknown, partial = false): string[] => {
      const result = checkLoopInput(body, NOW, { partial });
      return result.ok ? [] : result.errors.map((error) => error.field);
    };
    expect(fields('x')).toEqual(['']);
    expect(fields({})).toEqual(['prompt', 'schedule']);
    expect(fields({ prompt: 'x', cron: '* * * * *', at: '2026-10-10T10:00' })).toEqual(['schedule']);
    expect(fields({ prompt: 'x', cron: '0 0 30 2 *' })).toEqual(['cron']);
    expect(fields({ prompt: 'x', every_minutes: 44_641 })).toEqual(['every_minutes']);
    expect(fields({ prompt: 'x', at: '2026-10-09T09:59' })).toEqual(['at']);
    expect(fields({ prompt: 'x', at: '2026-10-09T12:00', expires_at: '2026-10-09T11:00' })).toEqual(['expires_at']);
    expect(fields({ prompt: 'x'.repeat(10_001), every_minutes: 5 })).toEqual(['prompt']);
    expect(fields({ prompt: 'x', every_minutes: 5, label: 'y'.repeat(61) })).toEqual(['label']);
  });

  it('an update takes only what it gets; null removes the expiry and the run limit; nothing to change is an error', () => {
    expect(checkLoopInput({ expires_at: null, max_runs: null, label: '' }, NOW, { partial: true })).toEqual({ ok: true, value: { expiresAt: null, maxRuns: null, label: null } });
    expect(checkLoopInput({ every_minutes: 10 }, NOW, { partial: true })).toEqual({ ok: true, value: { schedule: { kind: 'every', minutes: 10 } } });
    expect(checkLoopInput({}, NOW, { partial: true })).toMatchObject({ ok: false });
    expect(checkLoopInput({ prompt: '' }, NOW, { partial: true })).toMatchObject({ ok: false, errors: [{ field: 'prompt' }] });
  });
});

describe('due times', () => {
  it('nextDue: cron (local), every (from the time given), at (while ahead)', () => {
    expect(nextDue({ kind: 'cron', cron: '0 2 * * *' }, NOW)).toEqual(local(10, 2));
    expect(nextDue({ kind: 'every', minutes: 30 }, NOW)).toEqual(local(9, 10, 30));
    expect(nextDue({ kind: 'at', at: local(9, 12).toISOString() }, NOW)).toEqual(local(9, 12));
    expect(nextDue({ kind: 'at', at: local(9, 9).toISOString() }, NOW)).toBeNull();
  });

  it('followingDue: one firing, the rest counted as missed; every keeps its rhythm', () => {
    expect(followingDue({ kind: 'every', minutes: 10 }, local(9, 10), local(9, 10))).toEqual({ next: local(9, 10, 10), missed: 0 });
    expect(followingDue({ kind: 'every', minutes: 10 }, local(9, 10), local(9, 10, 45))).toEqual({ next: local(9, 10, 50), missed: 4 });
    expect(followingDue({ kind: 'cron', cron: '0 * * * *' }, local(9, 10), local(9, 13, 30))).toEqual({ next: local(9, 14), missed: 3 });
    expect(followingDue({ kind: 'at', at: local(9, 10).toISOString() }, local(9, 10), local(9, 11))).toEqual({ next: null, missed: 0 });
  });
});

describe('texts', () => {
  it('schedule, title, chip and list lines', () => {
    expect([1, 5, 60, 90, 120, 1440, 2880].map(everyText)).toEqual(['every minute', 'every 5 min', 'every 1 h', 'every 1 h 30 min', 'every 2 h', 'every day', 'every 2 days']);
    expect(scheduleText({ kind: 'cron', cron: '30 8 * * 1-5' })).toBe('08:30 weekdays');
    expect(scheduleText({ kind: 'cron', cron: '5 4 3 2 *' })).toBe('cron 5 4 3 2 *');
    expect(scheduleText({ kind: 'at', at: local(12, 15).toISOString() })).toBe('once at 2026-10-12 15:00');
    expect(loopTitle(null, '\n  Check the CI run and report what failed in the nightly job please\nmore')).toBe('Check the CI run and report what failed in the …');
    expect(loopTitle(' CI ', 'x')).toBe('CI');
    expect(loopChipText({ label: 'CI watch', run: 12 })).toBe('⟳ CI watch · run 12');
    const loop = { id: 'a1b2c3d4e5', title: 'CI', scheduleText: 'every 30 min', nextFireAt: '2026-10-09T10:30:00.000Z', expiresAt: null, runs: 3, maxRuns: 10, skipped: 2, state: 'active', endedReason: null, createdBy: 'developer' } as OwnedLoop;
    expect(loopLine(loop)).toBe('[a1b2c3d4e5] CI · every 30 min · next: 2026-10-09T10:30:00.000Z · expires: no expiry · runs: 3 of 10 (2 skipped) · active · made by the developer');
    expect(loopLine({ ...loop, state: 'ended', endedReason: 'expired', nextFireAt: null, maxRuns: null, skipped: 0, createdBy: 'agent' })).toBe('[a1b2c3d4e5] CI · every 30 min · next: — · expires: no expiry · runs: 3 · ended: expired');
    expect(loopListText([])).toBe('This session has no Switchboard loops.');
  });

  it('the tools: annotated, described, and telling agents to prefer them over CronCreate and /loop', () => {
    expect(LOOP_TOOLS.map((tool) => tool.name)).toEqual(['loop_create', 'loop_list', 'loop_update', 'loop_pause', 'loop_resume', 'loop_cancel']);
    for (const tool of LOOP_TOOLS) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) expect(typeof tool.annotations[hint]).toBe('boolean');
      expect(tool.annotations.openWorldHint).toBe(false);
      const properties = (tool.inputSchema['properties'] ?? {}) as Record<string, { description?: string }>;
      for (const [name, property] of Object.entries(properties)) expect(property.description, `${tool.name}.${name}`).toBeTruthy();
    }
    expect(LOOP_TOOLS[0]?.description).toContain('Prefer this over CronCreate, ScheduleWakeup or /loop');
    expect(LOOP_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(['loop_list']);
    expect(LOOP_TOOLS.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name)).toEqual(['loop_update', 'loop_cancel']);
  });

  it('D94 · the standing instruction: one short line added; the 1.14 default reads as the new one', () => {
    expect(DEFAULT_STANDING_INSTRUCTION.endsWith(' For recurring or scheduled work use the switchboard loop_create tool, not CronCreate or /loop.')).toBe(true);
    const d89 = PREVIOUS_DEFAULT_STANDING_INSTRUCTIONS.at(-1) as string;
    expect(DEFAULT_STANDING_INSTRUCTION.startsWith(d89)).toBe(true);
    expect(currentStandingInstruction(d89)).toBe(DEFAULT_STANDING_INSTRUCTION);
  });
});
