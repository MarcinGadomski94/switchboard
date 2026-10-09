import { describe, expect, it } from 'vitest';
import type { Schedule, TerminalLoop } from '../../src/core/api.ts';
import { deriveLoops } from '../../src/core/derive/loops.ts';
import { transcriptLoopEvents } from '../../src/core/derive/terminal-loops.ts';
import { mapPeerAnswer, peerAnswerKind, peerSchedule, peerTerminalLoop } from '../../src/core/peer-wire.ts';
import { parseTranscript } from '../../src/core/transcript-sync.ts';
import { assistantTextLine, assistantToolLine, lastUuid, ndjson, terminalLoopLines, terminalUserLine, toolResultLine } from '../helpers/transcripts.ts';

/** D52 "A peer's schedules and loops": the pure parts (the wire mapping, a terminal transcript's loop events). */

const MACHINE = { id: 'abcdefghijkl', name: 'pc-office', state: 'online' as const };

const SCHEDULE: Schedule = {
  id: 'sch1',
  name: 'nightly',
  description: 'Reindex',
  cron: '0 2 * * *',
  paused: false,
  template: { name: 'nightly', task: 'Reindex', folder: 'f1' },
  runs: [
    { ts: '2026-09-29T02:00:00.000Z', result: 'ok', summary: 'OK', finishedAt: '2026-09-29T02:01:00.000Z', sessionId: 's1', triggeredBy: 'cron' },
    { ts: '2026-09-29T03:00:00.000Z', result: 'fail', summary: 'Not started: x', finishedAt: '2026-09-29T03:00:00.000Z', sessionId: null, triggeredBy: 'manual' },
  ],
  nextRunAt: '2026-09-30T02:00:00.000Z',
  running: false,
  folder: 'f1',
};

describe('D52 peer wire: schedules and terminal loops', () => {
  it('namespaces a schedule and its runs\' sessions, tags its machine, keeps its folder and template', () => {
    const mapped = peerSchedule(MACHINE, SCHEDULE);
    expect(mapped.id).toBe('r~abcdefghijkl~sch1');
    expect(mapped.runs.map((run) => run.sessionId)).toEqual(['r~abcdefghijkl~s1', null]);
    expect(mapped.machine).toEqual(MACHINE);
    expect(mapped.folder).toBe('f1');
    expect(mapped.template).toEqual(SCHEDULE.template);
  });

  it('namespaces a terminal loop\'s id (the terminal id stays raw: it is hooked on that machine)', () => {
    const entry = { loop: { id: 'term:cs1:loop', sessionId: 'cs1' }, terminal: { id: 'cs1' } } as unknown as TerminalLoop;
    const mapped = peerTerminalLoop(MACHINE, entry);
    expect(mapped.loop).toMatchObject({ id: 'r~abcdefghijkl~term:cs1:loop', sessionId: 'cs1' });
    expect(mapped.terminal.id).toBe('cs1');
    expect(mapped.machine).toEqual(MACHINE);
  });

  it('picks the mapping of the schedule routes and the terminal loops', () => {
    expect(peerAnswerKind('GET', '/api/schedules')).toBe('schedules');
    expect(peerAnswerKind('POST', '/api/schedules')).toBe('schedule');
    expect(peerAnswerKind('POST', '/api/schedules/sch1/run')).toBe('schedule');
    expect(peerAnswerKind('POST', '/api/schedules/sch1/pause')).toBe('schedule');
    expect(peerAnswerKind('POST', '/api/schedules/sch1/resume')).toBe('schedule');
    expect(peerAnswerKind('DELETE', '/api/schedules/sch1')).toBe('none');
    expect(peerAnswerKind('GET', '/api/terminal-loops')).toBe('terminal-loops');
    const list = mapPeerAnswer(MACHINE, 'schedules', [SCHEDULE, 'junk']) as Schedule[];
    expect(list.map((schedule) => schedule.id)).toEqual(['r~abcdefghijkl~sch1']);
    expect(mapPeerAnswer(MACHINE, 'schedule', { error: 'running' })).toEqual({ error: 'running' });
  });
});

describe('D52 terminal transcript → loop events', () => {
  const cwd = '/tmp/repo';
  const start = new Date('2026-09-29T10:00:00.000Z');

  it('a typed /loop with CronCreate and one firing of its own: iteration 2, the cron\'s next firing and expiry', () => {
    const events = transcriptLoopEvents(parseTranscript(ndjson(terminalLoopLines({ sessionId: 'cs1', cwd, start }))));
    expect(events.map((event) => (event.payload as { type: string }).type)).toEqual(['user', 'tool', 'assistant', 'result', 'assistant', 'result']);
    expect(events[0]?.payload).toEqual({ type: 'user', text: '/loop 5m check the build' });
    expect(events[1]?.payload).toMatchObject({ type: 'tool', name: 'CronCreate', result: expect.stringMatching(/^Scheduled recurring job a5207d74/), isError: false });
    const [loop] = deriveLoops(events, { now: new Date('2026-09-29T10:06:00.000Z'), status: 'idle', mainAgentId: null });
    expect(loop).toMatchObject({ kind: '/loop', label: '/loop 5m', iteration: 2, nextFireAt: '2026-09-29T10:10:00.000Z', expiresAt: '2026-10-06T10:00:02.000Z' });
    expect(loop?.iterations.map((it) => it.result)).toEqual(['ok', 'ok']);
    expect(loop?.note).toContain('Last iteration: Still green.');
  });

  it('D52 probe shapes: one result per message (a thinking line and a text line share its id), after its last line; two scheduled firings (isMeta prompts) are iterations 2 and 3', () => {
    const events = transcriptLoopEvents(parseTranscript(ndjson(terminalLoopLines({ sessionId: 'cs1', cwd, start, fires: 2 }))));
    expect(events.map((event) => (event.payload as { type: string }).type)).toEqual(['user', 'tool', 'assistant', 'result', 'assistant', 'result', 'assistant', 'result']);
    expect(events.filter((event) => (event.payload as { type: string }).type === 'result').map((event) => event.label)).toEqual(['Build is green.', 'Still green.', 'Green again.']);
    // The skill's body and the scheduled prompts are meta lines: not user messages.
    expect(events.filter((event) => (event.payload as { type: string }).type === 'user')).toHaveLength(1);
    const [loop] = deriveLoops(events, { now: new Date('2026-09-29T10:11:00.000Z'), status: 'idle', mainAgentId: null });
    expect(loop).toMatchObject({ kind: '/loop', iteration: 3, nextFireAt: '2026-09-29T10:15:00.000Z' });
    expect(loop?.iterations.map((it) => it.result)).toEqual(['ok', 'ok', 'ok']);
    expect(loop?.note).toContain('Last iteration: Green again.');
  });

  it('ScheduleWakeup and Workflow calls without a /loop; a failed Workflow run is a failed iteration', () => {
    const lines = [terminalUserLine({ sessionId: 'cs2', cwd, content: 'Watch the queue.', parentUuid: null, timestamp: '2026-09-29T10:00:00.000Z' })];
    lines.push(assistantToolLine({ sessionId: 'cs2', cwd, toolUseId: 't1', name: 'ScheduleWakeup', input: { delaySeconds: 600 }, parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:01.000Z' }));
    lines.push(toolResultLine({ sessionId: 'cs2', cwd, toolUseId: 't1', text: 'ok', parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:02.000Z' }));
    lines.push(assistantToolLine({ sessionId: 'cs2', cwd, toolUseId: 't2', name: 'Workflow', input: { name: 'rollout' }, parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:03.000Z' }));
    lines.push(toolResultLine({ sessionId: 'cs2', cwd, toolUseId: 't2', text: 'boom', isError: true, parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:04.000Z' }));
    lines.push(assistantTextLine({ sessionId: 'cs2', cwd, text: 'Waiting.', parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:05.000Z' }));
    const loops = deriveLoops(transcriptLoopEvents(parseTranscript(ndjson(lines))), { now: new Date('2026-09-29T10:01:00.000Z'), status: 'idle', mainAgentId: null });
    expect(loops.map((loop) => [loop.kind, loop.label, loop.nextFireAt])).toEqual([
      ['ScheduleWakeup', 'ScheduleWakeup', '2026-09-29T10:10:01.000Z'],
      ['Workflow', 'Workflow · rollout', null],
    ]);
    expect(loops[1]?.iterations.map((it) => it.result)).toEqual(['fail']);
  });

  it('D93: the CLI process changing (entrypoint cli → sdk-cli) ends the crons made before it; one made after lives', () => {
    const lines = [terminalUserLine({ sessionId: 'cs4', cwd, content: 'Watch prod.', parentUuid: null, timestamp: '2026-10-05T07:08:00.000Z' })];
    lines.push(assistantToolLine({ sessionId: 'cs4', cwd, toolUseId: 'c1', name: 'CronCreate', input: { cron: '10,40 * * * *', prompt: 'watch' }, parentUuid: lastUuid(lines), timestamp: '2026-10-05T07:08:20.000Z' }));
    lines.push(toolResultLine({ sessionId: 'cs4', cwd, toolUseId: 'c1', text: 'Scheduled recurring job b4444444 (Every 30 minutes).', parentUuid: lastUuid(lines), timestamp: '2026-10-05T07:08:22.000Z' }));
    lines.push(assistantTextLine({ sessionId: 'cs4', cwd, text: 'Scheduled.', parentUuid: lastUuid(lines), timestamp: '2026-10-05T07:08:30.000Z' }));
    const before = transcriptLoopEvents(parseTranscript(ndjson(lines)));
    expect(deriveLoops(before, { now: new Date('2026-10-05T08:00:00.000Z'), status: 'idle', mainAgentId: null })).toHaveLength(1);
    // The same conversation resumed by Switchboard (`sdk-cli`).
    const sdk = (line: Record<string, unknown>) => ({ ...line, entrypoint: 'sdk-cli' });
    lines.push(sdk(terminalUserLine({ sessionId: 'cs4', cwd, content: 'Remind me on Tuesday.', parentUuid: lastUuid(lines), timestamp: '2026-10-09T19:20:40.000Z' })));
    lines.push(sdk(assistantToolLine({ sessionId: 'cs4', cwd, toolUseId: 'c2', name: 'CronCreate', input: { cron: '22 18 13 10 *', prompt: 'check', recurring: false }, parentUuid: lastUuid(lines), timestamp: '2026-10-09T19:20:50.000Z' })));
    lines.push(sdk(toolResultLine({ sessionId: 'cs4', cwd, toolUseId: 'c2', text: 'Scheduled one-shot job c5555555.', parentUuid: lastUuid(lines), timestamp: '2026-10-09T19:20:53.000Z' })));
    lines.push(sdk(assistantTextLine({ sessionId: 'cs4', cwd, text: 'Scheduled.', parentUuid: lastUuid(lines), timestamp: '2026-10-09T19:21:00.000Z' })));
    const events = transcriptLoopEvents(parseTranscript(ndjson(lines)));
    expect(events.filter((event) => (event.payload as { type: string }).type === 'lifecycle').map((event) => event.ts)).toEqual(['2026-10-09T19:20:40.000Z']);
    const loops = deriveLoops(events, { now: new Date('2026-10-09T20:00:00.000Z'), status: 'idle', mainAgentId: null });
    expect(loops.map((loop) => loop.label)).toEqual(['cron 22 18 13 10 *']);
  });

  it('a plain conversation has no loops; lines off the newest chain are ignored', () => {
    const lines = [terminalUserLine({ sessionId: 'cs3', cwd, content: 'Refactor the parser.', parentUuid: null, timestamp: '2026-09-29T10:00:00.000Z' })];
    lines.push(assistantTextLine({ sessionId: 'cs3', cwd, text: 'Done.', parentUuid: lastUuid(lines), timestamp: '2026-09-29T10:00:30.000Z' }));
    // An abandoned branch (a sibling of the first reply, written first) that called CronCreate.
    const branch = assistantToolLine({ sessionId: 'cs3', cwd, toolUseId: 'tx', name: 'CronCreate', input: { cron: '* * * * *', prompt: 'x' }, parentUuid: lines[0]?.['uuid'] as string, timestamp: '2026-09-29T10:00:10.000Z' });
    const events = transcriptLoopEvents(parseTranscript(ndjson([lines[0]!, branch, lines[1]!])));
    expect(events.some((event) => (event.payload as { name?: string }).name === 'CronCreate')).toBe(false);
    expect(deriveLoops(events, { now: new Date(), status: 'idle', mainAgentId: null })).toEqual([]);
  });
});
