import type { ReactNode } from 'react';
// Project memory (D107) hook, D136: Settings → Advanced → Notes checks (docs/memory-removal.md).
import { MemoryCheckSection } from '../../memory/CheckSettings.tsx';
import { UpdatesSection } from '../../updates/UpdatesSection.tsx';
import { McpView } from '../../views/McpView.tsx';
import { SolutionsView } from '../../views/SolutionsView.tsx';
import { AccountsSection as ClassicAccounts } from '../../views/settings/AccountsSection.tsx';
import { CiSection } from '../../views/settings/CiSection.tsx';
import { CleanupSection } from '../../views/settings/CleanupSection.tsx';
import { ClisSection } from '../../views/settings/ClisSection.tsx';
import { DevicesSection } from '../../views/settings/DevicesSection.tsx';
import { JiraSection } from '../../views/settings/JiraSection.tsx';
import { MachinesSection } from '../../views/settings/MachinesSection.tsx';
import { ModelRulesRow } from '../../views/settings/ModelRulesRow.tsx';
import { ProcessesSection } from '../../views/settings/ProcessesSection.tsx';
import { StartAtLoginRow } from '../../views/settings/StartAtLogin.tsx';
import { ToolsSection } from '../../views/settings/ToolsSection.tsx';
import { WorkspaceSection } from '../../views/settings/WorkspaceSection.tsx';
import { ClaudeSection, GithubSection, NotifySection, SchedulesSection, SessionsSection } from '../../views/settings/sections.tsx';
import { Button, Card, EmptyState, Icon, Skeleton } from '../components/index.ts';
import { ARCHIVE_WORDS, SETTINGS_WORDS as W } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { V2ToursSection } from '../tour/ToursSection.tsx';
import { ClassicFrame, useClassicModals } from './ClassicFrame.tsx';
import { ADVANCED_PAGES, type AdvancedKind, type AdvancedPage, resolveAdvanced } from './settings-map.ts';
import { useKnownSettings } from './sections.tsx';

/**
 * D131 · lane R · Settings › Advanced (the prototype's `#set-advanced`): a list of
 * pages, each `/settings/advanced/<key>`, that embed the classic Settings section
 * (or classic page) in a v2 frame, so nothing of classic Settings is lost
 * (`settings-map.ts` → `ADVANCED_PAGES`).
 */
export function AdvancedSection({ sub }: { readonly sub: string | null }) {
  if (!sub) return <AdvancedList />;
  const page = resolveAdvanced(sub);
  return (
    <div className="v2-set-stack" data-testid="v2-advanced-page" data-page={page?.key ?? sub}>
      <V2Link to={{ area: 'settings', section: 'advanced', sub: null }} className="v2-btn v2-set-backlink" data-variant="ghost" data-size="sm" data-testid="v2-advanced-back">
        <Icon name="back" size="s" />
        {W.advancedBack}
      </V2Link>
      {page ? (
        <>
          <h2 className="v2-set-h2">
            <Icon name={page.icon} /> {page.label}
          </h2>
          <Card pad className="v2-set-card v2-adv-card">
            <ClassicFrame testId="v2-advanced-body">
              <AdvancedBody kind={page.key} />
            </ClassicFrame>
          </Card>
        </>
      ) : (
        <EmptyState icon="alert" tone="grey" title={W.advancedMissing} testId="v2-advanced-missing" />
      )}
    </div>
  );
}

function AdvancedList() {
  return (
    <div className="v2-set-stack" data-testid="v2-advanced-list">
      <p className="v2-muted v2-set-p">{W.advancedSub}</p>
      <Card className="v2-adv-list">
        {ADVANCED_PAGES.map((page: AdvancedPage) => (
          <V2Link key={page.key} to={{ area: 'settings', section: 'advanced', sub: page.key }} className="v2-adv-row" data-testid={`v2-advanced-${page.key}`}>
            <span className="v2-comp-icon v2-adv-icon">
              <Icon name={page.icon} />
            </span>
            <span className="v2-grow">
              <span className="v2-adv-ttl">{page.label}</span>
              <span className="v2-muted v2-set-small v2-adv-sub">{page.sub}</span>
            </span>
            <Icon name="chev" className="v2-muted" />
          </V2Link>
        ))}
      </Card>
    </div>
  );
}

/** A classic section that needs the settings body. */
function WithSettings({ children }: { readonly children: (state: ReturnType<typeof useKnownSettings> & { readonly settings: NonNullable<ReturnType<typeof useKnownSettings>['settings']> }) => ReactNode }) {
  const state = useKnownSettings();
  if (!state.settings) return state.error ? <EmptyState icon="alert" tone="grey" title={W.loadError} /> : <Skeleton lines={4} />;
  return (
    <>
      {children({ ...state, settings: state.settings })}
      {state.saveError ? (
        <div className="v2-set-error" role="alert">
          {state.saveError}
        </div>
      ) : null}
    </>
  );
}

function SetupWizardPage() {
  const { open } = useClassicModals();
  return (
    <div>
      <p>{W.runSetupSub}</p>
      <Button variant="primary" icon="sparkle" onClick={() => open('setup-wizard')} data-testid="v2-run-setup">
        {W.runSetup}
      </Button>
    </div>
  );
}

function AdvancedBody({ kind }: { readonly kind: AdvancedKind }) {
  switch (kind) {
    case 'code-projects':
      return <SolutionsView />;
    case 'connections':
      return <McpView />;
    case 'clis':
      return (
        <WithSettings>
          {({ settings, onSaved }) => (
            <>
              <ClisSection />
              <ModelRulesRow settings={settings} onSaved={onSaved} />
            </>
          )}
        </WithSettings>
      );
    case 'workspace':
      return <WorkspaceSection />;
    case 'sessions':
      // D137: the archive's row in v2 words.
      return <WithSettings>{({ settings, save, onSaved }) => <SessionsSection settings={settings} save={save} onSaved={onSaved} archiveWords={ARCHIVE_WORDS} />}</WithSettings>;
    case 'schedules':
      return <SchedulesSection />;
    case 'tools':
      return <ToolsSection />;
    case 'github':
      return <WithSettings>{({ settings }) => <GithubSection settings={settings} />}</WithSettings>;
    case 'ci':
      return <WithSettings>{({ settings, save }) => <CiSection settings={settings} save={save} />}</WithSettings>;
    case 'processes':
      return <WithSettings>{({ settings, save }) => <ProcessesSection settings={settings} save={save} />}</WithSettings>;
    case 'jira':
      return <JiraSection />;
    case 'updates':
      return <UpdatesSection />;
    case 'tutorial':
      // Lane X · tour: the v2 tours, replayed with highlighting in v2 (the classic ones stay in Classic).
      return <V2ToursSection />;
    case 'cleanup':
      return <CleanupSection />;
    case 'setup':
      return <SetupWizardPage />;
    case 'login':
      return <StartAtLoginRow />;
    case 'claude':
      return <WithSettings>{({ settings }) => <ClaudeSection settings={settings} />}</WithSettings>;
    case 'notify':
      return <WithSettings>{({ settings, save, onSaved }) => <NotifySection settings={settings} save={save} onSaved={onSaved} />}</WithSettings>;
    case 'accounts':
      return <ClassicAccounts />;
    case 'machines':
      return <MachinesSection />;
    case 'devices':
      return <DevicesSection />;
    // Project memory (D107) hook, D136: the automatic checks (docs/memory-removal.md).
    case 'memory':
      return <MemoryCheckSection />;
  }
}
