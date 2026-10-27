import { useCallback, useState } from 'react';
import type { Plan, PlanItem, PlanMergeMode } from '../../../core/plans.ts';
import type { PlanJiraState } from '../../../core/plans-jira.ts';
import { plansApi, refusalText } from '../../plans/api.ts';
import { jiraApi } from '../../plans/jira/api.ts';
import { itemsWaitingForRepos } from '../../plans/model.ts';
import { dropPlan } from '../../plans/store.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { useLayout } from '../../shell/useLayout.ts';
import { Button, Checkbox, Chip, ComputerTag, EmptyState, Icon, MenuButton, type MenuItem, Segmented, Select, Skeleton, useToast } from '../components/index.ts';
import { ACCOUNT_CHOICE_WORDS, MODE_LABELS, PROJECT_WORDS, STEP_LABELS } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import { CancelProjectDialog, DeleteProjectDialog, EditStepDialog, JiraSyncDialog, ModeAckDialog, ProjectAccountDialog, RereadDialog, SendBackDialog, StartDialog, StepDetailSheet } from './dialogs.tsx';
import { JiraSection, ProposalsBlock } from './JiraSection.tsx';
import { PROJECT_VIEWS, type ProjectView, agentsCombine, jiraTag, modeOptions, needsProtectedAck, projectCounts, projectNotesHref, protectedAckText, readProjectView, remoteBlock, restartableSteps, timeLeft } from './project-model.ts';
import { ProgressBar } from './ProjectsPage.tsx';
import { useProject } from './useProject.ts';
import { useStepActions } from './useStepActions.ts';
import { BoardView, GraphView, StepsView, TimelineView } from './views.tsx';
import './projects.css';

const VIEW_KEY = 'switchboard.v2.projectView';

function storedView(): ProjectView {
  try {
    return readProjectView(window.localStorage.getItem(VIEW_KEY));
  } catch {
    return 'steps';
  }
}

/** D131 · one project (`/projects/:id`), lane P: Steps / Board / Graph / Timeline, the header, its menus. */
export function ProjectPage({ id }: { readonly id: string }) {
  const data = useProject(id);
  if (data.gone) {
    return (
      <div className="v2-page" data-testid="v2-page-project" data-area="project">
        <V2Link to="/projects" className="v2-p-back">
          <Icon name="back" size="s" />
          Projects
        </V2Link>
        <EmptyState icon="projects" tone="grey" title="This project is gone" text="It was deleted, or it belongs to a computer that no longer lists it." testId="v2-project-gone" />
      </div>
    );
  }
  if (!data.plan) {
    return (
      <div className="v2-page" data-wide="" data-testid="v2-page-project" data-area="project" aria-busy="true">
        <Skeleton width={180} height={14} />
        <Skeleton width="50%" height={30} style={{ margin: '14px 0 22px' }} />
        <Skeleton lines={4} height={18} />
        {data.error ? (
          <p className="v2-field-error" role="alert">
            {data.error}
          </p>
        ) : null}
      </div>
    );
  }
  return <ProjectBody plan={data.plan} jira={data.jira} proposals={data.proposals} todos={data.todos} put={data.put} reload={data.reload} />;
}

type Overlay =
  | { readonly kind: 'start' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'reread' }
  | { readonly kind: 'sync' }
  | { readonly kind: 'ack'; readonly mode: PlanMergeMode }
  | { readonly kind: 'sendback'; readonly item: PlanItem }
  | { readonly kind: 'edit'; readonly item: PlanItem }
  | { readonly kind: 'details'; readonly itemId: string }
  | { readonly kind: 'account' };

function ProjectBody({ plan, jira, proposals, todos, put, reload }: { readonly plan: Plan; readonly jira: PlanJiraState | null; readonly proposals: ReturnType<typeof useProject>['proposals']; readonly todos: ReturnType<typeof useProject>['todos']; readonly put: (plan: Plan) => void; readonly reload: () => Promise<void> }) {
  const layout = useLayout();
  const phone = layout === 'phone';
  const [viewChoice, setViewChoice] = useState<ProjectView>(storedView);
  const view: ProjectView = phone ? 'steps' : viewChoice;
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [draftMode, setDraftMode] = useState<PlanMergeMode | null>(null);
  const [jiraState, setJiraState] = useState<PlanJiraState | null>(null);
  const toast = useToast();
  const { navigate } = useV2Router();
  const close = useCallback(() => setOverlay(null), []);
  const actions = useStepActions(plan, put, (item) => setOverlay({ kind: 'edit', item }));
  const counts = projectCounts(plan);
  const left = timeLeft(plan);
  const tag = jiraTag(plan);
  const jiraNow = jiraState ?? jira;
  const blocked = remoteBlock(plan);
  const finished = plan.state === 'done' || plan.state === 'cancelled';
  const started = plan.state !== 'draft';
  const mode = plan.mergeMode ?? draftMode;
  const waitingRepos = itemsWaitingForRepos(plan);
  const sessions = useSessionListOf();
  const notesHref = projectNotesHref(plan, sessions.data ?? []);

  const setView = (next: ProjectView): void => {
    setViewChoice(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // No storage: the choice lasts for this page.
    }
  };

  const changeMode = async (next: PlanMergeMode): Promise<void> => {
    if (!started) {
      setDraftMode(next);
      return;
    }
    if (next === plan.mergeMode) return;
    if (needsProtectedAck(plan, next) && !plan.allowProtectedTarget) {
      setOverlay({ kind: 'ack', mode: next });
      return;
    }
    try {
      put(await plansApi.setMode(plan.id, next, plan.allowProtectedTarget ? { allowProtectedTarget: true } : {}));
      toast({ text: `${PROJECT_WORDS.whoApproves}: ${MODE_LABELS[next]}.` });
    } catch (e) {
      toast({ text: refusalText(e), tone: 'error' });
    }
  };

  const toggleAck = async (checked: boolean): Promise<void> => {
    if (!plan.mergeMode) return;
    try {
      put(await plansApi.setMode(plan.id, plan.mergeMode, { allowProtectedTarget: checked }));
    } catch (e) {
      toast({ text: refusalText(e), tone: 'error' });
    }
  };

  const pauseResume = async (): Promise<void> => {
    try {
      if (plan.state === 'paused') {
        put(await plansApi.resume(plan.id));
        toast({ text: 'Resumed. Waiting steps start again.' });
      } else {
        const next = await plansApi.pause(plan.id);
        put(next);
        toast({ text: 'On hold. Running steps finish; nothing new starts.', undo: async () => put(await plansApi.resume(plan.id)) });
      }
    } catch (e) {
      toast({ text: refusalText(e), tone: 'error' });
    }
  };

  const isJira = plan.external?.system === 'jira';
  const projectMenu: MenuItem[] = [
    { id: 'reread', label: PROJECT_WORDS.rereadDeps, icon: 'jira', ...(isJira ? (started ? { disabledReason: 'Only before the project starts.' } : {}) : { disabledReason: 'This project isn’t from Jira.' }), onSelect: () => setOverlay({ kind: 'reread' }) },
    { id: 'sync', label: PROJECT_WORDS.jiraSync, icon: 'sliders', ...(isJira && jiraNow ? {} : { disabledReason: 'This project isn’t from Jira.' }), onSelect: () => setOverlay({ kind: 'sync' }) },
    {
      id: 'propose',
      label: PROJECT_WORDS.proposeOrder,
      icon: 'diagram',
      ...(started ? { disabledReason: 'Only before the project starts.' } : plan.items.length < 2 ? { disabledReason: 'It needs two steps or more.' } : {}),
      onSelect: async () => {
        try {
          await jiraApi.askForOrder(plan.id);
          toast({ text: 'Asked the project’s agent to propose an order. Its proposals appear here.' });
        } catch (e) {
          toast({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
        }
      },
    },
    // D138: the project's account per engine.
    { id: 'account', label: ACCOUNT_CHOICE_WORDS.projectAccountMenu, icon: 'wallet', ...(finished ? { disabledReason: `It is ${plan.state} already.` } : blocked ? { disabledReason: blocked } : {}), onSelect: () => setOverlay({ kind: 'account' }) },
    { separator: true, id: 'sep' },
    { id: 'cancel', label: PROJECT_WORDS.cancel, icon: 'stop', ...(finished ? { disabledReason: `It is ${plan.state} already.` } : {}), onSelect: () => setOverlay({ kind: 'cancel' }) },
    { id: 'delete', label: PROJECT_WORDS.deleteProject, icon: 'trash', danger: true, ...(blocked ? { disabledReason: blocked } : {}), onSelect: () => setOverlay({ kind: 'delete' }) },
  ];

  const restartable = restartableSteps(plan);
  const restartAll = async (): Promise<void> => {
    try {
      const answer = await plansApi.restartStopped(plan.id);
      put(answer.plan);
      toast({ text: answer.waiting > 0 ? `Restarted ${answer.restarted}; ${answer.waiting} wait for their account (see Needs you).` : `Restarted ${answer.restarted} stopped step${answer.restarted === 1 ? '' : 's'}.` });
    } catch (e) {
      toast({ text: refusalText(e), tone: 'error' });
    }
  };

  const viewProps = { plan, actions, onDetails: (item: PlanItem) => setOverlay({ kind: 'details', itemId: item.id }), onSendBack: (item: PlanItem) => setOverlay({ kind: 'sendback', item }) };
  const detailsItem = overlay?.kind === 'details' ? plan.items.find((item) => item.id === overlay.itemId) : undefined;
  const ackShown = mode !== null && agentsCombine(mode) && needsProtectedAck(plan, mode);
  const options = modeOptions(plan);

  return (
    <div className="v2-page v2-p-project" data-wide="" data-testid="v2-page-project" data-area="project" data-state={plan.state} data-held={plan.state === 'paused' || undefined}>
      <V2Link to="/projects" className="v2-p-back" data-testid="v2-project-back">
        <Icon name="back" size="s" />
        Projects
      </V2Link>
      <div className="v2-p-project-title">
        <h1>{plan.title}</h1>
        {tag ? (
          <Chip tone="outline" icon="jira" size="s">
            {tag}
          </Chip>
        ) : null}
        {plan.sidebarFolder ? (
          <V2Link to="/agents" className="v2-p-tag-link" title="Its folder in Agents">
            <Icon name="folder" size="s" />
            {plan.sidebarFolder.name}
          </V2Link>
        ) : null}
        {plan.machine ? <ComputerTag name={plan.machine.name} state={plan.machine.state === 'online' ? 'online' : plan.machine.state === 'reconnecting' ? 'reconnecting' : 'offline'} /> : null}
        <span className="v2-grow" />
        {phone ? null : (
          <Segmented
            label="Project view"
            value={view}
            onChange={setView}
            testId="v2-project-views"
            options={PROJECT_VIEWS.map((value) => ({ value, label: PROJECT_WORDS[value], icon: value === 'steps' ? 'list' : value === 'board' ? 'board' : value === 'graph' ? 'diagram' : 'gantt' }))}
          />
        )}
      </div>

      <section className="v2-card v2-p-project-head" aria-label="Progress and approval">
        <div className="v2-row v2-p-wrap">
          <b data-testid="v2-project-count">
            {PROJECT_WORDS.stepsDone(counts.done, counts.total)}
            {counts.approval > 0 ? ` · ${counts.approval} waiting for your approval` : ''}
          </b>
          {left ? <span className="v2-muted">· {left}</span> : null}
          {counts.stopped > 0 ? (
            <Chip tone="red" icon="octagon" size="s">
              {PROJECT_WORDS.stoppedCount(counts.stopped)}
            </Chip>
          ) : null}
          <span className="v2-grow" />
          <label className="v2-muted v2-p-mode-label" htmlFor="v2-project-mode">
            {PROJECT_WORDS.whoApproves}:
          </label>
          <Select
            id="v2-project-mode"
            className="v2-p-mode-select"
            value={mode ?? ''}
            disabled={finished || blocked !== null}
            onChange={(event) => void changeMode(event.currentTarget.value as PlanMergeMode)}
            data-testid="v2-project-mode"
            options={[
              ...(mode === null ? [{ value: '', label: MODE_LABELS.unset, disabled: true }] : []),
              ...options.map((option) => ({ value: option, label: MODE_LABELS[option], disabled: started && plan.mergeMode !== null && (option === 'none') !== (plan.mergeMode === 'none') })),
            ]}
          />
          {plan.state === 'draft' ? (
            <Button variant="primary" icon="play" disabled={plan.items.length === 0 || blocked !== null} onClick={() => setOverlay({ kind: 'start' })} data-testid="v2-project-start">
              {PROJECT_WORDS.start}
            </Button>
          ) : null}
          {plan.state === 'running' || plan.state === 'paused' ? (
            <Button icon={plan.state === 'paused' ? 'play' : 'pause'} disabled={blocked !== null} onClick={() => void pauseResume()} data-testid="v2-project-hold">
              {plan.state === 'paused' ? PROJECT_WORDS.resume : PROJECT_WORDS.pause}
            </Button>
          ) : null}
          {/* D139: the steps whose agent failed start again (those whose account still needs you wait). */}
          {restartable.length > 0 ? (
            <Button icon="refresh" disabled={blocked !== null} onClick={() => void restartAll()} data-testid="v2-project-restart-stopped">
              {PROJECT_WORDS.restartStopped(restartable.length)}
            </Button>
          ) : null}
          <MenuButton items={projectMenu} label="Project actions" testId="v2-project-menu" />
        </div>
        <ProgressBar plan={plan} />
        <div className="v2-p-legend" aria-hidden="true">
          <span>
            <Icon name="check-circle" size="s" className="is-green" />
            {STEP_LABELS.done}
          </span>
          <span>
            <Icon name="half" size="s" className="is-violet" />
            {STEP_LABELS.approval}
          </span>
          <span>
            <Icon name="dot" size="s" className="is-blue" />
            Running
          </span>
          <span>
            <Icon name="circle" size="s" />
            {STEP_LABELS.waiting}
          </span>
          <span>
            <Icon name="hand" size="s" className="is-amber" />
            {STEP_LABELS.needs}
          </span>
          <span>
            <Icon name="octagon" size="s" className="is-red" />
            Stopped
          </span>
        </div>
        {ackShown ? (
          <div className="v2-row v2-p-wrap v2-p-ack-row">
            {started ? (
              <Checkbox plain label={protectedAckText(plan)} checked={plan.allowProtectedTarget} disabled={finished || blocked !== null} onChange={(event) => void toggleAck(event.currentTarget.checked)} data-testid="v2-project-ack" />
            ) : (
              <span className="v2-muted">You confirm “{protectedAckText(plan)}” when you start.</span>
            )}
            <span className="v2-muted v2-p-small">{PROJECT_WORDS.protectedAckNote}</span>
          </div>
        ) : null}
        {plan.state === 'paused' ? (
          <div className="v2-p-note" data-testid="v2-project-held">
            <Icon name="pause" size="s" />
            {plan.pausedReason ? `On hold: ${plan.pausedReason}. ` : ''}
            {PROJECT_WORDS.heldNote}
          </div>
        ) : null}
        {plan.state === 'running' && plan.held ? (
          <div className="v2-p-note">
            <Icon name="hourglass" size="s" />
            New steps wait: {plan.held}
          </div>
        ) : null}
        {waitingRepos.length > 0 ? (
          <div className="v2-p-note" data-testid="v2-project-pick">
            <Icon name="folder" size="s" />
            <span className="v2-grow">
              {waitingRepos.length} step{waitingRepos.length === 1 ? '' : 's'}: {STEP_LABELS.pick}.
            </span>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const answer = await jiraApi.askForRepos(plan.id);
                  toast({ text: `Asked the project’s agent to pick the code projects of ${answer.items} step${answer.items === 1 ? '' : 's'}.` });
                } catch (e) {
                  toast({ text: e instanceof Error ? e.message : String(e), tone: 'error' });
                }
              }}
            >
              Ask again
            </Button>
          </div>
        ) : null}
      </section>

      <ProposalsBlock plan={plan} proposals={proposals} onChanged={() => void reload()} />

      <div role="region" aria-label={`${PROJECT_WORDS[view]} view`} data-testid="v2-project-view" data-view={view}>
        {view === 'steps' ? <StepsView {...viewProps} /> : view === 'board' ? <BoardView {...viewProps} /> : view === 'graph' ? <GraphView {...viewProps} /> : <TimelineView {...viewProps} />}
      </div>

      {isJira && jiraNow ? <JiraSection plan={plan} state={jiraNow} onRefreshed={setJiraState} /> : null}

      <section className="v2-card v2-p-know" aria-label={PROJECT_WORDS.whatAgentsKnow} data-testid="v2-project-know">
        <Icon name="book" size="s" />
        <b>{PROJECT_WORDS.whatAgentsKnow}</b>
        <span className="v2-muted v2-p-know-text">{PROJECT_WORDS.whatAgentsKnowText}</span>
        <span className="v2-grow" />
        <V2Link to={notesHref} className="v2-btn" data-size="sm" data-testid="v2-project-notes" style={{ textDecoration: 'none' }}>
          {PROJECT_WORDS.openNotes}
        </V2Link>
      </section>

      {overlay?.kind === 'start' ? (
        <StartDialog
          plan={plan}
          initialMode={draftMode}
          onClose={close}
          onStarted={(next) => {
            put(next);
            close();
            toast({ text: `Started “${next.title}”. Ready steps start now.` });
          }}
        />
      ) : null}
      {overlay?.kind === 'ack' ? (
        <ModeAckDialog
          plan={plan}
          mode={overlay.mode}
          onClose={close}
          onChanged={(next) => {
            put(next);
            close();
          }}
        />
      ) : null}
      {overlay?.kind === 'account' ? <ProjectAccountDialog plan={plan} onClose={close} onChanged={put} /> : null}
      {overlay?.kind === 'sendback' ? <SendBackDialog item={overlay.item} onClose={close} onSend={(comment) => actions.sendBack(overlay.item, comment)} /> : null}
      {overlay?.kind === 'edit' ? <EditStepDialog item={overlay.item} onClose={close} onSave={(title, estimate) => actions.edit(overlay.item, title, estimate)} /> : null}
      {overlay?.kind === 'delete' ? (
        <DeleteProjectDialog
          plan={plan}
          onClose={close}
          onDeleted={() => {
            dropPlan(plan.id);
            toast({ text: `Deleted “${plan.title}”. Its agents stay in Agents.` });
            navigate('/projects');
          }}
        />
      ) : null}
      {overlay?.kind === 'cancel' ? (
        <CancelProjectDialog
          plan={plan}
          onClose={close}
          onCancelled={(next) => {
            put(next);
            close();
          }}
        />
      ) : null}
      {overlay?.kind === 'reread' ? (
        <RereadDialog
          plan={plan}
          onClose={close}
          onApplied={() => {
            close();
            void reload();
          }}
        />
      ) : null}
      {overlay?.kind === 'sync' && jiraNow ? (
        <JiraSyncDialog
          plan={plan}
          state={jiraNow}
          onClose={close}
          onSaved={(state) => {
            setJiraState(state);
            close();
            toast({ text: 'Jira sync saved.' });
          }}
        />
      ) : null}
      {detailsItem ? (
        <StepDetailSheet
          plan={plan}
          item={detailsItem}
          todo={todos.get(detailsItem.todoId) ?? null}
          onClose={close}
          onOpenAgent={() => {
            close();
            actions.openAgent(detailsItem);
          }}
          onAction={(action) => {
            close();
            void actions.run(detailsItem, action);
          }}
        />
      ) : null}
    </div>
  );
}
