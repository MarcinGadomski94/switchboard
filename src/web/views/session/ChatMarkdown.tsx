import { type ReactNode, memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
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

const REMARK_PLUGINS = [remarkGfm];
/** Syntax colors for fenced blocks with a language (lowlight's common languages; no guessing without one). */
const REHYPE_PLUGINS = [rehypeChatText, rehypeHighlight];

/** Props of {@link ChatMarkdown}. */
export interface ChatMarkdownProps {
  /** The message's text, rendered as GitHub-flavored Markdown. */
  readonly text: string;
  /** D69: the test id of the wrapper (`chat-markdown` in the chat; the todo cards name theirs). */
  readonly testId?: string;
}

/**
 * A chat message's text as GitHub-flavored Markdown (D20, `docs/chat.md` →
 * *Markdown*): headings, emphasis, lists, task lists (read-only), tables, block
 * quotes, inline code, fenced code blocks with syntax colors, links (new tab,
 * `rel="noopener noreferrer"`, http(s) / mailto only; bare URLs too) and rules.
 * Raw HTML is never rendered (its source shows as text) and images are not
 * loaded (they show as links). Text without Markdown looks exactly as it did as
 * plain text. Memoized on `text`: the chat re-renders on every event.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, testId = 'chat-markdown' }: ChatMarkdownProps) {
  return (
    <div className="sb-md" data-testid={testId}>
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS} urlTransform={chatUrlTransform}>
        {text}
      </Markdown>
    </div>
  );
});
