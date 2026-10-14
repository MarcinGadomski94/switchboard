import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Folder, OwnedLoop, SessionListItem, SessionModel } from '../../core/api.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import type { TeamCharter, TeamMember, TeamMoveRun, TeamSuggestion } from '../../core/team.ts';
import type { TeamTemplate } from '../../core/team-templates.ts';
import { displayTitle } from '../../core/session-title.ts';
import { api } from '../api/client.ts';
import { type MoveCheck, type MoveTarget, refusalText, teamApi } from './api.ts';
import type { TargetPlacement } from '../../core/takeover.ts';
import { RepoTable, TargetFolderPicker } from '../takeover/TargetFolders.tsx';
import { withRepoPath } from '../takeover/takeover.ts';
import { draftAll } from './charter-draft.ts';
import { dismissedSuggestions, setDismissed } from './local.ts';
import { MemberFormFields } from './MemberFormFields.tsx';
import { useFitMemberModel, useMemberModels } from './MemberModel.tsx';
import {
  CONFIDENCE_LABEL,
  type Confidence,
  type MemberForm,
  type MenuItem,
  type SessionLike,
  adoptNote,
  confidenceOf,
  evidenceLine,
  formBody,
  formFromSuggestion,
  formFromTemplate,
  newMemberSession,
  newMemberTemplates,
  splitSuggestions,
} from './model.ts';

/**
 * D100 · the Team page's dialogs (`docs/team.md` → *The Team page*): ＋ Member, the
 * review of suggestions, the Adopt / Create form, the template and session pickers,
 * Give a task…, the move, and the member's ⋯ menu.
 */

/** A dialog frame: a dimmed page, the card in the middle (a full-screen sheet on phones); Escape or a click outside closes it. */
export function Dialog({ label, testId, wide = false, onClose, children }: { readonly label: string; readonly testId: string; readonly wide?: boolean; readonly onClose: () => void; readonly children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sb-team-overlay" onClick={onClose}>
      <div className={`sb-team-dialog${wide ? ' sb-team-dialog--wide' : ''}`} role="dialog" aria-modal="true" aria-label={label} data-testid={testId} onClick={(event) => event.stopPropagation()}>
        <div className="sb-team-dialog__title">{label}</div>
        {children}
      </div>
    </div>
  );
}

// ── ＋ Member ─────────────────────────────────────────────────────────────

/** ＋ Member: Adopt one of your sessions / From a template / From scratch. */
export function AddMemberDialog({ onPick, onClose }: { readonly onPick: (how: 'adopt' | 'template' | 'scratch') => void; readonly onClose: () => void }) {
  const choices: readonly { readonly id: 'adopt' | 'template' | 'scratch'; readonly title: string; readonly text: string }[] = [
    { id: 'adopt', title: 'Adopt one of your sessions', text: 'It keeps its history, worktrees, todos and loops, and leaves your session list.' },
    { id: 'template', title: 'From a template', text: 'Planner, Developer, Reviewer / QA, Release manager, On-call, Delivery tracking, Marketing monitoring.' },
    { id: 'scratch', title: 'From scratch', text: 'A new session with a role and a charter you write.' },
  ];
  return (
    <Dialog label="Add a member" testId="team-add-dialog" onClose={onClose}>
      <div className="sb-team-choices">
        {choices.map((choice) => (
          <button key={choice.id} type="button" className="sb-button sb-team-choice" data-testid={`team-add-${choice.id}`} onClick={() => onPick(choice.id)}>
            <span className="sb-team-choice__title">{choice.title}</span>
            <span className="sb-team-choice__text">{choice.text}</span>
          </button>
        ))}
      </div>
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/** From a template: the registry, in its order. */
export function TemplatePicker({ templates, onPick, onClose }: { readonly templates: readonly TeamTemplate[]; readonly onPick: (template: TeamTemplate) => void; readonly onClose: () => void }) {
  return (
    <Dialog label="Start from a template" testId="team-template-dialog" onClose={onClose}>
      <div className="sb-team-choices">
        {templates.map((template) => (
          <button key={template.id} type="button" className="sb-button sb-team-choice" data-testid="team-template" data-template-id={template.id} onClick={() => onPick(template)}>
            <span className="sb-team-choice__title">
              {template.name}
              {template.readOnly ? <span className="sb-team-muted"> · read-only</span> : null}
            </span>
            <span className="sb-team-choice__text">{template.summary}</span>
          </button>
        ))}
      </div>
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/** A plain session picker (Adopt one of your sessions, when there are no suggestions to review). */
export function SessionPicker({ sessions, onPick, onClose }: { readonly sessions: readonly SessionListItem[]; readonly onPick: (session: SessionListItem) => void; readonly onClose: () => void }) {
  return (
    <Dialog label="Adopt one of your sessions" testId="team-session-dialog" onClose={onClose}>
      {sessions.length === 0 ? <div className="sb-team-muted">No open session to adopt.</div> : null}
      <div className="sb-team-choices">
        {sessions.map((session) => (
          <button key={session.id} type="button" className="sb-button sb-team-choice" data-testid="team-session-pick" data-session-id={session.id} disabled={session.hooked || !session.attached} onClick={() => onPick(session)}>
            <span className="sb-team-choice__title">
              {displayTitle(session)}
              {session.machine ? <span className="sb-team-chip">{session.machine.name}</span> : null}
            </span>
            <span className="sb-team-choice__text">{session.hooked ? 'A hooked terminal session: continue it in Switchboard first.' : !session.attached ? 'It continues in a terminal: attach it here first.' : (session.folderPath ?? session.cwd ?? '')}</span>
          </button>
        ))}
      </div>
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

// ── the review ───────────────────────────────────────────────────────────

/** What the review hands to the form. */
export type ReviewPick = { readonly kind: 'adopt'; readonly suggestion: TeamSuggestion; readonly form: MemberForm } | { readonly kind: 'create'; readonly template: TeamTemplate } | { readonly kind: 'adopt-session'; readonly sessionId: string; readonly title: string };

/**
 * Review: one card per suggestion (role, confidence, "← “<title>”", Why, the drafted
 * charter, Adopt… / Create… / Dismiss with Undo), the "new member" templates nobody
 * covers yet, and "Not suggested" with the reasons. Charters are drafted on demand
 * when it opens (`charter-draft.ts`; instant and cached, never blocking).
 */
export function ReviewDialog({
  suggestions,
  templates,
  sessions,
  members,
  onPick,
  onClose,
}: {
  readonly suggestions: readonly TeamSuggestion[] | null;
  readonly templates: readonly TeamTemplate[];
  readonly sessions: readonly SessionLike[];
  readonly members: readonly TeamMember[];
  readonly onPick: (pick: ReviewPick) => void;
  readonly onClose: () => void;
}) {
  const [dismissed, setDismissedState] = useState<ReadonlySet<string>>(() => dismissedSuggestions());
  const [undo, setUndo] = useState<string | null>(null);
  const templateOf = (id: string): TeamTemplate | null => templates.find((template) => template.id === id) ?? null;
  const memberRefs = useMemo(() => new Set(members.map((member) => member.sessionRef)), [members]);
  const split = useMemo(() => splitSuggestions(suggestions ?? [], sessions, { dismissed, members: memberRefs }), [suggestions, sessions, dismissed, memberRefs]);
  const drafts = useMemo(() => draftAll(split.suggested, templateOf), [split.suggested, templates]);
  const extra = newMemberTemplates(templates, split.suggested, members);
  const dismiss = (sessionId: string, value: boolean): void => {
    setDismissedState(setDismissed(sessionId, value));
    setUndo(value ? sessionId : null);
  };
  const [loopsOf, setLoopsOf] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  useEffect(() => {
    let live = true;
    for (const suggestion of split.suggested) {
      if (loopsOf.has(suggestion.sessionId) || suggestion.evidence.loops === 0) continue;
      api
        .sessionLoops(suggestion.sessionId)
        .then((list: OwnedLoop[]) => live && setLoopsOf((current) => new Map(current).set(suggestion.sessionId, list.filter((loop) => loop.state !== 'ended').map((loop) => loop.id))))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [split.suggested]);
  return (
    <Dialog label="Review suggestions" testId="team-review-dialog" wide onClose={onClose}>
      {suggestions === null ? <div className="sb-team-muted">Looking at your sessions…</div> : null}
      {undo ? (
        <div className="sb-team-undo" role="status" data-testid="team-review-undo">
          Dismissed.{' '}
          <button type="button" className="sb-button sb-team-link" data-testid="team-review-undo-button" onClick={() => dismiss(undo, false)}>
            Undo
          </button>
        </div>
      ) : null}
      <div className="sb-team-suggestions">
        {split.suggested.map((suggestion) => {
          const template = templateOf(suggestion.templateId);
          const draft = drafts.get(suggestion.sessionId) ?? null;
          const confidence = confidenceOf(suggestion);
          const remote = suggestion.sessionId.startsWith('r~');
          return (
            <div key={suggestion.sessionId} className="sb-team-suggestion" data-testid="team-suggestion" data-session-id={suggestion.sessionId}>
              <div className="sb-team-suggestion__head">
                <span className="sb-team-suggestion__role">{template?.name ?? suggestion.templateId}</span>
                <ConfidencePill value={confidence} />
                <span className="sb-team-suggestion__from">← “{suggestion.title}”</span>
                {remote ? <span className="sb-team-chip">{suggestion.sessionId.split('~')[1]}</span> : null}
              </div>
              <div className="sb-team-suggestion__why">Why: {evidenceLine(suggestion)}</div>
              {draft ? <CharterDraft charter={draft} /> : null}
              <div className="sb-team-need__actions">
                <button
                  type="button"
                  className="sb-button sb-team-btn sb-team-btn--primary"
                  data-testid="team-suggestion-adopt"
                  onClick={() => onPick({ kind: 'adopt', suggestion, form: formFromSuggestion(suggestion, template, draft, loopsOf.get(suggestion.sessionId) ?? []) })}
                >
                  Adopt…
                </button>
                {template ? (
                  <button type="button" className="sb-button sb-team-btn" data-testid="team-suggestion-create-new" title={`A new ${template.name} member in a new session; “${suggestion.title}” stays in your list`} onClick={() => onPick({ kind: 'create', template })}>
                    Create…
                  </button>
                ) : null}
                <button type="button" className="sb-button sb-team-btn" data-testid="team-suggestion-dismiss" onClick={() => dismiss(suggestion.sessionId, true)}>
                  Dismiss
                </button>
              </div>
            </div>
          );
        })}
        {extra.map((template) => (
          <div key={template.id} className="sb-team-suggestion" data-testid="team-suggestion-new" data-template-id={template.id}>
            <div className="sb-team-suggestion__head">
              <span className="sb-team-suggestion__role">{template.name}</span>
              <ConfidencePill value="new" />
            </div>
            <div className="sb-team-suggestion__why">Why: no session does this yet. {template.summary}</div>
            <CharterDraft charter={template.charter} />
            <div className="sb-team-need__actions">
              <button type="button" className="sb-button sb-team-btn" data-testid="team-suggestion-create" onClick={() => onPick({ kind: 'create', template })}>
                Create…
              </button>
            </div>
          </div>
        ))}
      </div>
      {split.notSuggested.length > 0 ? (
        <div className="sb-team-not-suggested" data-testid="team-not-suggested">
          <div className="sb-team-section-label">Not suggested</div>
          {split.notSuggested.map((entry) => (
            <div key={entry.sessionId} className="sb-team-not-suggested__row" data-testid="team-not-suggested-row" data-session-id={entry.sessionId}>
              <span className="sb-team-not-suggested__title">“{entry.title}”</span>
              <span className="sb-team-muted">{entry.reason}</span>
              {entry.reason === 'Dismissed' ? (
                <button type="button" className="sb-button sb-team-link" onClick={() => dismiss(entry.sessionId, false)}>
                  Undo
                </button>
              ) : entry.adoptable ? (
                <button type="button" className="sb-button sb-team-link" data-testid="team-not-suggested-adopt" onClick={() => onPick({ kind: 'adopt-session', sessionId: entry.sessionId, title: entry.title })}>
                  Adopt anyway…
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" data-testid="team-review-close" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

/** "Draft charter": owns / produces / never does. */
function CharterDraft({ charter }: { readonly charter: TeamCharter }) {
  return (
    <dl className="sb-team-suggestion__draft" data-testid="team-suggestion-draft" aria-label="Draft charter">
      <dt>Draft charter · owns</dt>
      <dd>{charter.owns}</dd>
      <dt>produces</dt>
      <dd>{charter.produces}</dd>
      <dt>never does</dt>
      <dd>{charter.neverDoes}</dd>
    </dl>
  );
}

function ConfidencePill({ value }: { readonly value: Confidence }) {
  return (
    <span className="sb-team-pill" data-testid="team-confidence" data-confidence={value}>
      {CONFIDENCE_LABEL[value]}
    </span>
  );
}

// ── Adopt / Create ───────────────────────────────────────────────────────

/** What the form dialog is for. */
export type FormTarget =
  | { readonly kind: 'adopt'; readonly sessionId: string; readonly title: string; readonly place: string; readonly form: MemberForm }
  | { readonly kind: 'create'; readonly form: MemberForm };

/** Adopt / Create: the member form pre-filled, the note on what adopting means, [Adopt into the team] / [Create member]. */
export function MemberFormDialog({
  target,
  folders,
  teams = [],
  teamId,
  sessionModel = null,
  provider = null,
  onDone,
  onClose,
}: {
  readonly target: FormTarget;
  /** D100 follow-up 2026-10-14: adopt: the session's model, effort and reported models (the model dropdown); create: `null`. */
  readonly sessionModel?: SessionModel | null;
  /** The CLI whose models the dropdown lists (the session's; create: the default CLI). */
  readonly provider?: CliProviderId | null;
  readonly folders: readonly Folder[] | null;
  /** D100 follow-up 2026-10-14: the teams to pick from (the picker shows with two or more). */
  readonly teams?: readonly { readonly id: string; readonly name: string }[];
  /** The team the member joins by default (the shown team). */
  readonly teamId?: string;
  readonly onDone: (member: TeamMember) => void;
  readonly onClose: () => void;
}) {
  const [form, setForm] = useState<MemberForm>(target.form);
  const [team, setTeam] = useState<string>(teamId ?? teams[0]?.id ?? '');
  // D100 follow-up 2026-10-14: the model dropdown, pre-selected on the template's suggestion when it is on offer, else the session's model.
  const models = useMemberModels(target.kind === 'adopt' ? sessionModel : null, provider);
  useFitMemberModel(models, setForm, false);
  const inTeam = team ? { teamId: team } : {};
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loops, setLoops] = useState<readonly OwnedLoop[] | null>(null);
  useEffect(() => {
    if (target.kind !== 'adopt') return undefined;
    let live = true;
    api
      .sessionLoops(target.sessionId)
      .then((list) => live && setLoops(list.filter((loop) => loop.state !== 'ended')))
      .catch(() => live && setLoops([]));
    return () => {
      live = false;
    };
  }, [target]);
  const submit = async (): Promise<void> => {
    const checked = formBody(form);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'adopt') {
        // D105: its own agent is asked for a specific charter right after (the developer approves it).
        onDone(await teamApi.addMember({ ...checked.body, ...inTeam, sessionId: target.sessionId, askCharter: true }));
        return;
      }
      const created = await teamApi.addMember({ ...checked.body, ...inTeam, rhythm: { loopIds: [], onHandoff: form.onHandoff }, session: newMemberSession(form) });
      // A template's suggested loops the developer kept become Switchboard loops (D94) of the new session, in its rhythm.
      const kept = form.templateLoops.filter((loop) => loop.kept);
      if (kept.length > 0) {
        const ids: string[] = [];
        for (const loop of kept) {
          const made = await api.createLoop(created.sessionRef, { prompt: loop.prompt, label: loop.label, ...(loop.cron ? { cron: loop.cron } : { everyMinutes: loop.everyMinutes ?? 60 }) });
          ids.push(made.id);
        }
        onDone(await teamApi.updateMember(created.id, { rhythm: { loopIds: ids, onHandoff: form.onHandoff } }));
        return;
      }
      onDone(created);
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label={target.kind === 'adopt' ? `Adopt “${target.title}”` : 'Create a member'} testId="team-form-dialog" wide onClose={onClose}>
      {target.kind === 'adopt' ? (
        <div className="sb-team-note" data-testid="team-adopt-note">
          {adoptNote(target.title, target.place)}
          <div className="sb-team-muted" data-testid="team-adopt-charter-note">
            Once adopted, its agent is asked to propose a specific charter from its own session; you accept, edit or dismiss it in Needs you.
          </div>
        </div>
      ) : null}
      {teams.length > 1 ? (
        <label className="sb-team-field" data-section="team">
          <span className="sb-team-field__label">Team</span>
          <select className="sb-team-input" data-testid="team-form-team" value={team} disabled={busy} onChange={(event) => setTeam(event.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <MemberFormFields form={form} onChange={setForm} errors={errors} parts={target.kind === 'adopt' ? { sessionLoops: loops, models: models.options } : { folder: folders ?? [], models: models.options }} disabled={busy} />
      {error ? (
        <div className="sb-team-error" role="alert" data-testid="team-form-error">
          {error}
        </div>
      ) : null}
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-form-submit" disabled={busy} onClick={() => void submit()}>
          {target.kind === 'adopt' ? 'Adopt into the team' : 'Create member'}
        </button>
      </div>
    </Dialog>
  );
}

/** A form for a template (create) or from scratch. */
export function createTarget(template: TeamTemplate | null): FormTarget {
  return { kind: 'create', form: formFromTemplate(template) };
}

// ── Give a task… ─────────────────────────────────────────────────────────

/** Give a task…: a hand-off from the developer (brief, expected result). */
export function GiveTaskDialog({ member, onDone, onClose }: { readonly member: TeamMember; readonly onDone: () => void; readonly onClose: () => void }) {
  const [brief, setBrief] = useState('');
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (): Promise<void> => {
    if (brief.trim() === '') {
      setError('Write what the task is.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await teamApi.handoff(member.id, brief.trim(), expected.trim());
      onDone();
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label={`Give ${member.name} a task`} testId="team-task-dialog" onClose={onClose}>
      <label className="sb-team-field">
        <span className="sb-team-field__label">Brief</span>
        <textarea className="sb-team-input" data-testid="team-task-brief" rows={3} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="Check the PROJ-123 board and list what is late." />
      </label>
      <label className="sb-team-field">
        <span className="sb-team-field__label">Expected result</span>
        <textarea className="sb-team-input" data-testid="team-task-expected" rows={2} value={expected} onChange={(event) => setExpected(event.target.value)} placeholder="A short list, saved as an artifact." />
      </label>
      <div className="sb-team-muted">It lands as a todo in {member.name}&apos;s session{member.rhythm.onHandoff && !member.paused ? ' and wakes it' : ''}.</div>
      {error ? (
        <div className="sb-team-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-task-send" disabled={busy} onClick={() => void send()}>
          Give the task
        </button>
      </div>
    </Dialog>
  );
}

// ── Move ─────────────────────────────────────────────────────────────────

/** How often a running move is read again. */
const MOVE_POLL_MS = 1_000;

/** Move to <PC>…: the checks first (nothing changes), then Move, then the run until it is done or failed. */
export function MoveDialog({ member, target, onDone, onClose }: { readonly member: TeamMember; readonly target: { readonly id: string; readonly name: string }; readonly onDone: () => void; readonly onClose: () => void }) {
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<TeamMoveRun | null>(null);
  // D110: the folders chosen on the target (`null` = its saved folders) and typed clone paths; each change checks again.
  const [placement, setPlacement] = useState<TargetPlacement | null>(null);
  const [clonePaths, setClonePaths] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = useRef(0);
  const choiceOf = (chosen: TargetPlacement | null, paths: Record<string, string>): MoveTarget => ({ ...(chosen ? { placement: chosen } : {}), ...(Object.keys(paths).length > 0 ? { clonePaths: paths } : {}) });
  const recheck = (chosen: TargetPlacement | null | undefined, paths: Record<string, string>): void => {
    const ask = ++asked.current;
    setError(null);
    // `undefined` = the first check (the remembered folders apply); `null` = the saved folders.
    const choice: MoveTarget = chosen === undefined ? choiceOf(null, paths) : { ...choiceOf(chosen, paths), ...(chosen === null ? { placement: null } : {}) };
    teamApi
      .moveCheck(member.id, target.id, choice)
      .then((result) => {
        if (ask !== asked.current) return;
        setCheck(result);
        setPlacement(result.preview?.placement ?? null);
      })
      .catch((caught: unknown) => ask === asked.current && setError(refusalText(caught)));
  };
  useEffect(() => {
    recheck(undefined, {});
    return () => {
      asked.current++;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id, target.id]);
  const follow = (id: string): void => {
    timer.current = setTimeout(() => {
      teamApi
        .moveRun(id)
        .then((next) => {
          setRun(next);
          if (next.state === 'running') follow(id);
          else if (next.state === 'done') onDone();
        })
        .catch((caught: unknown) => setError(refusalText(caught)));
    }, MOVE_POLL_MS);
  };
  const start = async (): Promise<void> => {
    setError(null);
    try {
      const started = await teamApi.move(member.id, target.id, choiceOf(placement, clonePaths));
      setRun(started);
      follow(started.id);
    } catch (caught) {
      setError(refusalText(caught));
    }
  };
  return (
    <Dialog label={`Move ${member.name} to ${target.name}`} testId="team-move-dialog" onClose={onClose}>
      <div className="sb-team-muted">The session moves with its repos, conversation, todos and loops (Switchboard&apos;s take-over). Its charter, rhythm, budget and gates stay. Access entries need setting up again on {target.name}.</div>
      {check === null && !error ? (
        <div className="sb-team-muted" data-testid="team-move-checking">
          Checking both machines…
        </div>
      ) : null}
      {check?.preview && run === null ? (
        <>
          <TargetFolderPicker
            machine={target.id}
            machineName={target.name}
            placement={placement}
            remembered={check.preview.remembered}
            onChange={(next) => {
              setPlacement(next);
              recheck(next, clonePaths);
            }}
          />
          <RepoTable
            preview={check.preview}
            sourceName={check.preview.source.machine.name}
            targetName={target.name}
            clonePaths={clonePaths}
            onClonePath={(key, value) => setClonePaths((current) => ({ ...current, [key]: value }))}
            onCloneDone={() => recheck(placement, clonePaths)}
            onPick={(key, value) => {
              const next = withRepoPath(placement, key, value);
              setPlacement(next);
              recheck(next, clonePaths);
            }}
          />
        </>
      ) : null}
      {check ? (
        <div className="sb-team-move-check" data-testid="team-move-check" data-ok={String(check.ok)}>
          {check.ok ? (
            <div data-testid="team-move-ok">Ready to move: nothing blocks it.</div>
          ) : (
            <ul className="sb-team-move-blockers">
              {check.blockers.map((blocker) => (
                <li key={blocker} data-testid="team-move-blocker">
                  {blocker}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {run ? (
        <div className="sb-team-muted" role="status" data-testid="team-move-run" data-state={run.state}>
          {run.state === 'running' ? 'Moving…' : run.state === 'done' ? `Moved to ${target.name}.` : `The move failed: ${run.error ?? 'unknown error'}`}
        </div>
      ) : null}
      {error ? (
        <div className="sb-team-error" role="alert" data-testid="team-move-error">
          {error}
        </div>
      ) : null}
      <div className="sb-team-dialog__actions">
        <button type="button" className="sb-button sb-team-btn" data-testid="team-move-close" onClick={onClose}>
          {run?.state === 'done' ? 'Close' : 'Cancel'}
        </button>
        {run === null ? (
          <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-move-start" disabled={!check?.ok} onClick={() => void start()}>
            Move to {target.name}
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}

// ── the ⋯ menu ───────────────────────────────────────────────────────────

/** The member's ⋯ menu at a point (a right click, or under its ⋯ button), kept inside the window. */
export function MemberMenu({ items, at, onPick, onClose }: { readonly items: readonly MenuItem[]; readonly at: { readonly x: number; readonly y: number }; readonly onPick: (item: MenuItem) => void; readonly onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ readonly left: number; readonly top: number }>({ left: at.x, top: at.y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(at.x - rect.width, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(at.y + 4, window.innerHeight - rect.height - 8)) });
  }, [at.x, at.y]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // D100 follow-up 2026-10-14 (keyboard): the first enabled entry takes the focus, ↑ / ↓ / Home / End move it, and closing gives it back to the ⋯.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      // Only when the focus went nowhere (a dialog the entry opened keeps its own).
      const now = document.activeElement;
      if (opener?.isConnected && (now === null || now === document.body)) opener.focus({ preventScroll: true });
    };
  }, []);
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const entries = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (entries.length === 0) return;
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const to = event.key === 'ArrowDown' ? (at + 1) % entries.length : event.key === 'ArrowUp' ? (at - 1 + entries.length) % entries.length : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    entries[to]?.focus();
  };
  return (
    <div className="sb-team-menu-scrim" onClick={onClose} onContextMenu={(event) => {
      event.preventDefault();
      onClose();
    }}>
      <div ref={ref} className="sb-team-menu" role="menu" data-testid="team-member-menu" style={{ left: pos.left, top: pos.top }} onClick={(event) => event.stopPropagation()} onKeyDown={onMenuKey}>
        {items.map((item, index) => (
          <div key={`${item.id}:${item.machineId ?? item.teamId ?? index}`}>
            {item.separator ? <div className="sb-team-menu__sep" role="separator" /> : null}
            <button type="button" role="menuitem" className="sb-button sb-team-menu__item" data-testid={`team-menu-${item.id}`} data-machine-id={item.machineId} data-team-id={item.teamId} disabled={item.disabled} onClick={() => onPick(item)}>
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The session list as the review's split reads it. */
export function sessionsForReview(sessions: readonly SessionListItem[]): SessionLike[] {
  return sessions.map((session) => ({ id: session.id, title: displayTitle(session), hooked: session.hooked === true, attached: session.attached, machineName: session.machine?.name ?? null }));
}
