import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveLoops } from '../../../src/core/derive/loops.ts';
import { transcriptLoopEvents } from '../../../src/core/derive/terminal-loops.ts';
import { parseTranscript } from '../../../src/core/transcript-sync.ts';
import { TranscriptLoopEvents } from '../../../src/server/loops/terminal.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * 1.24 perf (`docs/performance.md` → *Long runs (1.24)*): the transcript loop events kept in
 * memory carry only what `deriveLoops` reads, and a growing transcript is not parsed again
 * within `minRereadMs`.
 */

let tmp: string;
beforeEach(async () => {
  tmp = await makeTempDir('transcript-events');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;
const big = 'x'.repeat(50_000);

function transcript(): string {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, s)).toISOString();
  return [
    line({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(0), message: { role: 'user', content: `Please write it. ${big}` } }),
    line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(1), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.ts', content: big } }] } }),
    line({ type: 'user', uuid: 'r1', parentUuid: 'a1', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] } }),
    line({ type: 'assistant', uuid: 'a2', parentUuid: 'r1', timestamp: at(3), message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'check CI', recurring: true } }] } }),
    line({ type: 'user', uuid: 'r2', parentUuid: 'a2', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Scheduled job abc123' }] } }),
    line({ type: 'assistant', uuid: 'a3', parentUuid: 'r2', timestamp: at(5), message: { id: 'm3', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Done. ${big}` }] } }),
  ].join('');
}

describe('TranscriptLoopEvents', () => {
  it('keeps the loop essentials only, and derives the same loops as the whole events', async () => {
    const file = path.join(tmp, 't.jsonl');
    const text = transcript();
    await writeFile(file, text);
    const events = await new TranscriptLoopEvents().events(file);
    expect(JSON.stringify(events).length).toBeLessThan(5_000);
    const whole = transcriptLoopEvents(parseTranscript(text));
    expect(JSON.stringify(whole).length).toBeGreaterThan(150_000);
    const options = { now: new Date(Date.UTC(2026, 9, 19, 10, 1)), status: 'idle' as const, mainAgentId: null };
    expect(deriveLoops(events, options)).toEqual(deriveLoops(whole, options));
    expect(deriveLoops(events, options)).toHaveLength(1);
  });

  it('a file changed within minRereadMs answers the cached events as stale; after it, the file is read again', async () => {
    const file = path.join(tmp, 't.jsonl');
    await writeFile(file, transcript());
    let now = 1_000_000;
    const reader = new TranscriptLoopEvents(() => now);
    const first = await reader.read(file, 5_000);
    expect(first.stale).toBe(false);
    await appendFile(file, line({ type: 'user', uuid: 'u9', parentUuid: 'a3', timestamp: new Date(Date.UTC(2026, 9, 19, 10, 0, 9)).toISOString(), message: { role: 'user', content: 'More.' } }));
    now += 1_000;
    const soon = await reader.read(file, 5_000);
    expect(soon).toEqual({ events: first.events, stale: true });
    // Without a minimum (the terminal reader, the hooked sessions) a change is read at once.
    expect((await reader.read(file)).stale).toBe(false);
    now += 5_000;
    expect((await reader.read(file, 5_000)).stale).toBe(false);
  });
});
