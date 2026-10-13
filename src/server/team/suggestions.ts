import type { SuggestionEvidence, TeamSuggestion } from '../../core/team.ts';
import type { Store } from '../db/store.ts';
import type { LoopService } from '../loops/owned.ts';

/** Tool calls that change files (the "edit" side of the ratio). */
export const EDIT_TOOLS: readonly string[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch'];

/** Tool calls that only read (the "read" side). */
export const READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead'];

/** Tool calls that plan or hand out work (todo lists, plan mode, Switchboard todos and hand-offs). */
export const PLANNING_TOOLS: readonly string[] = [
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'mcp__switchboard__todo_add',
  'mcp__switchboard__todo_update',
  'mcp__switchboard__team_handoff',
];

/** Below this many events in 7 days a session carries too little signal to suggest anything. */
export const MIN_EVENTS = 50;

/** Below this many file tool calls (edits + reads) the edit ratio means nothing. */
export const MIN_FILE_CALLS = 10;

export type { SuggestionEvidence, TeamSuggestion } from '../../core/team.ts';

/**
 * The template the evidence matches, and why; `null` = too little signal or no clear
 * pattern (not suggested). Patterns: recurring loops and mostly reading → On-call /
 * Production monitoring (with file reads) or Delivery tracking (without); many
 * planning calls and little editing → Planner; mostly editing → Developer; reading a
 * lot without loops → Reviewer / QA.
 */
export function classifySuggestion(evidence: SuggestionEvidence): { readonly templateId: string; readonly reason: string } | null {
  if (evidence.events7d < MIN_EVENTS) return null;
  const loops = evidence.loops + evidence.cliLoops;
  const files = evidence.edits + evidence.reads;
  const ratio = evidence.editRatio;
  const planning = evidence.planning ?? 0;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (loops > 0 && (ratio === null || ratio < 0.2)) {
    if (files >= MIN_FILE_CALLS) return { templateId: 'on-call', reason: `${plural(loops, 'recurring loop')} and mostly reading: looks like monitoring.` };
    return { templateId: 'delivery-tracking', reason: `${plural(loops, 'recurring loop')} and few file tool calls: looks like tracking.` };
  }
  if (planning >= 5 && (ratio === null || ratio < 0.3)) return { templateId: 'planner', reason: `${plural(planning, 'planning call')} (todo lists, plans, hand-offs) and little editing: looks like planning.` };
  if (files >= MIN_FILE_CALLS && ratio !== null && ratio >= 0.5) return { templateId: 'developer', reason: `${Math.round(ratio * 100)}% of its ${files} file tool calls edit: looks like implementation.` };
  if (files >= MIN_FILE_CALLS * 2 && ratio !== null && ratio < 0.2 && loops === 0) return { templateId: 'reviewer', reason: `${Math.round((1 - ratio) * 100)}% of its ${files} file tool calls only read, without loops: looks like review or QA.` };
  return null;
}

/** One suggestion per template among sessions with identical evidence (the highest score; the first on a tie). */
export function dedupeSuggestions(list: readonly TeamSuggestion[]): TeamSuggestion[] {
  const seen = new Set<string>();
  const out: TeamSuggestion[] = [];
  for (const suggestion of [...list].sort((a, b) => b.score - a.score)) {
    const e = suggestion.evidence;
    const key = [suggestion.templateId, e.repos, e.loops, e.cliLoops, e.events7d, e.edits, e.reads, e.planning ?? 0].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
  }
  return out;
}

/**
 * D100 · candidate members from the existing sessions (`docs/team.md` → *Suggestions*):
 * this machine's open sessions that are not members, with cheap evidence from the
 * database (no transcript reads): repos, loops, events in the last 7 days, the edit
 * vs read ratio of their tool calls and their planning calls. A session is suggested
 * only when it has enough signal ({@link MIN_EVENTS}) and its evidence matches a
 * template's pattern ({@link classifySuggestion}); identical evidence is suggested
 * once per template ({@link dedupeSuggestions}). The others are left out (the Team
 * page lists them as "too little activity to tell").
 */
export async function computeSuggestions(input: { readonly store: Store; readonly loops: LoopService; readonly exclude: ReadonlySet<string>; readonly now: number }): Promise<TeamSuggestion[]> {
  const { store } = input;
  const since = new Date(input.now - 7 * 24 * 3600_000).toISOString();
  const sessions = (await store.sessions.list({ closed: false })).filter((s) => !input.exclude.has(s.id) && !s.hooked);
  if (sessions.length === 0) return [];
  const events = new Map<string, number>();
  for (const row of store.db.prepare('SELECT session_id AS id, COUNT(*) AS n FROM events WHERE ts > ? GROUP BY session_id').all(since)) events.set(String(row['id']), Number(row['n']));
  const tools = new Map<string, { edits: number; reads: number; planning: number }>();
  const rows = store.db
    .prepare("SELECT session_id AS id, json_extract(payload, '$.name') AS name, COUNT(*) AS n FROM events WHERE ts > ? AND json_extract(payload, '$.type') = 'tool' GROUP BY session_id, name")
    .all(since);
  for (const row of rows) {
    const id = String(row['id']);
    const name = String(row['name']);
    const entry = tools.get(id) ?? { edits: 0, reads: 0, planning: 0 };
    if (EDIT_TOOLS.includes(name)) entry.edits += Number(row['n']);
    else if (READ_TOOLS.includes(name)) entry.reads += Number(row['n']);
    else if (PLANNING_TOOLS.includes(name)) entry.planning += Number(row['n']);
    tools.set(id, entry);
  }
  const out: TeamSuggestion[] = [];
  for (const session of sessions) {
    const owned = (await input.loops.list(session.id).catch(() => [])).filter((loop) => loop.state !== 'ended').length;
    const cli = (await store.loops.list(session.id)).filter((row) => row.kind !== 'Workflow').length;
    const counts = tools.get(session.id) ?? { edits: 0, reads: 0, planning: 0 };
    const total = counts.edits + counts.reads;
    const evidence: SuggestionEvidence = {
      repos: session.solutions.length > 0 ? session.solutions.length : session.cwd ? 1 : 0,
      loops: owned,
      cliLoops: cli,
      events7d: events.get(session.id) ?? 0,
      edits: counts.edits,
      reads: counts.reads,
      editRatio: total === 0 ? null : Math.round((counts.edits / total) * 100) / 100,
      planning: counts.planning,
    };
    const match = classifySuggestion(evidence);
    if (!match) continue;
    out.push({
      sessionId: session.id,
      title: session.title ?? session.name,
      folder: session.cwd,
      evidence,
      templateId: match.templateId,
      reason: match.reason,
      score: evidence.events7d + (owned + cli) * 50 + evidence.repos * 5,
      charterDraft: null,
    });
  }
  return dedupeSuggestions(out).slice(0, 30);
}
