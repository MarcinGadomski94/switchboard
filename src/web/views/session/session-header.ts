import type { AttachWarningReason, Session, SessionModel, SessionModelInput } from '../../../core/api.ts';
import { CLI_EFFORT_LEVELS, DEFAULT_MODEL_VALUE, effortLevelsFor, modelOptionFor, normalizeModel } from '../../../core/model-choice.ts';
import { folderName, samePath } from '../../folders/folders.ts';

/** A session tab (the router's `SessionTab`, restated so this module has no JSX import). */
export type HeaderTab = 'chat' | 'timeline' | 'diff' | 'artifacts';

/**
 * Copy and rules of the session header (M4.1, SPEC → Session; prototype `ss`,
 * `pauseLabel`, `attachLabel`, `tabs`, `handoff`). Pure, so `tests/web` can check
 * them without a browser.
 */

/** "⇄ Continue in terminal" while attached, "⇄ Attach here" while a terminal owns the session (prototype `attachLabel`). */
export const CONTINUE_IN_TERMINAL = '⇄ Continue in terminal';
export const ATTACH_HERE = '⇄ Attach here';

/** The session's folder facts the root line reads (D14). */
export type SessionPlace = Pick<Session, 'cwd' | 'folderPath' | 'folderKind'>;

/**
 * What the session's working folder is (D14): `workspace root` for a workspace
 * folder (the prototype's words: the router applies there), `git repo` for a repo
 * session in the repo, `worktree of <repo>` for one in its worktree.
 */
export function placeLabel(session: SessionPlace): string {
  if (session.folderKind !== 'repo') return 'workspace root';
  const repo = session.folderPath ? folderName(session.folderPath) : null;
  if (session.cwd && session.folderPath && !samePath(session.cwd, session.folderPath)) return repo ? `worktree of ${repo}` : 'worktree';
  return 'git repo';
}

/**
 * The root path line: `<cwd> · workspace root` (prototype `D:\acme ·
 * workspace root`), and for a repo folder (D14) `<cwd> · git repo` or `<cwd> ·
 * worktree of <repo>`.
 */
export function rootLine(session: SessionPlace): string {
  const label = placeLabel(session);
  return session.cwd ? `${session.cwd} · ${label}` : label;
}

/** What the Pause / Resume button does for the session. */
export interface PauseButton {
  readonly action: 'pause' | 'resume';
  readonly label: 'Pause' | 'Resume';
  /** Resume is refused while a terminal owns the session (409 `detached`): Attach here first. */
  readonly disabled: boolean;
}

/**
 * Pause while the session has a live process, or while its stored status still
 * says it runs or waits (`run` / `need`); Resume otherwise (paused, ended, failed:
 * D7 `--resume` + "Continue."). Disabled while detached.
 */
export function pauseButton(session: Pick<Session, 'live' | 'status' | 'attached'>): PauseButton {
  const running = session.live || session.status === 'run' || session.status === 'need';
  if (running) return { action: 'pause', label: 'Pause', disabled: !session.attached };
  return { action: 'resume', label: 'Resume', disabled: !session.attached };
}

/** One header tab (prototype `TABS`: `Chat`, `Timeline`, `Diff · n`, `Artifacts · n`). */
export interface TabLabel {
  readonly tab: HeaderTab;
  readonly label: string;
}

/**
 * The tabs with their counts: changed files (gap #10) and the session's artifacts
 * (gap #9). D45 (developer ruling): a count is `null` while the session's detail
 * loads, and its tab reads just `Diff` / `Artifacts` until it is there.
 */
export function tabLabels(files: number | null, artifacts: number | null): TabLabel[] {
  return [
    { tab: 'chat', label: 'Chat' },
    { tab: 'timeline', label: 'Timeline' },
    { tab: 'diff', label: files === null ? 'Diff' : `Diff · ${files}` },
    { tab: 'artifacts', label: artifacts === null ? 'Artifacts' : `Artifacts · ${artifacts}` },
  ];
}

/** The handoff card (prototype `handoff`): state, its color and the explanation, verbatim. */
export interface Handoff {
  readonly state: 'attached' | 'in terminal';
  /** A SPEC status token (`done` attached, `need` in a terminal). */
  readonly status: 'done' | 'need';
  readonly text: string;
}

export function handoff(attached: boolean): Handoff {
  return attached
    ? {
        state: 'attached',
        status: 'done',
        text: 'Running in the background and attached here. Detach to continue in a terminal. The conversation stays in sync both ways.',
      }
    : {
        state: 'in terminal',
        status: 'need',
        text: 'Detached. Continue in any terminal with the command below. Switchboard keeps showing notifications and syncs back when you attach.',
      };
}

/** Seconds / minutes since `iso` (`12 s`, `1 min`), for the warning. */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return 'moments';
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/**
 * The Attach warning (gap #5, M0.4): why a terminal may still hold the session,
 * then what attaching now does. The prototype has no warning; the copy follows
 * the SPEC copy rules (plain, factual, sentence case).
 */
export function attachWarningText(reasons: readonly AttachWarningReason[], now: number = Date.now()): string {
  const why = reasons.map((reason) => {
    switch (reason.kind) {
      case 'transcript-recent':
        return `The transcript changed ${ago(reason.modifiedAt, now)} ago.`;
      case 'terminal-live':
        return `A claude process (pid ${reason.pid}) has this session open.`;
      case 'liveness-unknown':
        return 'Switchboard could not check whether a terminal still has this session open.';
    }
  });
  return [...why, 'Attaching while a terminal still has the session open forks the conversation. Close it there first, or attach anyway.'].join(' ');
}

/** Attach warning buttons. */
export const ATTACH_ANYWAY = 'Attach anyway';
export const CANCEL = 'Cancel';

/** D24: the Remote toggle's label. */
export const REMOTE_LABEL = 'Remote';

/** D24: the button that opens the link and QR popover while Remote is on. */
export const REMOTE_LINK_LABEL = 'Link & QR';

/** D24: the popover's note, verbatim from the ruling. */
export const REMOTE_NOTE = "While Remote is on, the transcript is stored on Anthropic's servers.";

/** What the header's Remote toggle shows (D24, `docs/remote-control.md`). */
export interface RemoteToggle {
  /** Remote is on for the session (a paused session stays on and reconnects on resume). */
  readonly on: boolean;
  /** Off-limits right now; {@link reason} says why (the tooltip). */
  readonly disabled: boolean;
  /** Why the toggle is disabled, `null` while it can be clicked. */
  readonly reason: string | null;
  /** The tooltip: the reason, else what a click does. */
  readonly title: string;
  /** The claude.ai link of the bridge while Remote is on, else `null`. */
  readonly url: string | null;
}

/**
 * The Remote toggle for `session` (D24), or `null` when the session has no Remote
 * state (`remote: null`: a session Switchboard never ran a process for, i.e. the
 * demo's; no toggle). It is enabled only while the session has a live process
 * whose `initialize` reported Remote Control available; otherwise it is disabled
 * with the reason as its tooltip. Remote stays on while paused (the next process
 * reconnects), so a paused session can show it on and disabled.
 */
export function remoteToggle(session: Pick<Session, 'remote' | 'live' | 'attached'>): RemoteToggle | null {
  const remote = session.remote;
  if (!remote) return null;
  const on = remote.enabled;
  const url = on ? remote.url : null;
  let reason: string | null = null;
  if (!session.attached) reason = 'The session continues in a terminal: attach it here first.';
  else if (!session.live) {
    reason = on
      ? 'Remote is on and reconnects when the session resumes: it needs a running claude process.'
      : 'Remote needs a running claude process: resume the session first.';
  } else if (!remote.available) {
    reason = "Remote Control is not available here: claude's initialize did not report remote_control_available (it needs a claude.ai subscription login).";
  }
  const title = reason ?? (on ? 'Turn Remote Control off' : 'Reachable from phone: turn Remote Control on (claude.ai and the Claude app)');
  return { on, disabled: reason !== null, reason, title, url };
}

/** A refused header action, in words (the server's `message` when it has one). */
export function actionErrorText(status: number, body: unknown): string {
  const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : null;
  if (status === 0) return 'Switchboard is not reachable.';
  return message ?? `The request failed (HTTP ${status}).`;
}

/** D31: the popover's section labels and notes. */
export const MODEL_SECTION = 'Model';
export const EFFORT_SECTION = 'Effort';
/** D31: the effort item that goes back to the CLI's default (`effort: null`). */
export const DEFAULT_EFFORT_LABEL = 'Default';
/** D31: why the picker is disabled while no claude process of the session has listed its models. */
export const MODELS_UNKNOWN_REASON = 'No claude process of this session has reported its models yet: the model and effort pickers work once it runs.';
/** D31: when a change applies (the popover's note and the trigger's tooltip). */
export const MODEL_APPLIES_LIVE = 'A change applies to the running claude process from its next turn.';
export const MODEL_APPLIES_LATER = 'A change applies when the session runs again (--model / --effort).';

/** D31: one model in the picker. */
export interface ModelPickerItem {
  /** What the route takes (`default` = the CLI's default model). */
  readonly value: string;
  readonly label: string;
  /** The CLI's description, `null` without one. */
  readonly description: string | null;
  readonly selected: boolean;
}

/** D31: one effort level in the picker (`value: null` = the CLI's default). */
export interface EffortPickerItem {
  readonly value: string | null;
  readonly label: string;
  readonly selected: boolean;
}

/** D31: what the header's model and effort picker shows (`docs/model-effort.md` → *UI*). */
export interface ModelPicker {
  /** The trigger's text: the chosen model's short label, plus ` · <effort>` when an effort is chosen (`Opus 5.5 · high`). */
  readonly label: string;
  /** Disabled while the choices are unknown; {@link reason} says why (the tooltip). */
  readonly disabled: boolean;
  readonly reason: string | null;
  /** The tooltip: the reason, else when a change applies. */
  readonly title: string;
  /** The models the session's claude process offers, in the CLI's order (plus a stored one it does not list). */
  readonly models: readonly ModelPickerItem[];
  /** The chosen model's effort levels after a Default item; `null` when the model has none (the effort picker hides). */
  readonly efforts: readonly EffortPickerItem[] | null;
  /** Where the popover's note says a change applies. */
  readonly note: string;
}

/** A model's label without a trailing parenthetical (`Default (recommended)` → `Default`), for the compact trigger. */
export function shortModelLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label;
}

/**
 * The header's model and effort picker for `session` (D31), or `null` when the
 * session has no model information (`model: null`: the demo's; no picker). While
 * no process has reported its models (`available: null`) it shows the stored
 * choice, disabled with {@link MODELS_UNKNOWN_REASON}. The effort items are the
 * chosen model's levels (the CLI's `--effort` choices when the model is not in
 * the list); `null` when the model has none, so the effort picker hides.
 */
export function modelPicker(session: Pick<Session, 'model' | 'live'>): ModelPicker | null {
  const model = session.model;
  if (!model) return null;
  return modelChoicePicker(model, session.live ? MODEL_APPLIES_LIVE : MODEL_APPLIES_LATER);
}

/**
 * The picker for a model choice and the models on offer (D31's header picker;
 * D42: the New-session form's Model row too), with `note` saying when a choice
 * applies. See {@link modelPicker} for the rules.
 */
export function modelChoicePicker(model: SessionModel, note: string): ModelPicker {
  const { current, effort, available } = model;
  const option = modelOptionFor(available, current);
  const name = option ? shortModelLabel(option.label) : current === null ? 'Default' : current;
  const levels = available === null ? null : (effortLevelsFor(available, current) ?? CLI_EFFORT_LEVELS);
  const efforts =
    levels === null || levels.length === 0
      ? null
      : [{ value: null, label: DEFAULT_EFFORT_LABEL, selected: effort === null }, ...levels.map((level) => ({ value: level, label: level, selected: level === effort }))];
  const shownEffort = effort !== null && (available === null || (efforts !== null && efforts.some((item) => item.value === effort))) ? effort : null;
  const selectedValue = current ?? DEFAULT_MODEL_VALUE;
  const models: ModelPickerItem[] = (available ?? []).map((item) => ({
    value: item.value,
    label: item.label,
    description: item.description ?? null,
    selected: item.value === selectedValue,
  }));
  if (available !== null && current !== null && !option) models.push({ value: current, label: current, description: null, selected: true });
  const reason = available === null ? MODELS_UNKNOWN_REASON : null;
  return {
    label: shownEffort === null ? name : `${name} · ${shownEffort}`,
    disabled: reason !== null,
    reason,
    title: reason ?? `Model and effort. ${note}`,
    models,
    efforts,
    note,
  };
}

/**
 * The body of `PUT /api/sessions/{id}/model` for a model picked in the list: the
 * model, and the stored effort when the new model supports it, else `null` (the
 * CLI's default; the server refuses an effort the model does not list). `null`
 * when the model is the one already chosen (nothing to send).
 */
export function modelPickBody(model: NonNullable<Session['model']>, value: string): SessionModelInput | null {
  const next = normalizeModel(value);
  if (next === model.current) return null;
  const levels = effortLevelsFor(model.available, next) ?? CLI_EFFORT_LEVELS;
  const keep = model.effort !== null && levels.includes(model.effort);
  return { model: value, effort: keep ? model.effort : null };
}

/** The body for an effort picked in the list (`null` = the CLI's default); `null` when it is the one already chosen. */
export function effortPickBody(model: NonNullable<Session['model']>, value: string | null): SessionModelInput | null {
  return value === model.effort ? null : { effort: value };
}

/**
 * D48 P4: the note of a hooked terminal session (`docs/peers.md` → *Hooked
 * terminal sessions*): what works from here, and what stays in the terminal.
 */
export const HOOKED_NOTE =
  'Hooked terminal session: your messages reach it at its next step, or wake it when idle; interrupt, / commands, model changes and pause stay in the terminal (hooks cannot do them).';
