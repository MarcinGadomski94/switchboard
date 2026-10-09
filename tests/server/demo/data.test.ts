import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_DATA_DIR, DEMO_DATA_FILES, ageMinutes, loadDemoData } from '../../../src/server/demo/data.ts';
import { REPO_ROOT } from '../../helpers/net.ts';

const PROTOTYPE = path.join(REPO_ROOT, 'docs', 'handoff', 'prototype', 'Switchboard App.dc.html');

/**
 * Keys whose values the seed adds on top of the prototype: run results the
 * prototype encodes as letters or colors, cron expressions for its readable
 * labels, the message author and the flag style. Every other string must appear
 * in the prototype verbatim.
 */
const ADDED_KEYS = new Set(['cron', 'runs', 'iterations', 'from', 'flagKind']);

/** The prototype source with JS string escapes undone, as a haystack. */
async function prototypeText(): Promise<string> {
  const html = await readFile(PROTOTYPE, 'utf8');
  return html.replaceAll("\\'", "'").replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}

function strings(value: unknown, key: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') out.push([key, value]);
  else if (Array.isArray(value)) for (const item of value) strings(item, key, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, k, out);
}

describe('demo seed data files (gap #21)', () => {
  it('holds only strings that appear verbatim in the prototype (apart from the added keys)', async () => {
    const haystack = await prototypeText();
    const missing: string[] = [];
    // D89: the artifacts are saved on purpose now, not the prototype's derived ART rows: not prototype copy.
    for (const file of DEMO_DATA_FILES.filter((name) => name !== 'artifacts.json')) {
      const data = JSON.parse(await readFile(path.join(DEMO_DATA_DIR, file), 'utf8')) as unknown;
      const found: Array<[string, string]> = [];
      strings(data, '', found);
      for (const [key, value] of found) {
        if (ADDED_KEYS.has(key) || value === '') continue;
        if (!haystack.includes(value)) missing.push(`${file} ${key}: ${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('carries every prototype array with its full length', async () => {
    const data = await loadDemoData();
    expect(data.sessions.map((s) => s.name)).toEqual([
      'free-talk-feature',
      'notifications-integration',
      'qa-free-talk',
      'button-rollout',
      'calendar-func-fix',
      'prod-monitoring',
    ]);
    expect(data.sessions.map((s) => s.questions.length)).toEqual([3, 1, 0, 1, 0, 0]);
    expect(data.sessions[0]?.files).toHaveLength(5);
    expect(data.sessions[0]?.timeline.flatMap((l) => l.blocks)).toHaveLength(16);
    expect(data.inbox.system.map((x) => x.id)).toEqual(['sys-run', 'sys-wt']);
    expect(data.inbox.incoming.question.options).toEqual(['Confluence (AC-7)', 'Figma', 'Flag as spec divergence']);
    expect(data.solutions.groups.map((g) => g.folder)).toEqual(['microfrontends/', 'mobile/', 'nugets/', 'microservices/', 'functions/', 'read-only']);
    expect(data.solutions.groups.flatMap((g) => g.solutions)).toHaveLength(12);
    expect(Object.keys(data.solutions.phaseLedgers)).toEqual(['mobile', 'acme-app-front']);
    expect(data.solutions.codebaseMemoryDirty.map((d) => d.project)).toEqual(['mobile', 'acme-app-front', 'components-library-nuget']);
    expect(data.schedules.map((s) => [s.name, s.cron, s.runs.length])).toEqual([
      ['nightly-build-verify', '0 2 * * *', 14],
      ['codebase-memory-reindex', '0 */4 * * *', 14],
      ['standup-digest', '30 8 * * 1-5', 14],
      ['dependency-audit', '0 7 * * 1', 14],
    ]);
    expect(data.loops.map((l) => [l.session, l.iterations.length])).toEqual([
      ['prod-monitoring', 17],
      ['button-rollout', 12],
    ]);
    expect(data.artifacts).toHaveLength(13); // D89: saved artifacts (not the prototype's ART rows), as many per session as its tabs count
    expect(data.history).toHaveLength(8);
    expect(data.tools.map((t) => [t.id, t.url])).toEqual([
      ['cm', 'http://localhost:13000'],
      ['sw', null],
    ]);
    expect(data.setup.scan).toHaveLength(8);
    expect(data.setup.wizardChecks).toHaveLength(3);
    expect(data.system.footer).toEqual({ service: '127.0.0.1:4870', processes: 9, cpu: '38%', ram: '11.2/32 GB', max: '62% · 1h48' });
  });

  it('reads prototype ages', () => {
    expect(ageMinutes('now')).toBe(0);
    expect(ageMinutes('38m')).toBe(38);
    expect(ageMinutes('3h')).toBe(180);
    expect(ageMinutes('6d')).toBe(8640);
    expect(() => ageMinutes('soon')).toThrow(/unreadable age/);
  });
});
