import type { Loop, LoopIteration, LoopIterationResult } from '../../core/api.ts';
import type { LoopRecord } from '../db/repos/loops.ts';

const RESULTS: readonly LoopIterationResult[] = ['ok', 'fail', 'run', 'need', 'none'];

/**
 * One stored strip entry as the API returns it. The tracker stores
 * `{result, ts, label}` objects; a bare result word (`ok`, `fail`, …) is read too,
 * and anything else (`skipped`, unknown words) is a `none` cell.
 */
export function toLoopIteration(value: unknown): LoopIteration {
  if (typeof value === 'string') {
    return { result: (RESULTS as readonly string[]).includes(value) ? (value as LoopIterationResult) : 'none', ts: null, label: null };
  }
  const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const result = entry['result'];
  return {
    result: typeof result === 'string' && (RESULTS as readonly string[]).includes(result) ? (result as LoopIterationResult) : 'none',
    ts: typeof entry['ts'] === 'string' ? entry['ts'] : null,
    label: typeof entry['label'] === 'string' ? entry['label'] : null,
  };
}

/** A `loops` row as the API returns it (`Session.loops`, M7.2). */
export function toLoop(record: LoopRecord): Loop {
  return {
    id: record.id,
    sessionId: record.sessionId,
    kind: record.kind,
    label: record.label,
    iteration: record.iteration,
    cap: record.cap,
    breakerCount: record.breakerCount,
    breakerState: record.breakerState,
    nextFireAt: record.nextFireAt,
    expiresAt: record.expiresAt,
    iterations: Array.isArray(record.iterations) ? record.iterations.map(toLoopIteration) : [],
    progressPath: record.progressPath,
    note: record.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
