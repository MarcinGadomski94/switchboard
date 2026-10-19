/**
 * D89 · the pure model of the artifact views (`docs/artifacts.md`): the session's
 * Artifacts tab (list + viewer), the global Artifacts page and Save as artifact.
 * Artifacts are saved on purpose (by the agent's `artifact_save` or the
 * developer); nothing here is derived from tool results any more.
 */
import type { Artifact, ArtifactAuthor, ArtifactKind, ArtifactListItem } from '../../../core/api.ts';
import { artifactSizeLabel, codeFence, isTextKind, messageArtifactTitle } from '../../../core/artifacts.ts';

export { KIND_TAGS, kindTag } from '../../../core/artifacts.ts';

/** A kind in words (the viewer's head, the save dialog's picker). */
export const KIND_LABELS: Readonly<Record<ArtifactKind, string>> = {
  markdown: 'Markdown',
  code: 'Code',
  html: 'HTML',
  mermaid: 'Mermaid',
  svg: 'SVG',
  image: 'Image',
  csv: 'CSV',
};

/** Who saved it, as the rows say. */
export function authorLabel(author: ArtifactAuthor): string {
  return author === 'agent' ? 'agent' : 'you';
}

/** A row's meta: `v3 · 14.2 KB · agent`. */
export function artifactMeta(artifact: Pick<Artifact, 'versions' | 'size' | 'createdBy'>): string {
  return `v${artifact.versions} · ${artifactSizeLabel(artifact.size)} · ${authorLabel(artifact.createdBy)}`;
}

/** The viewer's modes: `rendered` (each kind as it is meant to be seen), `source` (the text), `diff` (two versions, text kinds). */
export type ViewerMode = 'rendered' | 'source' | 'diff';

/** The modes a kind offers: text kinds all three (diff once there are two versions); an image only rendered. */
export function viewerModes(kind: ArtifactKind, versions: number): ViewerMode[] {
  if (!isTextKind(kind)) return ['rendered'];
  return versions > 1 ? ['rendered', 'source', 'diff'] : ['rendered', 'source'];
}

/** The Markdown the viewer renders for a text kind's "rendered" view where that is Markdown: markdown as is, code as one highlighted block (Mermaid draws in its sandboxed frame). */
export function renderedMarkdown(kind: ArtifactKind, language: string | null, content: string): string | null {
  if (kind === 'markdown') return content;
  if (kind === 'code') return codeFence(content, language);
  return null;
}

/** The global page's kind filters (`kind=` values; `null` = all). */
export const KIND_FILTERS: readonly { readonly label: string; readonly kinds: readonly ArtifactKind[] | null }[] = [
  { label: 'All', kinds: null },
  { label: 'Docs', kinds: ['markdown'] },
  { label: 'Code', kinds: ['code'] },
  { label: 'HTML', kinds: ['html'] },
  { label: 'Diagrams', kinds: ['mermaid', 'svg'] },
  { label: 'Images', kinds: ['image'] },
  { label: 'Tables', kinds: ['csv'] },
];

/** What Save as artifact proposes for a whole message: its title (first heading or line), kind markdown. */
export function messageDraft(text: string): { readonly title: string; readonly kind: ArtifactKind; readonly language: string | null; readonly content: string } {
  return { title: messageArtifactTitle(text), kind: 'markdown', language: null, content: text };
}

/** What Save as artifact proposes for a code block: kind code with its language, titled after the message (`Snippet` when it has nothing to go by). */
export function codeDraft(code: string, language: string | null, messageText: string | null): { readonly title: string; readonly kind: ArtifactKind; readonly language: string | null; readonly content: string } {
  const title = messageText ? messageArtifactTitle(messageText) : 'Untitled';
  return { title: title === 'Untitled' ? `Snippet${language ? ` (${language})` : ''}` : title, kind: 'code', language, content: code };
}

/** A fenced code block's language from its `className` (`language-ts`, `hljs language-ts`), `null` without one. */
export function codeLanguage(className: unknown): string | null {
  const names = Array.isArray(className) ? className.map(String) : typeof className === 'string' ? className.split(/\s+/) : [];
  const hit = names.find((name) => name.startsWith('language-'));
  return hit ? hit.slice('language-'.length) || null : null;
}

/** Delete's question: one artifact by its title, several by their count (the viewer, a row's ⋯, the Artifacts page's bulk Delete). */
export function deleteQuestion(titles: readonly string[]): string {
  return titles.length === 1 ? `Delete “${titles[0]}” and all its versions? This cannot be undone.` : `Delete ${titles.length} artifacts and all their versions? This cannot be undone.`;
}

/** An Artifacts page row's key: its machine (D48) and its id (ids are unique per machine only). */
export function artifactKey(artifact: Pick<ArtifactListItem, 'id' | 'machine'>): string {
  return `${artifact.machine?.id ?? ''}/${artifact.id}`;
}

/**
 * The Artifacts page's selection after a reload or a filter change: only the keys of
 * rows still shown and still selectable (`selectable` false: their machine is
 * unreachable, D48). The same set back when nothing dropped out.
 */
export function keepSelected(selected: ReadonlySet<string>, rows: readonly ArtifactListItem[], selectable: (row: ArtifactListItem) => boolean): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const shown = new Set(rows.filter(selectable).map(artifactKey));
  const kept = [...selected].filter((key) => shown.has(key));
  return kept.length === selected.size ? selected : new Set(kept);
}

/** What a bulk Delete says when some deletes failed: how many and why (each distinct reason once); `null` when none failed. */
export function bulkDeleteFailure(reasons: readonly string[], total: number): string | null {
  if (reasons.length === 0) return null;
  const why = [...new Set(reasons)].join(' · ');
  return `${reasons.length} of ${total} could not be deleted: ${why}`;
}
