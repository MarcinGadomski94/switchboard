import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_KINDS,
  ARTIFACT_TEXT_MAX,
  ARTIFACT_TOOLS,
  artifactExtension,
  artifactFileName,
  artifactLine,
  artifactListText,
  checkArtifactLanguage,
  checkArtifactTitle,
  codeFence,
  isArtifactKind,
  lineDiff,
  messageArtifactTitle,
  parseCsv,
  textContentProblem,
} from '../../src/core/artifacts.ts';
import { AGENT_MCP_INSTRUCTIONS } from '../../src/core/todos.ts';

/** D89 (`docs/artifacts.md`): the shared rules of artifacts saved on purpose. */

describe('D89 · fields', () => {
  it('kinds, titles and languages', () => {
    expect(ARTIFACT_KINDS).toEqual(['markdown', 'code', 'html', 'mermaid', 'svg', 'image', 'csv']);
    expect(isArtifactKind('csv')).toBe(true);
    expect(isArtifactKind('pdf')).toBe(false);
    expect(checkArtifactTitle('  Plan  ')).toEqual({ ok: true, value: 'Plan' });
    for (const bad of ['', '  ', 'a\nb', 'x'.repeat(121), 3]) expect(checkArtifactTitle(bad).ok, String(bad)).toBe(false);
    expect(checkArtifactLanguage(' TS ')).toEqual({ ok: true, value: 'ts' });
    expect(checkArtifactLanguage('c++')).toEqual({ ok: true, value: 'c++' });
    expect(checkArtifactLanguage('')).toEqual({ ok: true, value: null });
    expect(checkArtifactLanguage(undefined)).toEqual({ ok: true, value: null });
    expect(checkArtifactLanguage('rm -rf').ok).toBe(false);
  });

  it('text content: not empty, at most 2 MB, svg must be SVG', () => {
    expect(textContentProblem('markdown', '# x')).toBeNull();
    expect(textContentProblem('markdown', ' \n ')).toContain('empty');
    expect(textContentProblem('markdown', 'é'.repeat(ARTIFACT_TEXT_MAX / 2 + 1))).toContain('at most 2 MB');
    expect(textContentProblem('svg', '<svg viewBox="0 0 1 1"/>')).toBeNull();
    expect(textContentProblem('svg', '<html>')).toContain('SVG');
  });

  it('extensions and download names', () => {
    expect(artifactExtension('markdown')).toBe('md');
    expect(artifactExtension('code', 'python')).toBe('py');
    expect(artifactExtension('code', 'brainfuck')).toBe('txt');
    expect(artifactExtension('mermaid')).toBe('mmd');
    expect(artifactExtension('image', null, 'image/jpeg')).toBe('jpg');
    expect(artifactFileName('Plan: v2 / final', 'md')).toBe('Plan_ v2 _ final.md');
    expect(artifactFileName('...', 'md')).toBe('artifact.md');
  });
});

describe('D89 · Save as artifact from a message', () => {
  it('proposes the first heading, else the first line, without Markdown', () => {
    expect(messageArtifactTitle('Here is the plan.\n\n## Release **plan** for `v2`\n\n- a')).toBe('Release plan for v2');
    expect(messageArtifactTitle('- [Docs](https://x) are *ready*\nmore')).toBe('Docs are ready');
    expect(messageArtifactTitle('```\n# not a heading\n```\nAfter')).toBe('not a heading');
    expect(messageArtifactTitle('   ')).toBe('Untitled');
    expect(messageArtifactTitle('x'.repeat(200))).toHaveLength(120);
  });

  it('wraps code in a fence longer than any backtick run', () => {
    expect(codeFence('a\n', 'ts')).toBe('```ts\na\n```');
    expect(codeFence('x ```` y', null)).toBe('`````\nx ```` y\n`````');
  });
});

describe('D89 · CSV and the version diff', () => {
  it('parses RFC 4180 CSV and caps the rows', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n1,\n')).toEqual({ rows: [['a', 'b'], ['x, y', 'say "hi"'], ['1', '']], total: 3 });
    expect(parseCsv('"multi\nline",2')).toEqual({ rows: [['multi\nline', '2']], total: 1 });
    expect(parseCsv('a\nb\nc\n', 2)).toEqual({ rows: [['a'], ['b']], total: 3 });
    expect(parseCsv('')).toEqual({ rows: [], total: 0 });
  });

  it('diffs lines (Myers): same, removed, added', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'same', text: 'c' },
      { op: 'add', text: 'd' },
    ]);
    expect(lineDiff('', 'x')).toEqual([{ op: 'add', text: 'x' }]);
    expect(lineDiff('x', '')).toEqual([{ op: 'del', text: 'x' }]);
    expect(lineDiff('same', 'same')).toEqual([{ op: 'same', text: 'same' }]);
    // Past the edit budget: the whole old text out, the new one in.
    expect(lineDiff('a\nb', 'c\nd', 1).map((line) => line.op)).toEqual(['del', 'del', 'add', 'add']);
  });

  it('a long diff stays a correct edit script', () => {
    const before = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const after = before.filter((_, i) => i % 7 !== 0).map((line, i) => (i % 11 === 0 ? `${line}!` : line));
    const diff = lineDiff(before.join('\n'), after.join('\n'));
    expect(diff.filter((l) => l.op !== 'add').map((l) => l.text)).toEqual(before);
    expect(diff.filter((l) => l.op !== 'del').map((l) => l.text)).toEqual(after);
  });
});

describe('D89 · the MCP tools', () => {
  it('artifact_save / artifact_list / artifact_get with every hint declared; save is not read-only, destructive, idempotent or open-world', () => {
    expect(ARTIFACT_TOOLS.map((tool) => tool.name)).toEqual(['artifact_save', 'artifact_list', 'artifact_get']);
    const save = ARTIFACT_TOOLS[0]!;
    expect(save.annotations).toEqual({ title: 'Save an artifact', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(save.inputSchema).toMatchObject({ required: ['title', 'kind'], additionalProperties: false });
    expect(Object.keys(save.inputSchema['properties'] as object)).toEqual(['title', 'kind', 'content', 'path', 'language', 'id']);
    for (const words of ['deliverable', 'report', 'Not for ordinary file edits', 'new version', 'near-duplicates']) expect(save.description).toContain(words);
    for (const tool of ARTIFACT_TOOLS.slice(1)) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    for (const tool of ARTIFACT_TOOLS) {
      for (const [name, property] of Object.entries((tool.inputSchema['properties'] ?? {}) as Record<string, { description?: string }>)) expect(property.description, `${tool.name}.${name}`).toBeTruthy();
    }
    expect(AGENT_MCP_INSTRUCTIONS).toContain('artifact_save');
  });

  it('prints the list compactly', () => {
    const artifact = { id: 'a1b2c3d4e5', title: 'Plan', kind: 'code' as const, language: 'ts', versions: 3, size: 2048, createdBy: 'developer' as const };
    expect(artifactLine(artifact)).toBe('[a1b2c3d4e5] Plan · code (ts) · v3 · 2.0 KB · saved by the developer');
    expect(artifactListText([])).toBe('This session has no artifacts yet.');
  });
});
