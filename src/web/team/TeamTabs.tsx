import { useState } from 'react';
import { ALL_TEAMS, TEAM_NAME_MAX, type TeamSummary } from '../../core/team.ts';
import { refusalText, teamApi } from './api.ts';
import { Dialog } from './dialogs.tsx';
import { ReorderStrip } from './ReorderStrip.tsx';

/**
 * D100 follow-up 2026-10-14 · the Team page's team switcher (`docs/team.md` → *The
 * Team page* → *Teams*): one tab per team in the teams' order, each with its name
 * and needs-you count, in a row that scrolls sideways and reorders like the cards
 * strip (`ReorderStrip`: drag, long press, Alt+← / →); then **All teams** (every
 * team's Needs you) and **＋ New team**.
 */
export function TeamTabs({
  teams,
  current,
  onPick,
  onReorder,
  onNew,
}: {
  readonly teams: readonly TeamSummary[];
  /** The shown team's id, or `all`. */
  readonly current: string;
  readonly onPick: (teamId: string) => void;
  readonly onReorder: (teamIds: string[]) => void;
  readonly onNew: () => void;
}) {
  const allNeeds = teams.reduce((sum, team) => sum + team.needsYou, 0);
  return (
    <nav className="sb-team-tabs-row" data-testid="team-tabs" aria-label="Teams">
      <ReorderStrip items={teams} idOf={(team) => team.id} labelOf={(team) => team.name} axis="x" revealId={current} onReorder={onReorder} className="sb-team-tabs" testId="team-tab-strip">
        {(team) => (
          <TeamTab id={team.id} name={team.name} needs={team.needsYou} selected={team.id === current} onPick={onPick} />
        )}
      </ReorderStrip>
      <TeamTab id={ALL_TEAMS} name="All teams" needs={allNeeds} selected={current === ALL_TEAMS} onPick={onPick} />
      <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost sb-team-tabs-new" data-testid="team-new" onClick={onNew}>
        ＋ New team
      </button>
    </nav>
  );
}

function TeamTab({ id, name, needs, selected, onPick }: { readonly id: string; readonly name: string; readonly needs: number; readonly selected: boolean; readonly onPick: (teamId: string) => void }) {
  return (
    <div
      role="tab"
      tabIndex={0}
      className="sb-team-teamtab"
      data-testid="team-tab-team"
      data-team-id={id}
      aria-selected={selected}
      onClick={() => onPick(id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPick(id);
        }
      }}
    >
      <span className="sb-team-teamtab__name">{name}</span>
      {needs > 0 ? (
        <span className="sb-team-teamtab__need" data-testid="team-tab-need" title={`${needs} need${needs === 1 ? 's' : ''} you`}>
          {needs}
        </span>
      ) : null}
    </div>
  );
}

/** ＋ New team: a name, then the new (empty) team opens. */
export function NewTeamDialog({ onDone, onClose }: { readonly onDone: (team: TeamSummary) => void; readonly onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    const text = name.replace(/\s+/g, ' ').trim();
    if (text === '') {
      setError('Name the team.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await teamApi.createTeam(text));
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label="New team" testId="team-new-dialog" onClose={onClose}>
      <label className="sb-team-field">
        <span className="sb-team-field__label">Name</span>
        <input
          className="sb-team-input"
          data-testid="team-new-name"
          autoFocus
          maxLength={TEAM_NAME_MAX}
          placeholder="Growth"
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </label>
      {error ? (
        <div className="sb-team-error" role="alert" data-testid="team-new-error">
          {error}
        </div>
      ) : null}
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-new-create" onClick={() => void submit()} disabled={busy}>
          Create team
        </button>
      </div>
    </Dialog>
  );
}

/** Delete team…: asks first; its members go back to the session list (never a session deleted). */
export function DeleteTeamDialog({ team, members, onDone, onClose }: { readonly team: { readonly id: string; readonly name: string }; readonly members: number; readonly onDone: (returned: number) => void; readonly onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onDone((await teamApi.deleteTeam(team.id)).returned);
    } catch (caught) {
      setError(refusalText(caught));
      setBusy(false);
    }
  };
  return (
    <Dialog label={`Delete team ${team.name}?`} testId="team-delete-dialog" onClose={onClose}>
      <div className="sb-team-note" data-testid="team-delete-note">
        {members === 0
          ? `${team.name} has no members. Deleting it removes the team from every paired computer.`
          : `Its ${members === 1 ? 'member goes' : `${members} members go`} back to your session list as plain sessions, in the folders and places they came from — history, worktrees, todos and loops included. No session is deleted.`}
      </div>
      {error ? (
        <div className="sb-team-error" role="alert" data-testid="team-delete-error">
          {error}
        </div>
      ) : null}
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-team-btn sb-team-btn--danger" data-testid="team-delete-confirm" onClick={() => void remove()} disabled={busy}>
          Delete team
        </button>
      </div>
    </Dialog>
  );
}
