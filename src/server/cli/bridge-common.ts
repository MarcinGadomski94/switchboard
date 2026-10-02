import type { CliProviderId } from '../../core/cli-providers.ts';

/** A parsed JSON object. */
export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * D62 P7: a CLI's own usage limits, as a bridge read them (Codex's account rate
 * limits: primary / secondary windows). Shown in the usage footer for that CLI
 * and used by a switch to tell whether the outgoing CLI has capacity left.
 */
export interface ProviderUsage {
  readonly provider: CliProviderId;
  readonly windows: ReadonlyArray<{ readonly pct: number; readonly minutes: number | null; readonly resetsAt: string | null }>;
  readonly at: string;
}

/** What every bridge takes (built from the `SpawnRequest` by its adapter). */
export interface BridgeCommon {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** The CLI's own conversation to reopen; `null` = a new one. */
  readonly nativeId: string | null;
  /** The session's stored model / effort (`null` = the CLI's default). */
  readonly model: string | null;
  readonly effort: string | null;
  /** D6: echoed in `system/init` (the recorder compares it with what it asked for). */
  readonly permissionMode: string;
  /** The session's display title (OpenCode names its session after it). */
  readonly title: string;
  /** D64: the standing instruction (`null` = none). */
  readonly standingInstruction?: string | null;
  readonly onLine: (line: string) => void;
  readonly onNativeId?: (nativeId: string) => void;
  /** Something the developer should know that is no chat line (a conversation that could not be reopened). */
  readonly onNotice?: (text: string) => void;
  readonly onUsage?: (usage: ProviderUsage) => void;
  /** Switchboard's version, told to the CLI as the client's. */
  readonly clientVersion?: string;
}

/** A `control_response` success line. */
export function controlSuccess(requestId: string, response: unknown): JsonRecord {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

/** A `control_response` error line. */
export function controlError(requestId: string, error: string): JsonRecord {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}

/**
 * A stream-json user message's content (D57): its text (the text blocks joined),
 * its images as `data:` URLs, its PDFs as `data:` URLs, and how many blocks a
 * CLI that takes images only must drop (`dropped` = the PDFs).
 */
export function contentBlocks(content: unknown): { readonly text: string; readonly images: string[]; readonly pdfs: Array<{ readonly url: string; readonly name: string | null }>; readonly dropped: number } {
  if (typeof content === 'string') return { text: content, images: [], pdfs: [], dropped: 0 };
  const texts: string[] = [];
  const images: string[] = [];
  const pdfs: Array<{ url: string; name: string | null }> = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      const source = isRecord(block['source']) ? block['source'] : null;
      const data = source ? str(source['data']) : null;
      const media = source ? str(source['media_type']) : null;
      if (block['type'] === 'text') texts.push(str(block['text']) ?? '');
      else if (block['type'] === 'image' && data && media) images.push(`data:${media};base64,${data}`);
      else if (block['type'] === 'document' && data) pdfs.push({ url: `data:application/pdf;base64,${data}`, name: str(block['title']) });
    }
  }
  return { text: texts.join('\n'), images, pdfs, dropped: pdfs.length };
}

/**
 * M3.1's answers (`updatedInput.answers`: question text → label, several labels
 * joined with ", ") as each CLI's question ids → labels.
 */
export function mapAnswers(questions: ReadonlyArray<{ readonly id: string; readonly text: string }>, byText: JsonRecord): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const question of questions) {
    const answer = str(byText[question.text]);
    if (answer === null) continue;
    out[question.id] = answer
      .split(', ')
      .map((part) => part.trim())
      .filter((part) => part !== '');
  }
  return out;
}

/**
 * A file tool's input in Claude Code's names, so the recorder's rules (D38's
 * solution written, artifacts, the activity line) read it unchanged.
 */
export function toolInputFor(name: string, input: { readonly file_path: string; readonly diff?: string }): JsonRecord {
  return name === 'Delete' ? { file_path: input.file_path } : { file_path: input.file_path, ...(input.diff ? { diff: input.diff } : {}) };
}
