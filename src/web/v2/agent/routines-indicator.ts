/**
 * Fix after 2.0 · the agent's routines, visible without the side panel: the
 * compact indicator of the dock's status row ("⏰ Next: Nightly check 14:00 ·
 * 2 routines"), its popover and the side panel's Routines group all read this
 * model, so they always list the same set.
 *
 * The set is what classic's session shows (`docs/loops.md` → *UI*, D93, D94):
 * - **Switchboard loops** (D94, `Session.ownedLoops`, not ended): Pause / Resume,
 *   Run now, Edit, Cancel;
 * - **the CLI's own loops and schedules** (D9 / D93, `Session.loops` as
 *   `loopShown` keeps them): `/loop`, `CronCreate` jobs, `ScheduleWakeup`
 *   wake-ups, and the "unlisted schedule" series. Watched only: every action
 *   disabled with the reason, as on the Routines page. `Workflow` cards are runs,
 *   not schedules (they show as helpers in the chat), so they are left out.
 *
 * It reuses the Routines page's model (`agents/routines/routines-model.ts`) for
 * names, plain-words schedules and actions. Pure; unit-tested in
 * `tests/web/v2-agent-routines.test.ts`.
 */
import type { Loop, OwnedLoop, SessionListItem } from '../../../core/api.ts';
import { loopShown } from '../../../core/derive/loops.ts';
import { UNLISTED_KIND } from '../../../core/derive/unlisted-loops.ts';
import { type RoutineModel, cliRoutine, cronText, loopRoutine, nextText, pastText, routineCountText } from '../agents/routines/routines-model.ts';

/** A CLI schedule whose next time passed this long ago without a firing is shown as stale (D93: it may have died with its process). */
export const STALE_AFTER_MS = 2 * 60_000;

/** How the item stands. */
export type AgentRoutineState = 'active' | 'paused' | 'stale' | 'estimated';

/** The last run's result: ok / failed / skipped (with its reason, e.g. waiting for you) / running / waiting for you. */
export interface AgentRoutineLast {
  readonly tone: 'ok' | 'fail' | 'skip' | 'run' | 'need';
  readonly text: string;
}

/** One loop or schedule of the agent, as the popover and the side panel show it. */
export interface AgentRoutineItem {
  readonly key: string;
  /** `loop` = a Switchboard loop (D94); `cli` = run by the CLI itself (watched only). */
  readonly source: 'loop' | 'cli';
  /** What kind of schedule, in words: "Routine", "CLI loop", "CLI schedule", "Wake-up", "Unlisted CLI schedule". */
  readonly kindText: string;
  /** Its name, else the prompt's excerpt. */
  readonly name: string;
  /** The prompt's first line (Switchboard loops) or the observed note (CLI). */
  readonly what: string;
  /** The schedule in plain words. */
  readonly scheduleText: string;
  /** The next run's time ("14:00", "tomorrow 08:00"), `null` when none is known (paused, ended, unknown). */
  readonly nextText: string | null;
  /** The next run (epoch ms), `null` as above. */
  readonly nextAt: number | null;
  readonly last: AgentRoutineLast | null;
  readonly state: AgentRoutineState;
  /** The state in words ("On schedule", "Paused", "Stale: due at 14:00, not seen since", "Estimated"). */
  readonly stateText: string;
  /** The Routines page's model (actions and their reasons, the source objects). */
  readonly routine: RoutineModel;
  readonly loop: OwnedLoop | null;
}

/** The indicator, the popover's heading and the side panel's summary. */
export interface AgentRoutines {
  readonly items: readonly AgentRoutineItem[];
  readonly count: number;
  /** The item that runs next (an active one with the soonest next time), `null` when none is due. */
  readonly next: AgentRoutineItem | null;
  /** "Next: Nightly check 14:00 · 2 routines"; "2 routines · paused"; `''` with none. */
  readonly text: string;
  /** The phone / peek form: "14:00 · 2". */
  readonly short: string;
  /** Amber when something needs a look (a stale schedule, a failed run, a run skipped while it waits for you), else grey. */
  readonly tone: 'grey' | 'amber';
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/** A Switchboard loop's last run: the skip with its reason when the last due time was not sent, else the firing. */
export function ownedLast(loop: OwnedLoop, now: number): AgentRoutineLast | null {
  if (loop.lastError) {
    const waiting = /waiting for your answer/i.test(loop.lastError);
    return { tone: waiting ? 'need' : 'skip', text: `${waiting ? 'skipped — waiting for you' : `skipped — ${loop.lastError}`}` };
  }
  if (loop.lastFiredAt) return { tone: 'ok', text: `sent at ${pastText(loop.lastFiredAt, now)} (run ${loop.runs})` };
  return null;
}

const ITERATION_WORDS: Readonly<Record<Loop['iterations'][number]['result'], AgentRoutineLast>> = {
  ok: { tone: 'ok', text: 'passed' },
  fail: { tone: 'fail', text: 'failed' },
  run: { tone: 'run', text: 'running now' },
  need: { tone: 'need', text: 'waiting for you' },
  none: { tone: 'skip', text: 'no result (the process ended)' },
};

/** A CLI loop's last observed iteration. */
export function cliLast(loop: Loop, now: number): AgentRoutineLast | null {
  const last = loop.iterations.at(-1);
  if (!last) return null;
  const words = ITERATION_WORDS[last.result];
  return { tone: words.tone, text: last.ts ? `${words.text} at ${pastText(last.ts, now)}` : words.text };
}

function cliKind(loop: Loop): string {
  if (loop.kind === 'ScheduleWakeup') return 'Wake-up';
  if (loop.kind === 'CronCreate') return 'CLI schedule';
  if (loop.kind === UNLISTED_KIND) return 'Unlisted CLI schedule';
  return 'CLI loop';
}

/** A CLI loop's schedule in plain words: a cron job's expression read out, a wake-up's time, `/loop 1h` as it is. */
function cliSchedule(loop: Loop, now: number): string {
  const label = loop.label?.trim() ?? '';
  const cron = /^cron (.+)$/.exec(label);
  if (cron?.[1]) return cronText(cron[1]);
  if (loop.kind === 'ScheduleWakeup') {
    const at = nextText(loop.nextFireAt, now);
    return at ? `Once, at ${at}` : 'Once';
  }
  return label || loop.kind;
}

/** A Switchboard loop as an item. */
export function ownedItem(session: SessionListItem, loop: OwnedLoop, now: number): AgentRoutineItem {
  const routine = loopRoutine(session, loop, now);
  const paused = loop.state === 'paused';
  const nextAt = loop.state === 'active' ? ms(loop.nextFireAt) : null;
  return {
    key: routine.key,
    source: 'loop',
    kindText: 'Routine',
    name: loop.title,
    what: firstLine(loop.prompt),
    scheduleText: routine.scheduleText,
    nextText: nextAt !== null ? nextText(loop.nextFireAt, now) : null,
    nextAt,
    last: ownedLast(loop, now),
    state: paused ? 'paused' : 'active',
    stateText: paused ? 'Paused' : 'On schedule',
    routine,
    loop,
  };
}

/** A CLI loop or schedule as an item (watched only). */
export function cliItem(session: SessionListItem, loop: Loop, now: number): AgentRoutineItem {
  const routine = cliRoutine(session, loop, now);
  const due = ms(loop.nextFireAt);
  const unlisted = loop.kind === UNLISTED_KIND;
  const stale = !unlisted && due !== null && now - due > STALE_AFTER_MS;
  const kindText = cliKind(loop);
  const label = loop.label?.trim() ?? '';
  const name = unlisted ? 'Unlisted schedule in the CLI' : loop.kind === 'ScheduleWakeup' ? 'Wake-up' : loop.kind === 'CronCreate' ? 'CLI schedule' : label || loop.kind;
  const state: AgentRoutineState = stale ? 'stale' : unlisted ? 'estimated' : 'active';
  const nextWords = due !== null ? nextText(loop.nextFireAt, now) : null;
  return {
    key: routine.key,
    source: 'cli',
    kindText,
    name,
    what: loop.note?.trim() || '',
    scheduleText: cliSchedule(loop, now),
    nextText: stale ? null : nextWords,
    nextAt: stale ? null : due,
    last: cliLast(loop, now),
    state,
    stateText: stale ? `Stale: due at ${pastText(loop.nextFireAt, now)}, not seen since` : unlisted ? 'Estimated from the prompts the CLI sent' : 'On schedule',
    routine,
    loop: null,
  };
}

/**
 * The agent's loops and schedules: Switchboard loops (oldest first), then the
 * CLI's own (oldest first); the next one; the indicator's words.
 */
export function agentRoutines(session: SessionListItem | null, now: number = Date.now()): AgentRoutines {
  const items: AgentRoutineItem[] = [];
  if (session) {
    const at = new Date(now);
    const owned = [...(session.ownedLoops ?? [])].filter((loop) => loop.state !== 'ended').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const loop of owned) items.push(ownedItem(session, loop, now));
    const cli = [...(session.loops ?? [])].filter((loop) => loop.kind !== 'Workflow' && loopShown(loop, at)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const loop of cli) items.push(cliItem(session, loop, now));
  }
  let next: AgentRoutineItem | null = null;
  for (const item of items) {
    if (item.state === 'paused' || item.nextAt === null) continue;
    if (next === null || item.nextAt < (next.nextAt ?? Infinity)) next = item;
  }
  const count = items.length;
  const countText = routineCountText(count);
  let text = '';
  let short = '';
  if (count > 0) {
    if (next) {
      text = `Next: ${next.name} ${next.nextText ?? ''}`.trim() + (count > 1 ? ` · ${countText}` : '');
      short = `${next.nextText ?? ''}${count > 1 ? ` · ${count}` : ''}`;
    } else {
      const allPaused = items.every((item) => item.state === 'paused');
      text = `${countText}${allPaused ? ' · paused' : ''}`;
      short = String(count);
    }
  }
  const tone = items.some((item) => item.state === 'stale' || item.last?.tone === 'fail' || item.last?.tone === 'need') ? 'amber' : 'grey';
  return { items, count, next, text, short, tone };
}
