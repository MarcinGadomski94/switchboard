import { beforeAll, describe, expect, it } from 'vitest';
import { artifactRawUrl } from '../../src/web/api/client.ts';
import { KIND_FILTERS, artifactMeta, codeDraft, codeLanguage, kindTag, messageDraft, renderedMarkdown, viewerModes } from '../../src/web/views/session/artifacts.ts';

/** D89: the artifact views' pure model (`src/web/views/session/artifacts.ts`) and their addresses. */

describe('D89 · artifact rows and the viewer', () => {
  it('tags, meta and modes', () => {
    expect(kindTag({ kind: 'code', language: 'ts' })).toBe('CODE · ts');
    expect(kindTag({ kind: 'mermaid', language: null })).toBe('DIAGRAM');
    expect(artifactMeta({ versions: 3, size: 1536, createdBy: 'agent' })).toBe('v3 · 1.5 KB · agent');
    expect(artifactMeta({ versions: 1, size: 10, createdBy: 'developer' })).toBe('v1 · 10 B · you');
    expect(viewerModes('markdown', 1)).toEqual(['rendered', 'source']);
    expect(viewerModes('html', 2)).toEqual(['rendered', 'source', 'diff']);
    expect(viewerModes('image', 4)).toEqual(['rendered']);
  });

  it('renders code as one highlighted block, Markdown as it is (Mermaid draws in its frame)', () => {
    expect(renderedMarkdown('markdown', null, '# a')).toBe('# a');
    expect(renderedMarkdown('code', 'ts', 'const a = 1;')).toBe('```ts\nconst a = 1;\n```');
    expect(renderedMarkdown('mermaid', null, 'graph TD')).toBeNull();
    expect(renderedMarkdown('csv', null, 'a,b')).toBeNull();
  });

  it('drafts: a message (markdown, its heading) and a code block (code, its language)', () => {
    expect(messageDraft('## Weekly report\n\nAll good.')).toEqual({ title: 'Weekly report', kind: 'markdown', language: null, content: '## Weekly report\n\nAll good.' });
    expect(codeDraft('x = 1', 'python', 'Here is the fix:\n```python\nx = 1\n```')).toMatchObject({ title: 'Here is the fix:', kind: 'code', language: 'python', content: 'x = 1' });
    expect(codeDraft('x', null, null).title).toBe('Snippet');
    expect(codeLanguage(['hljs', 'language-ts'])).toBe('ts');
    expect(codeLanguage('language-sql')).toBe('sql');
    expect(codeLanguage(undefined)).toBeNull();
  });

  it('the page\'s kind filters cover every kind once', () => {
    const covered = KIND_FILTERS.flatMap((filter) => filter.kinds ?? []);
    expect([...covered].sort()).toEqual(['code', 'csv', 'html', 'image', 'markdown', 'mermaid', 'svg']);
  });

  /** The router module, imported at run time (the server tsconfig has no JSX; Vitest transforms it). */
  const ROUTER = '../../src/web/router.tsx';
  type RouteLike = { readonly view: string; readonly id?: string; readonly tab?: string; readonly artifactId?: string };
  let parseRoute: (pathname: string) => RouteLike;
  let routePath: (route: RouteLike) => string;
  beforeAll(async () => {
    ({ parseRoute, routePath } = (await import(/* @vite-ignore */ ROUTER)) as { parseRoute: typeof parseRoute; routePath: typeof routePath });
  });

  it('addresses: the tab on an artifact, the raw bytes', () => {
    expect(parseRoute('/sessions/s1/artifacts/a1b2c3d4e5')).toEqual({ view: 'session', id: 's1', tab: 'artifacts', artifactId: 'a1b2c3d4e5' });
    expect(routePath({ view: 'session', id: 'r~m~s1', tab: 'artifacts', artifactId: 'a1' })).toBe('/sessions/r~m~s1/artifacts/a1');
    expect(routePath({ view: 'session', id: 's1', tab: 'artifacts' })).toBe('/sessions/s1/artifacts');
    expect(artifactRawUrl('s 1', 'a1', 2)).toBe('/api/sessions/s%201/artifacts/a1/versions/2/raw');
    expect(artifactRawUrl('s1', 'a1', 2, true)).toBe('/api/sessions/s1/artifacts/a1/versions/2/raw?download');
  });
});
