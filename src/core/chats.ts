/**
 * D106 · Chats (`docs/chats.md`): a conversation to think and plan in, started
 * instead of a development session. A chat runs in its own empty scratch folder
 * (`<dataDir>/chats/<id>/`) in its CLI's read-only mode (Claude Code's plan
 * permission mode, Codex's read-only sandbox, OpenCode's plan agent with edits and
 * commands denied), may read folders the developer names ("look at folders"),
 * keeps the `switchboard` MCP tools, and is continued as a session to code.
 * These are the shared rules and texts (server and UI).
 */

import { CLI_LABELS, type CliProviderId } from './cli-providers.ts';

/** What a stored session is: a development session (every one before D106) or a chat. */
export const SESSION_KINDS = ['session', 'chat'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** `true` for a known kind. */
export function isSessionKind(value: unknown): value is SessionKind {
  return typeof value === 'string' && (SESSION_KINDS as readonly string[]).includes(value);
}

/** A session object as the lists see it (`kind` absent = a session: a machine before D106 sends none). */
export interface KindOf {
  readonly kind?: SessionKind;
}

/** `true` for a chat (D106). */
export function isChat(session: KindOf | null | undefined): boolean {
  return session?.kind === 'chat';
}

/** The permission mode a chat's Claude Code process runs in, from its first spawn to its last (never changed). */
export const CHAT_PERMISSION_MODE = 'plan';

/**
 * The Claude Code tools a chat's process never gets (`--disallowedTools`): the file
 * editors, and `ExitPlanMode`, the tool that would take the CLI out of plan mode.
 */
export const CHAT_DISALLOWED_TOOLS: readonly string[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'ExitPlanMode'];

/** The hint where the permission-mode picker would be, and on the locked chip. */
export const CHAT_LOCKED_HINT = 'Chats can plan but not edit. Continue as session to code.';

/** The locked chip's text in a chat's header. */
export const CHAT_MODE_LABEL = 'Plan mode';

/** The chat badge's text (header, search results). */
export const CHAT_BADGE = 'chat';

/** The ⋯ menu item that opens the New-session form carrying the chat over. */
export const CONTINUE_AS_SESSION_LABEL = 'Continue as session…';

/** The ⋯ menu item (and the New-chat field) for the folders a chat may read. */
export const LOOK_AT_FOLDERS_LABEL = 'Look at folders…';

/** Why a chat is not continued in a terminal (the terminal's CLI could leave plan mode). */
export const CHAT_TERMINAL_REFUSAL = 'a chat stays in Switchboard: continue it as a session to work in a terminal';

/** Why a chat has no Remote Control (claude.ai could switch its permission mode). */
export const CHAT_REMOTE_REFUSAL = 'a chat has no Remote Control: claude.ai could take it out of plan mode';

/** Why a chat is not taken over to another machine. */
export const CHAT_TAKEOVER_REFUSAL = 'a chat is not taken over to another machine: start a chat there';

/** The chat's divider when its process restarted to read a changed list of folders. */
export const LOOK_AT_UPDATED_DIVIDER = 'Folders to look at updated';

/** Most folders a chat may look at. */
export const LOOK_AT_MAX = 10;

/** Longest first message a chat title is cut from (characters). */
export const CHAT_TITLE_MAX = 60;

/** The title of a chat whose first message has no words. */
export const CHAT_UNTITLED = 'New chat';

/**
 * A chat's title from its first message: its first line with text, Markdown marks
 * (`#`, `>`, `-`, `*`, backticks) and links reduced, spaces collapsed, cut at a word
 * boundary to {@link CHAT_TITLE_MAX} characters with "…".
 */
export function chatTitleFromMessage(message: string): string {
  const line =
    message
      .split('\n')
      .map((part) =>
        part
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
          .replace(/[`*_~]/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .find((part) => /[\p{L}\p{N}]/u.test(part)) ?? '';
  if (line === '') return CHAT_UNTITLED;
  if (line.length <= CHAT_TITLE_MAX) return line;
  const cut = line.slice(0, CHAT_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= CHAT_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** A chat's short name (unique: from its id). Chats never get a worktree or a branch, so it is only a key. */
export function chatName(id: string): string {
  return `chat-${id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
}

/**
 * D106: whether a CLI can run a chat, and why not. Every CLI Switchboard runs has a
 * read-only mode today (`docs/chats.md` → *Read-only per CLI*); the function is the
 * one place a CLI without one would say why (the New-chat form shows it in the picker).
 */
export function chatSupport(provider: CliProviderId): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  switch (provider) {
    case 'claude':
    case 'codex':
    case 'opencode':
      return { ok: true };
    default:
      return { ok: false, reason: `${CLI_LABELS[provider as CliProviderId] ?? provider} has no read-only mode Switchboard can hold a chat in` };
  }
}

/** The answer a chat's agent gets when it asks to use a tool that would change something (Switchboard refuses it, D106). */
export function chatRefusal(tool: string): string {
  return `Refused: this is a Switchboard chat, which can read and plan but never edit files or run commands that change things (${tool} is not allowed here). Describe the change instead; the developer continues the chat as a session to code it.`;
}

/** The chat's line for a tool Switchboard refused (a text event in its chat). */
export function chatRefusedLabel(tool: string): string {
  return `Refused in a chat: ${tool} (chats can plan but not edit)`;
}

/**
 * The instruction a chat's agent gets instead of the standing instruction (D106:
 * the workspace's / developer's standing instruction does not apply to chats; of
 * Switchboard's own parts, the "write it out before you ask" rule, the todo tools
 * and `artifact_save` apply, `loop_create` does not: a chat does no recurring work).
 */
export function chatInstruction(lookAt: readonly string[]): string {
  const folders =
    lookAt.length === 0
      ? 'You have no project folders: your working folder is an empty scratch folder. Ask the developer to add folders to look at if you need to read code.'
      : `You may read these folders for planning (read-only): ${lookAt.join(', ')}.`;
  return [
    'This is a Switchboard chat: a conversation to think and plan in, not a development session.',
    'You run in plan mode and stay there: read files, search, browse the web and look at what the developer attaches, but never edit or write files, never run commands that change anything, and never try to leave plan mode.',
    'When the developer wants something built, describe the plan; they continue the chat as a session to code it.',
    folders,
    "Before you ask the user a question that refers to a proposal, table, list, plan or comparison, write that content out in a message first, then ask. Never refer to content 'above' that you have not actually written in this conversation.",
    "Todo list: when asked to add to it, use the switchboard todo tools with a title, short description, handover plan (or 'No plan: reason'), priority and estimate (minutes).",
    'Save deliverables the developer should see (reports, plans, docs, diagrams, mockups) with the switchboard artifact_save tool; update the same artifact instead of creating new ones.',
  ].join(' ');
}

/** "Continued as <session>" (the chat's note and divider once it was continued as a session). */
export function continuedAsLabel(title: string): string {
  return `Continued as ${title}`;
}

/** The new session's divider: "Continued from the chat <title>". */
export function continuedFromChatLabel(title: string): string {
  return `Continued from the chat ${title}`;
}

/** Characters of the chat a new session's first message carries inline (the newest part; the export file has all of it). */
export const CARRY_OVER_INLINE_MAX = 60_000;

/**
 * The block a session continued from a chat starts its first message with (D106,
 * `docs/chats.md` → *Continue as session*): the chat as Switchboard recorded it
 * (the D62 history export's Markdown), the newest {@link CARRY_OVER_INLINE_MAX}
 * characters inline, and where the whole export is.
 */
export function chatCarryOver(input: { readonly title: string; readonly markdown: string; readonly exportPath: string | null }): string {
  const text = input.markdown.trim();
  const inline = text.length > CARRY_OVER_INLINE_MAX ? `[… the older part is left out here; the whole chat is in the export …]\n\n${text.slice(-CARRY_OVER_INLINE_MAX)}` : text;
  return [
    `This session continues the Switchboard chat "${input.title}", where the developer and an agent planned the work in plan mode (nothing was changed there). The conversation so far:`,
    '',
    '---',
    inline,
    '---',
    ...(input.exportPath ? ['', `The whole chat is also saved here: ${input.exportPath}`] : []),
    '',
    'Now you can edit files and run commands. The developer asks:',
    '',
  ].join('\n');
}
