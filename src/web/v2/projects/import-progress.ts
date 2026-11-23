import type { JiraImportProgress } from '../../../core/api.ts';
import { PROJECT_WORDS } from '../glossary.ts';

/** D185: what an import form shows of its progress: the line, the bar (0–1, `null` = no bar), whether it stopped. */
export interface ImportProgressView {
  readonly text: string;
  readonly fraction: number | null;
  readonly failed: boolean;
  readonly finished: boolean;
}

const WORDS = PROJECT_WORDS.importSteps;

/** The bar's share per step: reading 0–10 %, creating 10–85 % by steps made, statuses 90 %, finishing 95 %, done 100 %. */
export function importProgressView(progress: Pick<JiraImportProgress, 'step' | 'done' | 'total' | 'message'>): ImportProgressView {
  const { step, done, total } = progress;
  switch (step) {
    case 'reading':
      return { text: WORDS.reading, fraction: 0.05, failed: false, finished: false };
    case 'creating': {
      const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
      return { text: total > 0 ? `${WORDS.creating} · ${done} of ${total}` : `${WORDS.creating}…`, fraction: 0.1 + share * 0.75, failed: false, finished: false };
    }
    case 'statuses':
      return { text: WORDS.statuses, fraction: 0.9, failed: false, finished: false };
    case 'finishing':
      return { text: WORDS.finishing, fraction: 0.95, failed: false, finished: false };
    case 'done':
      return { text: WORDS.done, fraction: 1, failed: false, finished: true };
    case 'failed':
      return { text: progress.message ? `${WORDS.failed}: ${progress.message}` : WORDS.failed, fraction: null, failed: true, finished: true };
  }
}

/** A fresh id for one import's progress events (letters, digits and dashes, as the server accepts). */
export function newProgressId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return random.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}
