import { useMemo, useState } from 'react';
import type { Plan } from '../../../core/plans.ts';
import { usePlans } from '../../plans/store.ts';
import { Button, Card, Chip, ComputerTag, EmptyState, Icon, Segmented, Skeleton, StatusBadge } from '../components/index.ts';
import { PROJECT_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { openNew } from '../new/index.tsx';
import { clock } from '../shared/time.ts';
import { JiraImportDialog } from './JiraImport.tsx';
import { axisPercent, jiraTag, modeLabel, projectCounts, projectStatus, projectsTimeline, sortProjects, stepKind, stepName, timeLeft } from './project-model.ts';
import './projects.css';

const LIST_VIEW_KEY = 'switchboard.v2.projectsView';

/** The progress bar: done green, ready for approval violet, running blue. */
export function ProgressBar({ plan }: { readonly plan: Plan }) {
  const counts = projectCounts(plan);
  const total = Math.max(1, counts.total);
  const pct = (n: number): string => `${(n / total) * 100}%`;
  return (
    <div className="v2-p-progress" role="progressbar" aria-valuemin={0} aria-valuemax={counts.total} aria-valuenow={counts.done} aria-label={PROJECT_WORDS.stepsDone(counts.done, counts.total)}>
      <b style={{ width: pct(counts.done) }} />
      <i style={{ width: pct(counts.approval) }} />
      <u style={{ width: pct(counts.running) }} />
    </div>
  );
}

/** One project's card on the list. */
function ProjectCard({ plan, onOpen }: { readonly plan: Plan; readonly onOpen: () => void }) {
  const counts = projectCounts(plan);
  const status = projectStatus(plan);
  const left = timeLeft(plan);
  const tag = jiraTag(plan);
  const running = plan.items.filter((item) => stepKind(item) === 'running');
  return (
    <Card interactive className="v2-p-pcard" onClick={onOpen} data-testid="v2-project-card" data-plan-id={plan.id} aria-label={`${plan.title}, ${PROJECT_WORDS.stepsDone(counts.done, counts.total)}`}>
      <div className="v2-row v2-p-wrap">
        <h3 className="v2-p-pcard-title">{plan.title}</h3>
        {tag ? (
          <Chip tone="outline" icon="jira" size="s">
            {tag}
          </Chip>
        ) : null}
        {counts.needsYou > 0 ? <StatusBadge status="needs" label={PROJECT_WORDS.needYou(counts.needsYou)} size="s" /> : <StatusBadge status={status.status} label={status.label} size="s" />}
        {plan.state === 'paused' && counts.needsYou > 0 ? <StatusBadge status="paused" label="On hold" size="s" /> : null}
        {counts.stopped > 0 ? (
          <Chip tone="red" icon="octagon" size="s" className="v2-p-pcard-stopped">
            {PROJECT_WORDS.stoppedCount(counts.stopped)}
          </Chip>
        ) : null}
        {plan.machine ? <ComputerTag name={plan.machine.name} short state={plan.machine.state === 'online' ? 'online' : plan.machine.state === 'reconnecting' ? 'reconnecting' : 'offline'} /> : null}
        <span className="v2-grow" />
        {left ? <span className="v2-muted">{left}</span> : null}
      </div>
      <ProgressBar plan={plan} />
      <div className="v2-p-kv">
        <span>
          <b>
            {counts.done} of {counts.total}
          </b>
          steps done
        </span>
        <span>
          <b>{running.length > 0 ? running.map(stepName).join(', ') : 'Nothing'}</b>running now
        </span>
        {counts.approval > 0 ? (
          <span>
            <b>{counts.approval} ready</b>for your approval
          </span>
        ) : null}
        <span>
          <b>{modeLabel(plan.mergeMode)}</b>combining
        </span>
        {plan.sidebarFolder ? (
          <span>
            <b>
              <Icon name="folder" size="s" /> {plan.sidebarFolder.name}
            </b>
            its folder in Agents
          </span>
        ) : null}
      </div>
    </Card>
  );
}

/** The list's Timeline: one bar per started project on a shared axis, a now line. */
function ProjectsTimeline({ plans, onOpen }: { readonly plans: readonly Plan[]; readonly onOpen: (id: string) => void }) {
  const now = Date.now();
  const view = projectsTimeline(plans, now);
  if (view.bars.length === 0) return <EmptyState icon="gantt" tone="grey" title="Nothing on the timeline yet" text="A project shows here once it starts." />;
  const pct = (at: number): string => `${axisPercent(at, view.start, view.end).toFixed(2)}%`;
  const ticks = 6;
  return (
    <div className="v2-card v2-p-tl" data-testid="v2-projects-timeline">
      <div className="v2-p-tl-grid">
        <div className="v2-p-tl-axis-name" />
        <div className="v2-p-tl-axis">
          {Array.from({ length: ticks }, (_, index) => view.start + ((view.end - view.start) * index) / (ticks - 1)).map((at) => (
            <span key={at} style={{ left: pct(at) }}>
              {clock(new Date(at).toISOString())}
            </span>
          ))}
        </div>
        {view.bars.map((bar) => (
          <div key={bar.planId} className="v2-p-tl-line" data-testid="v2-projects-timeline-row">
            <button type="button" className="v2-p-tl-n" onClick={() => onOpen(bar.planId)} title={bar.title}>
              <span>{bar.title}</span>
            </button>
            <div className="v2-p-tl-r">
              <button type="button" className="v2-p-tl-bar" data-status={bar.status} data-projected={bar.projected || undefined} style={{ left: pct(bar.from), width: `calc(${pct(bar.to)} - ${pct(bar.from)})` }} onClick={() => onOpen(bar.planId)} aria-label={`Open ${bar.title}`}>
                {bar.title}
              </button>
              <span className="v2-p-tl-now" style={{ left: pct(now) }} aria-hidden="true" />
            </div>
          </div>
        ))}
      </div>
      <p className="v2-muted v2-p-tl-sum">Red line = now ({clock(new Date(now).toISOString())}). Dashed ends are projected from the steps’ estimates.</p>
    </div>
  );
}

/** D131 · Projects (`/projects`), lane P: every project with its progress and what waits; a Timeline of all of them. */
export function ProjectsPage() {
  const { plans, loaded, on } = usePlans();
  const { navigate } = useV2Router();
  const [view, setView] = useState<'cards' | 'timeline'>(() => {
    try {
      return window.localStorage.getItem(LIST_VIEW_KEY) === 'timeline' ? 'timeline' : 'cards';
    } catch {
      return 'cards';
    }
  });
  const [importing, setImporting] = useState(false);
  const sorted = useMemo(() => sortProjects(plans), [plans]);
  const open = (id: string): void => navigate({ area: 'project', id });
  const choose = (next: 'cards' | 'timeline'): void => {
    setView(next);
    try {
      window.localStorage.setItem(LIST_VIEW_KEY, next);
    } catch {
      // No storage.
    }
  };
  return (
    <div className="v2-page" data-wide="" data-testid="v2-page-projects" data-area="projects">
      <div className="v2-p-ph">
        <div className="v2-grow">
          <h1>Projects</h1>
          <p className="v2-page-sub">{PROJECT_WORDS.pageSub}</p>
        </div>
        <Segmented
          label="Projects view"
          value={view}
          onChange={choose}
          testId="v2-projects-views"
          options={[
            { value: 'cards', label: PROJECT_WORDS.cards, icon: 'grid' },
            { value: 'timeline', label: PROJECT_WORDS.timeline, icon: 'gantt' },
          ]}
        />
        <Button icon="jira" onClick={() => setImporting(true)} data-testid="v2-projects-import">
          {PROJECT_WORDS.importJira}
        </Button>
        <Button variant="primary" icon="plus" onClick={() => openNew({ kind: 'project' })} data-testid="v2-projects-new">
          {PROJECT_WORDS.newProject}
        </Button>
      </div>
      {!loaded ? (
        <div className="v2-p-pcards" aria-busy="true">
          {[0, 1].map((index) => (
            <div key={index} className="v2-card v2-p-pcard">
              <Skeleton width="40%" height={18} />
              <Skeleton height={10} style={{ margin: '16px 0' }} />
              <Skeleton lines={2} />
            </div>
          ))}
        </div>
      ) : !on ? (
        <EmptyState icon="alert" tone="grey" title="Projects aren’t available" text="Switchboard could not open its projects file. Restart it; if it stays, check the log." />
      ) : sorted.length === 0 ? (
        <EmptyState icon="projects" tone="grey" title={PROJECT_WORDS.noProjects} text={PROJECT_WORDS.noProjectsText} testId="v2-projects-empty" />
      ) : view === 'cards' ? (
        <div className="v2-p-pcards" data-testid="v2-project-cards">
          {sorted.map((plan) => (
            <ProjectCard key={plan.id} plan={plan} onOpen={() => open(plan.id)} />
          ))}
        </div>
      ) : (
        <ProjectsTimeline plans={sorted} onOpen={open} />
      )}
      {importing ? <JiraImportDialog onClose={() => setImporting(false)} /> : null}
    </div>
  );
}
