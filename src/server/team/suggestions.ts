import type { SuggestionEvidence, TeamSuggestion } from '../../core/team.ts';
import type { Store } from '../db/store.ts';
import type { LoopService } from '../loops/owned.ts';

/** Tool calls that change files (the "edit" side of the ratio). */
export const EDIT_TOOLS: readonly string[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch'];

/** Tool calls that only read (the "read" side). */
export const READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead'];

export type { SuggestionEvidence, TeamSuggestion } from '../../core/team.ts';

/**
 * D100 · candidate members from the existing sessions (`docs/team.md` → *Suggestions*):
 * this machine's open sessions that are not members, with cheap evidence from the
 * database (no transcript reads): repos, loops, events in the last 7 days and the
 * edit vs read ratio of their tool calls. The template is a heuristic: recurring
 * loops and mostly reading → On-call / Production monitoring; mostly reading with
 * no loops → Reviewer / QA; mostly editing → Developer; few tool calls and loops →
 * Delivery tracking; otherwise Planner. Drafting a charter is T3's job.
 */
export async function computeSuggestions(input: { readonly store: Store; readonly loops: LoopService; readonly exclude: ReadonlySet<string>; readonly now: number }): Promise<TeamSuggestion[]> {
  const { store } = input;
  const since = new Date(input.now - 7 * 24 * 3600_000).toISOString();
  const sessions = (await store.sessions.list({ closed: false })).filter((s) => !input.exclude.has(s.id) && !s.hooked);
  if (sessions.length === 0) return [];
  const events = new Map<string, number>();
  for (const row of store.db.prepare('SELECT session_id AS id, COUNT(*) AS n FROM events WHERE ts > ? GROUP BY session_id').all(since)) events.set(String(row['id']), Number(row['n']));
  const tools = new Map<string, { edits: number; reads: number }>();
  const rows = store.db
    .prepare("SELECT session_id AS id, json_extract(payload, '$.name') AS name, COUNT(*) AS n FROM events WHERE ts > ? AND json_extract(payload, '$.type') = 'tool' GROUP BY session_id, name")
    .all(since);
  for (const row of rows) {
    const id = String(row['id']);
    const name = String(row['name']);
    const entry = tools.get(id) ?? { edits: 0, reads: 0 };
    if (EDIT_TOOLS.includes(name)) entry.edits += Number(row['n']);
    else if (READ_TOOLS.includes(name)) entry.reads += Number(row['n']);
    tools.set(id, entry);
  }
  const out: TeamSuggestion[] = [];
  for (const session of sessions) {
    const owned = (await input.loops.list(session.id).catch(() => [])).filter((loop) => loop.state !== 'ended').length;
    const cli = (await store.loops.list(session.id)).filter((row) => row.kind !== 'Workflow').length;
    const counts = tools.get(session.id) ?? { edits: 0, reads: 0 };
    const total = counts.edits + counts.reads;
    const editRatio = total === 0 ? null : Math.round((counts.edits / total) * 100) / 100;
    const evidence: SuggestionEvidence = {
      repos: session.solutions.length > 0 ? session.solutions.length : session.cwd ? 1 : 0,
      loops: owned,
      cliLoops: cli,
      events7d: events.get(session.id) ?? 0,
      edits: counts.edits,
      reads: counts.reads,
      editRatio,
    };
    const loops = owned + cli;
    let templateId = 'planner';
    let reason = 'Mixed work without a clear pattern.';
    if (loops > 0 && (editRatio === null || editRatio < 0.2)) {
      templateId = 'on-call';
      reason = `${loops} recurring loop${loops === 1 ? '' : 's'} and mostly reading: looks like monitoring.`;
    } else if (editRatio !== null && editRatio >= 0.5) {
      templateId = 'developer';
      reason = `${Math.round(editRatio * 100)}% of its file tool calls edit: looks like implementation.`;
    } else if (editRatio !== null && editRatio < 0.2 && total >= 10) {
      templateId = 'reviewer';
      reason = 'Mostly reads files without loops: looks like review or QA.';
    } else if (total < 10 && loops > 0) {
      templateId = 'delivery-tracking';
      reason = 'Few file tool calls but recurring work: looks like tracking.';
    }
    out.push({
      sessionId: session.id,
      title: session.title ?? session.name,
      folder: session.cwd,
      evidence,
      templateId,
      reason,
      score: evidence.events7d + loops * 50 + evidence.repos * 5,
      charterDraft: null,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 30);
}
