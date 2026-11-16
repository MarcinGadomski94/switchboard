import { type EstimateModel, type LearningContext, type LearningSample, type LikelyEstimate, buildEstimateModel, learningLine, likelyMinutes } from '../../core/estimate-learning.ts';
import type { Store } from '../db/store.ts';

/** How many of the newest completed items learning reads (every group looks at its newest 30 of these). */
export const LEARNING_READ_LIMIT = 2000;

/**
 * D167 (`docs/todos.md` → *Self-correcting estimates*): this computer's learned estimate model,
 * read from `todo_actuals` and rebuilt whenever what it reads changed (a cheap fingerprint query
 * on each use: an item completing, reopening or being re-measured is seen at once, without wiring).
 * One per store.
 */
export class EstimateLearner {
  readonly #store: Store;
  #fingerprint: string | null = null;
  #model: EstimateModel = buildEstimateModel([]);
  #samples: readonly LearningSample[] = [];

  constructor(store: Store) {
    this.#store = store;
  }

  /** The current model (rebuilt when the history changed). */
  model(): EstimateModel {
    const fingerprint = this.#store.todos.learningFingerprint();
    if (fingerprint !== this.#fingerprint) {
      this.#samples = this.#store.todos.learningSamples(LEARNING_READ_LIMIT);
      this.#model = buildEstimateModel(this.#samples);
      this.#fingerprint = fingerprint;
    }
    return this.#model;
  }

  /** The history (newest first), for Insights' corrected accuracy. */
  samples(): readonly LearningSample[] {
    this.model();
    return this.#samples;
  }

  /** The likely working time of an estimate in `context`. */
  likely(estimateMinutes: number, context: LearningContext): LikelyEstimate {
    return likelyMinutes(this.model(), estimateMinutes, context);
  }

  /** The agent's line (replaces D147's calibration line); `null` while nothing is learned. */
  line(context: LearningContext): string | null {
    return learningLine(this.model(), context);
  }
}

const learners = new WeakMap<Store, EstimateLearner>();

/** The store's learner (one per store, shared by the todos, plans and Insights services). */
export function estimateLearnerFor(store: Store): EstimateLearner {
  let learner = learners.get(store);
  if (!learner) {
    learner = new EstimateLearner(store);
    learners.set(store, learner);
  }
  return learner;
}
