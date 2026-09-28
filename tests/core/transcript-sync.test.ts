import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type TranscriptEntry,
  entriesSince,
  isChainEntry,
  newestChain,
  parseTranscript,
  promptText,
  transcriptItems,
} from '../../src/core/transcript-sync.ts';
import { REPO_ROOT } from '../helpers/net.ts';

/** The M0.4 transcript fixtures (`docs/spike-m0.md` → *Fixtures (M0.4)*). */
async function fixture(name: string): Promise<TranscriptEntry[]> {
  const text = await readFile(path.join(REPO_ROOT, 'tools', 'fake-claude', 'fixtures', 'transcripts', `${name}.jsonl`), 'utf8');
  return relink(parseTranscript(text));
}

/**
 * The fixtures dropped the CLI's attachment lines (instructions, listings), so some
 * `parentUuid` links dangle. The real file (and the fake's) is complete: a dangling
 * link is re-pointed at the previous chain entry in file order, where the dropped
 * lines were.
 */
function relink(entries: TranscriptEntry[]): TranscriptEntry[] {
  const present = new Set(entries.filter(isChainEntry).map((e) => e['uuid'] as string));
  let previous: string | null = null;
  return entries.map((entry) => {
    if (!isChainEntry(entry)) return entry;
    const parent = entry['parentUuid'];
    const fixed = typeof parent === 'string' && !present.has(parent) ? { ...entry, parentUuid: previous } : entry;
    previous = entry['uuid'] as string;
    return fixed;
  });
}

/** Lines of a fixture by uuid prefix (the dump in the test names is `uuid[0..8]`). */
function uuid(entries: readonly TranscriptEntry[], prefix: string): string {
  const hit = entries.find((e) => typeof e['uuid'] === 'string' && (e['uuid'] as string).startsWith(prefix));
  if (!hit) throw new Error(`no entry ${prefix}`);
  return hit['uuid'] as string;
}

function summary(entries: readonly TranscriptEntry[]) {
  return transcriptItems(entries).map((item) => {
    switch (item.kind) {
      case 'prompt':
      case 'text':
        return `${item.kind}: ${item.text}`;
      case 'tool-use':
        return `tool-use: ${item.name} ${item.toolUseId}`;
      case 'tool-result':
        return `tool-result: ${item.toolUseId} ${item.isError ? 'error' : 'ok'} ${item.text}`;
    }
  });
}

const env = (fields: Record<string, unknown>): TranscriptEntry => ({ isSidechain: false, timestamp: '2026-09-28T10:00:00.000Z', ...fields });

describe('transcript sync (M4.1 Attach, M0.4)', () => {
  it('a parentUuid the file does not have falls back to the previous chain entry (like History), so a gap keeps the whole conversation', () => {
    const line = (uuid: string, parentUuid: string | null, type = 'user') => ({ type, uuid, parentUuid, isSidechain: false, message: { role: type, content: uuid } });
    const entries = [line('a', null), line('b', 'a', 'assistant'), line('c', 'missing'), line('d', 'c', 'assistant')];
    expect(newestChain(entries).map((e) => e['uuid'])).toEqual(['a', 'b', 'c', 'd']);
    // A root (no parent) still ends the chain.
    expect(newestChain([line('x', null), line('y', null)]).map((e) => e['uuid'])).toEqual(['y']);
  });

  it('handoff: after the service turn, the three terminal / re-attach turns are new (one chain, one leaf)', async () => {
    const entries = await fixture('handoff');
    const sync = uuid(entries, 'b8d35b6c'); // step 1's reply "OK": the last main-chain uuid the service saw
    const slice = entriesSince(entries, sync);
    expect(slice).toMatchObject({ found: true, forked: false, tip: uuid(entries, '39c2846d') });
    expect(summary(slice.entries)).toEqual([
      'prompt: Please also remember a second code word: kestrel. What was the first code word I gave you? Reply with just that word.',
      'text: tangerine',
      'prompt: What were the two code words so far? Reply with both words, comma-separated, in the order I gave them.',
      'text: tangerine, kestrel',
      'prompt: What were the two code words I asked you to remember? Reply with both words, comma-separated, in the order I gave them.',
      'text: tangerine, kestrel',
    ]);
    // Synced to the tip: nothing new.
    expect(entriesSince(entries, slice.tip).entries).toEqual([]);
  });

  it('handoff-mid: the synthetic "No response requested." line is skipped', async () => {
    const entries = await fixture('handoff-mid');
    const slice = entriesSince(entries, uuid(entries, '3eb54cb0')); // the interrupt marker
    expect(slice.entries.some((e) => (e['message'] as { model?: string } | undefined)?.model === '<synthetic>')).toBe(true);
    expect(summary(slice.entries)).toEqual(['prompt: What code word did I ask you to remember? Reply with just the word.', 'text: marigold']);
  });

  it('handoff-mid: a mid-tool turn yields the tool call, its rejected result and no interrupt marker', async () => {
    const entries = await fixture('handoff-mid');
    const items = summary(entriesSince(entries, uuid(entries, '27db804c')).entries); // after the first prompt
    expect(items[0]).toBe("text: I'll remember the code word: **marigold**\n\nNow running the command:");
    expect(items[1]).toMatch(/^tool-use: Bash toolu_/);
    expect(items[2]).toMatch(/^tool-result: toolu_\S+ error The user doesn't want to proceed/);
    expect(items.some((item) => item.includes('[Request interrupted'))).toBe(false);
    expect(items.slice(3)).toEqual(['prompt: What code word did I ask you to remember? Reply with just the word.', 'text: marigold']);
  });

  it('handoff-conc: two leaves → the newest one; a sync point on the older branch imports after the fork point', async () => {
    const entries = await fixture('handoff-conc');
    const chain = newestChain(entries).map((e) => e['uuid']);
    expect(chain.at(-1)).toBe(uuid(entries, 'df4b6224'));
    expect(chain).not.toContain(uuid(entries, 'd3bbc485')); // P2's "lantern, walnut, quokka" is off the conversation
    const slice = entriesSince(entries, uuid(entries, 'd3bbc485'));
    expect(slice).toMatchObject({ found: true, forked: true });
    expect(summary(slice.entries)).toEqual([
      'prompt: List every code word I asked you to remember so far, comma-separated, in order.',
      'text: lantern, walnut',
      'prompt: List every code word I asked you to remember so far, comma-separated, in order.',
      'text: lantern, walnut',
    ]);
  });

  it('no sync point yet → the whole chain; a sync point not in the file → nothing (never guessed)', async () => {
    const entries = await fixture('handoff');
    expect(summary(entriesSince(entries, null).entries)[0]).toBe('prompt: Remember the code word: tangerine. Reply with just OK.');
    expect(entriesSince(entries, 'not-in-this-file')).toMatchObject({ entries: [], found: false });
  });

  it('skips isMeta, sidechain, attachment and system entries; follows logicalParentUuid across a compaction', () => {
    const entries: TranscriptEntry[] = [
      env({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'first' } }),
      env({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', model: 'x', content: [{ type: 'text', text: 'one' }] } }),
      env({ type: 'system', subtype: 'compact_boundary', uuid: 's1', parentUuid: null, logicalParentUuid: 'a1' }),
      env({ type: 'user', uuid: 'u2', parentUuid: 's1', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } }),
      env({ type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: '<command-name>/loop</command-name>\n<command-args>1h check</command-args>' } }),
      env({ type: 'user', uuid: 'side', parentUuid: 'u3', isSidechain: true, message: { role: 'user', content: 'sidechain' } }),
      env({ type: 'attachment', uuid: 'at1', parentUuid: 'u3' }),
      env({ type: 'assistant', uuid: 'a2', parentUuid: 'at1', message: { id: 'm2', model: 'x', content: [{ type: 'thinking', thinking: '' }] } }),
      env({ type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { id: 'm2', model: 'x', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.md' } }] } }),
      env({ type: 'user', uuid: 'u4', parentUuid: 'a3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'written' }] } }),
      env({ type: 'assistant', uuid: 'a4', parentUuid: 'u4', message: { id: 'm3', model: 'x', content: [{ type: 'text', text: 'done' }] } }),
      { type: 'last-prompt', lastPrompt: '/loop 1h check', leafUuid: 'a4' },
    ];
    expect(newestChain(entries).map((e) => e['uuid'])).toEqual(['u1', 'a1', 's1', 'u2', 'u3', 'at1', 'a2', 'a3', 'u4', 'a4']);
    expect(summary(entriesSince(entries, 'a1').entries)).toEqual(['prompt: /loop 1h check', 'tool-use: Write t1', 'tool-result: t1 ok written', 'text: done']);
  });

  it('parses JSONL leniently and words slash commands', () => {
    expect(parseTranscript('{"a":1}\nnot json\n{"b":\n[1]\n{"c":2}\n')).toEqual([{ a: 1 }, { c: 2 }]);
    expect(promptText('<command-name>/usage</command-name>')).toBe('/usage');
    expect(promptText('<command-name>/loop</command-name><command-args> 5m /foo </command-args>')).toBe('/loop 5m /foo');
    expect(promptText('<local-command-stdout>x</local-command-stdout>')).toBeNull();
    expect(promptText('   ')).toBeNull();
    expect(promptText(' hello ')).toBe('hello');
  });
});
