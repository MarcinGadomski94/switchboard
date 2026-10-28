import { beginTestRun } from './test-run.ts';

/** Vitest `globalSetup`: this run's test-server pid files, and the teardown that kills what they still list (`tests/helpers/test-run.ts`). */
export default async function setup(): Promise<() => Promise<void>> {
  return beginTestRun('vitest');
}
