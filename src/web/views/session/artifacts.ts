/**
 * D89 · the pure model of the artifact views (`docs/artifacts.md`): the session's
 * Artifacts tab (list + viewer), the global Artifacts page and Save as artifact.
 * Artifacts are saved on purpose (by the agent's `artifact_save` or the
 * developer); nothing here is derived from tool results any more.
 */
import type { Artifact, ArtifactAuthor, ArtifactKind } from '../../../core/api.ts';
import { artifactSizeLabel, codeFence, isTextKind, messageArtifactTitle } from '../../../core/artifacts.ts';

/** The kind tag a row shows (short, mono). */
export const KIND_TAGS: Readonly<Record<ArtifactKind, string>> = {
  markdown: 'DOC',
  code: 'CODE',
  html: 'HTML',
  mermaid: 'DIAGRAM',
  svg: 'SVG',
  image: 'IMAGE',
  csv: 'TABLE',
};

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

/** The tag of an artifact's row: `CODE · ts` for code with a language. */
export function kindTag(artifact: Pick<Artifact, 'kind' | 'language'>): string {
  return artifact.kind === 'code' && artifact.language ? `${KIND_TAGS.code} · ${artifact.language}` : KIND_TAGS[artifact.kind];
}

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

/**
 * D89 ruling (`docs/decisions.md` → D89, *Mermaid*): a Mermaid diagram is shown as
 * its source (highlighted), with this note: rendering it would need the Mermaid
 * library, a large runtime dependency the app does not carry.
 */
export const MERMAID_NOTE = 'Mermaid source: Switchboard does not draw Mermaid diagrams (that needs the Mermaid library). Copy it into a Mermaid viewer, or Download the .mmd.';

/** The Markdown the viewer renders for a text kind's "rendered" view where that is Markdown: markdown as is, code and mermaid as one highlighted block. */
export function renderedMarkdown(kind: ArtifactKind, language: string | null, content: string): string | null {
  if (kind === 'markdown') return content;
  if (kind === 'code') return codeFence(content, language);
  if (kind === 'mermaid') return codeFence(content, 'mermaid');
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
