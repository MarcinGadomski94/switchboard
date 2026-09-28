import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { type ServicePlan, type ServiceStep, displayCommand, serviceFileBytes } from '../../core/service-files.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';
import { ServiceError } from './errors.ts';

/** Options for {@link executePlan}. */
export interface ExecuteOptions {
  /** The service manager as an argv prefix (`["launchctl"]`, or a fake in tests). */
  readonly manager: readonly string[];
  /** Working folder of the manager commands. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Runs one manager command (default: {@link runCommand}, `shell: false`). */
  readonly run?: (command: readonly string[], args: readonly string[]) => Promise<RunResult>;
}

/** What happened to one step. */
export interface StepReport {
  readonly step: ServiceStep;
  /** `skipped` = a `run` step whose `onlyIf` command failed. */
  readonly outcome: 'done' | 'skipped';
}

/** A written file's previous bytes (`null` = it did not exist), for the rollback. */
interface Written {
  readonly path: string;
  readonly previous: Buffer | null;
}

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

async function rollback(written: readonly Written[]): Promise<void> {
  for (const file of [...written].reverse()) {
    try {
      if (file.previous === null) await rm(file.path, { force: true });
      else await writeFile(file.path, file.previous);
    } catch {
      // Best effort: the error that caused the rollback is what gets reported.
    }
  }
}

/**
 * Runs `plan` step by step: folders (recursive), files (the exact bytes of
 * `serviceFileBytes`), removals (missing is fine) and service-manager commands
 * (always an argv array, `shell: false`). A `run` step with `onlyIf` is skipped
 * when that command fails. When a command fails the files written so far are put
 * back as they were, and nothing after it runs.
 * @throws {ServiceError} `command-failed` / `file-failed`.
 */
export async function executePlan(plan: ServicePlan, options: ExecuteOptions): Promise<StepReport[]> {
  const run = options.run ?? ((command, args) => runCommand(command, args, { cwd: options.cwd, env: options.env ?? process.env, timeoutMs: 30_000 }));
  const reports: StepReport[] = [];
  const written: Written[] = [];
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'mkdir':
        try {
          await mkdir(step.path, { recursive: true });
        } catch (error) {
          await rollback(written);
          throw new ServiceError('file-failed', `could not create ${step.path}: ${(error as Error).message}`);
        }
        break;
      case 'write':
        try {
          const previous = await readIfExists(step.file.path);
          await writeFile(step.file.path, serviceFileBytes(step.file));
          written.push({ path: step.file.path, previous });
        } catch (error) {
          await rollback(written);
          throw new ServiceError('file-failed', `could not write ${step.file.path}: ${(error as Error).message}`);
        }
        break;
      case 'remove':
        try {
          await rm(step.path, { force: true });
        } catch (error) {
          await rollback(written);
          throw new ServiceError('file-failed', `could not remove ${step.path}: ${(error as Error).message}`);
        }
        break;
      case 'run': {
        if (step.onlyIf && !succeeded(await run(options.manager, step.onlyIf))) {
          reports.push({ step, outcome: 'skipped' });
          continue;
        }
        const result = await run(options.manager, step.args);
        if (!succeeded(result)) {
          await rollback(written);
          throw new ServiceError('command-failed', `${displayCommand([...options.manager, ...step.args])} failed: ${failureText(result)}`);
        }
        break;
      }
    }
    reports.push({ step, outcome: 'done' });
  }
  return reports;
}
