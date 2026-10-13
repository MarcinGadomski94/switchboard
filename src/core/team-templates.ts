import type { TeamCharter, TeamGateKind } from './team.ts';

/**
 * D100 · Team templates (`docs/team.md` → *Templates*): starting points for a
 * member. T3 (the UI lane) shows them and drafts charters; this registry holds the
 * defaults: charter, rhythm, gates and model. A template's rhythm loops are
 * suggestions: creating a member from a template creates them as Switchboard loops
 * (D94) in its session only when the developer keeps them.
 *
 * Generic on purpose: no organisation, product or tool names beyond the kind of tool.
 */

/** A loop a template suggests (D94 shape: one of `cron` / `everyMinutes`). */
export interface TemplateLoop {
  readonly label: string;
  readonly prompt: string;
  /** 5-field cron in local time (`docs/schedules.md`). */
  readonly cron?: string;
  readonly everyMinutes?: number;
}

/** Model defaults (D82's fields: CLI, model alias, effort). `null` = the normal choice. */
export interface TemplateModel {
  readonly provider: 'claude' | 'codex' | 'opencode';
  readonly model: string | null;
  readonly effort: 'low' | 'medium' | 'high' | null;
}

/** One template. */
export interface TeamTemplate {
  readonly id: string;
  /** The role name it suggests. */
  readonly name: string;
  /** One line for the picker. */
  readonly summary: string;
  readonly charter: TeamCharter;
  readonly rhythm: { readonly loops: readonly TemplateLoop[]; readonly onHandoff: boolean };
  /** Its gates besides the always-on `outward-facing`. */
  readonly gates: readonly TeamGateKind[];
  readonly model: TemplateModel;
  /** Read-only by charter (it never edits files or writes anywhere). */
  readonly readOnly: boolean;
}

/** The registry, in the picker's order. */
export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  {
    id: 'planner',
    name: 'Planner',
    summary: 'Turns requests into small, ordered work items and hands them out.',
    charter: {
      owns: 'The backlog of incoming requests and how they are broken down.',
      produces: 'Hand-offs with a clear brief and expected result; a short plan per request.',
      neverDoes: 'Writes code, merges, or changes anything outside its notes.',
    },
    rhythm: { loops: [{ label: 'Morning planning', prompt: 'Review new requests and open hand-offs; plan the day and hand out work.', cron: '0 9 * * 1-5' }], onHandoff: true },
    gates: ['external-write'],
    model: { provider: 'claude', model: 'opus', effort: 'high' },
    readOnly: true,
  },
  {
    id: 'developer',
    name: 'Developer',
    summary: 'Implements hand-offs in its repositories, with tests.',
    charter: {
      owns: 'Implementation in its workplace repositories.',
      produces: 'Commits on a work branch with tests, and a review card when done.',
      neverDoes: 'Merges into the default branch or pushes without approval.',
    },
    rhythm: { loops: [], onHandoff: true },
    gates: ['merge-default-branch'],
    model: { provider: 'claude', model: 'sonnet', effort: 'medium' },
    readOnly: false,
  },
  {
    id: 'reviewer',
    name: 'Reviewer / QA',
    summary: 'Reviews changes and checks them against the request.',
    charter: {
      owns: 'Reviews of finished work and the test evidence.',
      produces: 'Findings as hand-offs back to the author; a pass / fail line per change.',
      neverDoes: 'Fixes the code it reviews or approves its own work.',
    },
    rhythm: { loops: [], onHandoff: true },
    gates: ['merge-default-branch'],
    model: { provider: 'claude', model: 'opus', effort: 'high' },
    readOnly: false,
  },
  {
    id: 'release-manager',
    name: 'Release manager',
    summary: 'Prepares releases: changelog, version, checks.',
    charter: {
      owns: 'Release preparation: what is in, the changelog and the version.',
      produces: 'A release checklist and draft notes for the developer.',
      neverDoes: 'Tags, publishes or deploys without approval.',
    },
    rhythm: { loops: [{ label: 'Release readiness', prompt: 'Check what is merged since the last release and update the release checklist.', cron: '0 15 * * 5' }], onHandoff: true },
    gates: ['merge-default-branch', 'release'],
    model: { provider: 'claude', model: 'sonnet', effort: 'medium' },
    readOnly: false,
  },
  {
    id: 'on-call',
    name: 'On-call / Production monitoring',
    summary: 'Watches production signals and raises what needs attention.',
    charter: {
      owns: 'Watching logs and alerts for new problems.',
      produces: 'A short report per sweep; hand-offs for real problems with the evidence.',
      neverDoes: 'Changes production or silences alerts.',
    },
    rhythm: { loops: [{ label: 'Production sweep', prompt: 'Sweep production logs for new errors and warnings; report and hand off real problems.', everyMinutes: 60 }], onHandoff: false },
    gates: ['external-write', 'release'],
    model: { provider: 'claude', model: 'sonnet', effort: 'low' },
    readOnly: true,
  },
  {
    id: 'delivery-tracking',
    name: 'Delivery tracking',
    summary: 'Keeps track of what is in flight and what is late.',
    charter: {
      owns: 'The state of work in flight across the team.',
      produces: 'A daily status note: done, in progress, blocked, late.',
      neverDoes: 'Assigns work or changes tickets without approval.',
    },
    rhythm: { loops: [{ label: 'Daily status', prompt: 'Collect the team status and write the daily note.', cron: '30 16 * * 1-5' }], onHandoff: false },
    gates: ['external-write'],
    model: { provider: 'claude', model: 'haiku', effort: 'low' },
    readOnly: true,
  },
  {
    id: 'marketing-monitoring',
    name: 'Marketing monitoring',
    summary: 'Reads public channels and summarises what people say (read-only).',
    charter: {
      owns: 'Reading public channels about the product.',
      produces: 'A weekly summary of mentions, questions and sentiment.',
      neverDoes: 'Posts, replies or writes anywhere: read-only.',
    },
    rhythm: { loops: [{ label: 'Weekly summary', prompt: 'Summarise this week\'s public mentions, questions and sentiment.', cron: '0 10 * * 1' }], onHandoff: false },
    gates: ['external-write'],
    model: { provider: 'claude', model: 'haiku', effort: 'low' },
    readOnly: true,
  },
];

/** The template `id`, else `null`. */
export function templateById(id: string | null | undefined): TeamTemplate | null {
  return TEAM_TEMPLATES.find((template) => template.id === id) ?? null;
}
