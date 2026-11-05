import { type MoveLogSide, moveLogReason, moveStepMessage } from '../../core/move-log.ts';

/**
 * Where the move log's lines go: the service's pino logger (`app.log`), whose
 * lines carry `time` and `level`. Only `info` and `warn` are used.
 */
export interface MoveLogSink {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** A sink that drops everything (a service built without a logger). */
export const SILENT_MOVE_LOG: MoveLogSink = { info: () => undefined, warn: () => undefined };

/** A step begun with {@link MoveLog.begin}. */
export interface MoveLogStep {
  /** Logs `move: <step> finished` with its duration. */
  done(fields?: Record<string, unknown>): void;
  /** Logs `move: <step> failed` with its duration and the scrubbed reason. */
  fail(error: unknown, fields?: Record<string, unknown>): void;
}

interface OpenStep {
  readonly step: string;
  readonly handle: MoveLogStep;
}

/**
 * The move log of one machine (`docs/peers.md` → *The move log*): `move: <step>
 * started` / `finished` / `failed` lines with `run`, `step`, `state`, `side`, `ms`
 * and, on a failure, `reason` (scrubbed by {@link moveLogReason}: never a token,
 * file contents or an environment value). A step that fails also fails the
 * sub-steps of the same run still open (a clone that threw ends the clone and the
 * apply around it).
 */
export class MoveLog {
  readonly #sink: MoveLogSink;
  readonly #open = new Map<string, OpenStep[]>();

  constructor(sink: MoveLogSink = SILENT_MOVE_LOG) {
    this.#sink = sink;
  }

  /** The sink, for the run's own lines (start, outcome). */
  get sink(): MoveLogSink {
    return this.#sink;
  }

  /** Starts a step of `run` on `side`; the handle ends it (once). */
  begin(run: string, step: string, side: MoveLogSide, fields: Record<string, unknown> = {}): MoveLogStep {
    const started = Date.now();
    this.#sink.info({ run, step, state: 'started', side, ...fields }, moveStepMessage(step, 'started'));
    let ended = false;
    const end = (): number | null => {
      if (ended) return null;
      ended = true;
      const open = this.#open.get(run);
      if (open) {
        const index = open.findIndex((entry) => entry.handle === handle);
        if (index >= 0) open.splice(index, 1);
        if (open.length === 0) this.#open.delete(run);
      }
      return Date.now() - started;
    };
    const handle: MoveLogStep = {
      done: (more = {}) => {
        const ms = end();
        if (ms !== null) this.#sink.info({ run, step, state: 'finished', side, ms, ...fields, ...more }, moveStepMessage(step, 'finished'));
      },
      fail: (error, more = {}) => {
        // Sub-steps begun after this one and still open fail with it (newest first).
        const open = this.#open.get(run) ?? [];
        const mine = open.findIndex((entry) => entry.handle === handle);
        if (mine >= 0) for (const inner of open.slice(mine + 1).reverse()) inner.handle.fail(error);
        const ms = end();
        if (ms !== null) this.#sink.warn({ run, step, state: 'failed', side, ms, ...fields, ...more, reason: moveLogReason(error) }, moveStepMessage(step, 'failed'));
      },
    };
    const open = this.#open.get(run) ?? [];
    open.push({ step, handle });
    this.#open.set(run, open);
    return handle;
  }

  /**
   * Runs `work` as a step of `run` (`null`: not part of a run, nothing is logged):
   * `started`, then `finished` (with `result(value)`'s fields) or `failed`.
   */
  async step<T>(run: string | null, step: string, side: MoveLogSide, work: () => Promise<T>, fields: Record<string, unknown> = {}, result?: (value: T) => Record<string, unknown>): Promise<T> {
    if (run === null) return work();
    const handle = this.begin(run, step, side, fields);
    try {
      const value = await work();
      handle.done(result ? safeFields(() => result(value)) : {});
      return value;
    } catch (error) {
      handle.fail(error);
      throw error;
    }
  }
}

/** A result's fields, or none when reading them throws (a log line never breaks a step). */
function safeFields(read: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return read();
  } catch {
    return {};
  }
}
