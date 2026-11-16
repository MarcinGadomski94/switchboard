/**
 * D167 (`docs/todos.md` → *Self-correcting estimates*): Switchboard learns how the agents'
 * estimates turn out and corrects them by itself, the more work it sees. Pure: no I/O.
 *
 * - **Samples:** every completed item measured in working time (D147 `todo_actuals`,
 *   `measure = 'working'`) with an estimate: its working minutes against its estimate.
 * - **The factor** of a group of samples is the **recency-weighted median** of their ratios
 *   (working ÷ estimate), over the newest {@link LEARNING_WINDOW}, each weighted
 *   `0.5^(age / LEARNING_HALF_LIFE)` (age = its rank, 0 = the newest), clamped to
 *   {@link LEARNING_CLAMP}. A median, not D147's summed ratio: one item that ran long (a forgotten
 *   done, a stuck session) or one huge item no longer drags every estimate with it; the weights let
 *   a change in how agents estimate show within a few items. Fewer than {@link LEARNING_MIN} samples:
 *   no factor.
 * - **Which group** answers for an estimate: its folder's samples in its estimate band
 *   ({@link CALIBRATION_BANDS}), else its folder's samples of any band, else every folder's in its
 *   band, else every folder's; none with enough → no correction (`basis: 'none'`, factor 1). Then,
 *   when the context names a CLI and model and that group has {@link LEARNING_MIN} samples of the
 *   same CLI and model whose factor differs from the group's by more than
 *   {@link LEARNING_MODEL_DIFFERS} (relative), that factor answers (`basis: 'model'`).
 * - **Likely minutes** = the estimate × the factor, at least 1.
 */
import { CALIBRATION_BANDS, bandOf } from './todo-actuals.ts';
import { formatTodoMinutes } from './todos.ts';

/** How many of a group's newest samples the factor looks at. */
export const LEARNING_WINDOW = 30;
/** How many samples a group needs before it corrects anything. */
export const LEARNING_MIN = 5;
/** The age (in items) at which a sample weighs half as much as the newest. */
export const LEARNING_HALF_LIFE = 15;
/** The factor never goes below / above these. */
export const LEARNING_CLAMP: readonly [number, number] = [0.05, 5];
/** A CLI / model's own factor is used when it differs from its group's by more than this (relative). */
export const LEARNING_MODEL_DIFFERS = 0.25;

/** One completed item, as learning sees it (newest first in the lists below). */
export interface LearningSample {
  readonly estimateMinutes: number;
  readonly workingMinutes: number;
  /** Its session's folder (`todo_actuals.folder`), `null` when unknown. */
  readonly folder: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly completedAt: string;
}

/** Where an estimate is made: its folder and the CLI / model of the session that will work on it. */
export interface LearningContext {
  readonly folder?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
}

/** What answered: the folder's history, every folder's, a CLI / model's own, or nothing (no correction). */
export type LearningBasis = 'folder' | 'global' | 'model' | 'none';

/** A corrected estimate. */
export interface LikelyEstimate {
  /** The likely working time (minutes); the estimate itself when nothing corrects it. */
  readonly minutes: number;
  /** likely ÷ estimate (1 without a correction). */
  readonly factor: number;
  readonly basis: LearningBasis;
  /** How many finished items the factor comes from (0 without a correction). */
  readonly sampleSize: number;
}

/** The learned model: every completed sample, newest first, and the factors already computed. */
export interface EstimateModel {
  readonly samples: readonly LearningSample[];
  /** Group key → factor (or `null`: too few), filled on demand. */
  readonly cache: Map<string, { readonly factor: number | null; readonly size: number }>;
}

/** A model over `samples` (any order; kept newest first; non-positive estimates and bad times dropped). */
export function buildEstimateModel(samples: readonly LearningSample[]): EstimateModel {
  const usable = samples
    .filter((sample) => Number.isFinite(sample.estimateMinutes) && sample.estimateMinutes > 0 && Number.isFinite(sample.workingMinutes) && sample.workingMinutes >= 0)
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0));
  return { samples: usable, cache: new Map() };
}

function clamp(value: number): number {
  return Math.min(LEARNING_CLAMP[1], Math.max(LEARNING_CLAMP[0], value));
}

/**
 * The recency-weighted median ratio of `samples` (newest first; only the newest
 * {@link LEARNING_WINDOW} count), clamped; `null` with fewer than {@link LEARNING_MIN}.
 */
export function learnedFactor(samples: readonly Pick<LearningSample, 'estimateMinutes' | 'workingMinutes'>[]): number | null {
  const window = samples.slice(0, LEARNING_WINDOW);
  if (window.length < LEARNING_MIN) return null;
  const weighted = window.map((sample, age) => ({ ratio: sample.workingMinutes / sample.estimateMinutes, weight: 0.5 ** (age / LEARNING_HALF_LIFE) })).sort((a, b) => a.ratio - b.ratio);
  const half = weighted.reduce((sum, entry) => sum + entry.weight, 0) / 2;
  let seen = 0;
  for (const entry of weighted) {
    seen += entry.weight;
    if (seen >= half) return clamp(entry.ratio);
  }
  return clamp((weighted[weighted.length - 1] as { ratio: number }).ratio);
}

function groupFactor(model: EstimateModel, key: string, pick: (sample: LearningSample) => boolean): { readonly factor: number | null; readonly size: number } {
  const known = model.cache.get(key);
  if (known) return known;
  const group = model.samples.filter(pick);
  const entry = { factor: learnedFactor(group), size: Math.min(group.length, LEARNING_WINDOW) };
  model.cache.set(key, entry);
  return entry;
}

const NONE = (estimate: number, size: number): LikelyEstimate => ({ minutes: estimate, factor: 1, basis: 'none', sampleSize: size });

/**
 * The likely working time of an estimate (minutes) in `context`, from what `model` learned.
 * `bandOnly`: only an estimate band's own history answers (no fallback to a folder's or every
 * folder's other bands): the agent's line lists the bands that have one.
 */
export function likelyMinutes(model: EstimateModel, estimateMinutes: number, context: LearningContext = {}, bandOnly = false): LikelyEstimate {
  if (!Number.isFinite(estimateMinutes) || estimateMinutes <= 0) return NONE(estimateMinutes, 0);
  const band = bandOf(estimateMinutes);
  const folder = context.folder ?? null;
  const inBand = (sample: LearningSample): boolean => bandOf(sample.estimateMinutes) === band;
  const candidates: Array<{ readonly key: string; readonly basis: 'folder' | 'global'; readonly band: boolean; readonly pick: (sample: LearningSample) => boolean }> = [
    ...(folder ? [
      { key: `f:b${band}:${folder}`, basis: 'folder' as const, band: true, pick: (s: LearningSample) => s.folder === folder && inBand(s) },
      { key: `f:${folder}`, basis: 'folder' as const, band: false, pick: (s: LearningSample) => s.folder === folder },
    ] : []),
    { key: `g:b${band}`, basis: 'global', band: true, pick: inBand },
    { key: 'g', basis: 'global', band: false, pick: () => true },
  ];
  for (const candidate of candidates) {
    if (bandOnly && !candidate.band) continue;
    const group = groupFactor(model, candidate.key, candidate.pick);
    if (group.factor === null) continue;
    let factor = group.factor;
    let basis: LearningBasis = candidate.basis;
    let size = group.size;
    // A CLI / model of its own, when it estimates differently enough.
    if (context.provider && context.model) {
      const own = groupFactor(model, `${candidate.key}:m:${context.provider}/${context.model}`, (s) => candidate.pick(s) && s.provider === context.provider && s.model === context.model);
      if (own.factor !== null && Math.abs(own.factor / factor - 1) > LEARNING_MODEL_DIFFERS) {
        factor = own.factor;
        basis = 'model';
        size = own.size;
      }
    }
    return { minutes: Math.max(1, Math.round(estimateMinutes * factor)), factor, basis, sampleSize: size };
  }
  return NONE(estimateMinutes, model.samples.length);
}

/** Whether a likely estimate says something other than the estimate (a correction was learned). */
export function isCorrected(likely: Pick<LikelyEstimate, 'basis'> | null | undefined): boolean {
  return likely !== null && likely !== undefined && likely.basis !== 'none';
}

/** Where a factor was learned, in words: "this folder", "all folders", "this model". */
export function basisWords(basis: LearningBasis): string {
  return basis === 'folder' ? 'this folder' : basis === 'model' ? 'this model' : basis === 'global' ? 'all folders' : 'no history yet';
}

/** A task card's line while not done: `likely ~12m (est 1h 30m)`; `est ~1h 30m` without a correction. */
export function likelyText(estimateMinutes: number, likely: Pick<LikelyEstimate, 'minutes' | 'basis'> | null | undefined): string {
  if (!isCorrected(likely)) return `est ~${formatTodoMinutes(estimateMinutes)}`;
  return `likely ~${formatTodoMinutes((likely as LikelyEstimate).minutes)} (est ${formatTodoMinutes(estimateMinutes)})`;
}

/** An agent's view of one estimate: `est 90m → likely 12m`; `est 90m` without a correction. */
export function agentEstimateText(estimateMinutes: number, likely: Pick<LikelyEstimate, 'minutes' | 'basis'> | null | undefined): string {
  return isCorrected(likely) ? `est ${estimateMinutes}m → likely ${(likely as LikelyEstimate).minutes}m` : `est ${estimateMinutes}m`;
}

/**
 * The line an agent's todo answers end with (replaces D147's calibration line): what Switchboard
 * learned in this context, per band, and that it corrects the estimates itself. `null` when nothing
 * is learned yet.
 * `Learned from 30 finished in this folder: estimates take 0.13× (≤1 h 0.15× · 1–4 h 0.12×), so est 90m → likely 12m. Keep estimating as you do; Switchboard shows the corrected time.`
 */
export function learningLine(model: EstimateModel, context: LearningContext = {}): string | null {
  const probe = likelyMinutes(model, 90, context);
  if (!isCorrected(probe)) return null;
  // Only the bands with a history of their own (a band without one uses the factor above).
  const bands = CALIBRATION_BANDS.map((band, index) => {
    const at = index === 0 ? 30 : index === 1 ? 120 : 480;
    const likely = likelyMinutes(model, at, context, true);
    return isCorrected(likely) ? `${band.label} ${likely.factor.toFixed(2)}×` : null;
  }).filter((part): part is string => part !== null);
  return `Learned from ${probe.sampleSize} finished in ${basisWords(probe.basis)}: estimates take ${probe.factor.toFixed(2)}×${bands.length > 1 ? ` (${bands.join(' · ')})` : ''}, so est 90m → likely ${probe.minutes}m. Keep estimating as you do; Switchboard shows the corrected time.`;
}

// ── the developer's review waits (D167) ───────────────────────────────────

/** One closed "waiting on you" span of a plan item (`plan_item_spans`, kind `waiting-you`). */
export interface ReviewWaitSample {
  readonly minutes: number;
  /** `review`: it ended with the item's merge / confirmation; `answer`: anything else (a question, a stopped step). */
  readonly kind: 'review' | 'answer';
  readonly folder: string | null;
  readonly endedAt: string;
}

/** The developer's typical waits: the median minutes per kind (`null` = not enough data), and from where. */
export interface ReviewWaits {
  readonly reviewMinutes: number | null;
  readonly answerMinutes: number | null;
  readonly basis: 'folder' | 'global' | 'none';
  readonly sampleSize: number;
}

/** How long after a span's end an item's merge / done still makes it a review wait. */
export const REVIEW_END_SLACK_MS = 2 * 60_000;

/** A span's kind: `review` when the item was merged or done within {@link REVIEW_END_SLACK_MS} of the span's end. */
export function reviewWaitKind(span: { readonly endedAt: string }, item: { readonly mergedAt: string | null; readonly doneAt: string | null }): 'review' | 'answer' {
  const end = Date.parse(span.endedAt);
  for (const at of [item.mergedAt, item.doneAt]) {
    if (at === null) continue;
    const t = Date.parse(at);
    if (Number.isFinite(t) && Number.isFinite(end) && Math.abs(t - end) <= REVIEW_END_SLACK_MS) return 'review';
  }
  return 'answer';
}

function median(values: readonly number[]): number | null {
  if (values.length < LEARNING_MIN) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** The developer's typical waits in `folder` (its own when it has {@link LEARNING_MIN} of a kind, else every folder's), newest {@link LEARNING_WINDOW} per kind. */
export function learnReviewWaits(samples: readonly ReviewWaitSample[], folder: string | null = null): ReviewWaits {
  const newest = [...samples].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  const of = (pick: (sample: ReviewWaitSample) => boolean, kind: 'review' | 'answer'): number[] =>
    newest.filter((sample) => sample.kind === kind && pick(sample)).slice(0, LEARNING_WINDOW).map((sample) => sample.minutes);
  if (folder) {
    const review = median(of((s) => s.folder === folder, 'review'));
    const answer = median(of((s) => s.folder === folder, 'answer'));
    if (review !== null || answer !== null) {
      return { reviewMinutes: review, answerMinutes: answer, basis: 'folder', sampleSize: of((s) => s.folder === folder, 'review').length + of((s) => s.folder === folder, 'answer').length };
    }
  }
  const review = median(of(() => true, 'review'));
  const answer = median(of(() => true, 'answer'));
  if (review === null && answer === null) return { reviewMinutes: null, answerMinutes: null, basis: 'none', sampleSize: 0 };
  return { reviewMinutes: review, answerMinutes: answer, basis: 'global', sampleSize: of(() => true, 'review').length + of(() => true, 'answer').length };
}

// ── the corrected estimate an item had at its time (Insights) ─────────────

/**
 * What Switchboard would have shown for `item`'s estimate when it was made: learned only from the
 * `history` items finished **before** it (no look-ahead), so Insights can judge the corrected
 * estimates the same way it judges the raw ones. `history` may include `item` itself and any
 * later items: they are left out.
 */
export function correctedAtTheTime(item: Pick<LearningSample, 'estimateMinutes' | 'folder' | 'provider' | 'model' | 'completedAt'>, history: readonly LearningSample[]): LikelyEstimate {
  const before = buildEstimateModel(history.filter((sample) => sample.completedAt < item.completedAt));
  return likelyMinutes(before, item.estimateMinutes, { folder: item.folder, provider: item.provider, model: item.model });
}
