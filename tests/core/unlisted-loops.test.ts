import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type LoopEventInput, deriveLoops, loopShown } from '../../src/core/derive/loops.ts';
import { cliPromptText, transcriptLoopEvents } from '../../src/core/derive/terminal-loops.ts';
import {
  CLI_PROMPT,
  UNLISTED_KIND,
  UNLISTED_LABEL,
  formatInterval,
  promptKey,
  samePrompt,
  seriesInterval,
  seriesRunning,
} from '../../src/core/derive/unlisted-loops.ts';
import { parseTranscript } from '../../src/core/transcript-sync.ts';
import { assistantTextLine, lastUuid, ndjson, terminalUserLine } from '../helpers/transcripts.ts';

/**
 * Unlisted schedules: recurring turns the CLI starts by itself with no job
 * Switchboard sees. The fixtures replay the half-hourly series of the 2026-10-09
 * report with made-up ids and prompts.
 */

const MIN = 60_000;
const HALF_HOUR = 30 * MIN;
const MONITOR = 'Production monitoring shift: sweep the error logs and fix what is safe.';

/** Stored-event style log (a supervised session): lifecycle, the CLI's prompts (from its transcript), turn results. */
function log(start = '2026-10-05T08:44:26.000Z') {
  const events: LoopEventInput[] = [];
  const add = (ts: string, payload: unknown, label = ''): void => {
    events.push({ ts, agentId: null, label, payload });
  };
  return {
    events,
    lifecycle: (action: string, ts = start) => add(ts, { type: 'lifecycle', action }, action),
    /** One CLI-started turn: its prompt at `at`, its result 40 s later. */
    fire: (at: number, text = MONITOR, isError = false) => {
      add(new Date(at).toISOString(), { type: CLI_PROMPT, text }, text);
      add(new Date(at + 40_000).toISOString(), { type: 'result', isError, taskNotification: false }, isError ? 'Sweep failed' : 'Nothing new.');
    },
    tool: (ts: string, name: string, input: Record<string, unknown>, result: string, toolUseId = randomUUID()) =>
      add(ts, { type: 'tool', name, toolUseId, input, result, isError: false }, name),
    user: (ts: string, text: string) => add(ts, { type: 'user', text, origin: 'user', delivered: true }, text),
    result: (ts: string, label = 'Done.') => add(ts, { type: 'result', isError: false, taskNotification: false }, label),
  };
}

/** The half-hourly series of the report: hh:15:07 and hh:45:07 from `from` to `to` (inclusive). */
function halfHourly(l: ReturnType<typeof log>, from: string, to: string): number[] {
  const times: number[] = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += HALF_HOUR) {
    l.fire(at);
    times.push(at);
  }
  return times;
}

describe('unlisted schedules · the interval estimate', () => {
  it('median of the newest gaps, tolerating jitter; null for fewer than 3, sub-minute bursts or irregular gaps', () => {
    const t0 = Date.parse('2026-10-07T10:15:07.000Z');
    expect(seriesInterval([t0, t0 + HALF_HOUR])).toBeNull();
    expect(seriesInterval([t0, t0 + HALF_HOUR, t0 + 2 * HALF_HOUR])).toBe(HALF_HOUR);
    // Jitter of a few seconds to a few minutes.
    expect(seriesInterval([t0, t0 + HALF_HOUR + 20_000, t0 + 2 * HALF_HOUR - 90_000, t0 + 3 * HALF_HOUR + 4 * MIN])).toBeCloseTo(HALF_HOUR + 20_000, -4);
    expect(seriesInterval([t0, t0 + 10_000, t0 + 20_000])).toBeNull();
    // A developer re-sending the same prompt by hand at odd times is no schedule.
    expect(seriesInterval([t0, t0 + 5 * MIN, t0 + 70 * MIN, t0 + 75 * MIN])).toBeNull();
    expect(seriesRunning([t0, t0 + HALF_HOUR, t0 + 2 * HALF_HOUR], t0 + 4 * HALF_HOUR)).toBe(true);
    expect(seriesRunning([t0, t0 + HALF_HOUR, t0 + 2 * HALF_HOUR], t0 + 4 * HALF_HOUR + 1)).toBe(false);
    expect([formatInterval(HALF_HOUR), formatInterval(3 * 3_600_000), formatInterval(86_400_000), formatInterval(2 * 86_400_000)]).toEqual(['~30 min', '~3 h', '~24 h', '~2 days']);
  });

  it('prompts are the same series by their first line (whitespace, case and numbers ignored)', () => {
    expect(promptKey('  Sweep   the logs (run 12)\nmore')).toBe('sweep the logs (run ##)');
    expect(samePrompt('Sweep the logs (run 12)', 'sweep the logs (run 13)')).toBe(true);
    expect(samePrompt(MONITOR, 'Production monitoring shift')).toBe(true);
    expect(samePrompt(MONITOR, 'Check the release.')).toBe(false);
    expect(samePrompt('', MONITOR)).toBe(false);
  });
});

describe('unlisted schedules · deriveLoops', () => {
  it('the report replayed: half-hourly CLI prompts with no visible job → one unlisted card next to the live one-shot', () => {
    const l = log();
    // Earlier process: its prompts are not counted (the process change starts the series over).
    l.fire(Date.parse('2026-10-05T07:14:00.000Z'));
    l.fire(Date.parse('2026-10-05T07:44:00.000Z'));
    l.lifecycle('continued');
    const times = halfHourly(l, '2026-10-07T00:15:07.000Z', '2026-10-09T19:15:07.000Z');
    l.user('2026-10-09T19:20:40.000Z', 'Remind me on Tuesday');
    l.tool('2026-10-09T19:20:53.000Z', 'CronCreate', { cron: '22 18 13 10 *', prompt: 'Check the release.', recurring: false }, 'Scheduled one-shot job 0c0c0c0c.');
    l.result('2026-10-09T19:21:00.000Z', 'Scheduled.');
    l.fire(Date.parse('2026-10-09T19:45:07.000Z'));
    times.push(Date.parse('2026-10-09T19:45:07.000Z'));

    const now = new Date('2026-10-09T20:00:00.000Z');
    const loops = deriveLoops(l.events, { now, status: 'idle', mainAgentId: null });
    expect(loops.map((loop) => [loop.kind, loop.label])).toEqual([
      ['CronCreate', 'cron 22 18 13 10 *'],
      [UNLISTED_KIND, UNLISTED_LABEL],
    ]);
    // The half-hourly firing after the one-shot was made is not the one-shot's.
    expect(loops[0]?.iteration).toBe(0);
    const unlisted = loops[1];
    expect(unlisted).toMatchObject({ iteration: times.length, nextFireAt: null, expiresAt: null, startedAt: '2026-10-07T00:15:07.000Z' });
    expect(unlisted?.key).toMatch(/^unlisted-[0-9a-z]+$/);
    expect(unlisted?.iterations.at(-1)).toMatchObject({ result: 'ok', ts: '2026-10-09T19:45:07.000Z', label: 'Nothing new.' });
    expect(unlisted?.iterations).toHaveLength(100);
    expect(unlisted?.note).toBe(
      `Prompt: "${MONITOR}". Started by the CLI itself about every 30 min; no job for it is visible (CronList does not list it), so its next firing and expiry are unknown. It may stop on its own (a recurring job auto-expires 7 days after it was created).`,
    );
    // Stable key across refreshes (the row is updated in place).
    expect(deriveLoops(l.events, { now, status: 'idle', mainAgentId: null })[1]?.key).toBe(unlisted?.key);
  });

  it('fewer than three prompts, or prompts at irregular times, are no card', () => {
    const l = log();
    l.lifecycle('continued');
    l.fire(Date.parse('2026-10-07T10:15:07.000Z'));
    l.fire(Date.parse('2026-10-07T10:45:07.000Z'));
    expect(deriveLoops(l.events, { now: new Date('2026-10-07T10:50:00.000Z'), status: 'idle' })).toEqual([]);
    l.fire(Date.parse('2026-10-07T13:01:00.000Z'));
    expect(deriveLoops(l.events, { now: new Date('2026-10-07T13:05:00.000Z'), status: 'idle' })).toEqual([]);
  });

  it('the card goes when the series stops (no prompt for more than twice the interval) or the process ends', () => {
    const l = log();
    l.lifecycle('continued');
    halfHourly(l, '2026-10-07T10:15:07.000Z', '2026-10-07T12:15:07.000Z');
    const at = (iso: string) => deriveLoops(l.events, { now: new Date(iso), status: 'idle' }).map((loop) => loop.kind);
    expect(at('2026-10-07T13:15:00.000Z')).toEqual([UNLISTED_KIND]);
    expect(at('2026-10-07T13:15:08.000Z')).toEqual([]);
    // The process ends: gone at once; a new process counts its own prompts only.
    l.lifecycle('paused', '2026-10-07T12:20:00.000Z');
    expect(at('2026-10-07T12:21:00.000Z')).toEqual([]);
    l.lifecycle('resumed', '2026-10-07T12:30:00.000Z');
    halfHourly(l, '2026-10-07T12:45:07.000Z', '2026-10-07T13:15:07.000Z');
    expect(at('2026-10-07T13:20:00.000Z')).toEqual([]);
    l.fire(Date.parse('2026-10-07T13:45:07.000Z'));
    const [card] = deriveLoops(l.events, { now: new Date('2026-10-07T13:50:00.000Z'), status: 'idle' });
    expect(card).toMatchObject({ kind: UNLISTED_KIND, iteration: 3, startedAt: '2026-10-07T12:45:07.000Z' });
  });

  it('a live loop with the same prompt explains the series (no unlisted card; the firings are its iterations); another prompt does not', () => {
    const l = log();
    l.lifecycle('continued');
    l.tool('2026-10-07T10:09:00.000Z', 'CronCreate', { cron: '15,45 * * * *', prompt: MONITOR }, 'Scheduled recurring job 1d1d1d1d (Every 30 minutes).');
    l.tool('2026-10-07T10:09:30.000Z', 'CronCreate', { cron: '0 9 * * *', prompt: 'Morning summary.' }, 'Scheduled recurring job 2e2e2e2e (Daily at 09:00).');
    halfHourly(l, '2026-10-07T10:15:07.000Z', '2026-10-07T12:15:07.000Z');
    const loops = deriveLoops(l.events, { now: new Date('2026-10-07T12:20:00.000Z'), status: 'idle' });
    expect(loops.map((loop) => [loop.label, loop.iteration])).toEqual([
      ['cron 15,45 * * * *', 5],
      ['cron 0 9 * * *', 0],
    ]);

    // Only the other cron is live: the series is unlisted and is not counted as that cron's firings.
    const m = log();
    m.lifecycle('continued');
    m.tool('2026-10-07T10:09:30.000Z', 'CronCreate', { cron: '0 9 * * *', prompt: 'Morning summary.' }, 'Scheduled recurring job 2e2e2e2e (Daily at 09:00).');
    halfHourly(m, '2026-10-07T10:15:07.000Z', '2026-10-07T12:15:07.000Z');
    const other = deriveLoops(m.events, { now: new Date('2026-10-07T12:20:00.000Z'), status: 'idle' });
    expect(other.map((loop) => [loop.kind, loop.iteration])).toEqual([
      ['CronCreate', 0],
      [UNLISTED_KIND, 5],
    ]);
  });

  it('a failed turn is a failed cell; the turn still running takes the session status', () => {
    const l = log();
    l.lifecycle('continued');
    l.fire(Date.parse('2026-10-07T10:15:07.000Z'));
    l.fire(Date.parse('2026-10-07T10:45:07.000Z'), MONITOR, true);
    l.events.push({ ts: '2026-10-07T11:15:07.000Z', agentId: null, label: '', payload: { type: CLI_PROMPT, text: MONITOR } });
    const [card] = deriveLoops(l.events, { now: new Date('2026-10-07T11:16:00.000Z'), status: 'run' });
    expect(card?.iterations.map((it) => it.result)).toEqual(['ok', 'fail', 'run']);
  });

  it('a stored unlisted card is shown only while its series runs', () => {
    const iterations = ['2026-10-07T10:15:07.000Z', '2026-10-07T10:45:07.000Z', '2026-10-07T11:15:07.000Z'].map((ts) => ({ result: 'ok' as const, ts, label: null }));
    const row = { kind: UNLISTED_KIND, expiresAt: null, iterations };
    expect(loopShown(row, new Date('2026-10-07T12:00:00.000Z'))).toBe(true);
    expect(loopShown(row, new Date('2026-10-07T12:16:00.000Z'))).toBe(false);
    expect(loopShown({ ...row, kind: 'CronCreate' }, new Date('2026-10-07T12:16:00.000Z'))).toBe(true);
  });
});

describe('unlisted schedules · transcripts (hooked and terminal sessions)', () => {
  const cwd = '/tmp/repo';
  const sid = 'cs-unlisted';
  /** A prompt line the CLI wrote itself (as in the report: `promptSource: "system"`, no `scheduledTaskId`). */
  const systemPrompt = (timestamp: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => ({
    ...terminalUserLine({ sessionId: sid, cwd, content: MONITOR, parentUuid, timestamp }),
    entrypoint: 'sdk-cli',
    promptSource: 'system',
    ...extra,
  });

  it('which prompt lines count: promptSource system, no job id, not a task notification, not a tool result', () => {
    const base = systemPrompt('2026-10-07T10:15:07.000Z', null);
    expect(cliPromptText(base)).toBe(MONITOR);
    expect(cliPromptText({ ...base, scheduledTaskId: '3f3f3f3f' })).toBeNull();
    expect(cliPromptText({ ...base, turnOrigin: 'task_notification' })).toBeNull();
    expect(cliPromptText({ ...base, promptSource: 'sdk' })).toBeNull();
    expect(cliPromptText({ ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } })).toBeNull();
    expect(cliPromptText({ ...base, message: { role: 'user', content: '<task-notification>done</task-notification>' } })).toBeNull();
    expect(cliPromptText({ ...base, message: { role: 'user', content: [{ type: 'text', text: MONITOR }] } })).toBe(MONITOR);
  });

  it('a transcript with the half-hourly series (sdk-cli after cli) → the unlisted card; a typed prompt in between does not break it', () => {
    const lines: Array<Record<string, unknown>> = [terminalUserLine({ sessionId: sid, cwd, content: 'Watch prod.', parentUuid: null, timestamp: '2026-10-05T07:00:00.000Z' })];
    lines.push(assistantTextLine({ sessionId: sid, cwd, text: 'Watching.', parentUuid: lastUuid(lines), timestamp: '2026-10-05T07:00:10.000Z' }));
    for (let at = Date.parse('2026-10-07T10:15:07.000Z'); at <= Date.parse('2026-10-07T12:15:07.000Z'); at += HALF_HOUR) {
      lines.push(systemPrompt(new Date(at).toISOString(), lastUuid(lines)));
      lines.push({ ...assistantTextLine({ sessionId: sid, cwd, text: 'Nothing new.', parentUuid: lastUuid(lines), timestamp: new Date(at + 40_000).toISOString() }), entrypoint: 'sdk-cli' });
      if (at === Date.parse('2026-10-07T11:15:07.000Z')) {
        lines.push({ ...terminalUserLine({ sessionId: sid, cwd, content: 'How is it going?', parentUuid: lastUuid(lines), timestamp: new Date(at + 5 * MIN).toISOString() }), entrypoint: 'sdk-cli' });
        lines.push({ ...assistantTextLine({ sessionId: sid, cwd, text: 'Fine.', parentUuid: lastUuid(lines), timestamp: new Date(at + 6 * MIN).toISOString() }), entrypoint: 'sdk-cli' });
      }
    }
    const events = transcriptLoopEvents(parseTranscript(ndjson(lines)));
    const loops = deriveLoops(events, { now: new Date('2026-10-07T12:30:00.000Z'), status: 'idle', mainAgentId: null });
    expect(loops.map((loop) => [loop.kind, loop.iteration])).toEqual([[UNLISTED_KIND, 5]]);
    expect(loops[0]?.iterations.map((it) => it.label)).toEqual(['Nothing new.', 'Nothing new.', 'Nothing new.', 'Nothing new.', 'Nothing new.']);
  });
});
