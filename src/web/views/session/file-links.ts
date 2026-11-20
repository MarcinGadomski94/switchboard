/**
 * D180 · side panel Files: paths in a reply become links. The agent view provides
 * the files its conversation touched; {@link ChatMarkdown} reads them from the
 * context and turns matching paths into buttons. Without a provider (the classic
 * theme, every other place) nothing changes.
 */
import { createContext } from 'react';
import { findPathRefs } from '../../../core/agent-files.ts';

/** Where a link leads. */
export interface FileLinkTarget {
  /** The absolute path. */
  readonly path: string;
  /** The line the agent first pointed at, `null` without one. */
  readonly line: number | null;
}

export interface FileLinks {
  /** By the path exactly as the agent wrote it (and by the absolute path). */
  readonly known: ReadonlyMap<string, FileLinkTarget>;
  readonly open: (path: string, line: number | null) => void;
}

export const FileLinksContext = createContext<FileLinks | null>(null);

/** The little of a hast tree this touches. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Text inside these is left alone: code is handled by its own renderer, links stay links. */
const SKIPPED = new Set(['code', 'pre', 'a', 'button']);

/** Wraps every known path in the prose of `tree` in a `<span data-sb-file data-sb-line>`. */
export function linkFilePaths(tree: HastNode, known: ReadonlyMap<string, FileLinkTarget>): void {
  if (!tree.children) return;
  if (tree.type === 'element' && tree.tagName && SKIPPED.has(tree.tagName)) return;
  const next: HastNode[] = [];
  for (const child of tree.children) {
    if (child.type !== 'text' || typeof child.value !== 'string') {
      linkFilePaths(child, known);
      next.push(child);
      continue;
    }
    const text = child.value;
    const refs = findPathRefs(text).filter((ref) => known.has(ref.path));
    if (refs.length === 0) {
      next.push(child);
      continue;
    }
    let at = 0;
    for (const ref of refs) {
      if (ref.index < at) continue;
      if (ref.index > at) next.push({ type: 'text', value: text.slice(at, ref.index) });
      const target = known.get(ref.path);
      const line = ref.line ?? target?.line ?? null;
      next.push({
        type: 'element',
        tagName: 'span',
        properties: { dataSbFile: target?.path ?? ref.path, dataSbLine: line === null ? '' : String(line) },
        children: [{ type: 'text', value: text.slice(ref.index, ref.index + ref.length) }],
      });
      at = ref.index + ref.length;
    }
    if (at < text.length) next.push({ type: 'text', value: text.slice(at) });
  }
  tree.children = next;
}
