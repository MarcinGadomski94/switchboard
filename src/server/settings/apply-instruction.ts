import type { InstructionApplyFailure, InstructionApplyResult } from '../../core/standing-instruction.ts';
import type { Store } from '../db/store.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';

/**
 * D91 (`docs/settings.md` → *Apply to open sessions*): gives every open session of
 * this machine that Switchboard runs the current standing instruction, through
 * {@link SessionSupervisor.reloadInstruction} (idle → restarted with `--resume`,
 * busy or waiting on the developer → after its turn, no process → its next start).
 * Closed sessions are left out; hooked terminal sessions and sessions continued in
 * a terminal are skipped (Switchboard does not run their process). A paired
 * machine's sessions are not here: they are applied on that machine. The sessions
 * are handled at once; a failure leaves that session as it was and is reported.
 */
export async function applyInstructionToOpenSessions(store: Store, supervisor: SessionSupervisor): Promise<InstructionApplyResult> {
  const open = await store.sessions.list({ closed: false });
  const restarted: string[] = [];
  const pending: string[] = [];
  const failed: InstructionApplyFailure[] = [];
  let notRunning = 0;
  let current = 0;
  let skipped = 0;
  await Promise.all(
    open.map(async (session) => {
      if (session.hooked || !session.attached) {
        skipped += 1;
        return;
      }
      try {
        const outcome = await supervisor.reloadInstruction(session.id);
        if (outcome === 'restarted') restarted.push(session.id);
        else if (outcome === 'pending') pending.push(session.id);
        else if (outcome === 'current') current += 1;
        else notRunning += 1;
      } catch (error) {
        failed.push({ sessionId: session.id, title: session.title ?? session.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
  return { restarted, notRunning, pending, current, skipped, failed };
}
