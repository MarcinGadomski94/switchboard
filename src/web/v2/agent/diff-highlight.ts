/**
 * D180 · syntax colours in a diff, pure (the developer: "the color coding in classes, html that
 * should be added"). The colours are the file reader's (lowlight `common`, the `.hljs-*` rules of
 * `side-panel.css`), on top of the added / removed backgrounds.
 *
 * Each hunk is highlighted once per side, so block comments and multi-line strings stay right:
 * the old side is its context plus removed lines, the new side its context plus added lines,
 * each joined with `\n`. {@link splitHighlightedLines} cuts the highlighted tree back into lines.
 */

/** The part of a hast tree a highlighter answers (lowlight's `root.children`). */
export type HastNode =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'element'; readonly tagName: string; readonly properties?: Readonly<Record<string, unknown>>; readonly children: readonly HastNode[] };

/** A highlighter: a text's tree, `null` when it cannot (an unknown language). */
export type Highlighter = (text: string) => readonly HastNode[] | null;

/** Above this many lines a file's diff stays plain text. */
export const HIGHLIGHT_MAX_LINES = 2000;

/**
 * The tree of a highlighted text, cut at its `\n`s into one list of nodes per line. A span that
 * crosses a line end (a block comment, a multi-line string) is repeated on every line it covers,
 * so each line carries its own colours. `n` lines of text give `n` lists (an empty line: an empty
 * list).
 */
export function splitHighlightedLines(nodes: readonly HastNode[]): HastNode[][] {
  const lines: HastNode[][] = [[]];
  const walk = (node: HastNode, wrap: (child: HastNode) => HastNode): void => {
    if (node.type === 'text') {
      const parts = node.value.split('\n');
      parts.forEach((part, index) => {
        if (index > 0) lines.push([]);
        if (part !== '') (lines[lines.length - 1] as HastNode[]).push(wrap({ type: 'text', value: part }));
      });
      return;
    }
    const element = node;
    for (const child of element.children) walk(child, (inner) => wrap({ type: 'element', tagName: element.tagName, ...(element.properties ? { properties: element.properties } : {}), children: [inner] }));
  };
  for (const node of nodes) walk(node, (child) => child);
  return lines;
}

/** One line of a numbered diff, as `ChangesPanel` lays it out. */
export interface ToneLine {
  readonly tone: 'add' | 'del' | 'ctx' | 'hunk' | 'note';
  readonly text: string;
}

/**
 * Each diff line's highlighted nodes (`null`: shown as plain text: a hunk header, a note, or a
 * hunk the highlighter could not read). `highlight` is called twice per hunk (old and new side).
 */
export function highlightDiff(lines: readonly ToneLine[], highlight: Highlighter): Array<HastNode[] | null> {
  const out: Array<HastNode[] | null> = lines.map(() => null);
  let start = 0;
  const flush = (end: number): void => {
    const oldIdx: number[] = [];
    const newIdx: number[] = [];
    for (let i = start; i < end; i++) {
      const tone = (lines[i] as ToneLine).tone;
      if (tone === 'ctx' || tone === 'del') oldIdx.push(i);
      if (tone === 'ctx' || tone === 'add') newIdx.push(i);
    }
    const side = (indexes: readonly number[]): HastNode[][] | null => {
      if (indexes.length === 0) return [];
      const tree = highlight(indexes.map((i) => (lines[i] as ToneLine).text).join('\n'));
      if (tree === null) return null;
      const split = splitHighlightedLines(tree);
      return split.length === indexes.length ? split : null;
    };
    const oldLines = side(oldIdx);
    const newLines = side(newIdx);
    // A context line takes the new side's colours (they are the same text); a removed line the old side's.
    newIdx.forEach((index, at) => {
      if (newLines) out[index] = newLines[at] ?? null;
    });
    oldIdx.forEach((index, at) => {
      if ((lines[index] as ToneLine).tone === 'del' && oldLines) out[index] = oldLines[at] ?? null;
    });
  };
  lines.forEach((line, index) => {
    if (line.tone === 'hunk') {
      flush(index);
      start = index + 1;
    }
  });
  flush(lines.length);
  return out;
}
