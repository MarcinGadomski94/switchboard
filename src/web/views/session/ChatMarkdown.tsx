import { type ReactNode, memo, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { codeLanguage } from './artifacts.ts';
import { LINK_REL, chatUrlTransform, rehypeChatText, safeLinkUrl } from './markdown.ts';
import './markdown.css';

/** A link that opens in a new tab, or its text alone when the URL is not allowed ({@link safeLinkUrl}). */
function ChatLink({ href, title, children }: { readonly href?: string | undefined; readonly title?: string | undefined; readonly children?: ReactNode }) {
  const url = href === undefined ? null : safeLinkUrl(href);
  if (url === null) return <span data-md-link="blocked">{children}</span>;
  return (
    <a href={url} title={title} target="_blank" rel={LINK_REL}>
      {children}
    </a>
  );
}

/**
 * Tag overrides: links open in a new tab (only http(s) / mailto are kept). Images
 * are already links by now ({@link rehypeChatText}); `img` renders nothing, so no
 * image can ever load.
 */
const COMPONENTS: Components = {
  a: ({ href, title, children }) => (
    <ChatLink href={href} title={title}>
      {children}
    </ChatLink>
  ),
  img: () => null,
};

/** A hast node's text (the code inside a `<pre>`, highlighted spans included). */
function hastText(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const value = node as { type?: unknown; value?: unknown; children?: unknown };
  if (value.type === 'text' && typeof value.value === 'string') return value.value;
  return Array.isArray(value.children) ? value.children.map(hastText).join('') : '';
}

/** D89: the code block's language (its `<code>`'s `language-…` class), `null` without one. */
function hastLanguage(node: unknown): string | null {
  const children = (node as { children?: unknown } | null)?.children;
  const code = Array.isArray(children) ? (children.find((child) => (child as { tagName?: unknown }).tagName === 'code') as { properties?: { className?: unknown } } | undefined) : undefined;
  return codeLanguage(code?.properties?.className);
}

const REMARK_PLUGINS = [remarkGfm];
/** Syntax colors for fenced blocks with a language (lowlight's common languages; no guessing without one). */
const REHYPE_PLUGINS = [rehypeChatText, rehypeHighlight];

/** Props of {@link ChatMarkdown}. */
export interface ChatMarkdownProps {
  /** The message's text, rendered as GitHub-flavored Markdown. */
  readonly text: string;
  /** D69: the test id of the wrapper (`chat-markdown` in the chat; the todo cards name theirs). */
  readonly testId?: string;
  /** D89: each fenced code block offers **Save as artifact** (kind code, its language); absent = no button. */
  readonly onSaveCode?: ((code: string, language: string | null) => void) | null;
}

/**
 * A chat message's text as GitHub-flavored Markdown (D20, `docs/chat.md` →
 * *Markdown*): headings, emphasis, lists, task lists (read-only), tables, block
 * quotes, inline code, fenced code blocks with syntax colors, links (new tab,
 * `rel="noopener noreferrer"`, http(s) / mailto only; bare URLs too) and rules.
 * Raw HTML is never rendered (its source shows as text) and images are not
 * loaded (they show as links). Text without Markdown looks exactly as it did as
 * plain text. Memoized on `text`: the chat re-renders on every event. D89: with
 * `onSaveCode`, each fenced code block has a **Save as artifact** button.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, testId = 'chat-markdown', onSaveCode = null }: ChatMarkdownProps) {
  const components = useMemo<Components>(
    () =>
      onSaveCode
        ? {
            ...COMPONENTS,
            pre: ({ node, children }) => (
              <div className="sb-md-code">
                <pre>{children}</pre>
                {/* The label is drawn by CSS (save-artifact.css): the message's text (copy, selection) never picks it up. */}
                <button type="button" className="sb-button sb-md-code-save" data-testid="chat-code-save" aria-label="Save as artifact" title="Save as artifact" onClick={() => onSaveCode(hastText(node).replace(/\n$/, ''), hastLanguage(node))} />
              </div>
            ),
          }
        : COMPONENTS,
    [onSaveCode],
  );
  return (
    <div className="sb-md" data-testid={testId}>
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components} urlTransform={chatUrlTransform}>
        {text}
      </Markdown>
    </div>
  );
});
