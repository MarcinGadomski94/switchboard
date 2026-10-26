/**
 * D136 · Project memory checks (`docs/memory.md` → *Checking notes (D136)*): Switchboard checks
 * whether stored notes are still true, (A) when an agent proposes a new note (a short model call
 * that catches duplicates and contradictions with the folder's approved notes) and (B) by itself,
 * weekly per folder (a short-lived, read-only, headless run of the folder's CLI that verifies each
 * approved note against the code and recent git history). Neither is a session: no `sessions` row,
 * nothing to interact with.
 *
 * Shapes, limits, the prompts, the output validation, the removal cap and the schedule's pure
 * parts, shared by the server (`src/server/memory/check.ts`) and the pages.
 */
import { MEMORY_REASON_MAX, MEMORY_TEXT_MAX, MEMORY_TITLE_MAX, type MemoryEntry, folderName } from './memory.ts';

/** What check (A) found about a proposal: it says the same as an approved note, or contradicts one. */
export type MemoryConflictVerdict = 'duplicate' | 'conflict';

/**
 * `GET /api/memory/entries` only, on a proposed `add` entry that check (A) flagged: the approved note
 * it duplicates or contradicts (as it is now) and why. Absent / `null`: nothing found, the check
 * failed or was skipped, or the approved note is gone.
 */
export interface MemoryProposalCheck {
  readonly verdict: MemoryConflictVerdict;
  readonly targetId: string;
  /** The approved note's title now. */
  readonly targetTitle: string;
  readonly reason: string;
  readonly checkedAt: string;
}

/** Who moved a note to the removed list: the periodic check (B), or the developer's "Approve and remove the old note". */
export type MemoryRemovedBy = 'check' | 'approval';

/** A note moved out of the approved set, recoverable for {@link MEMORY_REMOVED_KEEP_DAYS} days (`GET /api/memory/removed`). */
export interface MemoryRemovedEntry {
  /** The note's id (Restore puts it back under the same id). */
  readonly id: string;
  /** Its folder. */
  readonly scope: string;
  /** The note as it was when it was removed. */
  readonly entry: MemoryEntry;
  readonly reason: string;
  readonly removedBy: MemoryRemovedBy;
  readonly removedAt: string;
  /** When it is deleted for good. */
  readonly purgeAt: string;
}

/** How a check run ended. */
export type MemoryCheckOutcome = 'done' | 'skipped' | 'failed';

/** One run's result, kept per folder (the page's "Last checked …" line). */
export interface MemoryCheckResult {
  readonly at: string;
  readonly outcome: MemoryCheckOutcome;
  /** `periodic` (the weekly run) or `manual` (Check now). */
  readonly trigger: 'periodic' | 'manual';
  /** Notes sent to the check. */
  readonly checked: number;
  /** Notes moved to the removed list. */
  readonly removed: number;
  /** Edit proposals filed. */
  readonly edits: number;
  /** Removals over the cap, filed as retract proposals instead. */
  readonly retracts: number;
  /** Why it was skipped or failed (`null` when done). */
  readonly reason: string | null;
}

/** A folder's check state (`GET /api/memory/check?scope=`). */
export interface MemoryCheckStatus {
  readonly folder: string;
  /** "Check notes automatically" for this folder (on unless switched off here). */
  readonly enabled: boolean;
  /** The global switch and frequency. */
  readonly settings: MemoryCheckSettings;
  readonly lastRunAt: string | null;
  readonly lastResult: MemoryCheckResult | null;
  /** When the next periodic run may start (it also waits for agent activity), `null` while off. */
  readonly nextDueAt: string | null;
  /** A run is in progress now. */
  readonly running: boolean;
  /** Approved notes the check would look at. */
  readonly notes: number;
}

/** `GET|PUT /api/memory/check/settings`. */
export interface MemoryCheckSettings {
  /** "Check notes automatically" (both the proposal check and the periodic one); on by default. */
  readonly enabled: boolean;
  /** The periodic check's frequency in days (weekly by default). */
  readonly frequencyDays: number;
}

/** The periodic check's frequencies the settings offer (days). */
export const MEMORY_CHECK_FREQUENCIES: readonly number[] = [1, 3, 7, 14, 30];
export const MEMORY_CHECK_DEFAULT_DAYS = 7;
export const MEMORY_CHECK_DEFAULT_SETTINGS: MemoryCheckSettings = { enabled: true, frequencyDays: MEMORY_CHECK_DEFAULT_DAYS };
/** Removed notes are kept this long, then purged. */
export const MEMORY_REMOVED_KEEP_DAYS = 30;
/** At most this many removals are applied by one run (the circuit breaker; also at most half the folder's notes). */
export const MEMORY_CHECK_MAX_REMOVALS = 5;
/** Folders' first runs and next runs are spread over this window (a stable offset per folder). */
export const MEMORY_CHECK_JITTER_MS = 6 * 60 * 60 * 1000;
/** A failed run is tried again after at most this long. */
export const MEMORY_CHECK_RETRY_MS = 24 * 60 * 60 * 1000;
/** At most this many notes go into one periodic run (the oldest checked first). */
export const MEMORY_CHECK_MAX_NOTES = 60;
/** The author label of proposals a check files. */
export const MEMORY_CHECK_AUTHOR = 'Memory check';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A frequency from a body value (`null` when it is not one of {@link MEMORY_CHECK_FREQUENCIES}). */
export function readCheckFrequency(value: unknown): number | null {
  return typeof value === 'number' && MEMORY_CHECK_FREQUENCIES.includes(value) ? value : null;
}

/** The frequency's words: "daily", "every 3 days", "weekly", "every 2 weeks", "monthly". */
export function checkFrequencyText(days: number): string {
  if (days === 1) return 'daily';
  if (days === 7) return 'weekly';
  if (days === 14) return 'every 2 weeks';
  if (days === 30) return 'monthly';
  return `every ${days} days`;
}

/**
 * The removal cap of one run over `notes` approved notes: at most {@link MEMORY_CHECK_MAX_REMOVALS}
 * and at most half of them (rounded down, so a folder with one note never loses it by itself).
 */
export function memoryRemovalCap(notes: number): number {
  return Math.max(0, Math.min(MEMORY_CHECK_MAX_REMOVALS, Math.floor(notes / 2)));
}

/** A stable offset in `[0, MEMORY_CHECK_JITTER_MS)` for a folder (FNV-1a of its path), so folders do not all run at once. */
export function memoryCheckJitterMs(folder: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < folder.length; i++) {
    hash ^= folder.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % MEMORY_CHECK_JITTER_MS;
}

/** What the schedule needs of a folder. */
export interface MemoryCheckClock {
  /** When the scheduler first saw the folder with approved notes. */
  readonly firstSeenAt: string;
  readonly lastRunAt: string | null;
  readonly lastOutcome: MemoryCheckOutcome | null;
  readonly frequencyDays: number;
  readonly folder: string;
}

/**
 * When the folder's next periodic run may start: the first one at first sight + its jitter; then
 * the last run + the frequency + the jitter; after a failed run at most a day later.
 */
export function memoryCheckDueAt(clock: MemoryCheckClock): number {
  const jitter = memoryCheckJitterMs(clock.folder);
  if (clock.lastRunAt === null) return Date.parse(clock.firstSeenAt) + jitter;
  const last = Date.parse(clock.lastRunAt);
  const period = clock.frequencyDays * DAY_MS;
  return last + (clock.lastOutcome === 'failed' ? Math.min(period, MEMORY_CHECK_RETRY_MS) : period) + jitter;
}

/**
 * The activity gate: a folder is checked again only when an agent worked there since its last run
 * (never run: within the last period).
 */
export function memoryCheckActive(lastActivityAt: string | null, lastRunAt: string | null, now: number, frequencyDays: number): boolean {
  if (lastActivityAt === null) return false;
  const since = lastRunAt !== null ? Date.parse(lastRunAt) : now - frequencyDays * DAY_MS;
  return Date.parse(lastActivityAt) > since;
}

/** "checked 12 notes, removed 1, proposed 2 edits" (and why a run was skipped or failed). */
export function memoryCheckSummary(result: MemoryCheckResult): string {
  if (result.outcome === 'skipped') return `skipped: ${result.reason ?? 'unknown reason'}`;
  if (result.outcome === 'failed') return `failed: ${result.reason ?? 'unknown reason'}`;
  const parts = [`checked ${result.checked} ${result.checked === 1 ? 'note' : 'notes'}`];
  parts.push(`removed ${result.removed}`);
  parts.push(`proposed ${result.edits} ${result.edits === 1 ? 'edit' : 'edits'}`);
  if (result.retracts > 0) parts.push(`proposed ${result.retracts} ${result.retracts === 1 ? 'removal' : 'removals'} for review`);
  return parts.join(', ');
}

// ── prompts ─────────────────────────────────────────────────────────────

function noteLines(notes: readonly Pick<MemoryEntry, 'id' | 'title' | 'text'>[]): string {
  return notes.map((note) => [`--- note ${note.id} ---`, `Title: ${note.title}`, `Text: ${note.text}`].join('\n')).join('\n\n');
}

/** Check (A)'s prompt: does `proposal` duplicate or contradict one of `approved`? Comparison only, no tools. */
export function memoryConflictPrompt(proposal: Pick<MemoryEntry, 'title' | 'text'>, approved: readonly Pick<MemoryEntry, 'id' | 'title' | 'text'>[]): string {
  return [
    'You check project-memory notes for Switchboard. A coding agent proposed a new note; the developer reviews it next to the approved notes below.',
    'Decide whether the proposed note DUPLICATES an approved note (it says the same thing, maybe in other words) or CONFLICTS with one (they contradict each other: both cannot be true now). A note that only adds detail to another is neither. Only compare the texts: do not use any tools.',
    'Answer with ONLY one JSON object and nothing else:',
    '{"verdict":"none"}',
    'or {"verdict":"duplicate","id":"<the approved note id>","reason":"<one short sentence>"}',
    'or {"verdict":"conflict","id":"<the approved note id>","reason":"<one short sentence>"}',
    '',
    'Proposed note:',
    `Title: ${proposal.title}`,
    `Text: ${proposal.text}`,
    '',
    'Approved notes:',
    noteLines(approved),
  ].join('\n');
}

/** Check (B)'s prompt: verify each of `notes` against the code and recent git history of the folder (read-only). */
export function memoryCheckPrompt(folder: string, label: string, notes: readonly Pick<MemoryEntry, 'id' | 'title' | 'text'>[], today: string): string {
  return [
    `You check project-memory notes for Switchboard. Each note below was approved earlier as a durable fact about the project in this folder (${label || folderName(folder)}). Today is ${today}.`,
    'Verify every note against the code in the current folder and its recent git history: do the files, settings, commands, scripts and branches it names exist, and does the code still behave as it says?',
    'You may only read: read files, search, list folders, and run read-only git commands (git log, git show, git ls-files, git branch, git status, git diff). Do not edit anything, do not run builds, tests or package managers, do not use the network.',
    'For each note decide:',
    '- "keep": still true, or you cannot tell (keep when unsure);',
    '- "edit": mostly true but something changed: give the corrected title and/or text (the complete new wording, not a diff) and the reason;',
    '- "remove": no longer true or no longer relevant: give the reason (what you found).',
    `Limits: title at most ${MEMORY_TITLE_MAX} characters, text at most ${MEMORY_TEXT_MAX}, reason at most ${MEMORY_REASON_MAX}. Every edit and removal needs a reason.`,
    'Answer with ONLY one JSON object and nothing else, one item per note:',
    '{"notes":[{"id":"<id>","action":"keep"},{"id":"<id>","action":"edit","title":"<new title>","text":"<new text>","reason":"<why>"},{"id":"<id>","action":"remove","reason":"<why>"}]}',
    '',
    'Notes:',
    noteLines(notes),
  ].join('\n');
}

// ── output validation ──────────────────────────────────────────────────

/** The first JSON object in a model's answer (code fences and words around it dropped), else `null`. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Check (A)'s answer, validated: `none`, or a verdict about an id among `allowedIds` with a reason. */
export type MemoryConflictAnswer = { readonly verdict: 'none' } | { readonly verdict: MemoryConflictVerdict; readonly id: string; readonly reason: string } | { readonly verdict: 'invalid'; readonly problem: string };

export function readConflictAnswer(text: string, allowedIds: ReadonlySet<string>): MemoryConflictAnswer {
  const parsed = extractJsonObject(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { verdict: 'invalid', problem: 'the answer was not a JSON object' };
  const raw = parsed as Record<string, unknown>;
  if (raw['verdict'] === 'none') return { verdict: 'none' };
  if (raw['verdict'] !== 'duplicate' && raw['verdict'] !== 'conflict') return { verdict: 'invalid', problem: 'verdict must be none, duplicate or conflict' };
  const id = clean(raw['id']);
  if (id === null || !allowedIds.has(id)) return { verdict: 'invalid', problem: `id ${String(raw['id'])} is not one of the approved notes` };
  const reason = clean(raw['reason']);
  if (reason === null) return { verdict: 'invalid', problem: 'a reason is required' };
  return { verdict: raw['verdict'], id, reason: reason.slice(0, MEMORY_REASON_MAX) };
}

/** One validated decision of check (B). */
export type MemoryCheckDecision =
  | { readonly id: string; readonly action: 'keep' }
  | { readonly id: string; readonly action: 'edit'; readonly title: string | null; readonly text: string | null; readonly reason: string }
  | { readonly id: string; readonly action: 'remove'; readonly reason: string };

/** Check (B)'s answer, validated: the decisions to apply and what was dropped (and why). */
export interface MemoryCheckAnswer {
  readonly ok: boolean;
  readonly decisions: readonly MemoryCheckDecision[];
  readonly problems: readonly string[];
}

/**
 * Validates check (B)'s answer (`{ notes: [...] }`): ids must be among `allowedIds` (the folder's
 * notes sent to the run; one decision per id, the first wins), edits and removals need a reason
 * (at most {@link MEMORY_REASON_MAX}), an edit needs a title and / or text within the D135 limits.
 * Anything else is dropped with its problem; `ok` is false when the answer was no JSON at all.
 */
export function readCheckAnswer(text: string, allowedIds: ReadonlySet<string>): MemoryCheckAnswer {
  const parsed = extractJsonObject(text);
  const list = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)['notes'] : null;
  if (!Array.isArray(list)) return { ok: false, decisions: [], problems: ['the answer was not a JSON object with a notes list'] };
  const decisions: MemoryCheckDecision[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problems.push('an item was not an object');
      continue;
    }
    const raw = item as Record<string, unknown>;
    const id = clean(raw['id']);
    if (id === null || !allowedIds.has(id)) {
      problems.push(`unknown note id ${String(raw['id'])}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`note ${id} was decided twice (the first decision counts)`);
      continue;
    }
    const action = raw['action'];
    if (action === 'keep') {
      seen.add(id);
      decisions.push({ id, action: 'keep' });
      continue;
    }
    if (action !== 'edit' && action !== 'remove') {
      problems.push(`note ${id}: action must be keep, edit or remove`);
      continue;
    }
    const reason = clean(raw['reason']);
    if (reason === null) {
      problems.push(`note ${id}: ${action} without a reason`);
      continue;
    }
    if (reason.length > MEMORY_REASON_MAX) {
      problems.push(`note ${id}: the reason is over ${MEMORY_REASON_MAX} characters`);
      continue;
    }
    if (action === 'remove') {
      seen.add(id);
      decisions.push({ id, action: 'remove', reason });
      continue;
    }
    const title = clean(raw['title']);
    const body = typeof raw['text'] === 'string' && raw['text'].trim() !== '' ? raw['text'].trim() : null;
    if (title === null && body === null) {
      problems.push(`note ${id}: an edit needs a title or a text`);
      continue;
    }
    if (title !== null && title.length > MEMORY_TITLE_MAX) {
      problems.push(`note ${id}: the title is over ${MEMORY_TITLE_MAX} characters`);
      continue;
    }
    if (body !== null && body.length > MEMORY_TEXT_MAX) {
      problems.push(`note ${id}: the text is over ${MEMORY_TEXT_MAX} characters`);
      continue;
    }
    seen.add(id);
    decisions.push({ id, action: 'edit', title, text: body, reason });
  }
  return { ok: true, decisions, problems };
}

/** A `PUT /api/memory/check/settings` body, validated (`null` fields: unchanged). */
export function readCheckSettings(body: unknown): { readonly enabled: boolean | null; readonly frequencyDays: number | null } | { readonly error: string; readonly field: string } {
  const raw = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  let enabled: boolean | null = null;
  let frequencyDays: number | null = null;
  if (raw['enabled'] !== undefined) {
    if (typeof raw['enabled'] !== 'boolean') return { error: 'enabled must be true or false', field: 'enabled' };
    enabled = raw['enabled'];
  }
  if (raw['frequencyDays'] !== undefined) {
    frequencyDays = readCheckFrequency(raw['frequencyDays']);
    if (frequencyDays === null) return { error: `frequencyDays must be one of ${MEMORY_CHECK_FREQUENCIES.join(', ')}`, field: 'frequencyDays' };
  }
  return { enabled, frequencyDays };
}

// ── the pages' words ───────────────────────────────────────────────────

/** "Conflicts with: <title>" / "Duplicates: <title>" (the review card's line). */
export function checkFindingText(check: Pick<MemoryProposalCheck, 'verdict' | 'targetTitle'>): string {
  return `${check.verdict === 'duplicate' ? 'Duplicates' : 'Conflicts with'}: ${check.targetTitle}`;
}

/** The button that approves a flagged proposal and moves the old note to the removed list. */
export const APPROVE_REPLACE_LABEL = 'Approve and remove the old note';

/** "today", "yesterday", "3 days ago" (the check line; whole local days). */
export function checkDayText(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const day = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(at)) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * The folder's quiet check line on the Memory / Notes page: "Checked 2 days ago: checked 12 notes,
 * removed 1, proposed 2 edits", "Checking now…", "Not checked yet", "Automatic checks are off …".
 */
export function memoryCheckLine(status: Pick<MemoryCheckStatus, 'enabled' | 'settings' | 'lastResult' | 'lastRunAt' | 'running'>, now: number): string {
  if (status.running) return 'Checking the notes now…';
  const last = status.lastResult;
  const off = !status.settings.enabled ? 'Automatic checks are off (Settings).' : !status.enabled ? 'Automatic checks are off for this folder.' : null;
  if (!last) {
    const interrupted = status.lastRunAt !== null ? `A check started ${checkDayText(status.lastRunAt, now)} did not finish.` : 'Not checked yet.';
    return off ? `${interrupted} ${off}` : `${interrupted} Notes are checked ${checkFrequencyText(status.settings.frequencyDays)} while agents work here.`;
  }
  const line = `Checked ${checkDayText(last.at, now)}: ${memoryCheckSummary(last)}.`;
  return off ? `${line} ${off}` : line;
}

/** The removed list's line under a note: "Removed today by the memory check: <reason> · deleted for good on Nov 25". */
export function removedLine(removed: Pick<MemoryRemovedEntry, 'removedAt' | 'removedBy' | 'reason' | 'purgeAt'>, now: number): string {
  const who = removed.removedBy === 'check' ? 'by the memory check' : 'when you approved its replacement';
  const purge = new Date(removed.purgeAt);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `Removed ${checkDayText(removed.removedAt, now)} ${who}: ${removed.reason} · deleted for good on ${months[purge.getMonth()]} ${purge.getDate()}`;
}
