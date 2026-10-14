import { type DragEvent, type MutableRefObject, useEffect, useState } from 'react';
import { ALL_TEAMS, TEAM_NAME_MAX, type TeamSummary } from '../../core/team.ts';
import { refusalText, teamApi } from './api.ts';
import { Dialog } from './dialogs.tsx';
import { canDropOnTeam } from './model.ts';
import { ReorderStrip } from './ReorderStrip.tsx';

/**
 * D100 follow-up 2026-10-14 · the Team page's team switcher (`docs/team.md` → *The
 * Team page* → *Teams*): one tab per team in the teams' order, each with its name
 * and needs-you count, in a row that scrolls sideways and reorders like the cards
 * strip (`ReorderStrip`: drag, long press, Alt+← / →); then **All teams** (every
 * team's Needs you) and **＋ New team**.
 *
 * D100 follow-up 2026-10-14 (drag to move between teams): while a member card is
 * held (`memberDrag`), every other team's tab is a drop target (highlighted; never
 * the member's own team nor All teams); dropping calls `onMemberDrop`. A held finger
 * is fed through `touchRef` (its point: the tab under it lights up, and the row
 * scrolls at its edges); the parent asks {@link teamTabAt} where it was released.
 */
export function TeamTabs({
  teams,
  current,
  onPick,
  onReorder,
  onNew,
  memberDrag = null,
  onMemberDrop,
  touchRef,
}: {
  readonly teams: readonly TeamSummary[];
  /** The shown team's id, or `all`. */
  readonly current: string;
  readonly onPick: (teamId: string) => void;
  readonly onReorder: (teamIds: string[]) => void;
  readonly onNew: () => void;
  /** The member card being dragged (its id and team), or `null`. */
  readonly memberDrag?: { readonly memberId: string; readonly teamId: string } | null;
  /** A member card was dropped on this team's tab. */
  readonly onMemberDrop?: (teamId: string) => void;
  /** Set here: the parent feeds a held finger's point (or `null`) through it. */
  readonly touchRef?: MutableRefObject<((point: { readonly x: number; readonly y: number } | null) => void) | null>;
}) {
  const allNeeds = teams.reduce((sum, team) => sum + team.needsYou, 0);
  const [mouseOver, setMouseOver] = useState<string | null>(null);
  const [touch, setTouch] = useState<{ readonly point: { readonly x: number; readonly y: number }; readonly over: string | null } | null>(null);
  useEffect(() => {
    if (!touchRef) return undefined;
    touchRef.current = (point) => setTouch(point ? { point, over: teamTabAt(point.x, point.y) } : null);
    return () => {
      touchRef.current = null;
    };
  }, [touchRef]);
  useEffect(() => {
    if (!memberDrag) {
      setMouseOver(null);
      setTouch(null);
    }
  }, [memberDrag]);
  const over = mouseOver ?? touch?.over ?? null;
  const dropProps = (teamId: string): TabDrop | undefined => {
    if (!memberDrag || !onMemberDrop || !canDropOnTeam(teams, memberDrag.teamId, teamId)) return undefined;
    return {
      over: over === teamId,
      onDragOver: (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (mouseOver !== teamId) setMouseOver(teamId);
      },
      onDragLeave: (event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setMouseOver((current) => (current === teamId ? null : current));
      },
      onDrop: (event) => {
        event.preventDefault();
        event.stopPropagation();
        setMouseOver(null);
        onMemberDrop(teamId);
      },
    };
  };
  return (
    <nav className="sb-team-tabs-row" data-testid="team-tabs" data-tour="team-switcher" aria-label="Teams" data-member-drag={memberDrag ? '' : undefined}>
      <ReorderStrip
        items={teams}
        idOf={(team) => team.id}
        labelOf={(team) => team.name}
        axis="x"
        revealId={current}
        onReorder={onReorder}
        className="sb-team-tabs"
        testId="team-tab-strip"
        externalDrag={memberDrag !== null}
        externalPoint={touch?.point ?? null}
      >
        {(team) => <TeamTab id={team.id} name={team.name} needs={team.needsYou} selected={team.id === current} onPick={onPick} drop={dropProps(team.id)} />}
      </ReorderStrip>
      <TeamTab id={ALL_TEAMS} name="All teams" needs={allNeeds} selected={current === ALL_TEAMS} onPick={onPick} />
      <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost sb-team-tabs-new" data-testid="team-new" data-tour="team-new" onClick={onNew}>
        ＋ New team
      </button>
    </nav>
  );
}

/** A team tab as a drop target for a dragged member card. */
interface TabDrop {
  readonly over: boolean;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

/** The team whose tab (a drop target for the held member card) is at this point, if any. */
export function teamTabAt(x: number, y: number): string | null {
  const tab = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-member-drop]');
  return tab?.dataset['teamId'] ?? null;
}

function TeamTab({ id, name, needs, selected, onPick, drop }: { readonly id: string; readonly name: string; readonly needs: number; readonly selected: boolean; readonly onPick: (teamId: string) => void; readonly drop?: TabDrop | undefined }) {
  return (
    <div
      role="tab"
      tabIndex={0}
      className="sb-team-teamtab"
      data-testid="team-tab-team"
      data-team-id={id}
      data-member-drop={drop ? '' : undefined}
      data-drop-over={drop?.over ? '' : undefined}
      aria-selected={selected}
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
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
