import type { TeamCharter, TeamSuggestion } from '../../core/team.ts';
import type { TeamTemplate } from '../../core/team-templates.ts';

/**
 * D100 · drafting a suggestion's charter (`docs/team.md` → *Suggestions*). The core
 * leaves `charterDraft` empty; the review drafts one on demand when it opens, for
 * every suggestion without one. Switchboard has no model call for summaries (History
 * and review-card summaries are the agent's own last message, not a model's), so the
 * draft is built here, deterministically, from the template the heuristic picked and
 * the session's evidence: instant, free, and never blocking the dialog. Drafts are
 * cached per session, template and evidence for the page's lifetime.
 */

const cache = new Map<string, TeamCharter>();

/** The last path segment of a folder ("/work/acme-app" → "acme-app"). */
function folderName(folder: string | null): string | null {
  if (!folder) return null;
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function sentence(text: string): string {
  const t = text.trim();
  return t === '' ? t : /[.!?]$/.test(t) ? t : `${t}.`;
}

function key(suggestion: TeamSuggestion, template: TeamTemplate | null): string {
  const e = suggestion.evidence;
  return [suggestion.sessionId, template?.id ?? '', suggestion.title, suggestion.folder ?? '', e.repos, e.loops, e.cliLoops].join('\u0000');
}

/**
 * A charter for `suggestion`: the template's charter, tied to what the session was
 * doing (its title and folder) and to the work it already repeats (its loops).
 */
export function draftCharter(suggestion: TeamSuggestion, template: TeamTemplate | null): TeamCharter {
  if (suggestion.charterDraft) return suggestion.charterDraft;
  const cacheKey = key(suggestion, template);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const where = folderName(suggestion.folder);
  const e = suggestion.evidence;
  const base = template?.charter ?? { owns: 'Its own area of work.', produces: 'Short status notes and hand-offs.', neverDoes: 'Anything outward-facing without approval.' };
  const scope = where ? `the work of “${suggestion.title}” in ${where}` : `the work of “${suggestion.title}”`;
  const owns = `${sentence(base.owns)} Continues ${scope}.`;
  const loops = e.loops + e.cliLoops;
  const routine = loops > 0 ? ` Keeps its ${loops} recurring loop${loops === 1 ? '' : 's'} going.` : '';
  const produces = `${sentence(base.produces)}${routine}`;
  const repos = e.repos > 1 ? ` Stays within its ${e.repos} repositories.` : '';
  const neverDoes = `${sentence(base.neverDoes)}${repos}`;
  const draft: TeamCharter = { owns, produces, neverDoes };
  cache.set(cacheKey, draft);
  return draft;
}

/** Drafts for every suggestion without one (the review calls this when it opens). */
export function draftAll(suggestions: readonly TeamSuggestion[], templateOf: (id: string) => TeamTemplate | null): ReadonlyMap<string, TeamCharter> {
  const out = new Map<string, TeamCharter>();
  for (const suggestion of suggestions) out.set(suggestion.sessionId, draftCharter(suggestion, templateOf(suggestion.templateId)));
  return out;
}

/** Forgets the cached drafts (tests). */
export function clearDraftCache(): void {
  cache.clear();
}
