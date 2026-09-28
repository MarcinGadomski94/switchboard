/**
 * The session header's chips (M4.1, SPEC → Session: "Chips (k v, mono);
 * loop/workflow chips are blue"; `docs/derivations.md` → *Session chips*).
 *
 * Only what Switchboard knows is shown (D13, no inference): the session-start
 * answers in the words the prototype uses for a session started from the
 * New-session form (`nsLaunch`: work, mode, phase, scope, ultracode), the QA stack
 * of a QA session, then one blue chip per loop / workflow observed in the session
 * (the `loops` rows, D9). The prototype's hand-written mock chips (`bp 360`,
 * `cap …`, `contract …`, `runbook …`, `expires …`) have no source and are not made up.
 */
import type { Phase, QaStack, SessionMode, WorkType } from '../model.ts';

/** One header chip: `k` in muted mono, then `v`; `loop` chips are blue. */
export interface SessionChip {
  readonly k: string;
  readonly v: string;
  /** A loop / workflow (or ultracode) chip: blue border and text. */
  readonly loop: boolean;
}

/** The session fields the chips come from. */
export interface ChipSession {
  readonly workType: WorkType | null;
  readonly mode: SessionMode | null;
  readonly phase: Phase | null;
  readonly qaStack: QaStack | null;
  readonly solutions: readonly string[];
  readonly ultracode: boolean;
}

/** A loop observed in the session (`loops` row: `kind` = the observed source, `label` = its card subtitle). */
export interface ChipLoop {
  readonly kind: string;
  readonly label: string | null;
}

const WORK: Record<WorkType, string> = { feature: 'feature-building', qa: 'test-authoring (QA)' };
const MODE: Record<SessionMode, string> = { single: 'single-solution', orchestrator: 'orchestrator' };
const PHASE: Record<Phase, string> = { 'ui-first': 'UI-first', integration: 'integration' };

/** The observed source that marks a workflow run (the prototype's `run workflow …` chip); every other kind is a loop. */
export const WORKFLOW_LOOP_KIND = 'Workflow';

/** The header chips of a session, in the prototype's order (answers, scope, ultracode, then loops). */
export function sessionChips(session: ChipSession, loops: readonly ChipLoop[] = []): SessionChip[] {
  const chips: SessionChip[] = [];
  if (session.workType) chips.push({ k: 'work', v: WORK[session.workType], loop: false });
  if (session.mode) chips.push({ k: 'mode', v: MODE[session.mode], loop: false });
  if (session.phase) chips.push({ k: 'phase', v: PHASE[session.phase], loop: false });
  if (session.workType === 'qa' && session.qaStack) chips.push({ k: 'stack', v: session.qaStack, loop: false });
  if (session.solutions.length > 0) chips.push({ k: 'scope', v: session.solutions.join(' + '), loop: false });
  if (session.ultracode) chips.push({ k: 'ultracode', v: 'on', loop: true });
  for (const loop of loops) {
    const v = loop.label?.trim() || loop.kind;
    chips.push({ k: loop.kind === WORKFLOW_LOOP_KIND ? 'run' : 'loop', v, loop: true });
  }
  return chips;
}
