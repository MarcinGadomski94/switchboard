/**
 * The facts History (M7.4) reads from one Claude Code transcript
 * (`<configDir>/projects/<slug>/<sessionId>.jsonl`, `docs/spike-m0.md` → M0.3
 * *Transcript format* and *Sample parse*, M0.4 *Transcript behavior*). The parser
 * takes one line at a time, so the server can feed it from an async stream and
 * never hold a file (they reach tens of MB) in memory. Pure: no I/O here.
 *
 * Rules (`docs/derivations.md` → *History*):
 * - a **human prompt** is a main-chain `user` line that is not meta, not a
 *   tool_result, not a system / task-notification turn, and whose text is not a
 *   slash command, local-command output or an interrupt marker;
 * - a **slash command** is a main-chain `user` line carrying `<command-name>`;
 * - the **last text** is the newest assistant text on the chain of the newest
 *   leaf (the last chain entry in the file, as the CLI continues from it), skipping
 *   `model:"<synthetic>"` lines; a `parentUuid` that points at a line the file does
 *   not have falls back to the previous chain entry in file order.
 */

/** Bumped when the parsed shape or its rules change; older cached facts are re-parsed (2: D24 `remoteControl`). */
export const TRANSCRIPT_FACTS_VERSION = 2;

/** Longest stored first / last prompt and command (characters). */
const PROMPT_CAP = 500;
/** Longest stored last assistant text (characters). */
const TEXT_CAP = 4000;
/** Longest stored search text of all prompts (characters). */
const PROMPTS_CAP = 8000;
/** Most distinct working folders kept. */
const CWDS_CAP = 100;

/** What History needs from one transcript file. JSON-safe (cached in `history_cache.item`). */
export interface TranscriptFacts {
  /** {@link TRANSCRIPT_FACTS_VERSION} at parse time. */
  readonly v: number;
  /** The file name without `.jsonl` (= the CLI session id). */
  readonly sessionId: string;
  /** `cwd` of the first entry that has one: where the session started. */
  readonly startCwd: string | null;
  /** Distinct `cwd` values in order of first appearance (the session follows `cd`). */
  readonly cwds: readonly string[];
  /** `gitBranch` of the first entry that has one (resolved from the start cwd; `"HEAD"` outside a repo). */
  readonly gitBranch: string | null;
  /** First and last `timestamp` in the file. */
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  /** `entrypoint` of the first human prompt, else of the first slash command (`cli` = interactive terminal). */
  readonly entrypoint: string | null;
  /** Every distinct `entrypoint` (a Switchboard session continued in a terminal mixes `sdk-cli` and `cli`). */
  readonly entrypoints: readonly string[];
  readonly firstPrompt: string | null;
  /** The first slash command as typed: `/loop 1h Watch the build`. */
  readonly firstCommand: string | null;
  /** `true` when a slash command came before any human prompt. */
  readonly startedWithCommand: boolean;
  /** The last `last-prompt` entry, else the last human prompt. */
  readonly lastPrompt: string | null;
  readonly humanTurns: number;
  /** Last `custom-title` (`--name`, `/rename`) and last `ai-title`. */
  readonly customTitle: string | null;
  readonly aiTitle: string | null;
  /** Newest main-chain assistant text on the newest leaf's chain (see the module comment). */
  readonly lastText: string | null;
  /** `prNumber` of the last `pr-link` entry. */
  readonly prNumber: number | null;
  /** The human prompts joined by newlines (search text, capped). */
  readonly prompts: string;
  /** Lines that were not a JSON object. */
  readonly badLines: number;
  /**
   * D24: the file has a `{type:"bridge-session", …}` line: the conversation had
   * Remote Control on (`docs/spike-remote.md` → R.8), History's "Remote Control" badge.
   */
  readonly remoteControl: boolean;
}

type Entry = Record<string, unknown>;

/** Entry types that form the `parentUuid` chain (M0.3 envelope). */
const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);

function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The text blocks of a message `content` (a string counts as one text block). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Entry => isEntry(block) && block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('\n');
}

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function isToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isEntry(block) && block['type'] === 'tool_result');
}

/** A prompt someone typed or Switchboard sent (spike M0.3 `isHumanPrompt`), else `null`. */
export function humanPromptText(entry: Entry): string | null {
  if (entry['type'] !== 'user' || entry['isSidechain'] === true || entry['isMeta'] === true) return null;
  const content = isEntry(entry['message']) ? entry['message']['content'] : undefined;
  if (isToolResult(content)) return null;
  if (entry['promptSource'] === 'system' || entry['turnOrigin'] === 'task_notification') return null;
  const text = contentText(content).trim();
  if (!text || text.startsWith('<local-command-') || text.startsWith('<command-') || text.startsWith('[Request interrupted')) return null;
  return text;
}

/** A slash command line (`<command-name>/loop</command-name>…<command-args>1h …</command-args>`) as `/loop 1h …`, else `null`. */
export function slashCommandText(entry: Entry): string | null {
  if (entry['type'] !== 'user' || entry['isSidechain'] === true || entry['isMeta'] === true) return null;
  const content = isEntry(entry['message']) ? entry['message']['content'] : undefined;
  if (isToolResult(content)) return null;
  const text = contentText(content);
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '';
  const command = name.startsWith('/') ? name : `/${name}`;
  return `${command} ${args}`.replace(/\s+/g, ' ').trim();
}

interface ChainEntry {
  readonly uuid: string;
  readonly parent: string | null;
  readonly logicalParent: string | null;
}

/**
 * Accumulates {@link TranscriptFacts} line by line: `pushLine` for raw NDJSON
 * lines, `push` for parsed entries, then `finish` once.
 */
export class TranscriptParser {
  readonly #sessionId: string;
  readonly #chain: ChainEntry[] = [];
  readonly #index = new Map<string, number>();
  /** Assistant line uuid → its `message.id` (lines with text only). */
  readonly #textLine = new Map<string, string>();
  /** `message.id` → its text blocks joined (one message is written as one line per block). */
  readonly #messageText = new Map<string, string>();
  readonly #cwds: string[] = [];
  readonly #entrypoints: string[] = [];
  #startCwd: string | null = null;
  #gitBranch: string | null = null;
  #startedAt: string | null = null;
  #lastActivityAt: string | null = null;
  #promptEntrypoint: string | null = null;
  #commandEntrypoint: string | null = null;
  #firstPrompt: string | null = null;
  #lastHumanPrompt: string | null = null;
  #lastPromptEntry: string | null = null;
  #firstCommand: string | null = null;
  #startedWithCommand = false;
  #humanTurns = 0;
  #customTitle: string | null = null;
  #aiTitle: string | null = null;
  #prNumber: number | null = null;
  #prompts = '';
  #badLines = 0;
  #remoteControl = false;

  /** @param sessionId the file name without `.jsonl`. */
  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  /** One raw line of the file; blank lines are skipped, anything but a JSON object counts as bad. */
  pushLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#badLines += 1;
      return;
    }
    if (isEntry(parsed)) this.push(parsed);
    else this.#badLines += 1;
  }

  /** One parsed entry. */
  push(entry: Entry): void {
    const timestamp = str(entry['timestamp']);
    if (timestamp) {
      this.#startedAt ??= timestamp;
      this.#lastActivityAt = timestamp;
    }
    const type = entry['type'];
    const sidechain = entry['isSidechain'] === true;
    const uuid = str(entry['uuid']);
    if (typeof type === 'string' && CHAIN_TYPES.has(type) && !sidechain) {
      if (uuid) {
        this.#index.set(uuid, this.#chain.length);
        this.#chain.push({ uuid, parent: str(entry['parentUuid']), logicalParent: str(entry['logicalParentUuid']) });
      }
      const cwd = str(entry['cwd']);
      if (cwd) {
        this.#startCwd ??= cwd;
        if (!this.#cwds.includes(cwd) && this.#cwds.length < CWDS_CAP) this.#cwds.push(cwd);
      }
      const branch = str(entry['gitBranch']);
      if (branch) this.#gitBranch ??= branch;
      const entrypoint = str(entry['entrypoint']);
      if (entrypoint && !this.#entrypoints.includes(entrypoint)) this.#entrypoints.push(entrypoint);
    }

    switch (type) {
      case 'user':
        this.#onUser(entry);
        break;
      case 'assistant':
        this.#onAssistant(entry, uuid, sidechain);
        break;
      case 'last-prompt': {
        const text = str(entry['lastPrompt']);
        if (text) this.#lastPromptEntry = cap(text, PROMPT_CAP);
        break;
      }
      case 'custom-title':
        this.#customTitle = str(entry['customTitle'])?.trim() || this.#customTitle;
        break;
      case 'ai-title':
        this.#aiTitle = str(entry['aiTitle'])?.trim() || this.#aiTitle;
        break;
      case 'pr-link':
        if (typeof entry['prNumber'] === 'number' && Number.isFinite(entry['prNumber'])) this.#prNumber = entry['prNumber'];
        break;
      case 'bridge-session':
        // D24: `{type:"bridge-session", sessionId, bridgeSessionId:"cse_…", …}` (R.8): Remote Control was on.
        this.#remoteControl = true;
        break;
      default:
        break;
    }
  }

  #onUser(entry: Entry): void {
    const prompt = humanPromptText(entry);
    const entrypoint = str(entry['entrypoint']);
    if (prompt !== null) {
      if (this.#firstPrompt === null) {
        this.#firstPrompt = cap(prompt, PROMPT_CAP);
        this.#promptEntrypoint = entrypoint;
      }
      this.#lastHumanPrompt = cap(prompt, PROMPT_CAP);
      this.#humanTurns += 1;
      if (this.#prompts.length < PROMPTS_CAP) this.#prompts = cap(this.#prompts ? `${this.#prompts}\n${prompt}` : prompt, PROMPTS_CAP);
      return;
    }
    const command = slashCommandText(entry);
    if (command !== null && this.#firstCommand === null) {
      this.#firstCommand = cap(command, PROMPT_CAP);
      this.#commandEntrypoint = entrypoint;
      this.#startedWithCommand = this.#firstPrompt === null;
    }
  }

  #onAssistant(entry: Entry, uuid: string | null, sidechain: boolean): void {
    if (sidechain || !uuid || !isEntry(entry['message'])) return;
    const message = entry['message'];
    if (message['model'] === '<synthetic>') return;
    const text = contentText(message['content']).trim();
    if (!text) return;
    const messageId = str(message['id']) ?? uuid;
    const before = this.#messageText.get(messageId);
    this.#messageText.set(messageId, cap(before ? `${before}\n${text}` : text, TEXT_CAP));
    this.#textLine.set(uuid, messageId);
  }

  /** The newest assistant text on the newest leaf's chain (see the module comment). */
  #lastText(): string | null {
    const visited = new Set<number>();
    let i = this.#chain.length - 1;
    while (i >= 0 && !visited.has(i)) {
      visited.add(i);
      const entry = this.#chain[i] as ChainEntry;
      const messageId = this.#textLine.get(entry.uuid);
      if (messageId !== undefined) return this.#messageText.get(messageId) ?? null;
      const parent = entry.parent ?? entry.logicalParent;
      if (parent === null) return null;
      const next = this.#index.get(parent);
      i = next !== undefined && next < i ? next : i - 1;
    }
    return null;
  }

  /** The facts of everything pushed so far. */
  finish(): TranscriptFacts {
    return {
      v: TRANSCRIPT_FACTS_VERSION,
      sessionId: this.#sessionId,
      startCwd: this.#startCwd,
      cwds: [...this.#cwds],
      gitBranch: this.#gitBranch,
      startedAt: this.#startedAt,
      lastActivityAt: this.#lastActivityAt,
      entrypoint: this.#promptEntrypoint ?? this.#commandEntrypoint,
      entrypoints: [...this.#entrypoints],
      firstPrompt: this.#firstPrompt,
      firstCommand: this.#firstCommand,
      startedWithCommand: this.#startedWithCommand,
      lastPrompt: this.#lastPromptEntry ?? this.#lastHumanPrompt,
      humanTurns: this.#humanTurns,
      customTitle: this.#customTitle,
      aiTitle: this.#aiTitle,
      lastText: this.#lastText(),
      prNumber: this.#prNumber,
      prompts: this.#prompts,
      badLines: this.#badLines,
      remoteControl: this.#remoteControl,
    };
  }
}

/** Parses a whole transcript text (tests, small files); the server streams instead. */
export function parseTranscript(sessionId: string, text: string): TranscriptFacts {
  const parser = new TranscriptParser(sessionId);
  for (const line of text.split('\n')) parser.pushLine(line);
  return parser.finish();
}

/** `true` when `value` looks like facts of the current version (a cache entry may be older). */
export function isCurrentFacts(value: unknown): value is TranscriptFacts {
  return isEntry(value) && value['v'] === TRANSCRIPT_FACTS_VERSION && typeof value['sessionId'] === 'string';
}

/**
 * Project-folder name of a cwd, as CLI 2.1.283 computes it (`docs/spike-m0.md` →
 * *Transcript location*): every char except ASCII letters/digits becomes `-`; past
 * 200 chars the first 200 are kept plus `-` and a base-36 hash of the raw cwd.
 */
export function slugForCwd(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * The prefix every project folder of a session started at `root` or below it
 * shares: the sanitized root, cut at 200 chars (longer slugs keep their first 200).
 */
export function projectFolderPrefix(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
}
