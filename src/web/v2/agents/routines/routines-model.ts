/**
 * D131 · lane A · the Routines page's pure model (`/routines`): every routine in
 * plain words, from three sources:
 * - **Switchboard loops** (D94, `Session.ownedLoops`): Switchboard fires them, so
 *   Pause / Resume / Run now / Edit / Cancel all work;
 * - **scheduled runs** (D8, `GET /api/schedules`): each run starts a new agent;
 * - **loops the AI engine runs itself** (D9 / D52, `Session.loops` and
 *   `GET /api/terminal-loops`): watched only, every action disabled with the reason.
 *
 * Each routine: its name, what it does, "Every hour · next run 14:00 · last 5 runs
 * passed", a status (icon + word + colour), the agent it belongs to, its computer,
 * the run history lines and which actions are possible. DOM-free; unit-tested in
 * `tests/web/v2-routines.test.ts`.
 */
import type { Loop, LoopIterationResult, OwnedLoop, OwnedLoopSchedule, Schedule, ScheduleRun, SessionListItem, TerminalLoop } from '../../../../core/api.ts';
import { cronLabel, parseCron } from '../../../../core/cron.ts';
import { loopShown } from '../../../../core/derive/loops.ts';
import { type SessionMachine, offlineReason } from '../../../../core/peers.ts';
import { displayTitle } from '../../../../core/session-title.ts';
import { ROUTINES_WORDS, type V2Status } from '../../glossary.ts';

/** Where a routine comes from. */
export type RoutineSource = 'loop' | 'schedule' | 'cli';

/** An action: possible, or not with the reason (never silently missing). */
export type RoutineAllowed = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The routine's actions. */
export interface RoutineActions {
  readonly pause: RoutineAllowed;
  readonly run: RoutineAllowed;
  readonly edit: RoutineAllowed;
  readonly cancel: RoutineAllowed;
}

/** One line of the run history: "13:00 ✓ passed in 41 s". */
export interface RoutineHistoryLine {
  readonly time: string;
  readonly tone: 'ok' | 'fail' | 'skip' | 'run' | 'need';
  readonly text: string;
}

/** One routine as the page shows it. */
export interface RoutineModel {
  /** Unique: `loop:<session>:<id>`, `schedule:<id>`, `cli:<id>`. */
  readonly key: string;
  readonly source: RoutineSource;
  readonly id: string;
  readonly name: string;
  /** What it does each time (the prompt's first line, the description). */
  readonly what: string;
  /** "Every hour". */
  readonly scheduleText: string;
  /** "Every hour · next run 14:00 · last 5 runs passed". */
  readonly summary: string;
  readonly status: V2Status;
  /** The status word ("On schedule", "Paused", "Running now", "Last run failed"). */
  readonly statusLabel: string;
  readonly paused: boolean;
  readonly ended: boolean;
  /** The agent it belongs to (an owned loop's session, a CLI loop's session, a schedule's last run). */
  readonly agent: { readonly id: string; readonly name: string; readonly label: string } | null;
  /** A terminal session's name for a CLI loop Switchboard does not follow. */
  readonly terminalName: string | null;
  readonly machine: SessionMachine | null;
  /** Why nothing can be done now (an offline computer), else `null`. */
  readonly blocked: string | null;
  readonly history: readonly RoutineHistoryLine[];
  readonly actions: RoutineActions;
  /** Sort key: when it was made. */
  readonly createdAt: string;
  /** The source objects, for the actions. */
  readonly loop?: OwnedLoop;
  readonly schedule?: Schedule;
}

/** History lines shown per routine. */
export const HISTORY_LINES = 6;

const OK: RoutineAllowed = { ok: true };
const no = (reason: string): RoutineAllowed => ({ ok: false, reason });

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number): string => String(n).padStart(2, '0');

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function clockOf(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A coming time: "14:00" today, "tomorrow 08:00", "Mon 08:00" within a week, else "10-29 08:00". */
export function nextText(iso: string | null | undefined, now: number): string | null {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const days = Math.round((startOfDay(at) - startOfDay(new Date(now))) / 86_400_000);
  if (days <= 0) return clockOf(at);
  if (days === 1) return `tomorrow ${clockOf(at)}`;
  if (days < 7) return `${WEEKDAYS[at.getDay()]} ${clockOf(at)}`;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clockOf(at)}`;
}

/** A past time for the history: "13:00" today, "Fri 08:00" within the week, else "10-12 08:00". */
export function pastText(iso: string | null | undefined, now: number): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '—';
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return clockOf(at);
  if (days < 7) return `${WEEKDAYS[at.getDay()]} ${clockOf(at)}`;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clockOf(at)}`;
}

/** A duration: "41 s", "3 min", "1 h 5 min". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An interval of minutes in words: "Every 30 minutes", "Every hour", "Every 2 hours", "Every day". */
export function everyText(minutes: number): string {
  if (minutes === 1) return 'Every minute';
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/**
 * A cron expression in plain words, from `cronLabel`'s short form: "Every hour",
 * "Every 4 hours", "Every day at 02:00", "Weekdays at 08:00", "Mon at 07:00",
 * "Monthly on the 1st at 09:00"; an expression it cannot describe stays as it is.
 */
export function cronText(cron: string): string {
  const label = cronLabel(cron);
  let match: RegExpMatchArray | null;
  if (label === 'every minute') return 'Every minute';
  if (label === 'hourly') return 'Every hour';
  if ((match = label.match(/^hourly at (:\d\d)$/))) return `Every hour at ${match[1]}`;
  if ((match = label.match(/^every (\d+) min$/))) return everyText(Number(match[1]));
  if ((match = label.match(/^every (\d+)h$/))) return everyText(Number(match[1]) * 60);
  if ((match = label.match(/^every (\d+)h at (:\d\d)$/))) return `Every ${match[1]} hours at ${match[2]}`;
  if ((match = label.match(/^(.+) on the (\w+) monthly$/))) return `Monthly on the ${match[2]} at ${match[1]}`;
  if ((match = label.match(/^([\d:, ]+) daily$/))) return `Every day at ${match[1]}`;
  if ((match = label.match(/^([\d:, ]+) (weekdays|weekends)$/))) return `${capital(match[2] ?? '')} at ${match[1]}`;
  if ((match = label.match(/^([A-Z][a-z]{2}(?:, [A-Z][a-z]{2})*) ([\d:, ]+)$/))) return `${match[1]} at ${match[2]}`;
  return `On schedule ${label}`;
}

/** An owned loop's schedule in plain words. */
export function loopScheduleText(schedule: OwnedLoopSchedule, now: number): string {
  if (schedule.kind === 'every') return everyText(schedule.minutes);
  if (schedule.kind === 'cron') return cronText(schedule.cron);
  return `Once, at ${nextText(schedule.at, now) ?? schedule.at}`;
}

/** "last 5 runs passed", "last run failed at 08:00", "no runs yet" (skipped and running runs are passed over). */
export function lastRunsText(runs: readonly ScheduleRun[], now: number): string {
  const done = runs.filter((run) => run.result !== 'running' && run.result !== 'skipped');
  const last = done[done.length - 1];
  if (!last) return runs.some((run) => run.result === 'skipped') ? 'last run skipped' : 'no runs yet';
  if (last.result === 'fail') return `last run failed at ${pastText(last.finishedAt ?? last.ts, now)}`;
  if (last.result === 'need') return 'last run is waiting for you';
  let passed = 0;
  for (let i = done.length - 1; i >= 0 && done[i]?.result === 'ok'; i--) passed += 1;
  return passed === 1 ? 'last run passed' : `last ${passed} runs passed`;
}

/** One schedule run as a history line. */
export function scheduleRunLine(run: ScheduleRun, now: number): RoutineHistoryLine {
  const summary = run.summary?.trim() || null;
  const byYou = run.triggeredBy === 'manual' ? ' (run by you)' : '';
  const time = pastText(run.ts, now);
  switch (run.result) {
    case 'ok': {
      const took = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.ts) : Number.NaN;
      return { time, tone: 'ok', text: `${Number.isFinite(took) ? `passed in ${durationText(took)}` : 'passed'}${byYou}` };
    }
    case 'fail':
      return { time, tone: 'fail', text: `failed${summary ? ` — ${summary}` : ''}${byYou}` };
    case 'need':
      return { time, tone: 'need', text: `waiting for you${summary ? ` — ${summary}` : ''}` };
    case 'running':
      return { time, tone: 'run', text: `running now…${byYou}` };
    default:
      return { time, tone: 'skip', text: `skipped — ${summary ?? 'the last run was still going or waiting for you'}` };
  }
}

/** An owned loop's history: Switchboard keeps its counts, not each run, so the last firing and the last skip. */
export function loopHistory(loop: OwnedLoop, now: number): RoutineHistoryLine[] {
  const lines: RoutineHistoryLine[] = [];
  if (loop.lastError) lines.push({ time: pastText(loop.updatedAt, now), tone: 'skip', text: `skipped — ${loop.lastError}` });
  if (loop.lastFiredAt) lines.push({ time: pastText(loop.lastFiredAt, now), tone: 'ok', text: `sent to its agent (run ${loop.runs})` });
  return lines;
}

const ITERATION_TONE: Readonly<Record<LoopIterationResult, RoutineHistoryLine['tone']>> = { ok: 'ok', fail: 'fail', run: 'run', need: 'need', none: 'skip' };
const ITERATION_WORD: Readonly<Record<LoopIterationResult, string>> = { ok: 'passed', fail: 'failed', run: 'running now…', need: 'waiting for you', none: 'no result' };

/** A CLI loop's history: its observed iterations, newest first. */
export function cliHistory(loop: Loop, now: number): RoutineHistoryLine[] {
  return [...loop.iterations]
    .reverse()
    .slice(0, HISTORY_LINES)
    .map((it) => ({ time: pastText(it.ts, now), tone: ITERATION_TONE[it.result], text: it.label?.trim() ? `${ITERATION_WORD[it.result]} — ${it.label.trim()}` : ITERATION_WORD[it.result] }));
}

function runsWords(loop: Pick<OwnedLoop, 'runs' | 'maxRuns' | 'skipped'>): string {
  const runs = loop.maxRuns !== null ? `run ${loop.runs} of ${loop.maxRuns}` : loop.runs === 0 ? 'no runs yet' : loop.runs === 1 ? '1 run so far' : `${loop.runs} runs so far`;
  return loop.skipped > 0 ? `${runs} (${loop.skipped} skipped)` : runs;
}

function join(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** The actions of a routine on a computer that is offline: all disabled with its reason. */
function allBlocked(reason: string): RoutineActions {
  return { pause: no(reason), run: no(reason), edit: no(reason), cancel: no(reason) };
}

/** A Switchboard loop (D94) as a routine. */
export function loopRoutine(session: SessionListItem, loop: OwnedLoop, now: number): RoutineModel {
  const machine = session.machine ?? null;
  const blocked = offlineReason(machine);
  const closed = session.closedAt != null;
  const ended = loop.state === 'ended';
  const paused = loop.state === 'paused';
  const scheduleText = loopScheduleText(loop.schedule, now);
  const next = loop.state === 'active' ? nextText(loop.nextFireAt, now) : null;
  const status: V2Status = ended ? 'done' : paused ? 'paused' : 'idle';
  const statusLabel = ended ? ROUTINES_WORDS.ended : paused ? ROUTINES_WORDS.paused : ROUTINES_WORDS.onSchedule;
  const ending = ended ? `ended: ${loop.endedReason ?? 'cancelled'}` : null;
  let actions: RoutineActions;
  if (ended) {
    const reason = `It has ended (${loop.endedReason ?? 'cancelled'}).`;
    actions = allBlocked(reason);
  } else if (blocked) {
    actions = allBlocked(blocked);
  } else if (closed) {
    actions = { pause: no(ROUTINES_WORDS.agentClosed), run: no(ROUTINES_WORDS.agentClosed), edit: no(ROUTINES_WORDS.agentClosed), cancel: OK };
  } else {
    actions = { pause: OK, run: OK, edit: OK, cancel: OK };
  }
  const name = displayTitle(session);
  return {
    key: `loop:${session.id}:${loop.id}`,
    source: 'loop',
    id: loop.id,
    name: loop.title,
    what: firstLine(loop.prompt),
    scheduleText,
    summary: join([scheduleText, paused ? 'paused' : next ? `next run ${next}` : null, ending, runsWords(loop)]),
    status,
    statusLabel,
    paused,
    ended,
    agent: { id: session.id, name, label: ROUTINES_WORDS.belongsTo },
    terminalName: null,
    machine,
    blocked,
    history: loopHistory(loop, now),
    actions,
    createdAt: loop.createdAt,
    loop,
  };
}

/** A scheduled run (D8) as a routine. `sessions` names the agent its last run started. */
export function scheduleRoutine(schedule: Schedule, sessions: readonly SessionListItem[], now: number): RoutineModel {
  const machine = schedule.machine ?? null;
  const blocked = offlineReason(machine);
  const running = schedule.running === true || schedule.runs.at(-1)?.result === 'running';
  const scheduleText = cronText(schedule.cron);
  const next = schedule.paused ? null : nextText(schedule.nextRunAt, now);
  const lastDone = [...schedule.runs].reverse().find((run) => run.result !== 'skipped' && run.result !== 'running');
  let status: V2Status = 'idle';
  let statusLabel: string = ROUTINES_WORDS.onSchedule;
  if (running) {
    status = 'working';
    statusLabel = ROUTINES_WORDS.runningNow;
  } else if (schedule.paused) {
    status = 'paused';
    statusLabel = ROUTINES_WORDS.paused;
  } else if (lastDone?.result === 'fail') {
    status = 'stopped';
    statusLabel = ROUTINES_WORDS.lastFailed;
  } else if (lastDone?.result === 'need') {
    status = 'needs';
    statusLabel = ROUTINES_WORDS.waitingForYou;
  }
  const lastSessionId = [...schedule.runs].reverse().find((run) => run.sessionId)?.sessionId ?? null;
  const lastSession = lastSessionId ? sessions.find((session) => session.id === lastSessionId) : undefined;
  const actions: RoutineActions = blocked
    ? allBlocked(blocked)
    : {
        pause: OK,
        run: running ? no(ROUTINES_WORDS.running) : OK,
        edit: OK,
        cancel: running ? no(ROUTINES_WORDS.waitForRun) : OK,
      };
  return {
    key: `schedule:${schedule.id}`,
    source: 'schedule',
    id: schedule.id,
    name: schedule.name,
    what: firstLine(schedule.description),
    scheduleText,
    summary: join([scheduleText, schedule.paused ? 'paused' : next ? `next run ${next}` : null, running ? 'running now' : lastRunsText(schedule.runs, now)]),
    status,
    statusLabel,
    paused: schedule.paused,
    ended: false,
    agent: lastSessionId ? { id: lastSessionId, name: lastSession ? displayTitle(lastSession) : 'its agent', label: ROUTINES_WORDS.lastRunAgent } : null,
    terminalName: null,
    machine,
    blocked,
    history: [...schedule.runs].reverse().slice(0, HISTORY_LINES).map((run) => scheduleRunLine(run, now)),
    actions,
    createdAt: schedule.runs[0]?.ts ?? '',
    schedule,
  };
}

function cliStatus(loop: Loop): { status: V2Status; label: string } {
  const last = loop.iterations.at(-1)?.result;
  if (last === 'run') return { status: 'working', label: ROUTINES_WORDS.runningNow };
  if (last === 'need') return { status: 'needs', label: ROUTINES_WORDS.waitingForYou };
  if (last === 'fail') return { status: 'stopped', label: ROUTINES_WORDS.lastFailed };
  return { status: 'idle', label: ROUTINES_WORDS.onSchedule };
}

function cliSummary(loop: Loop, now: number): { scheduleText: string; summary: string } {
  const scheduleText = loop.label?.trim() || loop.kind;
  const next = nextText(loop.nextFireAt, now);
  const iteration = loop.iteration === null ? null : loop.cap !== null ? `run ${loop.iteration} of ${loop.cap}` : `run ${loop.iteration}`;
  return { scheduleText, summary: join([scheduleText, next ? `next run ${next}` : null, iteration]) };
}

const CLI_ACTIONS: RoutineActions = allBlocked(ROUTINES_WORDS.cliManaged);

/** A loop the AI engine runs itself in a Switchboard agent (D9) as a watched routine. */
export function cliRoutine(session: SessionListItem, loop: Loop, now: number): RoutineModel {
  const { scheduleText, summary } = cliSummary(loop, now);
  const { status, label } = cliStatus(loop);
  const machine = session.machine ?? null;
  return {
    key: `cli:${loop.id}`,
    source: 'cli',
    id: loop.id,
    name: loop.label?.trim() || `${loop.kind} in ${displayTitle(session)}`,
    what: loop.note?.trim() || ROUTINES_WORDS.cliManaged,
    scheduleText,
    summary,
    status,
    statusLabel: label,
    paused: false,
    ended: false,
    agent: { id: session.id, name: displayTitle(session), label: ROUTINES_WORDS.belongsTo },
    terminalName: null,
    machine,
    blocked: offlineReason(machine),
    history: cliHistory(loop, now),
    actions: CLI_ACTIONS,
    createdAt: loop.createdAt,
  };
}

function baseName(folder: string | null): string {
  return (folder ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

/** A loop of a terminal session Switchboard does not follow (D52) as a watched routine. */
export function terminalRoutine(entry: TerminalLoop, now: number): RoutineModel {
  const loop = entry.loop;
  const { scheduleText, summary } = cliSummary(loop, now);
  const { status, label } = cliStatus(loop);
  const terminalName = entry.terminal.name?.trim() || `${ROUTINES_WORDS.terminal} · ${baseName(entry.terminal.cwd) || 'session'}`;
  const machine = entry.machine ?? null;
  return {
    key: `cli:${loop.id}`,
    source: 'cli',
    id: loop.id,
    name: loop.label?.trim() || `${loop.kind} in ${terminalName}`,
    what: loop.note?.trim() || ROUTINES_WORDS.cliManaged,
    scheduleText,
    summary,
    status,
    statusLabel: label,
    paused: false,
    ended: false,
    agent: null,
    terminalName,
    machine,
    blocked: offlineReason(machine),
    history: cliHistory(loop, now),
    actions: CLI_ACTIONS,
    createdAt: loop.createdAt,
  };
}

/** What the page lists. */
export interface RoutineLists {
  readonly active: readonly RoutineModel[];
  readonly ended: readonly RoutineModel[];
}

/**
 * Every routine: Switchboard loops and scheduled runs first (they can be
 * controlled), then the watched CLI loops; oldest first within each. Ended
 * Switchboard loops are listed apart.
 */
export function routineLists(input: { readonly sessions: readonly SessionListItem[]; readonly schedules: readonly Schedule[]; readonly terminalLoops: readonly TerminalLoop[] }, now: number = Date.now()): RoutineLists {
  const owned: RoutineModel[] = [];
  const ended: RoutineModel[] = [];
  const cli: RoutineModel[] = [];
  const at = new Date(now);
  for (const session of input.sessions) {
    for (const loop of session.ownedLoops ?? []) {
      const routine = loopRoutine(session, loop, now);
      (routine.ended ? ended : owned).push(routine);
    }
    for (const loop of session.loops ?? []) {
      if (loopShown(loop, at)) cli.push(cliRoutine(session, loop, now));
    }
  }
  for (const entry of input.terminalLoops) {
    if (loopShown(entry.loop, at)) cli.push(terminalRoutine(entry, now));
  }
  const schedules = input.schedules.map((schedule) => scheduleRoutine(schedule, input.sessions, now));
  const byCreated = (a: RoutineModel, b: RoutineModel): number => a.createdAt.localeCompare(b.createdAt);
  return {
    active: [...owned.sort(byCreated), ...schedules, ...cli.sort(byCreated)],
    ended: ended.sort((a, b) => (b.loop?.updatedAt ?? '').localeCompare(a.loop?.updatedAt ?? '')),
  };
}

/** "3 routines". */
export function routineCountText(count: number): string {
  return count === 1 ? ROUTINES_WORDS.countOne : ROUTINES_WORDS.count.replace('{n}', String(count));
}

// ── Edit ────────────────────────────────────────────────────────────────

/** A scheduled run's Edit form: how often (cron) and what it does (the prompt each run starts with). */
export interface ScheduleDraft {
  readonly cron: string;
  readonly what: string;
}

/** The form as a schedule opens it. */
export function scheduleDraft(schedule: Pick<Schedule, 'cron' | 'template' | 'description'>): ScheduleDraft {
  const template = schedule.template !== null && typeof schedule.template === 'object' ? (schedule.template as { readonly task?: unknown }) : {};
  return { cron: schedule.cron, what: typeof template.task === 'string' ? template.task : schedule.description };
}

/** The `POST /api/schedules` body that replaces the schedule's cron and prompt (its other settings kept), or the problem in words. */
export function scheduleEditBody(schedule: Pick<Schedule, 'id' | 'template'>, draft: ScheduleDraft): { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly error: string } {
  const what = draft.what.trim();
  if (what === '') return { ok: false, error: 'Write what it should do each time.' };
  const parsed = parseCron(draft.cron.trim());
  if (!parsed.ok) return { ok: false, error: `How often: ${parsed.error}` };
  const cron = parsed.cron.expression;
  const template = schedule.template !== null && typeof schedule.template === 'object' ? schedule.template : {};
  return { ok: true, body: { id: schedule.id, cron, template: { ...template, task: what } } };
}
