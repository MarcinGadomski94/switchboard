import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Folder, NewSessionPrefill, SessionListItem } from '../../../core/api.ts';
import { isChat } from '../../../core/chats.ts';
import { draftField } from '../../../core/drafts.ts';
import type { MachinesView } from '../../../core/peers.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import type { TeamSummary } from '../../../core/team.ts';
import type { TeamTemplate } from '../../../core/team-templates.ts';
import { TODO_PRIORITY_LABELS } from '../../../core/todos.ts';
import { COORDINATION_OPTIONS, MODE_OPTIONS, PHASE_OPTIONS, WORK_TYPE_OPTIONS, chipGroups, formFromPrefill, isPlainFolder, isRepoFolder, toggleSolution } from '../../modals/new-session.ts';
import { ApiError, api, machineApi } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { AttachmentChips, pasteFiles, useAttachmentDraft, useFileDrop } from '../../components/Attachments.tsx';
import { attachmentsBlocker } from '../../components/attachments.ts';
import { ImportJiraDialog } from '../../plans/jira/index.ts';
import { plansApi, refusalText as planRefusal } from '../../plans/api.ts';
import { pageClientId } from '../../pwa/presence.ts';
import { refusalText as teamRefusal, teamApi } from '../../team/api.ts';
import { Button, Checkbox, Dialog, Field, Icon, Kbd, Segmented, Select, Switch, TextArea, useToast } from '../components/index.ts';
import { NEW_WORDS, THINKING_DEPTH } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { agentName } from '../shared/agent-line.ts';
import { timeAgo } from '../shared/time.ts';
import {
  type AgentForm,
  ESTIMATES,
  NEW_KINDS,
  type NewKindId,
  ROUTINE_PRESETS,
  type SheetState,
  agentBody,
  agentProblems,
  chatBody,
  conversationProblems,
  crewProblems,
  estimateLabel,
  foldersByRecent,
  parseSteps,
  projectProblems,
  routineBody,
  routineProblems,
  sheetDraft,
  sheetFromDraft,
  sheetFromRequest,
  sheetHasText,
  stepIndex,
  taskBody,
  taskProblems,
  teammateBody,
  teammateProblems,
} from './new-model.ts';
import './new.css';

const W = NEW_WORDS;

/** What opened the sheet. */
export interface SheetRequest {
  readonly kind: NewKindId;
  readonly text?: string;
  readonly prefill?: NewSessionPrefill;
  readonly machine?: string | null;
}

/** A readable line for a refused call. */
function refusal(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string' && body.message !== '') return body.message;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Open agents that can own tasks, routines and projects (not conversations, not closed). */
function workingAgents(sessions: readonly SessionListItem[] | null): SessionListItem[] {
  return (sessions ?? []).filter((session) => !isChat(session) && !session.closedAt);
}

function agentOptions(sessions: readonly SessionListItem[]) {
  return [{ value: '', label: '—' }, ...sessions.map((session) => ({ value: session.id, label: `${agentName(session)}${session.machine ? ` · ${session.machine.name}` : ''}` }))];
}

function Label({ children, htmlFor }: { readonly children: ReactNode; readonly htmlFor?: string }) {
  return htmlFor ? (
    <label className="v2-new-label" htmlFor={htmlFor}>
      {children}
    </label>
  ) : (
    <span className="v2-new-label">{children}</span>
  );
}

/**
 * D131 · lane R · the + New sheet's body (the prototype's `#m-new`): the kinds,
 * the form of the chosen kind, Save as draft and the start button. Mounted while
 * open; `request` is what opened it.
 */
export function NewSheetBody({ request, onClose }: { readonly request: SheetRequest; readonly onClose: () => void }) {
  const toast = useToast();
  const { navigate, route } = useV2Router();
  const fromRequest = (request.text ?? '') !== '' || request.prefill !== undefined;
  const [sheet, setSheet] = useState<SheetState>(() => sheetFromRequest(request.kind, request.text, request.prefill ? formFromPrefill(request.prefill) : null, request.machine));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [hadDraft, setHadDraft] = useState(false);
  const [jiraOpen, setJiraOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // D88: this computer's `new-session` draft comes back when the sheet opens plain (no text, no prefill)
  // for the default kind or the draft's own kind.
  useEffect(() => {
    if (fromRequest) return undefined;
    let live = true;
    api
      .machineDrafts()
      .then((drafts) => {
        const saved = drafts.find((draft) => draft.field === draftField.newSession);
        const value = saved?.value as { form?: Readonly<Record<string, unknown>> } | undefined;
        if (!live || !value?.form) return;
        const restored = sheetFromDraft(value.form);
        if (!sheetHasText(restored)) return;
        if (request.kind !== 'agent' && restored.kind !== request.kind) return;
        setSheet((current) => ({ ...restored, agent: { ...restored.agent, machine: current.agent.machine } }));
        setHadDraft(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kind = sheet.kind;
  const agent = sheet.agent;
  const machine = agent.machine;
  const setAgent = (patch: Partial<AgentForm>): void => setSheet((s) => ({ ...s, agent: { ...s.agent, ...patch } }));
  const patch = <K extends 'task' | 'routine' | 'project' | 'teammate' | 'crew'>(key: K, value: Partial<SheetState[K]>): void => setSheet((s) => ({ ...s, [key]: { ...s[key], ...value } }));
  const setForm = (patch: Partial<AgentForm['form']>): void => setSheet((s) => ({ ...s, agent: { ...s.agent, form: { ...s.agent.form, ...patch } } }));

  // Data.
  const machines = useApi((): Promise<MachinesView | null> => api.machines().catch(() => null), []);
  const folders = useApi((): Promise<Folder[]> => machineApi(machine).savedFolders().catch(() => []), [machine]);
  const sessions = useSessionListOf();
  const layout = useApi((): Promise<SidebarLayout | null> => api.sidebarLayout().catch(() => null), []);
  const clis = useApi(() => machineApi(machine).clis().catch(() => null), [machine]);
  const accounts = useApi(() => machineApi(machine).accounts().catch(() => null), [machine]);
  const provider = agent.form.provider ?? clis.data?.default ?? 'claude';
  const models = useApi(() => machineApi(machine).models(provider).catch(() => null), [machine, provider]);
  const needsTeams = kind === 'teammate';
  const teams = useApi((): Promise<TeamSummary[]> => (needsTeams ? teamApi.teams().catch(() => []) : Promise.resolve([])), [needsTeams]);
  const templates = useApi((): Promise<TeamTemplate[]> => (needsTeams ? teamApi.templates().catch(() => []) : Promise.resolve([])), [needsTeams]);

  const sortedFolders = useMemo(() => foldersByRecent(folders.data ?? []), [folders.data]);
  // The form's folder: its own while it is listed, else the default, else the most recent.
  const folderId = agent.form.folder && sortedFolders.some((f) => f.id === agent.form.folder) ? agent.form.folder : ((sortedFolders.find((f) => f.isDefault) ?? sortedFolders[0])?.id ?? null);
  const folder = sortedFolders.find((f) => f.id === folderId) ?? null;
  const askQuestions = agent.askQuestions && folder !== null && !isRepoFolder(folder) && !isPlainFolder(folder);
  const solutions = useApi(() => (askQuestions && folderId ? machineApi(machine).solutions(folderId).catch(() => null) : Promise.resolve(null)), [askQuestions, folderId, machine]);
  const agents = workingAgents(sessions.data);
  const currentAgent = route.area === 'agent' ? route.id : null;
  const defaultAgent = agents.find((s) => s.id === currentAgent)?.id ?? agents[0]?.id ?? '';
  const peerList = machines.data?.machines ?? [];
  const chosenPeer = peerList.find((m) => m.id === machine) ?? null;
  const machineOffline = chosenPeer !== null && chosenPeer.state === 'offline';
  const takenNames = (sessions.data ?? []).filter((s) => (s.machine?.id ?? null) === machine).map((s) => s.name);
  const offered = models.data?.options ?? clis.data?.clis.find((c) => c.provider === provider)?.models ?? null;

  const attach = useAttachmentDraft();
  const drop = useFileDrop(attach.add);

  // The pickers that hold an agent start on the one on screen (or the most recent).
  const task = { ...sheet.task, agent: sheet.task.agent || defaultAgent };
  const routine = { ...sheet.routine, agent: sheet.routine.agent || defaultAgent };
  const project = { ...sheet.project, owner: sheet.project.owner || defaultAgent };
  const teammate = { ...sheet.teammate, crew: sheet.teammate.crew || (teams.data?.[0]?.id ?? '') };

  const formAgent: AgentForm = { ...agent, form: { ...agent.form, folder: folderId }, askQuestions };
  const problems = (() => {
    switch (kind) {
      case 'agent': {
        const list = agentProblems(formAgent, folder, takenNames, machineOffline);
        const blocker = attachmentsBlocker(attach.items);
        return blocker ? [...list, W.errors.attachments] : list;
      }
      case 'conversation':
        return conversationProblems(agent);
      case 'task':
        return Object.values(taskProblems(task));
      case 'routine':
        return Object.values(routineProblems(routine));
      case 'project':
        return Object.values(projectProblems(project));
      case 'teammate':
        return Object.values(teammateProblems(teammate));
      case 'crew':
        return Object.values(crewProblems(sheet.crew));
    }
  })();
  const fieldError = (message: string | undefined): string | null => (tried && message ? message : null);

  const clearDraft = (): void => {
    if (hadDraft) void api.deleteMachineDraft(draftField.newSession).catch(() => undefined);
  };

  const finish = (text: string, go: string | null, showLabel?: string): void => {
    clearDraft();
    onClose();
    if (go && !showLabel) navigate(go);
    toast(showLabel && go ? { text, undo: () => navigate(go), actionLabel: showLabel } : { text });
  };

  const submit = async (): Promise<void> => {
    setTried(true);
    if (problems.length > 0 || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      switch (kind) {
        case 'agent': {
          const ids = attach.items.length > 0 ? await attach.uploadAll((body) => machineApi(machine).uploadAttachment(body)) : [];
          const body = agentBody(formAgent, folder, takenNames, offered);
          const session = await machineApi(machine).createSession({ ...body, ...(ids.length > 0 ? { attachments: ids } : {}) });
          if (agent.sidebarFolder && machine === null) await api.placeSidebarSession({ sessionId: session.id, place: 'folder', folderId: agent.sidebarFolder }).catch(() => undefined);
          finish(W.started(agentName(session)), `/agents/${encodeURIComponent(session.id)}`);
          break;
        }
        case 'conversation': {
          const ids = attach.items.length > 0 ? await attach.uploadAll((body) => machineApi(null).uploadAttachment(body)) : [];
          const chat = await api.createChat(chatBody(agent, offered, ids));
          finish(W.started(agentName(chat)), `/agents/${encodeURIComponent(chat.id)}`);
          break;
        }
        case 'task': {
          await api.addTodo(task.agent, taskBody(task));
          const owner = agents.find((s) => s.id === task.agent);
          finish(W.taskAdded(task.title.trim(), owner ? agentName(owner) : ''), '/tasks', W.show);
          break;
        }
        case 'routine': {
          await api.createLoop(routine.agent, routineBody(routine));
          const owner = agents.find((s) => s.id === routine.agent);
          finish(W.routineMade(owner ? agentName(owner) : ''), '/routines', W.show);
          break;
        }
        case 'project': {
          const plan = await plansApi.create({ sourceSessionId: project.owner, title: project.title.trim(), targetBranch: null });
          const steps = parseSteps(project.steps);
          const ids: string[] = [];
          for (const [index, step] of steps.entries()) {
            const after = step.after ? stepIndex(steps, index, step.after) : -1;
            const answer = await plansApi.addItem(plan.id, { todo: { title: step.title, description: null, plan: 'No plan', priority: 'medium', estimateMinutes: null }, ...(after >= 0 && ids[after] ? { after: [ids[after]] } : {}) });
            ids.push(answer.itemId);
          }
          finish(W.projectMade(plan.title), `/projects/${encodeURIComponent(plan.id)}`);
          break;
        }
        case 'teammate': {
          const member = await teamApi.addMember(teammateBody(teammate) as unknown as Parameters<typeof teamApi.addMember>[0]);
          finish(W.teammateMade(member.name), `/crews/${encodeURIComponent(teammate.crew)}`);
          break;
        }
        case 'crew': {
          const crew = await teamApi.createTeam(sheet.crew.name.trim());
          finish(W.crewMade(crew.name), `/crews/${encodeURIComponent(crew.id)}`);
          break;
        }
      }
    } catch (error) {
      setFailure(kind === 'project' ? planRefusal(error) : kind === 'teammate' || kind === 'crew' ? teamRefusal(error) : refusal(error));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async (): Promise<void> => {
    try {
      await api.putMachineDraft(draftField.newSession, { value: sheetDraft({ ...sheet, agent: formAgent }), client: pageClientId() });
      onClose();
      toast({ text: W.draftSaved });
    } catch (error) {
      setFailure(refusal(error));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const look = W.kinds[kind];
  const canDraft = sheetHasText({ ...sheet, agent: formAgent });
  const footer = (
    <>
      <Button variant="ghost" onClick={() => void saveDraft()} disabled={!canDraft || busy} title={canDraft ? undefined : W.errors.message} data-testid="v2-new-draft">
        {W.saveDraft}
      </Button>
      {hadDraft ? (
        <Button
          variant="ghost"
          size="sm"
          data-testid="v2-new-clear-draft"
          onClick={() => {
            clearDraft();
            setHadDraft(false);
            setSheet(sheetFromRequest(kind, undefined, null, machine));
          }}
        >
          {W.clearDraft}
        </Button>
      ) : null}
      <span className="v2-grow" />
      {failure ? (
        <span className="v2-new-failure" role="alert" data-testid="v2-new-failure">
          {failure}
        </span>
      ) : tried && problems.length > 0 ? (
        <span className="v2-new-failure" role="alert" data-testid="v2-new-problems">
          {problems[0]}
        </span>
      ) : (
        <Kbd className="v2-new-kbd">⌘↩</Kbd>
      )}
      <Button onClick={onClose}>{W.cancel}</Button>
      <Button variant="primary" icon={look.icon} onClick={() => void submit()} disabled={busy} data-testid="v2-new-go">
        {busy ? W.working : look.go}
      </Button>
    </>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      testId="v2-new-sheet"
      icon="plus"
      width={760}
      title={
        <span className="v2-new-title">
          {W.title}
          <span className="v2-muted">{W.sub}</span>
        </span>
      }
      footer={footer}
    >
      <div ref={bodyRef} className="v2-new" data-kind={kind} onKeyDown={onKeyDown}>
        {hadDraft ? (
          <p className="v2-new-note" data-testid="v2-new-restored">
            <Icon name="edit" size="s" /> {W.draftRestored}
          </p>
        ) : null}
        <div className="v2-new-types" role="group" aria-label={W.whatToStart}>
          {NEW_KINDS.map((id) => (
            <button
              key={id}
              type="button"
              className="v2-new-type"
              aria-pressed={id === kind}
              data-kind={id}
              data-testid={`v2-new-kind-${id}`}
              onClick={() => {
                setSheet((s) => ({ ...s, kind: id }));
                setTried(false);
                setFailure(null);
              }}
            >
              <Icon name={W.kinds[id].icon} />
              <b>{W.kinds[id].label}</b>
              <small>{W.kinds[id].sub}</small>
            </button>
          ))}
        </div>

        {kind === 'agent' ? (
          <>
            <Label>{W.whichFolder}</Label>
            {sortedFolders.length === 0 && !folders.loading ? <p className="v2-muted">{W.noFolders}</p> : null}
            <div className="v2-new-folders" role="radiogroup" aria-label={W.whichFolder}>
              {sortedFolders.map((f) => (
                <button key={f.id} type="button" role="radio" className="v2-new-folder" aria-checked={f.id === folderId} aria-pressed={f.id === folderId} data-testid="v2-new-folder" data-folder={f.displayName} onClick={() => setForm({ folder: f.id })}>
                  <Icon name="folder" />
                  <span>
                    {f.displayName}
                    <small>{f.lastUsedAt ? W.usedAgo(timeAgo(f.lastUsedAt)) : W.neverUsed}</small>
                  </span>
                </button>
              ))}
            </div>
            {fieldError(folder === null ? W.errors.folder : undefined) ? <div className="v2-field-error">{W.errors.folder}</div> : null}
          </>
        ) : null}

        {kind === 'agent' || kind === 'conversation' ? (
          <div className="v2-new-message" {...drop.handlers} data-dragging={drop.dragging ? 'true' : undefined}>
            <TextArea
              label={W.whatToDo}
              placeholder={W.whatToDoPlaceholder}
              value={agent.form.task}
              data-autofocus=""
              data-testid="v2-new-message"
              rows={4}
              onPaste={pasteFiles(attach.add)}
              onChange={(event) => setForm({ task: event.currentTarget.value })}
              error={fieldError(agent.form.task.trim() === '' ? W.errors.message : undefined)}
            />
            <div className="v2-row v2-new-attach">
              <Button
                variant="ghost"
                size="sm"
                icon="clip"
                data-testid="v2-new-attach"
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.multiple = true;
                  input.addEventListener('change', () => {
                    const files = Array.from(input.files ?? []);
                    if (files.length > 0) attach.add(files);
                  });
                  input.click();
                }}
              >
                {W.attach}
              </Button>
              <AttachmentChips items={attach.items} notice={attach.notice} onRemove={attach.remove} />
            </div>
          </div>
        ) : null}

        {kind === 'agent' || kind === 'conversation' ? (
          <div className="v2-new-choices">
            <div>
              <Label>{W.speed}</Label>
              <Segmented label={W.speed} testId="v2-new-speed" value={agent.speed} onChange={(speed) => setAgent({ speed })} options={[{ value: 'smart', label: W.smart }, { value: 'fast', label: W.fast }]} />
            </div>
            <div>
              <Label>{W.depth}</Label>
              <Segmented label={W.depth} testId="v2-new-depth" value={agent.depth} onChange={(depth) => setAgent({ depth })} options={[{ value: 'normal', label: THINKING_DEPTH['medium'] ?? W.depthNormal }, { value: 'deep', label: THINKING_DEPTH['high'] ?? W.depthDeep }]} />
            </div>
            {kind === 'agent' && peerList.length > 0 ? (
              <div>
                <Label>{W.computer}</Label>
                <div className="v2-seg" role="group" aria-label={W.computer} data-testid="v2-new-computer">
                  <button type="button" aria-pressed={machine === null} onClick={() => setAgent({ machine: null, form: { ...agent.form, folder: null } })}>
                    <Icon name="laptop" size="s" />
                    {machines.data?.self.name ?? 'This computer'}
                  </button>
                  {peerList.map((peer) => {
                    const offline = peer.state === 'offline';
                    return (
                      <button
                        key={peer.id}
                        type="button"
                        aria-pressed={machine === peer.id}
                        disabled={offline}
                        title={offline ? W.offlineWhy(peer.name) : undefined}
                        data-machine={peer.id}
                        onClick={() => setAgent({ machine: peer.id, form: { ...agent.form, folder: null } })}
                      >
                        <Icon name={offline ? 'offline' : 'desktop'} size="s" />
                        {offline ? `${peer.name} · ${W.offlineSuffix}` : peer.name}
                      </button>
                    );
                  })}
                </div>
                {peerList.some((p) => p.state === 'offline') ? <div className="v2-field-hint">{W.offlineWhy(peerList.find((p) => p.state === 'offline')?.name ?? '')}</div> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {kind === 'agent' ? (
          <>
            <div className="v2-row v2-new-switch-row">
              <Switch label={W.separateCopy} checked={agent.form.worktrees && !isPlainFolder(folder)} disabled={isPlainFolder(folder)} onChange={(worktrees) => setForm({ worktrees })} testId="v2-new-copy" />
              <span>
                {W.separateCopy} <span className="v2-muted">· {isPlainFolder(folder) ? W.separateCopyPlain : W.separateCopyNote}</span>
              </span>
            </div>
            {layout.data && layout.data.folders.length > 0 ? (
              <div className="v2-row v2-new-put">
                <Icon name="folder" size="s" />
                <Select
                  label={W.putItIn}
                  value={agent.sidebarFolder}
                  onChange={(event) => setAgent({ sidebarFolder: event.currentTarget.value })}
                  options={[{ value: '', label: W.notInFolder }, ...layout.data.folders.map((f) => ({ value: f.id, label: f.name }))]}
                  data-testid="v2-new-put"
                  disabled={machine !== null}
                />
              </div>
            ) : null}
            <details className="v2-new-adv" data-testid="v2-new-advanced">
              <summary>
                <Icon name="chev" size="s" />
                {W.advanced}
                <span className="v2-muted">{W.advancedNote}</span>
              </summary>
              <div className="v2-new-grid">
                <Field label={W.titleField} placeholder={W.titlePlaceholder} value={agent.form.name} onChange={(event) => setForm({ name: event.currentTarget.value })} data-testid="v2-new-title" />
                <Field label={W.branch} placeholder={W.branchPlaceholder} value={agent.form.branch ?? ''} onChange={(event) => setForm({ branch: event.currentTarget.value === '' ? null : event.currentTarget.value })} disabled={!agent.form.worktrees || isPlainFolder(folder)} />
                <Select
                  label={W.engine}
                  value={provider}
                  onChange={(event) => setForm({ provider: event.currentTarget.value as typeof provider, profileId: null, model: null })}
                  options={(clis.data?.clis ?? [{ provider: 'claude', label: 'Claude Code', available: true, reason: null }]).map((cli) => ({ value: cli.provider, label: cli.available ? cli.label : `${cli.label} · ${cli.reason ?? 'unavailable'}`, disabled: !cli.available }))}
                />
                <Select
                  label={W.account}
                  value={agent.form.profileId ?? ''}
                  onChange={(event) => setForm({ profileId: event.currentTarget.value === '' ? null : event.currentTarget.value })}
                  options={[{ value: '', label: W.accountAuto }, ...(accounts.data?.profiles ?? []).filter((p) => p.cli === provider && p.enabled).map((p) => ({ value: p.id, label: p.exhausted ? `${p.name} (out of usage)` : p.name }))]}
                />
                <Select label={W.model} value={agent.exactModel} onChange={(event) => setAgent({ exactModel: event.currentTarget.value })} options={[{ value: '', label: W.modelBySpeed }, ...(offered ?? []).filter((o) => o.value !== 'default').map((o) => ({ value: o.value, label: o.label }))]} />
                <div className="v2-row v2-new-switch-row">
                  <Switch label={W.ultracode} checked={agent.form.ultracode} onChange={(ultracode) => setForm({ ultracode })} />
                  <span>
                    {W.ultracode} <span className="v2-muted">· {W.ultracodeNote}</span>
                  </span>
                </div>
              </div>
              {folder && !isRepoFolder(folder) && !isPlainFolder(folder) ? (
                <>
                  <div className="v2-row v2-new-switch-row">
                    <Switch label={W.askQuestions} checked={agent.askQuestions} onChange={(on) => setAgent({ askQuestions: on })} testId="v2-new-questions" />
                    <span>
                      {W.askQuestions} <span className="v2-muted">· {W.askQuestionsNote}</span>
                    </span>
                  </div>
                  {askQuestions ? (
                    <div className="v2-new-grid">
                      <Select label={W.workType} value={agent.form.workType} onChange={(event) => setForm({ workType: event.currentTarget.value as typeof agent.form.workType })} options={WORK_TYPE_OPTIONS.map(([value, label]) => ({ value, label }))} />
                      <Select label={W.mode} value={agent.form.mode} onChange={(event) => setForm({ mode: event.currentTarget.value as typeof agent.form.mode })} options={MODE_OPTIONS.map(([value, label]) => ({ value, label }))} />
                      <Select label={W.phase} value={agent.form.phase} onChange={(event) => setForm({ phase: event.currentTarget.value as typeof agent.form.phase })} options={PHASE_OPTIONS.map(([value, label]) => ({ value, label }))} />
                      <Select label={W.coordination} value={agent.form.coordination} onChange={(event) => setForm({ coordination: event.currentTarget.value as typeof agent.form.coordination })} options={COORDINATION_OPTIONS.map(([value, label]) => ({ value, label }))} />
                      <div className="v2-new-span">
                        <Label>{W.codeProjects}</Label>
                        <div className="v2-new-chips">
                          {chipGroups(solutions.data ?? null, agent.form.solutions).flatMap((group) =>
                            group.chips.map((chip) => (
                              <button key={chip.value} type="button" className="v2-new-chip" aria-pressed={chip.selected} disabled={chip.locked} onClick={() => setForm({ solutions: toggleSolution(agent.form.solutions, chip.value) })}>
                                {chip.label}
                              </button>
                            )),
                          )}
                        </div>
                        <div className="v2-field-hint">{W.codeProjectsNote}</div>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </details>
          </>
        ) : null}

        {kind === 'conversation' ? <p className="v2-new-note">{W.convNote}</p> : null}

        {kind === 'task' ? (
          <>
            <Field label={W.task} value={task.title} data-autofocus="" data-testid="v2-new-task-title" onChange={(event) => patch('task', { title: event.currentTarget.value })} error={fieldError(taskProblems(task).title)} />
            <div className="v2-new-grid">
              <Select label={W.priority} value={task.priority} onChange={(event) => patch('task', { priority: event.currentTarget.value as typeof task.priority })} options={(['urgent', 'high', 'medium', 'low'] as const).map((p) => ({ value: p, label: TODO_PRIORITY_LABELS[p] }))} />
              <Select label={W.estimate} value={task.estimate === null ? '' : String(task.estimate)} onChange={(event) => patch('task', { estimate: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })} options={ESTIMATES.map((m) => ({ value: m === null ? '' : String(m), label: estimateLabel(m) }))} />
            </div>
            <TextArea label={W.taskDescription} rows={3} value={task.description} onChange={(event) => patch('task', { description: event.currentTarget.value })} data-testid="v2-new-task-description" />
            <TextArea
              label={
                <>
                  {W.taskPlan} <span className="v2-muted">{W.taskPlanNote}</span>
                </>
              }
              rows={3}
              value={task.plan}
              onChange={(event) => patch('task', { plan: event.currentTarget.value })}
            />
            <Select label={W.forAgent} hint={agents.length === 0 ? W.noAgents : W.forAgentNote} value={task.agent} onChange={(event) => patch('task', { agent: event.currentTarget.value })} options={agentOptions(agents)} error={fieldError(taskProblems(task).agent)} data-testid="v2-new-task-agent" />
          </>
        ) : null}

        {kind === 'project' ? (
          <>
            <Field label={W.projectName} value={project.title} data-autofocus="" data-testid="v2-new-project-title" onChange={(event) => patch('project', { title: event.currentTarget.value })} error={fieldError(projectProblems(project).title)} />
            <Select label={W.projectOwner} hint={agents.length === 0 ? W.noAgents : W.projectOwnerNote} value={project.owner} onChange={(event) => patch('project', { owner: event.currentTarget.value })} options={agentOptions(agents)} error={fieldError(projectProblems(project).owner)} />
            <div className="v2-row v2-new-jira">
              <Button icon="jira" onClick={() => setJiraOpen(true)} data-testid="v2-new-jira">
                {W.importJira}
              </Button>
              <span className="v2-muted">{W.orWriteSteps}</span>
            </div>
            <TextArea label={W.projectSteps} hint={W.projectStepsNote} rows={4} value={project.steps} onChange={(event) => patch('project', { steps: event.currentTarget.value })} error={fieldError(projectProblems(project).steps)} data-testid="v2-new-project-steps" />
            {jiraOpen ? (
              <ImportJiraDialog
                onClose={() => setJiraOpen(false)}
                onImported={(plan) => {
                  setJiraOpen(false);
                  finish(W.projectMade(plan.title), `/projects/${encodeURIComponent(plan.id)}`);
                }}
              />
            ) : null}
          </>
        ) : null}

        {kind === 'routine' ? (
          <>
            <Field label={W.routineWhat} value={routine.prompt} data-autofocus="" data-testid="v2-new-routine-prompt" onChange={(event) => patch('routine', { prompt: event.currentTarget.value })} error={fieldError(routineProblems(routine).prompt)} />
            <div className="v2-new-grid">
              <Select label={W.routineHow} value={routine.preset} onChange={(event) => patch('routine', { preset: event.currentTarget.value })} options={ROUTINE_PRESETS.map((p) => ({ value: p.id, label: p.label }))} data-testid="v2-new-routine-how" />
              <Select
                label={W.routineAgent}
                hint={(() => {
                  const owner = agents.find((s) => s.id === routine.agent);
                  return owner ? W.routineOn(owner.machine?.name ?? machines.data?.self.name ?? 'this computer') : agents.length === 0 ? W.noAgents : undefined;
                })()}
                value={routine.agent}
                onChange={(event) => patch('routine', { agent: event.currentTarget.value })}
                options={agentOptions(agents)}
                error={fieldError(routineProblems(routine).agent)}
                data-testid="v2-new-routine-agent"
              />
            </div>
            {routine.preset === 'custom' ? <Field label={W.routineCron} value={routine.cron} placeholder="0 8 * * 1-5" onChange={(event) => patch('routine', { cron: event.currentTarget.value })} error={fieldError(routineProblems(routine).cron)} /> : null}
            <p className="v2-new-note">{W.routineNote}</p>
          </>
        ) : null}

        {kind === 'teammate' ? (
          <>
            <div className="v2-row v2-new-roles">
              <span className="v2-muted">{W.roleFrom}</span>
              {(templates.data ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="v2-new-chip"
                  aria-pressed={teammate.templateId === t.id}
                  title={t.summary}
                  onClick={() => patch('teammate', { templateId: t.id, name: t.name, owns: t.charter.owns, produces: t.charter.produces, neverDoes: t.charter.neverDoes })}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <Checkbox label={W.adopt} checked={teammate.adopt} onChange={(event) => patch('teammate', { adopt: event.currentTarget.checked })} />
            {teammate.adopt ? <Select label={W.adoptAgent} value={teammate.agent} onChange={(event) => patch('teammate', { agent: event.currentTarget.value })} options={agentOptions(agents)} error={fieldError(teammateProblems(teammate).agent)} /> : null}
            <div className="v2-new-grid">
              <Field label={W.role} value={teammate.name} data-testid="v2-new-role" onChange={(event) => patch('teammate', { name: event.currentTarget.value })} error={fieldError(teammateProblems(teammate).name)} />
              <Select label={W.joinsCrew} value={teammate.crew} onChange={(event) => patch('teammate', { crew: event.currentTarget.value })} options={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))} error={fieldError(teammateProblems(teammate).crew)} />
            </div>
            <Label>{W.jobDescription}</Label>
            <div className="v2-new-grid">
              <TextArea label={W.owns} rows={2} value={teammate.owns} onChange={(event) => patch('teammate', { owns: event.currentTarget.value })} />
              <TextArea label={W.produces} rows={2} value={teammate.produces} onChange={(event) => patch('teammate', { produces: event.currentTarget.value })} />
              <TextArea label={W.neverDoes} rows={2} value={teammate.neverDoes} onChange={(event) => patch('teammate', { neverDoes: event.currentTarget.value })} />
              {!teammate.adopt ? (
                <Select label={W.teammateFolder} value={teammate.folder} onChange={(event) => patch('teammate', { folder: event.currentTarget.value })} options={[{ value: '', label: '—' }, ...sortedFolders.map((f) => ({ value: f.id, label: f.displayName }))]} />
              ) : null}
            </div>
          </>
        ) : null}

        {kind === 'crew' ? (
          <>
            <Field label={W.crewName} value={sheet.crew.name} data-autofocus="" data-testid="v2-new-crew-name" onChange={(event) => patch('crew', { name: event.currentTarget.value })} error={fieldError(crewProblems(sheet.crew).name)} />
            <p className="v2-new-note">{W.crewNote}</p>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
