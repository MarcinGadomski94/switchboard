import { type ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react';
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

/** Copies `text` to the clipboard (the async API, else a hidden textarea); `true` when it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea (e.g. no secure context, or permission refused).
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A fenced code block with its tools: **Copy** (D92), and D89's **Save as artifact** when the chat offers it. */
function CodeBlock({ node, children, onSaveCode }: { readonly node: unknown; readonly children?: ReactNode; readonly onSaveCode: ((code: string, language: string | null) => void) | null }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const code = (): string => hastText(node).replace(/\n$/, '');
  const copy = (): void => {
    void copyText(code()).then((ok) => {
      setCopied(ok ? 'copied' : 'failed');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied('idle'), 1500);
    });
  };
  return (
    <div className="sb-md-code">
      <pre>{children}</pre>
      {/* The labels are drawn by CSS (markdown.css / save-artifact.css): the message's text (copy, selection) never picks them up. */}
      <div className="sb-md-code-tools">
        <button type="button" className="sb-button sb-md-code-copy" data-testid="chat-code-copy" data-state={copied} aria-label={copied === 'copied' ? 'Copied' : 'Copy code'} title="Copy code" onClick={copy} />
        {onSaveCode ? <button type="button" className="sb-button sb-md-code-save" data-testid="chat-code-save" aria-label="Save as artifact" title="Save as artifact" onClick={() => onSaveCode(code(), hastLanguage(node))} /> : null}
      </div>
      <span className="sb-visually-hidden" role="status" aria-live="polite">
        {copied === 'copied' ? 'Copied to the clipboard' : copied === 'failed' ? 'Could not copy' : ''}
      </span>
    </div>
  );
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
    () => ({
      ...COMPONENTS,
      // D92: every fenced code block has Copy; D89 adds Save as artifact where the chat offers it.
      pre: ({ node, children }) => (
        <CodeBlock node={node} onSaveCode={onSaveCode}>
          {children}
        </CodeBlock>
      ),
    }),
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
