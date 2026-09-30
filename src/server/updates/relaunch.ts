/**
 * The restart helper of D55 (`docs/updates.md` → *Restarting*): started
 * detached by the updater of the **running** install (never from a downloaded
 * package) with one JSON argument (`HelperPlan` in `restart.ts`). It waits
 * until the old Switchboard process has exited, then runs the service manager
 * commands in order (`launchctl bootout` + `bootstrap` on macOS, `schtasks /Run`
 * on Windows), each as an argv array with `shell: false`; the last one is
 * retried a few times (the old instance may still be winding down in the
 * manager's view). Everything goes to the log file it inherited as stdout.
 */
import { spawn } from 'node:child_process';

interface Plan {
  readonly pid: number;
  readonly steps: readonly (readonly string[])[];
  readonly waitMs: number;
}

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} relaunch: ${line}\n`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(argv: readonly string[]): Promise<number | null> {
  const [command, ...args] = argv;
  if (!command) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', (error) => {
      log(`${command}: ${error.message}`);
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  });
}

async function main(): Promise<void> {
  const plan = JSON.parse(process.argv[2] ?? '{}') as Plan;
  if (!Number.isInteger(plan.pid) || !Array.isArray(plan.steps)) throw new Error('bad plan');
  log(`waiting for process ${plan.pid} to exit`);
  const deadline = Date.now() + (plan.waitMs || 120_000);
  while (alive(plan.pid)) {
    if (Date.now() > deadline) {
      log(`process ${plan.pid} is still running; giving up (restart Switchboard yourself)`);
      process.exit(1);
    }
    await sleep(200);
  }
  // A moment for the service manager to register the exit.
  await sleep(1000);
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i] as readonly string[];
    const last = i === plan.steps.length - 1;
    for (let attempt = 1; ; attempt++) {
      const code = await run(step);
      log(`${step.join(' ')} → ${String(code)}`);
      if (code === 0 || !last) break;
      if (attempt >= 5) {
        log('the service could not be started; restart Switchboard yourself');
        process.exit(1);
      }
      await sleep(2000);
    }
  }
  log('done');
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
