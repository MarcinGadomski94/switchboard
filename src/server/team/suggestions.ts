import type { SuggestionConfidence, SuggestionEvidence, TeamSuggestion } from '../../core/team.ts';
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

export type { SuggestionConfidence, SuggestionEvidence, TeamSuggestion } from '../../core/team.ts';

/** Below this many edits per active day a session with loops counts as watching, not building (orchestrators read a lot but still edit). */
export const MAX_WATCH_EDITS_PER_DAY = 3;

/** Mid edit ratio (0.2–0.5) counts as implementation only with this many file tool calls… */
export const MID_MIN_FILE_CALLS = 30;

/** …and this many real edits; also the edit count that backs a "developer" title. */
export const MID_MIN_EDITS = 20;

/** What a template looks like, in a reason ("looks like <noun>"). */
const NOUN: Readonly<Record<string, string>> = {
  'on-call': 'monitoring',
  'delivery-tracking': 'tracking',
  planner: 'planning',
  developer: 'implementation',
  reviewer: 'review or QA',
  'release-manager': 'release work',
};

/** Title words that are about production rather than delivery (tracking words + these = On-call). */
const PROD_WORDS = /\b(?:prod|production|errors?|logs?|incidents?|alerts?|alerting|outages?|on-?call)\b/giu;
/** Title words that mean On-call on their own. */
const ON_CALL_WORDS = /\b(?:incidents?|alerts?|alerting|outages?|on-?call)\b/giu;

/** Title keywords per template, most specific first (the first template with a match wins). */
const TITLE_RULES: ReadonlyArray<{ readonly templateId: string; readonly words: RegExp }> = [
  { templateId: 'delivery-tracking', words: /\b(?:monitor\w*|track\w*|kpis?|metrics?|dashboards?|reports?|reporting)\b/giu },
  { templateId: 'release-manager', words: /\b(?:releases?|releasing)\b/giu },
  { templateId: 'reviewer', words: /\b(?:reviews?|reviewing|qa|tests?|testing)\b/giu },
  { templateId: 'planner', words: /\b(?:plan|plans|planning|planned|roadmaps?|breakdowns?)\b/giu },
  { templateId: 'developer', words: /\b(?:implement\w*|features?|epics?|tickets?|jira|bugs?|bugfix\w*|fix|fixes|fixing|maintenance|maintain\w*)\b/giu },
];

const matches = (title: string, words: RegExp): string[] => [...title.matchAll(words)].map((m) => m[0]);

/**
 * The template a session's title names, and the words that name it; `null` = no keyword.
 * Monitoring / tracking / KPI / metrics / dashboard / report → Delivery tracking, or
 * On-call when the title is also about production / errors / logs / incidents / alerts
 * (incidents, alerts, outages and on-call alone are enough); release → Release manager;
 * review / QA / test → Reviewer; plan / roadmap / breakdown → Planner; implement /
 * feature / epic / ticket / Jira / bug / fix / maintenance → Developer.
 */
export function titleTemplate(title: string | null | undefined): { readonly templateId: string; readonly words: readonly string[] } | null {
  if (!title) return null;
  const onCall = matches(title, ON_CALL_WORDS);
  for (const rule of TITLE_RULES) {
    const words = matches(title, rule.words);
    if (rule.templateId === 'delivery-tracking') {
      const prod = matches(title, PROD_WORDS);
      if (words.length > 0 && prod.length > 0) return { templateId: 'on-call', words: [...words, ...prod] };
      if (onCall.length > 0) return { templateId: 'on-call', words: onCall };
    }
    if (words.length > 0) return { templateId: rule.templateId, words };
  }
  return null;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The template the behaviour alone matches, with the evidence phrase; `null` = no clear
 * pattern. Loops + mostly reading + under {@link MAX_WATCH_EDITS_PER_DAY} edits per
 * active day → On-call (with file reads) or Delivery tracking (without); ≥ 5 planning
 * calls and little editing → Planner; ≥ 50 % edits → Developer; 20–50 % edits with
 * ≥ {@link MID_MIN_FILE_CALLS} file calls and ≥ {@link MID_MIN_EDITS} edits → Developer;
 * < 20 % edits of ≥ 20 file calls without loops → Reviewer / QA.
 */
export function behaviourTemplate(evidence: SuggestionEvidence): { readonly templateId: string; readonly because: string } | null {
  const loops = evidence.loops + evidence.cliLoops;
  const files = evidence.edits + evidence.reads;
  const ratio = evidence.editRatio;
  const planning = evidence.planning ?? 0;
  const perDay = evidence.edits / Math.max(1, evidence.activeDays ?? 1);
  if (loops > 0 && (ratio === null || ratio < 0.2) && perDay < MAX_WATCH_EDITS_PER_DAY) {
    if (files >= MIN_FILE_CALLS) return { templateId: 'on-call', because: `${plural(loops, 'recurring loop')} and mostly reading` };
    return { templateId: 'delivery-tracking', because: `${plural(loops, 'recurring loop')} and few file tool calls` };
  }
  if (planning >= 5 && (ratio === null || ratio < 0.3)) return { templateId: 'planner', because: `${plural(planning, 'planning call')} (todo lists, plans, hand-offs) and little editing` };
  if (files >= MIN_FILE_CALLS && ratio !== null && ratio >= 0.5) return { templateId: 'developer', because: `${Math.round(ratio * 100)}% of its ${files} file tool calls edit` };
  if (files >= MID_MIN_FILE_CALLS && evidence.edits >= MID_MIN_EDITS && ratio !== null && ratio >= 0.2) return { templateId: 'developer', because: `${plural(evidence.edits, 'edit')} in ${files} file tool calls` };
  if (files >= MIN_FILE_CALLS * 2 && ratio !== null && ratio < 0.2 && loops === 0) return { templateId: 'reviewer', because: `${Math.round((1 - ratio) * 100)}% of its ${files} file tool calls only read, without loops` };
  return null;
}

/** Behaviour that backs a template a title names, without matching it on its own (an orchestrator reads a lot, a tracker edits its reports). */
function backing(templateId: string, evidence: SuggestionEvidence): string | null {
  const loops = evidence.loops + evidence.cliLoops;
  const files = evidence.edits + evidence.reads;
  const planning = evidence.planning ?? 0;
  if ((templateId === 'on-call' || templateId === 'delivery-tracking') && loops > 0) return plural(loops, 'recurring loop');
  if (templateId === 'planner' && planning >= 5) return plural(planning, 'planning call');
  if (templateId === 'developer' && evidence.edits >= MID_MIN_EDITS) return `${plural(evidence.edits, 'edit')} in ${files} file tool calls`;
  if (templateId === 'reviewer' && files >= MIN_FILE_CALLS * 2 && evidence.editRatio !== null && evidence.editRatio < 0.3) return `${Math.round((1 - evidence.editRatio) * 100)}% of its ${files} file tool calls only read`;
  return null;
}

/**
 * The template a session looks like, why, and how sure (`docs/team.md` → *Suggestions*);
 * `null` = too little signal ({@link MIN_EVENTS}) or neither the title nor the behaviour
 * names a template (not suggested). Cheap, no model call. The title is strong evidence
 * ({@link titleTemplate}); the behaviour is {@link behaviourTemplate}. Both agree (the
 * behaviour matches the title's template, or backs it) → high; they disagree → the title
 * wins at medium and the reason names both; only one of them → medium; a title with
 * almost no file activity and no loops → low.
 */
export function classifySuggestion(
  evidence: SuggestionEvidence,
  title?: string | null,
): { readonly templateId: string; readonly reason: string; readonly confidence: SuggestionConfidence } | null {
  if (evidence.events7d < MIN_EVENTS) return null;
  const named = titleTemplate(title);
  const seen = behaviourTemplate(evidence);
  if (!named) return seen ? { templateId: seen.templateId, reason: `${seen.because}: looks like ${NOUN[seen.templateId]}.`, confidence: 'medium' } : null;
  const words = named.words.map((word) => `“${word}”`).join(', ');
  const noun = NOUN[named.templateId];
  const backed = seen?.templateId === named.templateId ? seen.because : backing(named.templateId, evidence);
  if (backed) return { templateId: named.templateId, reason: `The title (${words}) and the behaviour (${backed}) agree: looks like ${noun}.`, confidence: 'high' };
  if (seen) return { templateId: named.templateId, reason: `The title (${words}) says ${noun}; the behaviour (${seen.because}) looks like ${NOUN[seen.templateId]}. Going by the title.`, confidence: 'medium' };
  const weak = evidence.edits + evidence.reads < MIN_FILE_CALLS && evidence.loops + evidence.cliLoops === 0;
  return { templateId: named.templateId, reason: `The title (${words}) says ${noun}; the behaviour shows no clear pattern${weak ? ' (almost no file activity)' : ''}.`, confidence: weak ? 'low' : 'medium' };
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
 * vs read ratio of their tool calls, their planning calls and their active days. Any
 * open session counts, whatever its status (done and idle ones too). A session is
 * suggested only when it has enough signal ({@link MIN_EVENTS}) and its title or its
 * evidence names a template ({@link classifySuggestion}, with a confidence); identical
 * evidence is suggested once per template ({@link dedupeSuggestions}). The others are
 * left out (the Team page lists them under "Not suggested").
 */
export async function computeSuggestions(input: { readonly store: Store; readonly loops: LoopService; readonly exclude: ReadonlySet<string>; readonly now: number }): Promise<TeamSuggestion[]> {
  const { store } = input;
  const since = new Date(input.now - 7 * 24 * 3600_000).toISOString();
  const sessions = (await store.sessions.list({ closed: false })).filter((s) => !input.exclude.has(s.id) && !s.hooked && s.kind !== 'chat'); // D106: chats are never suggested
  if (sessions.length === 0) return [];
  const events = new Map<string, { readonly n: number; readonly days: number }>();
  for (const row of store.db.prepare('SELECT session_id AS id, COUNT(*) AS n, COUNT(DISTINCT substr(ts, 1, 10)) AS days FROM events WHERE ts > ? GROUP BY session_id').all(since)) {
    events.set(String(row['id']), { n: Number(row['n']), days: Number(row['days']) });
  }
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
      events7d: events.get(session.id)?.n ?? 0,
      edits: counts.edits,
      reads: counts.reads,
      editRatio: total === 0 ? null : Math.round((counts.edits / total) * 100) / 100,
      planning: counts.planning,
      activeDays: events.get(session.id)?.days ?? 0,
    };
    const title = session.title ?? session.name;
    const match = classifySuggestion(evidence, title);
    if (!match) continue;
    out.push({
      sessionId: session.id,
      title,
      folder: session.cwd,
      evidence,
      templateId: match.templateId,
      reason: match.reason,
      confidence: match.confidence,
      score: evidence.events7d + (owned + cli) * 50 + evidence.repos * 5,
      charterDraft: null,
    });
  }
  return dedupeSuggestions(out).slice(0, 30);
}
