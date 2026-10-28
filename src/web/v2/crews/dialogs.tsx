import { useEffect, useMemo, useState } from 'react';
import type { SessionModelOption } from '../../../core/api.ts';
import type { TeamCharter, TeamMember, TeamSuggestion, TeamSummary } from '../../../core/team.ts';
import type { TeamTemplate } from '../../../core/team-templates.ts';
import { api } from '../../api/client.ts';
import { useMachines } from '../../api/useMachines.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { refusalText, teamApi } from '../../team/api.ts';
import { draftCharter } from '../../team/charter-draft.ts';
import { useTeamSwitch } from '../../team/hidden.ts';
import { EMPTY_FORM, type MemberForm, formBody, formFromSuggestion, formFromTemplate, newMemberSession } from '../../team/model.ts';
import { Button, Checkbox, Dialog, Field, Select, TextArea, useToast } from '../components/index.ts';
import { CREW_WORDS, WORDS } from '../glossary.ts';
import { checkBudget, computerChoices } from './crew-model.ts';

/**
 * D131 · lane P · the Crews dialogs: New crew, Rename, Delete, Move to crew… (with Undo by the
 * caller), Move to computer… (D100's move: the take-over's checks, then the run), Budget, Model,
 * a job description's Edit (D105), and **New teammate** (role templates, the suggestions, or an
 * existing agent adopted).
 */

function ErrorLine({ text }: { readonly text: string | null }) {
  return text ? (
    <p className="v2-field-error" role="alert">
      {text}
    </p>
  ) : null;
}

/** New crew: a name; it goes last in the order. */
export function NewCrewDialog({ onClose, onCreated }: { readonly onClose: () => void; readonly onCreated: (crew: TeamSummary) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async (): Promise<void> => {
    try {
      onCreated(await teamApi.createTeam(name.trim()));
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={CREW_WORDS.newCrew}
      icon="crew"
      testId="v2-new-crew"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={name.trim() === ''} onClick={() => void create()} data-testid="v2-new-crew-go">
            Create crew
          </Button>
        </>
      }
    >
      <Field label="Crew name" value={name} autoFocus maxLength={60} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && name.trim() !== '' && void create()} data-testid="v2-new-crew-name" />
      <p className="v2-muted v2-c-small">It goes last in your crew order. Add teammates next.</p>
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Rename a crew. */
export function RenameCrewDialog({ crew, onClose, onDone }: { readonly crew: TeamSummary; readonly onClose: () => void; readonly onDone: () => void }) {
  const [name, setName] = useState(crew.name);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    try {
      await teamApi.rename(name.trim(), crew.id);
      onDone();
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <Dialog open onClose={onClose} title="Rename crew" icon="edit" testId="v2-rename-crew" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={name.trim() === ''} onClick={() => void save()}>Rename</Button></>}>
      <Field label="Name" value={name} autoFocus maxLength={60} onChange={(event) => setName(event.currentTarget.value)} />
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Delete a crew: its teammates go back to Agents as plain agents. */
export function DeleteCrewDialog({ crew, onClose, onDone }: { readonly crew: TeamSummary; readonly onClose: () => void; readonly onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete crew “${crew.name}”?`}
      icon="trash"
      testId="v2-delete-crew"
      footer={
        <>
          <Button onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              try {
                await teamApi.deleteTeam(crew.id);
                onDone();
              } catch (e) {
                setError(refusalText(e));
              }
            }}
          >
            Delete crew
          </Button>
        </>
      }
    >
      <p className="v2-c-p">Its {crew.members} teammate{crew.members === 1 ? '' : 's'} go back to Agents with their chats, tasks and routines. No agent is deleted.</p>
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Move to crew…: the crews as a radio list (↑ ↓ pick, ↩ moves). */
export function MoveToCrewDialog({ member, crews, onClose, onMove }: { readonly member: TeamMember; readonly crews: readonly TeamSummary[]; readonly onClose: () => void; readonly onMove: (crewId: string) => void }) {
  const [pick, setPick] = useState(member.teamId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move ${member.name} to crew`}
      icon="crew"
      testId="v2-move-crew"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pick === member.teamId} onClick={() => onMove(pick)} data-testid="v2-move-crew-go">
            Move to crew
          </Button>
        </>
      }
    >
      <p className="v2-muted v2-c-small">Keeps its chat, job description and budget.</p>
      <div className="v2-c-pick" role="radiogroup" aria-label="Crews">
        {crews.map((crew) => (
          <label key={crew.id} className="v2-c-pick-row" data-testid="v2-move-crew-option" data-crew={crew.id}>
            <input
              type="radio"
              name="v2-move-crew"
              checked={pick === crew.id}
              onChange={() => setPick(crew.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && pick !== member.teamId) onMove(pick);
              }}
            />
            <span className="v2-grow">{crew.name}</span>
            <span className="v2-muted v2-c-small">{crew.id === member.teamId ? 'now' : CREW_WORDS.teammates(crew.members)}</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

/** Move to computer…: the computers (offline ones disabled), the move's checks, then the move run (D100 / D65). */
export function MoveToComputerDialog({ member, onClose }: { readonly member: TeamMember; readonly onClose: () => void }) {
  const machines = useMachines();
  const [self, setSelf] = useState<{ id: string; name: string } | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'checking' | 'moving'>('idle');
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    api
      .machines()
      .then((view) => alive && setSelf({ id: view.self.id, name: view.self.name }))
      .catch(() => alive && setSelf({ id: 'self', name: 'This computer' }));
    return () => {
      alive = false;
    };
  }, []);
  const choices = self ? computerChoices(member, self, machines) : [];
  const move = async (): Promise<void> => {
    if (!pick) return;
    setState('checking');
    setError(null);
    try {
      const check = await teamApi.moveCheck(member.id, pick);
      if (!check.ok) {
        setBlockers(check.blockers);
        setState('idle');
        return;
      }
      setState('moving');
      const run = await teamApi.move(member.id, pick);
      const name = choices.find((choice) => choice.id === pick)?.name ?? 'the other computer';
      toast({ text: `${member.name} moves to ${name} after its current reply.` });
      onClose();
      let left = 120;
      const poll = async (): Promise<void> => {
        const now = await teamApi.moveRun(run.id).catch(() => null);
        if (now?.state === 'done') toast({ text: `${member.name} now runs on ${name}.` });
        else if (now?.state === 'failed') toast({ text: `Couldn’t move ${member.name}: ${now.error ?? 'the move failed'}`, tone: 'error' });
        else if (left-- > 0) setTimeout(() => void poll(), 2_000);
      };
      void poll();
    } catch (e) {
      setError(refusalText(e));
      setState('idle');
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move “${member.name}” to a computer`}
      icon="desktop"
      testId="v2-move-computer"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!pick || state !== 'idle'} onClick={() => void move()} data-testid="v2-move-computer-go">
            {state === 'checking' ? 'Checking…' : state === 'moving' ? 'Moving…' : 'Move'}
          </Button>
        </>
      }
    >
      <p className="v2-muted v2-c-small">It finishes its current reply first, then continues on the new computer with its chat, tasks, routines and separate copies.</p>
      <div className="v2-c-pick" role="radiogroup" aria-label="Computers">
        {choices.map((choice) => (
          <label key={choice.id} className="v2-c-pick-row" data-testid="v2-move-computer-option" data-disabled={choice.disabledReason !== null || undefined}>
            <input type="radio" name="v2-move-computer" disabled={choice.current || choice.disabledReason !== null} checked={pick === choice.id} onChange={() => setPick(choice.id)} />
            <span className="v2-grow">
              {choice.name}
              {choice.current ? <span className="v2-muted v2-c-small"> · now</span> : null}
            </span>
            {choice.disabledReason ? <span className="v2-muted v2-c-small">{choice.disabledReason}</span> : null}
          </label>
        ))}
      </div>
      {blockers.length > 0 ? (
        <ul className="v2-c-blockers" data-testid="v2-move-computer-blockers">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Budget: the teammate's daily share of its account's usage (empty = none). */
export function BudgetDialog({ member, onClose }: { readonly member: TeamMember; readonly onClose: () => void }) {
  const [value, setValue] = useState(member.budget.dailyPct === null ? '' : String(member.budget.dailyPct));
  const [error, setError] = useState<string | null>(null);
  const check = checkBudget(value);
  const toast = useToast();
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Budget · ${member.name}`}
      icon="wallet"
      testId="v2-budget-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!check.ok}
            onClick={async () => {
              if (!check.ok) return;
              try {
                await teamApi.updateMember(member.id, { budget: { dailyPct: check.dailyPct, profileId: member.budget.profileId } });
                toast({ text: check.dailyPct === null ? `${member.name} has no budget now.` : `${member.name} may use ${check.dailyPct}% of its account a day.` });
                onClose();
              } catch (e) {
                setError(refusalText(e));
              }
            }}
            data-testid="v2-budget-save"
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Share of the account’s daily usage (%)" inputMode="numeric" value={value} autoFocus onChange={(event) => setValue(event.currentTarget.value)} error={check.ok ? null : check.message} hint="Over it, its routines pause for the rest of the day and Needs you asks you. Empty = no budget." data-testid="v2-budget-value" />
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** Model…: the models its engine offers (the session's list), and the effort (the CLI's level names) when the model has levels. */
export function ModelDialog({ member, onClose }: { readonly member: TeamMember; readonly onClose: () => void }) {
  const sessions = useSessionListOf();
  const session = sessions.data?.find((entry) => entry.id === member.sessionRef) ?? null;
  const [listed, setListed] = useState<readonly SessionModelOption[] | null>(null);
  const available = session?.model?.available ?? listed;
  const [model, setModel] = useState<string>(member.model ?? session?.model?.current ?? '');
  const [effort, setEffort] = useState<string>(member.effort ?? session?.model?.effort ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (session?.model?.available) return;
    let alive = true;
    api
      .models()
      .then((settings) => {
        if (alive && settings.options) setListed(settings.options);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session?.model?.available]);
  const levels = useMemo(() => available?.find((option) => option.value === model)?.efforts ?? [], [available, model]);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Model · ${member.name}`}
      icon="sparkle"
      testId="v2-model-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={model === ''}
            onClick={async () => {
              try {
                await teamApi.updateMember(member.id, { model, effort: effort === '' || !levels.includes(effort) ? null : effort });
                onClose();
              } catch (e) {
                setError(refusalText(e));
              }
            }}
            data-testid="v2-model-save"
          >
            Save
          </Button>
        </>
      }
    >
      <Select label={WORDS.model} value={model} onChange={(event) => setModel(event.currentTarget.value)} options={[...(model === '' ? [{ value: '', label: 'Choose a model', disabled: true }] : []), ...(available ?? []).map((option) => ({ value: option.value, label: option.label }))]} data-testid="v2-model-select" />
      {levels.length > 0 ? (
        <Select label={WORDS.effort} value={effort} onChange={(event) => setEffort(event.currentTarget.value)} options={[{ value: '', label: 'Default' }, ...levels.map((level) => ({ value: level, label: level }))]} data-testid="v2-model-effort-select" />
      ) : null}
      <p className="v2-muted v2-c-small">Its agent uses it from its next reply; a running reply finishes on the current one.</p>
      <ErrorLine text={error} />
    </Dialog>
  );
}

/** D105 · Edit… a proposed job description, then accept it with your edits. */
export function CharterEditDialog({ member, charter, requestId, onClose }: { readonly member: TeamMember; readonly charter: TeamCharter; readonly requestId: string; readonly onClose: () => void }) {
  const [form, setForm] = useState<TeamCharter>({ owns: charter.owns, produces: charter.produces, neverDoes: charter.neverDoes, howItWorks: charter.howItWorks ?? '' });
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const set = (key: keyof TeamCharter, value: string): void => setForm((current) => ({ ...current, [key]: value }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Job description · ${member.name}`}
      icon="edit"
      width={640}
      testId="v2-charter-edit"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const how = (form.howItWorks ?? '').trim();
                await teamApi.decide(requestId, 'approve', { charter: { owns: form.owns.trim(), produces: form.produces.trim(), neverDoes: form.neverDoes.trim(), ...(how ? { howItWorks: how } : {}) } });
                toast({ text: `Accepted ${member.name}’s job description with your edits.` });
                onClose();
              } catch (e) {
                setError(refusalText(e));
              }
            }}
            data-testid="v2-charter-edit-save"
          >
            Accept with my edits
          </Button>
        </>
      }
    >
      <TextArea label="Owns" rows={2} value={form.owns} onChange={(event) => set('owns', event.currentTarget.value)} />
      <TextArea label="Produces" rows={2} value={form.produces} onChange={(event) => set('produces', event.currentTarget.value)} />
      <TextArea label="How it works" rows={3} value={form.howItWorks ?? ''} onChange={(event) => set('howItWorks', event.currentTarget.value)} />
      <TextArea label="Never does" rows={2} value={form.neverDoes} onChange={(event) => set('neverDoes', event.currentTarget.value)} />
      <ErrorLine text={error} />
    </Dialog>
  );
}

/**
 * New teammate: start from a role (the templates), from a suggestion (sessions that look like a
 * role, `GET /api/team/suggestions`), or make an existing agent a teammate; it joins the crew
 * picked here. A new one starts on this computer in the folder picked (move it later).
 */
export function NewTeammateDialog({ crews, crewId, onClose, onCreated }: { readonly crews: readonly TeamSummary[]; readonly crewId: string | null; readonly onClose: () => void; readonly onCreated: (member: TeamMember) => void }) {
  const [templates, setTemplates] = useState<readonly TeamTemplate[]>([]);
  const [suggestions, setSuggestions] = useState<readonly TeamSuggestion[]>([]);
  const [folders, setFolders] = useState<readonly { readonly id: string; readonly label: string }[]>([]);
  const [form, setForm] = useState<MemberForm>({ ...EMPTY_FORM });
  const [adopt, setAdopt] = useState(false);
  const [agent, setAgent] = useState('');
  const [crew, setCrew] = useState(crewId ?? crews[0]?.id ?? '');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sessions = useSessionListOf();
  const { hidden } = useTeamSwitch();
  useEffect(() => {
    let alive = true;
    void teamApi.templates().then((list) => alive && setTemplates(list)).catch(() => undefined);
    void teamApi.suggestions().then((list) => alive && setSuggestions(list)).catch(() => undefined);
    void api
      .savedFolders()
      .then((list) => alive && setFolders(list.map((entry) => ({ id: entry.id, label: entry.displayName }))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const agents = (sessions.data ?? []).filter((session) => !session.closedAt && !hidden.has(session.id));
  const templateOf = (id: string): TeamTemplate | null => templates.find((template) => template.id === id) ?? null;
  const useTemplate = (template: TeamTemplate): void => setForm((current) => ({ ...formFromTemplate(template), folder: current.folder }));
  const useSuggestion = (suggestion: TeamSuggestion): void => {
    const template = templateOf(suggestion.templateId);
    setForm(formFromSuggestion(suggestion, template, draftCharter(suggestion, template), []));
    setAdopt(true);
    setAgent(suggestion.sessionId);
  };
  const create = async (): Promise<void> => {
    const check = formBody(form);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    if (adopt && agent === '') {
      setErrors({ agent: 'Pick the agent that becomes a teammate.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const member = await teamApi.addMember({ ...check.body, ...(crew ? { teamId: crew } : {}), ...(adopt ? { sessionId: agent } : { session: newMemberSession(form) }) });
      onCreated(member);
    } catch (e) {
      setError(refusalText(e));
      setBusy(false);
    }
  };
  const set = (key: keyof MemberForm, value: string): void => setForm((current) => ({ ...current, [key]: value }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={CREW_WORDS.newTeammate}
      icon="crew"
      width={680}
      testId="v2-new-teammate"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || form.name.trim() === ''} onClick={() => void create()} data-testid="v2-new-teammate-go">
            {adopt ? 'Make teammate' : 'Add teammate'}
          </Button>
        </>
      }
    >
      <div className="v2-c-chips" role="group" aria-label="Start from a role">
        <span className="v2-muted v2-c-small">Start from a role:</span>
        {templates.map((template) => (
          <button key={template.id} type="button" className="v2-c-fchip" aria-pressed={form.templateId === template.id} title={template.summary} onClick={() => useTemplate(template)} data-testid="v2-new-teammate-role">
            {template.name}
          </button>
        ))}
      </div>
      {suggestions.length > 0 ? (
        <div className="v2-c-chips" role="group" aria-label="Suggestions" data-testid="v2-new-teammate-suggestions">
          <span className="v2-muted v2-c-small">Suggested:</span>
          {suggestions.slice(0, 4).map((suggestion) => (
            <button key={suggestion.sessionId} type="button" className="v2-c-fchip" title={suggestion.reason} onClick={() => useSuggestion(suggestion)} data-testid="v2-new-teammate-suggestion">
              {templateOf(suggestion.templateId)?.name ?? suggestion.templateId} ← “{suggestion.title}”
            </button>
          ))}
        </div>
      ) : null}
      <Checkbox label="Make an existing agent a teammate instead" checked={adopt} onChange={(event) => setAdopt(event.currentTarget.checked)} data-testid="v2-new-teammate-adopt" />
      {adopt ? (
        <Select
          label="Agent"
          value={agent}
          onChange={(event) => setAgent(event.currentTarget.value)}
          error={errors['agent'] ?? null}
          options={[{ value: '', label: 'Choose an agent', disabled: true }, ...agents.map((session) => ({ value: session.id, label: session.displayTitle ?? session.title ?? session.name }))]}
          data-testid="v2-new-teammate-agent"
        />
      ) : (
        <Select label="Folder" value={form.folder} onChange={(event) => set('folder', event.currentTarget.value)} options={[{ value: '', label: 'The default folder' }, ...folders.map((folder) => ({ value: folder.id, label: folder.label }))]} />
      )}
      <div className="v2-c-grid2">
        <Field label="Role" value={form.name} onChange={(event) => set('name', event.currentTarget.value)} error={errors['name'] ?? null} data-testid="v2-new-teammate-role-name" />
        <Select label="Joins which crew?" value={crew} onChange={(event) => setCrew(event.currentTarget.value)} options={crews.map((entry) => ({ value: entry.id, label: entry.name }))} data-testid="v2-new-teammate-crew" />
      </div>
      <TextArea label="Owns" rows={2} value={form.owns} onChange={(event) => set('owns', event.currentTarget.value)} />
      <TextArea label="Produces" rows={2} value={form.produces} onChange={(event) => set('produces', event.currentTarget.value)} />
      <TextArea label="Never does" rows={2} value={form.neverDoes} onChange={(event) => set('neverDoes', event.currentTarget.value)} />
      <div className="v2-c-grid2">
        <Field label="Budget (% of the account a day)" inputMode="numeric" value={form.budget} onChange={(event) => set('budget', event.currentTarget.value)} error={errors['budget'] ?? null} />
        <Checkbox label="Picks up hand-offs as they arrive" checked={form.onHandoff} onChange={(event) => setForm((current) => ({ ...current, onHandoff: event.currentTarget.checked }))} />
      </div>
      <p className="v2-muted v2-c-small">{adopt ? 'It keeps its chat, tasks and routines, and leaves the Agents list for its crew.' : 'It starts on this computer; move it to another one later from its ⋯ menu.'}</p>
      <ErrorLine text={error} />
    </Dialog>
  );
}
