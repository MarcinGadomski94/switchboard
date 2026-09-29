import { useCallback, useEffect, useRef, useState } from 'react';
import type { BranchingPreflightRequest, BranchingPreflightRow } from '../../core/api.ts';
import { DEFAULT_EPIC_BASE, EPIC_KEY_EXAMPLE, tidyEpicKey } from '../../core/branching.ts';
import { PARENT_EPIC_LABEL, parentText, parseParent } from '../../core/stacking.ts';
import { ApiError, machineApi } from '../api/client.ts';
import {
  type BranchingForm,
  CREATION_LINE,
  PREFLIGHT_DEBOUNCE_MS,
  type RepoChoice,
  droppedSolutions,
  fieldProblems,
  formEpicBranch,
  formParent,
  hasEpic,
  parentFromTaskShown,
  preflightCells,
  preflightKey,
  prTargetCell,
  rowMissesBase,
  stackedCells,
  stackedParent,
} from './branching-form.ts';
import './branching.css';

/** The preflight table's state: the last answer (for the request it answered), running, the error text. */
export interface PreflightState {
  readonly rows: readonly BranchingPreflightRow[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** Runs the check again now (the Re-check button). */
  readonly recheck: () => void;
}

function errorText(caught: unknown): string {
  const error = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
  const body = error.body as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
  if (typeof body?.message === 'string') return body.message;
  const first = body?.errors?.[0]?.message;
  if (typeof first === 'string') return first;
  return error.unreachable ? 'Switchboard is not reachable.' : `The preflight failed (HTTP ${error.status}).`;
}

/**
 * D40: runs `POST /api/branching/preflight` about {@link PREFLIGHT_DEBOUNCE_MS}
 * after the request's key (folder, solutions, epic, base, overrides) settles, and
 * again on `recheck`. Answers to an older request are dropped. `null` = no check
 * (no solutions, or the section is hidden): no rows.
 */
export function useBranchingPreflight(request: BranchingPreflightRequest | null, machine: string | null = null): PreflightState {
  // D48 (P3): on another machine the preflight runs there (its repos); a machine switch is a new request.
  const requestKey = preflightKey(request);
  const key = requestKey === null ? null : `${machine ?? ''}\u0000${requestKey}`;
  const latest = useRef(request);
  latest.current = request;
  const latestMachine = useRef(machine);
  latestMachine.current = machine;
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string | null; rows: readonly BranchingPreflightRow[] | null; loading: boolean; error: string | null }>({
    key: null,
    rows: null,
    loading: false,
    error: null,
  });

  const run = useCallback((): void => {
    const body = latest.current;
    const id = ++sequence.current;
    if (body === null) {
      setState({ key: null, rows: null, loading: false, error: null });
      return;
    }
    const runMachine = latestMachine.current;
    const runKey = `${runMachine ?? ''}\u0000${preflightKey(body)}`;
    setState((current) => ({ ...current, key: runKey, loading: true, error: null }));
    machineApi(runMachine).branchingPreflight(body).then(
      (answer) => {
        if (id === sequence.current) setState({ key: runKey, rows: answer.rows, loading: false, error: null });
      },
      (caught: unknown) => {
        if (id === sequence.current) setState({ key: runKey, rows: null, loading: false, error: errorText(caught) });
      },
    );
  }, []);

  useEffect(() => {
    if (key === null) {
      sequence.current += 1;
      setState({ key: null, rows: null, loading: false, error: null });
      return;
    }
    const timer = setTimeout(run, PREFLIGHT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, run]);

  const current = state.key === key;
  return { rows: current ? state.rows : null, loading: key !== null && (!current || state.loading), error: current ? state.error : null, recheck: run };
}

/** One row's "Use other base: ___" field (applied on Enter or blur). */
function OtherBase({ solution, value, onApply }: { readonly solution: string; readonly value: string; readonly onApply: (base: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const apply = (): void => {
    if (text.trim() !== value) onApply(text.trim());
  };
  return (
    <label className="sb-br-other">
      <span>Use other base:</span>
      <input
        className="sb-ns-input sb-ns-input--name sb-br-other-input"
        data-testid="br-other-base"
        data-solution={solution}
        aria-label={`Other base for ${solution}`}
        value={text}
        placeholder="main"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            apply();
          }
        }}
      />
    </label>
  );
}

/**
 * The New-session form's **Branching** section (D40), shown with Worktree on
 * (like D32's Branch field): the epic key and summary, the derived (editable)
 * epic branch and its base (default `dev`), the read-only creation line, and the
 * preflight table (one row per picked solution, or the repo of a repo folder)
 * with Re-check; a row whose base is missing offers **Drop from task** / **Use
 * other base: ___** (a repo folder only the latter). The task branch is D32's
 * Branch field above. `docs/new-session.md` → *Branching (D40)*. D47: the
 * **Parent** field (empty = the epic branch; pre-filled from the task text until
 * typed in), the PR target column on every row (ruling D47-columns) and,
 * while stacked, the Resolved base / Parent status columns (`docs/new-session.md` → *Parent (D47)*).
 */
export function BranchingSection({
  form,
  onChange,
  solutions,
  taskBranch,
  preflight,
  repo,
  task = '',
}: {
  readonly form: BranchingForm;
  readonly onChange: (patch: Partial<BranchingForm>) => void;
  readonly solutions: readonly string[];
  readonly taskBranch: string;
  readonly preflight: PreflightState;
  readonly repo: boolean;
  /** D47: the task text the Parent field is pre-filled from. */
  readonly task?: string;
}) {
  const epic = hasEpic(form);
  // D47: the Parent field as it reads (typed, else the task text's key).
  const parentValue = formParent(form, task);
  const reading: BranchingForm = { ...form, parent: parentValue };
  const stacked = stackedParent(reading) !== null;
  const problems = fieldProblems(reading, taskBranch);
  const dropped = droppedSolutions(form, solutions);
  const choose = (solution: string, choice: RepoChoice | null): void => {
    const choices = { ...form.choices };
    if (choice === null) delete choices[solution];
    else choices[solution] = choice;
    onChange({ choices });
  };
  const rows = (preflight.rows ?? []).filter((row) => solutions.includes(row.solution));
  const note = problems.key ?? problems.epicBranch ?? problems.base ?? problems.parent;

  return (
    <div className="sb-ns-section sb-ns-section--branching" data-testid="ns-branching" data-section="branching">
      <div className="sb-br-label">
        Branching
        <span className="sb-ns-hint" data-testid="br-model">
          {`${epic ? 'epic/task · lazy' : 'task only · no epic'}${stacked ? ' · stacked' : ''}`}
        </span>
      </div>
      <div className="sb-br-epic">
        <input
          className="sb-ns-input sb-ns-input--name"
          data-testid="br-epic-key"
          aria-label="Epic key"
          value={form.epicKey}
          placeholder={`Epic key (optional), e.g. ${EPIC_KEY_EXAMPLE}`}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange({ epicKey: event.target.value })}
          onBlur={() => {
            const tidy = tidyEpicKey(form.epicKey);
            if (tidy !== form.epicKey) onChange({ epicKey: tidy });
          }}
        />
        <input
          className="sb-ns-input"
          data-testid="br-epic-summary"
          aria-label="Epic summary"
          value={form.epicSummary}
          placeholder="Epic summary"
          onChange={(event) => onChange({ epicSummary: event.target.value })}
        />
      </div>
      {epic ? (
        <div className="sb-br-branch">
          <input
            className="sb-ns-input sb-ns-input--name"
            data-testid="br-epic-branch"
            aria-label="Epic branch"
            data-derived={form.epicBranch === null ? 'true' : 'false'}
            value={formEpicBranch(form)}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onChange({ epicBranch: event.target.value })}
          />
          <label className="sb-br-base">
            <span>base</span>
            <input
              className="sb-ns-input sb-ns-input--name"
              data-testid="br-epic-base"
              aria-label="Epic base branch"
              value={form.base}
              placeholder={DEFAULT_EPIC_BASE}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => onChange({ base: event.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="sb-br-line" data-testid="br-task-only">
          No epic: the task branch is cut from each repo&apos;s origin default branch (origin/HEAD, usually origin/master).
        </div>
      )}
      <label className="sb-br-parent">
        <span>Parent</span>
        <input
          className="sb-ns-input sb-ns-input--name"
          data-testid="br-parent"
          aria-label="Parent branch"
          data-derived={parentFromTaskShown(form, task) ? 'true' : 'false'}
          value={parentValue}
          placeholder={epic ? PARENT_EPIC_LABEL : "Origin default branch (independent)"}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange({ parent: event.target.value })}
          onBlur={() => {
            const check = parseParent(parentValue);
            const tidy = check.ok ? (check.parent ? parentText(check.parent) : '') : parentValue;
            if (form.parent !== null && form.parent !== undefined && tidy !== form.parent) onChange({ parent: tidy });
          }}
        />
      </label>
      <div className="sb-br-line" data-testid="br-parent-hint">
        {stacked
          ? parentFromTaskShown(form, task)
            ? 'Stacked (from the task text): cut from the parent in each repo where it is on origin, its PR into the parent.'
            : 'Stacked: cut from the parent in each repo where it is on origin, its PR into the parent.'
          : 'A task key (e.g. PROJ-3013) or branch name to stack this task on an unmerged task branch.'}
      </div>
      {note ? (
        <div className="sb-br-line" data-testid="br-note" data-ok="false">
          {note}
        </div>
      ) : null}
      <div className="sb-br-line" data-testid="br-creation">
        {CREATION_LINE}
      </div>
      {solutions.length === 0 ? (
        <div className="sb-br-line" data-testid="br-no-rows">
          No solutions picked: the agent cuts its own worktrees by these rules.
        </div>
      ) : (
        <div className="sb-br-preflight" data-testid="br-preflight">
          <div className="sb-br-preflight-head">
            <span>Preflight</span>
            <span className="sb-br-status" data-testid="br-status">
              {preflight.loading ? 'checking… (git fetch origin)' : (preflight.error ?? '')}
            </span>
            <button type="button" className="sb-button sb-ns-browse sb-br-recheck" data-testid="br-recheck" disabled={preflight.loading} onClick={preflight.recheck}>
              Re-check
            </button>
          </div>
          {rows.length > 0 ? (
            <table className="sb-br-table" data-testid="br-table">
              <thead>
                <tr>
                  <th>repo</th>
                  <th>base</th>
                  {epic ? <th>epic</th> : null}
                  <th>{`task ${taskBranch || '—'}`}</th>
                  {stacked ? <th>resolved base</th> : null}
                  <th>PR target</th>
                  {stacked ? <th>parent status</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const cells = preflightCells(row);
                  const extra = stacked ? stackedCells(row) : null;
                  const target = prTargetCell(row);
                  const choice = form.choices[row.solution];
                  const isDropped = dropped.includes(row.solution);
                  const failed = row.error !== null;
                  const offer = rowMissesBase(row) || (choice !== undefined && row.error === null && row.baseExists === false);
                  return (
                    <tr key={row.solution} data-testid="br-row" data-solution={row.solution} data-dropped={isDropped ? 'true' : 'false'}>
                      <td className="sb-br-repo">{row.solution}</td>
                      <td colSpan={failed ? (epic ? 3 : 2) + 1 + (stacked ? 2 : 0) : 1} data-testid="br-cell-base" data-tone={cells.base.tone}>
                        {isDropped ? '— dropped from the task' : cells.base.text}
                        {offer && !isDropped ? (
                          <div className="sb-br-choices">
                            {repo ? null : (
                              <button type="button" className="sb-button sb-ns-browse" data-testid="br-drop" onClick={() => choose(row.solution, { drop: true })}>
                                Drop from task
                              </button>
                            )}
                            <OtherBase solution={row.solution} value={choice && 'base' in choice ? choice.base : ''} onApply={(base) => choose(row.solution, base === '' ? null : { base })} />
                          </div>
                        ) : null}
                        {isDropped ? (
                          <button type="button" className="sb-button sb-br-undo" data-testid="br-undo" onClick={() => choose(row.solution, null)}>
                            Undo
                          </button>
                        ) : null}
                      </td>
                      {epic && !failed ? (
                        <td data-testid="br-cell-epic" data-tone={cells.epic?.tone}>
                          {cells.epic?.text ?? ''}
                        </td>
                      ) : null}
                      {!failed ? (
                        <td data-testid="br-cell-task" data-tone={cells.task?.tone}>
                          {cells.task?.text ?? '—'}
                        </td>
                      ) : null}
                      {stacked && !failed ? (
                        <td data-testid="br-cell-resolved" data-tone={extra?.resolved.tone}>
                          {extra?.resolved.text ?? '—'}
                        </td>
                      ) : null}
                      {!failed ? (
                        <td data-testid="br-cell-target" data-tone={target?.tone}>
                          {target?.text ?? '—'}
                        </td>
                      ) : null}
                      {stacked && !failed ? (
                        <td data-testid="br-cell-parent" data-tone={extra?.status.tone}>
                          {extra?.status.text ?? '—'}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      )}
    </div>
  );
}
