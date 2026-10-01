import { type MouseEvent, useEffect, useId, useState } from 'react';
import type { Folder, HistoryItem, ModelSettings, NewSessionPrefill, Schedule, SolutionGroup } from '../../core/api.ts';
import { DEFAULT_MODEL_CHOICE } from '../../core/model-choice.ts';
import { machineTagSuffix } from '../../core/peers.ts';
import type { NewSessionMode } from '../../core/settings.ts';
import { formatHistoryDate } from '../../core/history.ts';
import { TICKET_BRANCH_EXAMPLE, tidyTicketBranch } from '../../core/ticket-branch.ts';
import { ApiError, api, machineApi } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { AddFolderPanel } from '../folders/AddFolderPanel.tsx';
import { defaultFolder, folderById, folderCheckLine } from '../folders/folders.ts';
import { useSavedFolders } from '../folders/useFolders.ts';
import { useRouter } from '../router.tsx';
import { CONTINUE_ANYWAY, addFolderLabel, movesSettled, needsFolderText, moveWarningText, terminalConversations } from '../views/history-move.ts';
import { ModelChoicePicker } from '../views/session/ModelPicker.tsx';
import { CliPicker } from '../components/CliPicker.tsx';
import { effectiveCli } from '../components/cli.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import { useConversationMoves } from '../views/useConversationMoves.ts';
import {
  COORDINATION_OPTIONS,
  type FormFolder,
  MODEL_ROW_DESCRIPTION,
  MODEL_ROW_TITLE,
  MODE_OPTIONS,
  NO_MODEL_SETTINGS,
  type NewSessionForm,
  PHASE_OPTIONS,
  type PillOption,
  RECOMMENDED,
  STACK_OPTIONS,
  WORK_TYPE_OPTIONS,
  branchCheck,
  canStart,
  chipGroups,
  folderChoices,
  formBranch,
  formFromPrefill,
  formModel,
  formModelOptions,
  formModelPicker,
  PLAIN_FOLDER_FULL_NOTE,
  PLAIN_FOLDER_SCHEDULE_NOTE,
  isPlainFolder,
  isRepoFolder,
  pickFormEffort,
  pickFormModel,
  resolveFormFolder,
  sanitizeName,
  showsBranch,
  showsCoordination,
  showsQa,
  solutionsHint,
  startErrorText,
  startNames,
  summaryLines,
  toStartBody,
  toggleSolution,
  withFormModel,
  workspaceRoot,
  worktreeFolder,
} from './new-session.ts';
import {
  RESUME_TERMINAL_CONVERSATION,
  type ResumePick,
  canStartResume,
  resumeEntryMeta,
  resumeNamePreview,
  resumePickOf,
  resumeSummaryLines,
} from './resume-conversation.ts';
import {
  FROM_REMOTE_SESSION,
  NO_REPO_FOLDER_HINT,
  REMOTE_LAUNCH_NOTE,
  REMOTE_PLACEHOLDER,
  REMOTE_TASK_PLACEHOLDER,
  REPO_FOLDERS_HINT,
  canStartRemote,
  remoteFormFolder,
  remoteNames,
  remoteSummaryLines,
  repoFolders,
  toTeleportBody,
} from './remote-session.ts';
import { ScheduleSection } from './ScheduleSection.tsx';
import { BranchingSection, useBranchingPreflight } from './BranchingSection.tsx';
import { type BranchingForm, branchingBlocks, branchingFromPrefill, formParent, preflightRequest, toBranching, withBranchingLines } from './branching-form.ts';
import { type ScheduleDraft, canSaveSchedule, cronPreview, deleteErrorText, saveErrorText, scheduleMachine, scheduleSummaryLines, toScheduleInput } from './schedule-form.ts';
import { ModeToggle, SimpleSessionForm } from './SimpleSessionForm.tsx';
import { AttachButton, AttachmentChips, pasteFiles, useAttachmentDraft, useFileDrop } from '../components/Attachments.tsx';
import { attachmentsBlocker } from '../components/attachments.ts';
import { offersModeToggle, openingMode, toSimpleBody } from './simple-session.ts';
import './new-session.css';

/** `sessionUpdated` comes in bursts; the name check's session list reloads at most this often. */
const SESSIONS_RELOAD_MS = 1_000;

/** The message of a failed `GET /api/solutions` (as in the Solutions view). */
function solutionsErrorText(error: ApiError): string {
  const body = error.body as { error?: unknown; message?: unknown } | null;
  if (body?.error === 'no-folder') return 'No folder is saved yet. Add a workspace or a git repository with Browse… above.';
  if (typeof body?.message === 'string') return body.message;
  return error.unreachable ? 'Switchboard is not reachable.' : `The solutions could not be loaded (HTTP ${error.status}).`;
}

function Pills<T extends string>({
  group,
  label,
  options,
  value,
  onPick,
}: {
  readonly group: string;
  readonly label: string;
  readonly options: ReadonlyArray<PillOption<T>>;
  readonly value: T | null;
  readonly onPick: (value: T) => void;
}) {
  return (
    <div className="sb-ns-pills" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          className="sb-button sb-ns-pill"
          data-testid="ns-pill"
          data-group={group}
          data-value={option}
          data-selected={value === option ? 'true' : 'false'}
          onClick={() => onPick(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Toggle({ name, title, description, on, onToggle }: { readonly name: string; readonly title: string; readonly description: string; readonly on: boolean; readonly onToggle: () => void }) {
  return (
    <div className="sb-ns-toggle-row">
      <div className="sb-ns-toggle-text">
        <div className="sb-ns-toggle-title">{title}</div>
        <div className="sb-ns-toggle-desc">{description}</div>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={title} className="sb-button sb-ns-switch" data-testid={`ns-switch-${name}`} data-on={on ? 'true' : 'false'} onClick={onToggle}>
        <span className="sb-ns-knob" />
      </button>
    </div>
  );
}

/**
 * New-session modal (M5.1, SPEC → Modals → New session; prototype `mNew`): 1080px,
 * `1fr | 360px`. Left: sections 1–6 (task first; work type, mode, solutions from
 * the workspace scan with read-only folders locked, phase, then mobile
 * coordination for a single-solution feature session with a `*-front`, or the QA
 * contract for test-authoring). Right: the Worktree / Ultracode toggles, the live
 * mono summary with the worktree folders (gap #1), Cancel and "Start session",
 * which posts `POST /api/sessions` and opens the new session. `prefill` (M3.3, the
 * Inbox's "Open fix session") replaces the defaults; the dialog also carries it as
 * `data-prefill` (JSON). With `schedule` (M7.1, D8: "+ New scheduled run", or a
 * schedule's Edit with its id + cron) it adds section 7 · Schedule and "Save
 * schedule" posts `POST /api/schedules` instead (`docs/schedules.md`). D14: the
 * Folder row at the top (the saved folders, Browse… to add one, the check line);
 * the chips are the chosen folder's scan, and a repo folder keeps only Task,
 * Worktree and Ultracode with the repo as its one locked solution. D16: **Resume
 * a terminal conversation** (next to the task) lists the folder's terminal
 * conversations not in Switchboard yet; picking one replaces the task, hides the
 * router sections and the toggles (a moved session has neither), and Start moves
 * it (`POST /api/history/{id}/continue`) instead of posting a new session. D25:
 * **From a remote session** (on the Folder label line) replaces the task with a
 * claude.ai/code URL or id field, offers only git repo folders, hides the router
 * sections and the toggles, and Start posts `POST /api/sessions/teleport`. D22:
 * the name field takes free text as the session's title; the summary's worktree
 * lines show the short name derived from it, and Start posts both
 * (`startNames` in new-session.ts). D32: while Start will create a worktree, a
 * **Branch** row under the name names its branch after the ticket (pre-filled
 * from a title that starts with a ticket key, tidied on blur, its check under
 * it; Start waits for a valid one). D38: picking solutions is optional for a
 * workspace folder (the hint says to leave them empty to let the agent choose,
 * the summary reads `solutions  chosen by the agent`). D42: a **Model** row
 * under the Launch toggles (D31's picker over `GET /api/models`' list, else the
 * CLI's aliases) starts on the last choice; the summary's `model` line follows
 * `ultracode`, and Start / Save schedule send `model` / `effort`. Details:
 * `docs/new-session.md`, `docs/folders.md` → *UI*.
 */
export function NewSessionModal({
  onClose,
  prefill = null,
  schedule = null,
  machine: initialMachine = null,
}: {
  readonly onClose: () => void;
  readonly prefill?: NewSessionPrefill | null;
  readonly schedule?: ScheduleDraft | null;
  /** D52: the machine the form starts on (a paired machine's id; `null` = this one). */
  readonly machine?: string | null;
}) {
  const { navigate } = useRouter();
  const scheduling = schedule !== null;
  // D56: Simple / Full. A schedule and a prefill open Full; else the remembered mode (`newSession.mode`, Simple on a fresh install).
  const remembered = useApi(() => (scheduling || prefill ? Promise.resolve(null) : api.settings().catch(() => null)), []);
  const [pickedMode, setPickedMode] = useState<NewSessionMode | null>(null);
  const mode: NewSessionMode | null = pickedMode ?? (scheduling || prefill ? 'full' : remembered.loading ? null : openingMode({ scheduling, prefill }, remembered.data));
  const simple = mode === 'simple' && !scheduling;
  // D56: the simple form's worktree branch as edited (`null` = derived from the title); kept apart from D32's Branch field.
  const [simpleBranch, setSimpleBranch] = useState<string | null>(null);
  // D57: the first message's attachments; uploaded at Start to the chosen machine (`POST /api/attachments`).
  const attach = useAttachmentDraft();
  const drop = useFileDrop(attach.add);
  // D48 (P3, docs/peers.md): the machine the session starts on; `null` = this one.
  // D52: a schedule too (it is saved and runs there); a peer's schedule's Edit stays on its machine (its remote id names it).
  const lockedMachine = scheduleMachine(schedule);
  const machines = useApi(() => api.machines().catch(() => null), []);
  const [machine, setMachine] = useState<string | null>(() => lockedMachine ?? initialMachine);
  const peer = machine;
  const localFolders = useSavedFolders();
  // A peer's saved folders (its own ids), tagged with the machine so a switch never shows the last machine's list.
  const peerFolders = useApi(
    (): Promise<{ readonly machine: string; readonly list: Folder[] } | null> => (peer ? machineApi(peer).savedFolders().then((list) => ({ machine: peer, list })) : Promise.resolve(null)),
    [peer],
  );
  const folders: { readonly data: Folder[] | null; readonly error: ApiError | null } = peer
    ? { data: peerFolders.data?.machine === peer ? peerFolders.data.list : null, error: peerFolders.error }
    : localFolders;
  // D33: closed sessions keep their short names, so the name check lists them too.
  const sessions = useApi(() => api.listSessions({ closed: 'include' }));
  useHubEvent('sessionUpdated', useThrottled(sessions.reload, SESSIONS_RELOAD_MS));

  const schedules = useApi((): Promise<Schedule[]> => (scheduling ? api.schedules() : Promise.resolve([])), [scheduling]);
  const [cron, setCron] = useState(() => schedule?.cron ?? '');

  const [form, setForm] = useState<NewSessionForm>(() => formFromPrefill(prefill));
  // D40: the Branching section's state (epic, base, per-repo choices), next to the form's.
  const [branching, setBranching] = useState<BranchingForm>(() => branchingFromPrefill(prefill));
  // D62: the machine's CLIs; the session runs on the form's pick, else the default CLI (when it can be chosen).
  const clis = useApi(() => machineApi(peer).clis().catch(() => null), [peer]);
  const provider = effectiveCli(form.provider, clis.data ?? null);
  // D42: the latest reported model list and the last choice (the Model row starts on it); a failed read = neither.
  // D62: of the chosen CLI (tagged, so a switch never shows the last CLI's list).
  const models = useApi(() => machineApi(peer).models(provider).then((settings) => ({ provider, settings })), [peer, provider]);
  const modelSettings: ModelSettings | null = models.data?.provider === provider ? models.data.settings : models.error ? NO_MODEL_SETTINGS : null;
  const modelOptions = formModelOptions(modelSettings, provider);
  // What the summary and the bodies read: the form with its model choice and its CLI filled in.
  const launch = { ...withFormModel(form, modelSettings, provider), provider };
  /** D62: another CLI: its own models, so the model choice starts over. */
  const pickProvider = (next: CliProviderId): void => update({ provider: next, model: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const update = (patch: Partial<NewSessionForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };
  // D16: a terminal conversation picked instead of a task (never while scheduling), and its move.
  const [resume, setResume] = useState<ResumePick | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const moves = useConversationMoves((id) => {
    onClose();
    navigate({ view: 'session', id, tab: 'chat' });
  });
  const resuming = resume !== null && !scheduling;
  // D25: "From a remote session": the remote field replaces the task (never while scheduling).
  const [remoteMode, setRemoteMode] = useState(false);
  const [remote, setRemote] = useState('');
  const remoting = remoteMode && !scheduling;
  const conversations = useApi((): Promise<HistoryItem[] | null> => (resumeOpen ? api.history() : Promise.resolve(null)), [resumeOpen]);
  const pickMachine = (id: string | null): void => {
    setMachine(id);
    // The folders, their scan and the conversations belong to a machine: nothing carries over.
    update({ folder: null, solutions: [] });
    setResume(null);
    setResumeOpen(false);
    setRemoteMode(false);
    setAdding(false);
    moves.close();
  };
  const peerMachines = machines.data?.machines ?? [];
  const pickFolder = (id: string): void => {
    update({ folder: id, solutions: [] });
    // The conversations belong to the folder: a pick from another folder does not carry over.
    setResume(null);
    moves.close();
  };

  // D14: once the saved folders are known, the form's folder is a saved one (its own while saved, else the default).
  // D25: from a remote session, a saved git repo folder (the first one when the form's is not).
  useEffect(() => {
    const list = folders.data;
    if (!list) return;
    setForm((current) => {
      const folder = remoting ? remoteFormFolder(current.folder, list) : resolveFormFolder(current.folder, list);
      // A folder switched for the remote option leaves no solutions of the other folder behind.
      return folder === current.folder ? current : { ...current, folder, ...(remoting ? { solutions: [] } : {}) };
    });
  }, [folders.data, remoting]);
  const folderReady = folders.data !== null || folders.error !== null;
  const anyTarget = folderById(folders.data, form.folder) ?? (form.folder ? null : defaultFolder(folders.data));
  // D25: from a remote session, only a git repo folder is a target.
  const target = remoting && anyTarget?.kind !== 'repo' ? null : anyTarget;
  const folder: FormFolder | null = target ? { id: target.id, path: target.path, name: target.name, displayName: target.displayName, kind: target.kind } : null;
  const repo = isRepoFolder(folder);
  // The chips are the chosen folder's scan (D14): read again when the folder changes, tagged with it so a switch never shows the last folder's chips.
  const scanFolder = folder?.id ?? form.folder ?? undefined;
  const solutions = useApi(
    (): Promise<{ readonly folder: string | undefined; readonly machine: string | null; readonly groups: SolutionGroup[] }> =>
      // D56: the simple form picks no solutions: nothing to scan.
      folderReady && mode === 'full' ? machineApi(peer).solutions(scanFolder).then((groups) => ({ folder: scanFolder, machine: peer, groups })) : new Promise(() => undefined),
    [scanFolder, folderReady, peer, mode],
  );
  const scan = solutions.data && solutions.data.folder === scanFolder && solutions.data.machine === peer ? solutions.data.groups : null;
  const scanError = scan === null && !solutions.loading ? solutions.error : null;

  // Short names are unique per machine (D48: a peer's sessions are listed too, with their machine).
  const takenNames = (sessions.data ?? []).filter((session) => (session.machine?.id ?? null) === peer).map((session) => session.name);
  const scanned = scan ?? (scanError ? [] : null);
  const groups = chipGroups(scanned, form.solutions);
  // D52: schedule names are unique per machine (a peer's schedules are listed too, with their machine).
  const takenScheduleNames = (schedules.data ?? []).filter((s) => s.id !== schedule?.id && (s.machine?.id ?? null) === peer).map((s) => s.name);
  const preview = cronPreview(cron, new Date());
  const lines = scheduling
    ? scheduleSummaryLines(launch, workspaceRoot(scan), preview, takenScheduleNames, folder, modelOptions)
    : remoting
      ? remoteSummaryLines(remote, folder, form.name, form.task, takenNames)
      : resume
        ? resumeSummaryLines(resume, folder, form.name, takenNames)
        : summaryLines(launch, workspaceRoot(scan), takenNames, folder, 'start', modelOptions);
  // D32: the Branch row, while Start will create a worktree on the developer's branch (not a schedule, move or teleport).
  const branchShown = showsBranch(form) && !scheduling && !resuming && !remoting && mode === 'full';
  // D40: the Branching section shows with the Branch row; its repos are the picked solutions (a repo folder: its repo).
  const branchingSolutions = repo && folder ? [folder.name] : form.solutions;
  // D47: the Parent field as it reads (typed, else the key the task text stacks on).
  const stacking: BranchingForm = { ...branching, parent: formParent(branching, form.task) };
  const preflight = useBranchingPreflight(branchShown ? preflightRequest(stacking, folder?.id ?? form.folder, branchingSolutions, formBranch(form)) : null, peer);
  const summary = branchShown
    ? withBranchingLines(lines, stacking, branchingSolutions, (solution) => worktreeFolder(solution, startNames(form, takenNames).name), preflight.rows, formBranch(form))
    : lines;
  const branchingReady = !branchShown || !branchingBlocks(stacking, branchingSolutions, preflight.rows, formBranch(form));
  const move = moves.items?.[0] ?? null;
  const moveRunning = moves.items !== null && !movesSettled(moves.items);
  // D57: the first message's attachments (a new session's start only: not a schedule, a move or a teleport).
  const attachable = !remoting && !resuming && !scheduling;
  const attaching = attachable ? attachmentsBlocker(attach.items) : null;
  const startable = remoting
    ? canStartRemote(remote, form.name, folder) && !busy
    : resuming
      ? canStartResume(resume, form.name) && !moves.busy && !moveRunning
      : (scheduling ? canSaveSchedule(form, preview, takenScheduleNames, folder) : canStart(form, takenNames, folder) && branchingReady && attaching === null) && !busy;
  // D59: a plain folder has no router either (the Full form cannot start there; the note offers Simple).
  const plain = isPlainFolder(folder) && !remoting;
  const hideRouter = repo || plain || resuming || remoting;
  const branchNoteId = useId();
  const branchState = branchCheck(form);
  const conversationRows = terminalConversations(conversations.data ?? [], folder?.id ?? null);
  const title = scheduling ? (schedule.id ? 'Edit scheduled run' : 'New scheduled run') : 'New session';
  // D25: from a remote session, only git repo folders.
  const choices = folderChoices(remoting ? repoFolders(folders.data ?? []) : (folders.data ?? []));
  const checkLine = folderCheckLine(target?.check ?? null);

  const saveSchedule = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // D52: a new schedule on a peer names it (`machine`); an Edit's remote id already does.
      const input = toScheduleInput(launch, cron, schedule?.id, folder);
      await api.createSchedule(peer && !schedule?.id ? { ...input, machine: peer } : input);
      onClose();
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(saveErrorText(apiError.status, apiError.body));
      schedules.reload();
      setBusy(false);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const removeSchedule = async (): Promise<void> => {
    if (!schedule?.id) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteSchedule(schedule.id);
      onClose();
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(deleteErrorText(apiError.status, apiError.body));
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  const toggleRemote = (): void => {
    const next = !remoteMode;
    setRemoteMode(next);
    setError(null);
    if (next) {
      // The remote field replaces the task: a picked terminal conversation does not carry over.
      setResume(null);
      setResumeOpen(false);
      moves.close();
    }
  };

  /** D56: switches Simple / Full; what is typed stays (one form state), the pick is remembered (`newSession.mode`). */
  const pickMode = (next: NewSessionMode): void => {
    setPickedMode(next);
    setError(null);
    if (next === 'simple') {
      // Neither is offered in the simple form.
      setRemoteMode(false);
      setResume(null);
      setResumeOpen(false);
      moves.close();
    }
    void api.saveSettings({ 'newSession.mode': next }).catch(() => undefined);
  };

  const uploadAttachments = async (): Promise<string[]> => (attach.items.length > 0 ? attach.uploadAll((body) => machineApi(peer).uploadAttachment(body)) : []);

  const startSimple = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // D57: the attachments upload to the chosen machine first; their ids go with the start.
      const ids = await uploadAttachments();
      // D56: a NewSimpleSession (no router answers, no solutions, no branching); D48: on the chosen machine.
      const session = await machineApi(peer).createSession({ ...toSimpleBody({ form: launch, folder, branch: simpleBranch, takenNames }), ...(ids.length > 0 ? { attachments: ids } : {}) });
      onClose();
      navigate({ view: 'session', id: session.id, tab: 'chat' });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(startErrorText(apiError.status, apiError.body));
      sessions.reload();
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (simple) {
      if (!busy) await startSimple();
      return;
    }
    if (!startable) return;
    if (scheduling) return saveSchedule();
    if (remoting && folder) {
      // D25: a new worktree of the repo, `claude --teleport` there; a refusal shows the CLI's text verbatim.
      setBusy(true);
      setError(null);
      try {
        const session = await api.teleportSession(toTeleportBody(remote, folder, form.name, form.task));
        onClose();
        navigate({ view: 'session', id: session.id, tab: 'chat' });
      } catch (caught) {
        const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
        setError(startErrorText(apiError.status, apiError.body));
        sessions.reload();
        setBusy(false);
      }
      return;
    }
    if (resume) {
      // D16: the picked conversation moves into Switchboard as the same conversation; D22: typed text is its title.
      setError(null);
      moves.start([{ claudeSessionId: resume.claudeSessionId, name: resume.name }], form.name);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // D22: the field is the title; the short name is derived from it (unique among the listed sessions).
      // D57: the attachments upload to the chosen machine first; their ids go with the start.
      const ids = await uploadAttachments();
      const body = { ...toStartBody(launch, folder, takenNames), ...(ids.length > 0 ? { attachments: ids } : {}) };
      // D40: with a worktree, the branching (epic, base, per-repo choices; D47: the parent) goes with it.
      // D48: on a peer the session starts there; the answer is its remote id (the session view opens it like a local one).
      const session = await machineApi(peer).createSession(branchShown ? { ...body, branching: toBranching(stacking, branchingSolutions) } : body);
      onClose();
      navigate({ view: 'session', id: session.id, tab: 'chat' });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(startErrorText(apiError.status, apiError.body));
      sessions.reload();
      setBusy(false);
    }
  };


  // D48's Machine row and D14's Folder row: the same in both forms (D56).
  const machineRow =
    peerMachines.length > 0 || lockedMachine ? (
      <div className="sb-ns-section sb-ns-section--machine" data-testid="ns-section" data-section="machine">
        <div className="sb-ns-label">Machine</div>
        <div className="sb-ns-folder-row">
          <select
            className="sb-ns-input sb-ns-select"
            data-testid="ns-machine"
            aria-label="Machine"
            value={peer ?? ''}
            disabled={busy || lockedMachine !== null}
            title={lockedMachine !== null ? 'A schedule stays on the machine it was saved on' : undefined}
            onChange={(event) => pickMachine(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">{`This machine${machines.data ? ` (${machines.data.self.name})` : ''}`}</option>
            {peerMachines.map((entry) => (
              // Fix · peer reconnects: a reconnecting machine can be chosen (its calls wait for the reconnection).
              <option key={entry.id} value={entry.id} disabled={entry.state !== 'online' && entry.state !== 'reconnecting'}>
                {entry.state === 'online' ? entry.name : `${entry.name} (${machineTagSuffix(entry.state) ?? entry.state})`}
              </option>
            ))}
          </select>
          {peer ? (
            <span className="sb-ns-folder-check" data-testid="ns-machine-note">
              {scheduling
                ? 'Folders and models come from that machine; the schedule is saved there and its runs start there.'
                : 'Folders, models and the branching check come from that machine; the session runs there.'}
            </span>
          ) : null}
        </div>
      </div>
    ) : null;
  const folderRow = (
    <>
    <div className="sb-ns-folder-row">
      <select
        className="sb-ns-input sb-ns-select"
        data-testid="ns-folder"
        aria-label="Folder"
        value={form.folder ?? ''}
        disabled={choices.length === 0}
        title={target?.path}
        onChange={(event) => pickFolder(event.target.value)}
      >
        {choices.length === 0 ? (
          <option value="">{folders.data ? (remoting ? 'No git repo folder saved yet' : 'No folder saved yet') : 'Loading folders…'}</option>
        ) : null}
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id} title={choice.path}>
            {choice.label}
          </option>
        ))}
      </select>
      {peer ? null : (
      <button
        type="button"
        className="sb-button sb-ns-browse"
        data-testid="ns-folder-browse"
        aria-expanded={adding}
        onClick={() => setAdding((open) => !open)}
      >
        Browse…
      </button>
      )}
      {checkLine ? (
        <span className="sb-ns-folder-check" data-testid="ns-folder-check" data-ok={String(checkLine.ok)} title={checkLine.text}>
          {checkLine.text}
        </span>
      ) : null}
    </div>
    {adding ? (
      <AddFolderPanel
        testId="ns-folder-add"
        onAdded={(added) => {
          setAdding(false);
          pickFolder(added.id);
        }}
        onCancel={() => setAdding(false)}
      />
    ) : null}
    </>
  );
  const modelPicker = (
    <ModelChoicePicker
      testId="ns-model"
      picker={formModelPicker(form, modelSettings, provider)}
      keepEscape
      onPickModel={(value) => update({ model: pickFormModel(formModel(form, modelSettings, provider) ?? DEFAULT_MODEL_CHOICE, modelOptions, value) })}
      onPickEffort={(value) => update({ model: pickFormEffort(formModel(form, modelSettings, provider) ?? DEFAULT_MODEL_CHOICE, value) })}
    />
  );
  // D62: the CLI choice (Simple: its own row; Full: beside the model picker in the Model row).
  const cliPicker = <CliPicker testId="ns-cli" value={provider} overview={clis.data ?? null} onPick={pickProvider} disabled={busy} />;
  const modeToggle = mode !== null && offersModeToggle(scheduling) ? <ModeToggle mode={mode} onPick={pickMode} disabled={busy} /> : null;

  if (mode === null || simple) {
    return (
      <div className="sb-overlay" data-modal="new-session" onClick={onClose}>
        <div
          className="sb-modal-simple"
          role="dialog"
          aria-modal="true"
          aria-label="New session"
          data-testid="modal-new-session"
          data-mode={mode ?? 'loading'}
          onClick={(event: MouseEvent) => event.stopPropagation()}
        >
          {mode === null ? (
            <div className="sb-ns-simple-loading" data-testid="ns-mode-loading">
              Loading…
            </div>
          ) : (
            <SimpleSessionForm
              form={form}
              update={update}
              folder={folder}
              takenNames={takenNames}
              branch={simpleBranch}
              onBranch={(value) => {
                setSimpleBranch(value);
                setError(null);
              }}
              toggle={modeToggle}
              machineRow={machineRow}
              folderRow={folderRow}
              modelPicker={modelPicker}
              cliPicker={cliPicker}
              error={error}
              busy={busy}
              attachments={attach}
              onStart={() => void start()}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="sb-overlay" data-modal="new-session" onClick={onClose}>
      <div
        className="sb-modal-new"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="modal-new-session"
        data-mode="full"
        data-schedule={scheduling ? (schedule.id ?? 'new') : undefined}
        data-prefill={prefill ? JSON.stringify(prefill) : undefined}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <div className="sb-ns-form">
          <div className="sb-ns-head">
            <div className="sb-ns-title" data-testid="ns-title">
              {title}
            </div>
            <div className="sb-ns-sub">Claude Code · background · Max</div>
            {hideRouter ? null : (
              <button type="button" className="sb-button sb-ns-recommended" data-testid="ns-recommended" onClick={() => update(RECOMMENDED)}>
                Accept recommended
              </button>
            )}
          </div>

          {machineRow}

          <div className="sb-ns-section sb-ns-section--folder" data-testid="ns-section" data-section="folder" data-kind={folder?.kind}>
            <div className="sb-ns-label">Folder</div>
            {folderRow}
            {plain ? (
              <div className="sb-ns-plain-note" data-testid="ns-plain-note" role="note">
                <span>{scheduling ? PLAIN_FOLDER_SCHEDULE_NOTE : PLAIN_FOLDER_FULL_NOTE}</span>
                {scheduling || resuming ? null : (
                  <button type="button" className="sb-button sb-ns-plain-simple" data-testid="ns-plain-use-simple" disabled={busy} onClick={() => pickMode('simple')}>
                    Use Simple
                  </button>
                )}
              </div>
            ) : null}
            {remoting ? (
              <div className="sb-ns-remote-hint" data-testid="ns-remote-hint">
                {choices.length === 0 ? NO_REPO_FOLDER_HINT : REPO_FOLDERS_HINT}
              </div>
            ) : null}
            {/* D48: a peer's folders are managed there, and a teleport runs here only. */}
            {scheduling || peer ? null : (
              <button
                type="button"
                className="sb-button sb-ns-remote-toggle"
                data-testid="ns-remote"
                aria-pressed={remoting}
                disabled={busy || moveRunning}
                onClick={toggleRemote}
              >
                {`⇣ ${FROM_REMOTE_SESSION}`}
              </button>
            )}
          </div>

          <div
            className="sb-ns-section sb-ns-section--task"
            data-testid="ns-section"
            data-section="task"
            data-dragging={attachable && drop.dragging ? 'true' : undefined}
            {...(attachable ? drop.handlers : {})}
          >
            <div className="sb-ns-label">1 · Task definition</div>
            <div className="sb-ns-task">
              <input
                className="sb-ns-input sb-ns-input--name"
                data-testid="ns-name"
                aria-label="Session name"
                value={form.name}
                placeholder={remoting ? remoteNames(remote, '', takenNames).name : resuming && resume ? resumeNamePreview(resume, takenNames) : 'session-name'}
                spellCheck={false}
                // D22: the field takes free text (the title of a new or a moved session); a schedule's name stays kebab-case.
                onChange={(event) => update({ name: scheduling ? sanitizeName(event.target.value) : event.target.value })}
              />
              {remoting ? (
                <input
                  className="sb-ns-input sb-ns-input--remote"
                  data-testid="ns-remote-input"
                  aria-label="Remote session"
                  value={remote}
                  placeholder={REMOTE_PLACEHOLDER}
                  spellCheck={false}
                  onChange={(event) => {
                    setRemote(event.target.value);
                    setError(null);
                  }}
                />
              ) : resuming && resume ? (
                <div className="sb-ns-input sb-ns-resume-picked" data-testid="ns-resume-picked" data-claude-session-id={resume.claudeSessionId} title={resume.firstPrompt ?? undefined}>
                  <span className="sb-ns-resume-picked-title">{`↻ ${resume.name}`}</span>
                  <span className="sb-ns-resume-picked-meta">{formatHistoryDate(resume.startedAt)}</span>
                  <button
                    type="button"
                    className="sb-button sb-ns-resume-clear"
                    data-testid="ns-resume-clear"
                    aria-label="Type a task instead"
                    title="Type a task instead"
                    disabled={moveRunning}
                    onClick={() => {
                      setResume(null);
                      moves.close();
                    }}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <input
                  className={attachable ? 'sb-ns-input sb-ns-input--attach' : 'sb-ns-input'}
                  data-testid="ns-task"
                  aria-label="Task"
                  value={form.task}
                  placeholder="What should be implemented?"
                  onChange={(event) => update({ task: event.target.value })}
                  onPaste={pasteFiles(attach.add, attachable)}
                />
              )}
              {/* D57: last in the row, drawn inside the task field at its right (the fields keep their boxes). */}
              {attachable ? <AttachButton className="sb-attach-button--task" onFiles={attach.add} /> : null}
            </div>
            {attachable ? <AttachmentChips items={attach.items} notice={attach.notice} onRemove={attach.remove} /> : null}
            {branchShown ? (
              <div className="sb-ns-branch" data-testid="ns-branch-row">
                <input
                  className="sb-ns-input sb-ns-input--name"
                  data-testid="ns-branch"
                  aria-label="Branch"
                  aria-invalid={!branchState.ok}
                  aria-describedby={branchNoteId}
                  data-prefilled={form.branch === null ? 'true' : 'false'}
                  value={formBranch(form)}
                  placeholder={TICKET_BRANCH_EXAMPLE}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => update({ branch: event.target.value })}
                  onBlur={() => {
                    // Typed text is tidied on blur (the key upper case, the description kebab-case); a pre-filled name already is.
                    if (form.branch === null) return;
                    const tidy = tidyTicketBranch(form.branch);
                    if (tidy !== form.branch) setForm((current) => ({ ...current, branch: tidy }));
                  }}
                />
                <span id={branchNoteId} className="sb-ns-branch-note" data-testid="ns-branch-note" data-ok={branchState.ok ? 'true' : 'false'}>
                  {branchState.ok ? (repo ? '⎇ the branch of the worktree' : '⎇ the branch of every worktree') : branchState.message}
                </span>
              </div>
            ) : null}
            {remoting ? (
              <input
                className="sb-ns-input"
                data-testid="ns-remote-task"
                aria-label="First message"
                value={form.task}
                placeholder={REMOTE_TASK_PLACEHOLDER}
                onChange={(event) => update({ task: event.target.value })}
              />
            ) : null}
            {resumeOpen && !scheduling && !remoting ? (
              <div className="sb-ns-resume-list" data-testid="ns-resume-list" role="listbox" aria-label={RESUME_TERMINAL_CONVERSATION}>
                {conversations.data === null ? (
                  <div className="sb-ns-resume-empty" data-testid="ns-resume-empty">
                    {conversations.error ? 'The conversations could not be loaded.' : 'Loading conversations…'}
                  </div>
                ) : conversationRows.length === 0 ? (
                  <div className="sb-ns-resume-empty" data-testid="ns-resume-empty">
                    {folder ? `No terminal conversations in ${folder.displayName} that are not in Switchboard yet.` : 'Pick a folder first.'}
                  </div>
                ) : (
                  conversationRows.map((row) => (
                    <button
                      key={row.claudeSessionId}
                      type="button"
                      role="option"
                      aria-selected={resume?.claudeSessionId === row.claudeSessionId}
                      className="sb-button sb-ns-resume-entry"
                      data-testid="ns-resume-entry"
                      data-claude-session-id={row.claudeSessionId}
                      data-selected={resume?.claudeSessionId === row.claudeSessionId ? 'true' : 'false'}
                      onClick={() => {
                        setResume(resumePickOf(row));
                        setResumeOpen(false);
                        setError(null);
                        moves.close();
                      }}
                    >
                      <span className="sb-ns-resume-entry-title">{row.name}</span>
                      <span className="sb-ns-resume-entry-meta">{resumeEntryMeta(row)}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
            {scheduling || peer ? null : (
              <button
                type="button"
                className="sb-button sb-ns-resume-toggle"
                data-testid="ns-resume"
                aria-expanded={resumeOpen}
                disabled={moveRunning || remoting}
                onClick={() => setResumeOpen((open) => !open)}
              >
                {`↻ ${RESUME_TERMINAL_CONVERSATION}`}
              </button>
            )}
          </div>

          {hideRouter ? null : (
            <div className="sb-ns-section" data-testid="ns-section" data-section="work-type">
              <div className="sb-ns-label">2 · Work type</div>
              <Pills group="work-type" label="Work type" options={WORK_TYPE_OPTIONS} value={form.workType} onPick={(workType) => update({ workType })} />
            </div>
          )}

          {hideRouter ? null : (
            <div className="sb-ns-section" data-testid="ns-section" data-section="mode">
              <div className="sb-ns-label">3 · Mode</div>
              <Pills group="mode" label="Mode" options={MODE_OPTIONS} value={form.mode} onPick={(mode) => update({ mode })} />
            </div>
          )}

          {resuming || remoting ? null : (
            <div className="sb-ns-section sb-ns-section--solutions" data-testid="ns-section" data-section="solutions">
              <div className="sb-ns-label sb-ns-label--row">
                {repo ? '2 · Solution in scope' : '4 · Solutions in scope'}
                <span className="sb-ns-hint" data-testid="ns-solutions-hint">
                  {solutionsHint(form, folder)}
                </span>
              </div>
              {repo && folder ? (
                <div className="sb-ns-group" data-testid="ns-group" data-folder={`${folder.name}/`}>
                  <span className="sb-ns-folder">{`${folder.name}/`}</span>
                  <div className="sb-ns-chips">
                    <button
                      type="button"
                      className="sb-button sb-ns-chip"
                      data-testid="ns-chip"
                      data-solution={folder.name}
                      data-selected="true"
                      data-fixed="true"
                      disabled
                      title="A git repo folder is its own one solution"
                    >
                      {`✓ ${folder.name}`}
                    </button>
                  </div>
                </div>
              ) : null}
              {(repo ? [] : groups).map((group) => (
                <div key={group.folder} className="sb-ns-group" data-testid="ns-group" data-folder={group.folder}>
                  <span className="sb-ns-folder">{group.folder}</span>
                  <div className="sb-ns-chips">
                    {group.chips.map((chip) => (
                      <button
                        key={chip.value}
                        type="button"
                        className="sb-button sb-ns-chip"
                        data-testid="ns-chip"
                        data-solution={chip.value}
                        data-selected={chip.selected ? 'true' : 'false'}
                        data-locked={chip.locked ? 'true' : undefined}
                        aria-pressed={chip.locked ? undefined : chip.selected}
                        disabled={chip.locked}
                        title={chip.locked ? 'Read-only: never a write target' : undefined}
                        onClick={() => update({ solutions: toggleSolution(form.solutions, chip.value) })}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {!repo && scanError ? (
                <div className="sb-ns-note" data-testid="ns-solutions-note">
                  {solutionsErrorText(scanError)}
                </div>
              ) : null}
              {!repo && scan && scan.length === 0 ? (
                <div className="sb-ns-note" data-testid="ns-solutions-note">
                  No solutions found in the workspace.
                </div>
              ) : null}
            </div>
          )}

          {hideRouter ? null : (
            <div className="sb-ns-section" data-testid="ns-section" data-section="phase">
              <div className="sb-ns-label">5 · Phase</div>
              <Pills group="phase" label="Phase" options={PHASE_OPTIONS} value={form.phase} onPick={(phase) => update({ phase })} />
            </div>
          )}

          {!hideRouter && showsCoordination(form) ? (
            <div className="sb-ns-section" data-testid="ns-section" data-section="coordination">
              <div className="sb-ns-label">6 · Mobile coordination</div>
              <Pills group="coordination" label="Mobile coordination" options={COORDINATION_OPTIONS} value={form.coordination} onPick={(coordination) => update({ coordination })} />
            </div>
          ) : null}

          {!hideRouter && showsQa(form) ? (
            <div className="sb-ns-section sb-ns-section--qa" data-testid="ns-section" data-section="qa">
              <div className="sb-ns-label">6 · QA contract</div>
              <Pills group="stack" label="Stack under test" options={STACK_OPTIONS} value={form.stack} onPick={(stack) => update({ stack })} />
              <div className="sb-ns-qa-fields">
                <input
                  className="sb-ns-input sb-ns-input--qa"
                  data-testid="ns-confluence"
                  aria-label="Confluence page URL"
                  value={form.confluenceUrl}
                  placeholder="Confluence page URL (required)"
                  spellCheck={false}
                  onChange={(event) => update({ confluenceUrl: event.target.value })}
                />
                <input
                  className="sb-ns-input sb-ns-input--qa"
                  data-testid="ns-figma"
                  aria-label="Figma frame URLs"
                  value={form.figmaUrls}
                  placeholder="Figma frame URL per breakpoint (required)"
                  spellCheck={false}
                  onChange={(event) => update({ figmaUrls: event.target.value })}
                />
              </div>
            </div>
          ) : null}

          {branchShown ? (
            <BranchingSection
              form={branching}
              onChange={(patch) => {
                setBranching((current) => ({ ...current, ...patch }));
                setError(null);
              }}
              solutions={branchingSolutions}
              taskBranch={formBranch(form)}
              task={form.task}
              preflight={preflight}
              repo={repo}
            />
          ) : null}

          {scheduling ? (
            <ScheduleSection
              cron={cron}
              preview={preview}
              number={repo ? 3 : 7}
              onCron={(value) => {
                setCron(value);
                setError(null);
              }}
            />
          ) : null}
        </div>

        <div className="sb-ns-side">
          <div className="sb-ns-side-label">Launch</div>
          <div className="sb-ns-toggles">
            {remoting ? (
              <div className="sb-ns-note" data-testid="ns-remote-note">
                {REMOTE_LAUNCH_NOTE}
              </div>
            ) : resuming ? (
              <div className="sb-ns-note" data-testid="ns-resume-note">
                Continues where the conversation started: no worktree, no first message.
              </div>
            ) : (
              <>
                <Toggle
                  name="worktrees"
                  title={repo ? 'Worktree' : 'Worktree per solution'}
                  description="Kept until the PR is merged on GitHub"
                  on={form.worktrees}
                  onToggle={() => update({ worktrees: !form.worktrees })}
                />
                <Toggle name="ultracode" title="Ultracode (workflows)" description="Dispatch via the Workflow tool" on={form.ultracode} onToggle={() => update({ ultracode: !form.ultracode })} />
                {/* D42: the model and effort the session starts with (D31's picker), on the last choice until picked. */}
                <div className="sb-ns-toggle-row sb-ns-model-row" data-testid="ns-model-row">
                  <div className="sb-ns-toggle-text">
                    <div className="sb-ns-toggle-title">{MODEL_ROW_TITLE}</div>
                    <div className="sb-ns-toggle-desc">{MODEL_ROW_DESCRIPTION}</div>
                  </div>
                  {modelPicker}
                </div>
                {/* D62: the CLI the session runs on (its own Launch row under D42's Model row; the model list follows it). */}
                <div className="sb-ns-toggle-row sb-ns-cli-row" data-testid="ns-cli-row">
                  <div className="sb-ns-toggle-text">
                    <div className="sb-ns-toggle-title">CLI</div>
                    <div className="sb-ns-toggle-desc">The agent CLI it runs on</div>
                  </div>
                  {cliPicker}
                </div>
              </>
            )}
          </div>
          <div className="sb-ns-side-label sb-ns-side-label--summary">Summary</div>
          <div className="sb-ns-summary" data-testid="ns-summary">
            {summary.map((line, index) => (
              <div key={index} className="sb-ns-summary-line" data-testid="ns-summary-line" data-tone={line.tone}>
                {line.text}
              </div>
            ))}
          </div>
          {error ? (
            <div className="sb-ns-error" data-testid="ns-error" data-remote={remoting ? 'true' : undefined} role="alert">
              {error}
            </div>
          ) : null}
          {resuming && move && (move.state.kind === 'needs-folder' || move.state.kind === 'terminal-open') ? (
            <div className="sb-ns-move" data-testid="ns-move" data-kind={move.state.kind} role="alertdialog" aria-label={RESUME_TERMINAL_CONVERSATION}>
              <div className="sb-ns-move-text" data-testid="ns-move-text">
                {move.state.kind === 'needs-folder' ? needsFolderText(move.state.check) : moveWarningText(move.state.reasons)}
              </div>
              <div className="sb-ns-move-actions">
                {move.state.kind === 'needs-folder' ? (
                  <button type="button" className="sb-button sb-ns-move-primary" data-testid="ns-move-add-folder" onClick={() => moves.addFolder(move.claudeSessionId)}>
                    {addFolderLabel(move.state.check)}
                  </button>
                ) : (
                  <button type="button" className="sb-button sb-ns-move-primary" data-testid="ns-move-confirm" onClick={() => moves.confirm(move.claudeSessionId)}>
                    {CONTINUE_ANYWAY}
                  </button>
                )}
                <button type="button" className="sb-button sb-ns-move-outlined" data-testid="ns-move-cancel" onClick={() => moves.close()}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {resuming && move && move.state.kind === 'refused' ? (
            <div className="sb-ns-error" data-testid="ns-error" role="alert">
              {`Not moved: ${move.state.reason}`}
            </div>
          ) : null}
          <div className="sb-ns-actions">
            {scheduling && schedule.id ? (
              // D52: Delete (two steps: the first click asks, the second deletes; on a peer the schedule is deleted there).
              <button
                type="button"
                className="sb-button sb-ns-cancel sb-ns-delete"
                data-testid="ns-delete-schedule"
                data-confirm={confirmDelete ? 'true' : undefined}
                disabled={busy}
                onClick={() => void removeSchedule()}
              >
                {confirmDelete ? 'Delete it?' : 'Delete schedule'}
              </button>
            ) : null}
            <button type="button" className="sb-button sb-ns-cancel" data-testid="ns-cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="sb-button sb-ns-start"
              data-testid={scheduling ? 'ns-save-schedule' : 'ns-start'}
              disabled={!startable}
              onClick={() => void start()}
            >
              {scheduling ? 'Save schedule' : remoting && busy ? 'Pulling…' : 'Start session'}
            </button>
          </div>
          {/* D56: the Simple / Full switch, on the Launch label line (out of the flow, after every prototype part). */}
          {modeToggle ? <div className="sb-ns-mode-slot">{modeToggle}</div> : null}
        </div>
      </div>
    </div>
  );
}
