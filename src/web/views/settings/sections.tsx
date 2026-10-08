import { useState } from 'react';
import type { KnownSettings } from '../../../core/settings.ts';
import { cronLabel } from '../../../core/cron-label.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useModals } from '../../modals/ModalHost.tsx';
import { useToasts } from '../../toast/ToastHost.tsx';
import {
  accountValue,
  cliRow,
  ghValue,
  notificationState,
  pollValue,
  repoCount,
  scheduleColor,
  warnAtOptions,
} from './model.ts';
import { notificationPermission, notifyOS, playChime, requestNotifications } from './notify.ts';
import { InstallAppRow } from './InstallApp.tsx';
import { Action, Row, SectionTitle, ToggleValue, Value } from './rows.tsx';
import { StandingInstructionRow } from './StandingInstruction.tsx';
import { StartAtLoginToggle } from './StartAtLogin.tsx';

/**
 * The row-based Settings sections (M8.2, SPEC → Settings; copy from the
 * prototype's `rowsClaude` / `rowsSessions` / notify markup / `scheds` /
 * `rowsGithub`). Values come from `GET /api/settings`, `GET /api/system` (M5.3),
 * `GET /api/schedules` (M7.1) and `GET /api/solutions` (M6.1); what the API
 * cannot tell reads "unknown".
 */

/** Saves a subset of the editable settings (`PUT /api/settings`). */
export type SaveSettings = (patch: Partial<KnownSettings>) => Promise<void>;

/** Claude Code: CLI, account, service, bind address, start at login, install as app (D34, when offered), permissions + Run setup again. */
export function ClaudeSection({ settings }: { readonly settings: KnownSettings }) {
  const system = useApi(api.system);
  const { open } = useModals();
  const cli = cliRow(system.data);
  return (
    <>
      <SectionTitle>Claude Code</SectionTitle>
      <Row id="cli" label="CLI" description={cli.description}>
        <Value>{cli.value}</Value>
      </Row>
      <Row id="account" label="Account" description="Uses the CLI's own login. Switchboard stores no credentials.">
        <Value>{accountValue(system.data)}</Value>
      </Row>
      <Row id="service" label="Background service" description="Starts and supervises Claude Code processes">
        <Value>{`${settings['service.address'] || window.location.host} · running`}</Value>
      </Row>
      <Row id="bind" label="Bind address" description="The service never listens beyond this PC">
        <Value>localhost only</Value>
      </Row>
      <Row id="start-at-login" label="Start at login" description="Launch the service when you sign in (Windows / macOS)">
        <StartAtLoginToggle />
      </Row>
      <InstallAppRow />
      <Row
        id="permissions"
        label="Permissions"
        description="Follow Claude Code's .claude/settings.json. Only agent questions and permission requests surface here."
      >
        <Value>managed by Claude Code</Value>
      </Row>
      <div className="sb-set-actions">
        <button type="button" className="sb-set-button" data-testid="settings-run-setup" onClick={() => open('setup-wizard')}>
          Run setup again
        </button>
      </div>
    </>
  );
}

/** Sessions & worktrees: fixed rules plus the New-session defaults (worktrees, ultracode), D75's todo finish reminder and D64's standing instruction for agents. */
export function SessionsSection({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const [busy, setBusy] = useState(false);
  const flip = (key: 'sessions.worktrees' | 'sessions.ultracode' | 'sessions.todoReminder' | 'sessions.reviewCards'): void => {
    setBusy(true);
    void save({ [key]: !settings[key] }).finally(() => setBusy(false));
  };
  return (
    <>
      <SectionTitle>Sessions &amp; worktrees</SectionTitle>
      <Row
        id="working-folder"
        label="Working folder"
        description="A workspace session starts at the folder root, so the router applies; a repo session in the repo or its worktree"
      >
        <Value>the session&apos;s folder</Value>
      </Row>
      <Row id="worktrees" label="Worktree per session" description="One worktree per solution the session writes to">
        <ToggleValue label="Worktree per session" value={settings['sessions.worktrees']} disabled={busy} onToggle={() => flip('sessions.worktrees')} />
      </Row>
      <Row id="worktree-location" label="Worktree location" description="Next to the repo">
        <Value>{'../{repo}-wt-{session}'}</Value>
      </Row>
      <Row id="cleanup" label="Cleanup" description="Keep until the branch's PR is merged on GitHub">
        <Value>keep until merged</Value>
      </Row>
      <Row id="ultracode" label="Ultracode by default" description="Pre-select workflows in the new-session form">
        <ToggleValue label="Ultracode by default" value={settings['sessions.ultracode']} disabled={busy} onToggle={() => flip('sessions.ultracode')} />
      </Row>
      <Row
        id="session-start"
        label="Session-start questions"
        description="Asked in the new-session form and passed to the agent as confirmed answers"
      >
        <Value>from AGENTS.md</Value>
      </Row>
      {/* D75: one reminder when a turn ends with a started todo still in progress and untouched. */}
      <Row
        id="todo-reminder"
        label="Remind the agent to finish started todos"
        description="When a turn ends with an item it started still in progress, send it one reminder to mark it done or say what's left"
      >
        <ToggleValue label="Remind the agent to finish started todos" value={settings['sessions.todoReminder']} disabled={busy} onToggle={() => flip('sessions.todoReminder')} />
      </Row>
      {/* D79: a Review card when a session with changes goes idle. */}
      <Row
        id="review-cards"
        label="Raise review cards when a session with changes goes idle"
        description="Once per change set, in the Inbox and on the session's header; advisory, never blocks the agent"
      >
        <ToggleValue label="Raise review cards when a session with changes goes idle" value={settings['sessions.reviewCards']} disabled={busy} onToggle={() => flip('sessions.reviewCards')} />
      </Row>
      <StandingInstructionRow settings={settings} save={save} />
    </>
  );
}

/** Notifications & usage: Send test, OS notification permission + Allow, the warning threshold, "just warn". */
export function NotifySection({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const { show } = useToasts();
  const [permission, setPermission] = useState(notificationPermission);
  const state = notificationState(permission);
  const sendTest = (): void => {
    show({
      id: 'settings-test-notification',
      title: 'Test notification',
      sub: 'now',
      branch: 'this is how questions arrive',
      text: 'Sound, toast and OS notification all fire together.',
      sessionId: null,
    });
    playChime();
    notifyOS('Switchboard', 'Test notification');
  };
  const allow = (): void => {
    void requestNotifications().then(setPermission, () => setPermission(notificationPermission()));
  };
  const warnAt = settings['usage.warnAtPct'];
  return (
    <>
      <SectionTitle>Notifications &amp; usage</SectionTitle>
      <Row id="toast" label="In-app toast + sound" description="Questions, approvals, failed scheduled runs, merged-PR worktrees">
        <Action testId="settings-send-test" onClick={sendTest}>
          Send test
        </Action>
      </Row>
      <Row id="os-notifications" label="OS notifications" description="Windows / macOS notification center, also when the tab is in the background">
        <Value color={state.color}>{state.text}</Value>
        <Action testId="settings-allow-notifications" onClick={allow}>
          Allow
        </Action>
      </Row>
      <Row id="warn-at" label="Warn at Max usage" description="5-hour window and weekly limit">
        <select
          className="sb-set-select"
          data-testid="setting-value"
          aria-label="Warn at Max usage"
          value={warnAt}
          onChange={(event) => void save({ 'usage.warnAtPct': Number(event.target.value) })}
        >
          {warnAtOptions(warnAt).map((pct) => (
            <option key={pct} value={pct}>{`${pct}%`}</option>
          ))}
        </select>
      </Row>
      <Row id="near-limit" label="Near the limit" description="Sessions and scheduled runs keep going">
        <Value>just warn</Value>
      </Row>
    </>
  );
}

/** Schedules: dot, name, cron (readable), description, from `GET /api/schedules` (M7.1). */
export function SchedulesSection() {
  const schedules = useApi(api.schedules);
  return (
    <>
      <SectionTitle>Schedules</SectionTitle>
      {schedules.data?.map((schedule) => (
        <div key={schedule.id} className="sb-set-sched" data-schedule={schedule.name}>
          <span className="sb-set-sched-dot" style={{ background: scheduleColor(schedule) }} />
          <span className="sb-set-sched-name">{schedule.name}</span>
          <span className="sb-set-sched-cron" title={schedule.cron}>
            {cronLabel(schedule.cron)}
          </span>
          <span className="sb-set-sched-desc">{schedule.description}</span>
        </div>
      ))}
      {schedules.data?.length === 0 ? (
        <div className="sb-set-note" data-testid="settings-note">
          No schedules.
        </div>
      ) : null}
      {!schedules.data && schedules.error ? (
        <div className="sb-set-note" data-testid="settings-note">
          Schedules could not be loaded.
        </div>
      ) : null}
    </>
  );
}

/** GitHub: gh login (M5.3), PR merge detection interval, repositories found by the scan (M6.1). */
export function GithubSection({ settings }: { readonly settings: KnownSettings }) {
  const system = useApi(api.system);
  const solutions = useApi(api.solutions);
  return (
    <>
      <SectionTitle>GitHub</SectionTitle>
      <Row id="gh-login" label="GitHub CLI login" description="Reused from gh auth. No token stored in Switchboard.">
        <Value>{ghValue(system.data)}</Value>
      </Row>
      <Row id="pr-detection" label="PR merge detection" description="Marks a worktree ready to remove once its PR is merged">
        <Value>{pollValue(settings['github.prPollMinutes'])}</Value>
      </Row>
      <Row id="repositories" label="Repositories" description="Matched from each solution's git remote">
        <Value>{repoCount(solutions.data)}</Value>
      </Row>
    </>
  );
}
