import { describe, expect, it } from 'vitest';
import type { NewSession, Schedule, ScheduleRun } from '../../src/core/api.ts';
import type { ScheduleRunResult } from '../../src/core/model.ts';
import { DEFAULT_FORM, type NewSessionForm } from '../../src/web/modals/new-session.ts';
import {
  canSaveSchedule,
  cronPreview,
  formatRunTime,
  saveErrorText,
  scheduleSummaryLines,
  toScheduleInput,
} from '../../src/web/modals/schedule-form.ts';
import {
  actionErrorText,
  dotTone,
  lastLine,
  nextLine,
  resultTone,
  scheduleRows,
  stripCells,
  toneColor,
} from '../../src/web/views/schedule-table.ts';

const local = (month: number, day: number, hour = 0, minute = 0): Date => new Date(2026, month - 1, day, hour, minute);
const NOW = local(9, 28, 10, 0).getTime(); // a Monday
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function run(result: ScheduleRunResult, summary: string | null = null, finishedAgo = 60): ScheduleRun {
  return { ts: minutesAgo(finishedAgo + 5), result, summary, finishedAt: result === 'running' || result === 'need' ? null : minutesAgo(finishedAgo) };
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return { id: 's1', name: 'nightly-build-verify', description: 'Build web + mobile on main, report failures', cron: '0 2 * * *', paused: false, template: {}, runs: [], nextRunAt: null, running: false, ...overrides };
}

describe('schedule table model (M7.1)', () => {
  it('strip: the newest 14 runs oldest first, padded with none at the start; tones as the prototype letters', () => {
    expect(stripCells([])).toEqual(Array(14).fill('none'));
    expect(stripCells([run('ok'), run('fail')])).toEqual([...Array(12).fill('none'), 'done', 'fail']);
    const many = Array.from({ length: 20 }, (_, i) => run(i === 19 ? 'need' : 'ok'));
    expect(stripCells(many)).toEqual([...Array(13).fill('done'), 'need']);
    expect((['ok', 'fail', 'need', 'running', 'skipped'] as const).map(resultTone)).toEqual(['done', 'fail', 'need', 'run', 'none']);
    expect(toneColor('none')).toBe('var(--status-none)');
    expect(toneColor('done')).toBe('var(--status-done)');
  });

  it('dot: idle while paused; else the newest run that was not skipped; idle without runs', () => {
    expect(dotTone(schedule())).toBe('idle');
    expect(dotTone(schedule({ runs: [run('fail')] }))).toBe('fail');
    expect(dotTone(schedule({ runs: [run('ok'), run('skipped')] }))).toBe('done');
    expect(dotTone(schedule({ runs: [run('running')] }))).toBe('run');
    expect(dotTone(schedule({ runs: [run('fail')], paused: true }))).toBe('idle');
  });

  it('last line: the prototype copy from the newest run', () => {
    expect(lastLine([], NOW)).toBe('No runs yet');
    expect(lastLine([run('fail', 'Android XamlC', 38)], NOW)).toBe('Failed 38m ago · Android XamlC');
    expect(lastLine([run('fail', null, 120)], NOW)).toBe('Failed 2h ago');
    expect(lastLine([run('fail', 'x', 0)], NOW)).toBe('Failed just now · x');
    expect(lastLine([run('ok', '5 projects reindexed')], NOW)).toBe('OK · 5 projects reindexed');
    expect(lastLine([run('ok')], NOW)).toBe('OK');
    expect(lastLine([run('need', 'include QA coverage?')], NOW)).toBe('Asked: include QA coverage?');
    expect(lastLine([run('need')], NOW)).toBe('Waiting for you');
    expect(lastLine([run('running')], NOW)).toBe('Running now…');
    expect(lastLine([run('skipped', 'the previous run was still in progress')], NOW)).toBe('Skipped · the previous run was still in progress');
  });

  it('next: paused, in Xh Ym within a day, tomorrow HH:MM, weekday within a week, else the date', () => {
    const next = (date: Date | null, paused = false) => nextLine({ paused, nextRunAt: date ? date.toISOString() : null }, NOW);
    expect(next(local(9, 29, 2, 0), true)).toBe('paused');
    expect(next(null)).toBe('—');
    expect(next(local(9, 29, 9, 22))).toBe('in 23h 22m');
    expect(next(local(9, 28, 11, 12))).toBe('in 1h 12m');
    expect(next(local(9, 28, 12, 0))).toBe('in 2h');
    expect(next(local(9, 28, 10, 30))).toBe('in 30m');
    expect(next(new Date(NOW + 20_000))).toBe('in 1m');
    expect(next(local(9, 29, 10, 30))).toBe('tomorrow 10:30');
    expect(next(local(10, 2, 7, 0))).toBe('Fri 07:00');
    expect(next(local(10, 5, 7, 0))).toBe('5 Oct 07:00'); // a week away: the date
    expect(next(local(10, 29, 7, 0))).toBe('29 Oct 07:00');
  });

  it('rows: readable cron, labels of the buttons, running disables Run now', () => {
    const rows = scheduleRows(
      [
        schedule({ runs: [run('ok'), run('fail', 'Android XamlC', 38)], nextRunAt: local(9, 29, 2, 0).toISOString() }),
        schedule({ id: 's2', name: 'reindex', cron: '0 */4 * * *', paused: true, runs: [run('running')], running: true }),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.name, r.cronText, r.dot, r.last, r.next, r.runLabel, r.runDisabled, r.pauseLabel])).toEqual([
      ['nightly-build-verify', '02:00 daily', 'fail', 'Failed 38m ago · Android XamlC', 'in 16h', 'Run now', false, 'Pause'],
      ['reindex', 'every 4h', 'idle', 'Running now…', 'paused', 'Running', true, 'Resume'],
    ]);
    expect(rows[0]?.cron).toBe('0 2 * * *');
  });

  it('refusals read "Not done: …"', () => {
    expect(actionErrorText(409, { error: 'running', message: 'a run of this schedule is still in progress' })).toBe('Not done: a run of this schedule is still in progress');
    expect(actionErrorText(0, null)).toBe('Not done: Switchboard is not reachable.');
    expect(actionErrorText(500, null)).toBe('Not done: HTTP 500');
  });
});

describe('Schedule section of the New-session modal (D8)', () => {
  const form = (overrides: Partial<NewSessionForm> = {}): NewSessionForm => ({ ...DEFAULT_FORM, name: 'nightly-check', task: 'Check the build.', solutions: ['mobile'], ...overrides });
  const at = local(9, 28, 12, 0);

  it('previews a cron: readable text and the next 3 runs; explains an invalid or empty field', () => {
    expect(cronPreview('0 2 * * *', at)).toMatchObject({ ok: true, label: '02:00 daily', runs: ['Tue 29 Sep · 02:00', 'Wed 30 Sep · 02:00', 'Thu 1 Oct · 02:00'], error: null });
    expect(cronPreview('30 8 * * 1-5', at).runs).toEqual(['Tue 29 Sep · 08:30', 'Wed 30 Sep · 08:30', 'Thu 1 Oct · 08:30']);
    const invalid = cronPreview('0 25 * * *', at);
    expect(invalid).toMatchObject({ ok: false, runs: [], first: null });
    expect(invalid.error).toMatch(/not a valid hour/);
    expect(cronPreview('', at).error).toMatch(/enter a cron expression/);
    expect(cronPreview('0 0 30 2 *', at)).toMatchObject({ ok: false, error: 'this expression never runs (no such date)' });
    expect(formatRunTime(local(10, 5, 7, 5))).toBe('Mon 5 Oct · 07:05');
  });

  it('Save schedule needs what Start needs, a task (the prompt) and a valid cron; the name is unique among schedules', () => {
    const ok = cronPreview('0 2 * * *', at);
    expect(canSaveSchedule(form(), ok, [])).toBe(true);
    expect(canSaveSchedule(form({ task: '  ' }), ok, [])).toBe(false);
    expect(canSaveSchedule(form({ solutions: [] }), ok, [])).toBe(false);
    expect(canSaveSchedule(form(), cronPreview('nope', at), [])).toBe(false);
    expect(canSaveSchedule(form(), ok, ['nightly-check'])).toBe(false);
    expect(canSaveSchedule(form({ workType: 'qa' }), ok, [])).toBe(false);
  });

  it('summary: the first run’s worktree folders, a schedule line, the schedule’s warnings', () => {
    const lines = scheduleSummaryLines(form(), '/ws', cronPreview('0 2 * * *', at), []);
    const texts = lines.map((l) => l.text);
    expect(texts).toContain('schedule  02:00 daily');
    expect(texts.indexOf('schedule  02:00 daily')).toBe(texts.findIndex((t) => t.startsWith('ultracode')) + 1);
    expect(texts).toContain('../mobile-wt-nightly-check-0929-0200');
    expect(texts.at(-1)).toBe('✓ answers pre-filled → agent confirms, no re-ask');
    const warned = scheduleSummaryLines(form({ task: '' }), '/ws', cronPreview('x', at), ['nightly-check']).map((l) => l.text);
    expect(warned).toContain('schedule  —');
    expect(warned).toContain('../mobile-wt-nightly-check-<MMDD>-<HHMM>');
    expect(warned.slice(-5, -2)).toEqual(['⚠ a schedule with this name exists', '⚠ add the task: it is the prompt of every run', '⚠ enter a valid cron expression']);
  });

  it('the body is the cron + exactly what Start would post (+ the id for Edit); refusals read "Not saved: …"', () => {
    const body = toScheduleInput(form(), ' 0 2 * * * ', undefined);
    expect(body.cron).toBe('0 2 * * *');
    expect('id' in body).toBe(false);
    expect(body.template).toMatchObject<Partial<NewSession>>({ name: 'nightly-check', task: 'Check the build.', solutions: ['mobile'], worktrees: true });
    expect(toScheduleInput(form(), '0 2 * * *', 'abc').id).toBe('abc');
    expect(saveErrorText(422, { errors: [{ field: 'cron', message: 'cron: bad' }, { field: 'template.task', message: 'no task' }] })).toBe('Not saved: cron: bad; no task');
    expect(saveErrorText(404, { error: 'not-found', message: 'no schedule x' })).toBe('Not saved: no schedule x');
    expect(saveErrorText(0, null)).toBe('Not saved: Switchboard is not reachable.');
  });
});
