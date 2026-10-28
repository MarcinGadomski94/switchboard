import { appendFileSync } from 'node:fs';
import { TEST_RUN_DIR_ENV, onServerSpawned, setStopGraceMs } from '../../helpers/server-registry.ts';

/** The pid log the outer test reads (`LEAK_LOG`): one line per spawned server, plus notes. */
export function leakLog(line: string): void {
  appendFileSync(process.env['LEAK_LOG'] as string, `${line}\n`);
}

/** Logs every server this fixture file spawns; a short SIGTERM grace keeps the hung-server case fast. */
export function logSpawns(): void {
  setStopGraceMs(1_000);
  leakLog(`run ${process.env[TEST_RUN_DIR_ENV] ?? ''}`);
  onServerSpawned((pid) => leakLog(`pid ${pid}`));
}

/** The root the outer test removes (`LEAK_ROOT`). */
export function leakRoot(): string {
  return process.env['LEAK_ROOT'] as string;
}

/** Never resolves (a hung hook or test). */
export function hang(): Promise<never> {
  return new Promise<never>(() => undefined);
}
