import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepoBranch } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { type PickerLoad, branchRow, filterBranches, pickerStatus } from './branch-picker.ts';
import { isolateErrorText } from './solutions-conflict.ts';

const EMPTY: PickerLoad = { list: null, fetching: false, error: null };

/**
 * D60: the branches of `repo` for `sessionId` (`GET /api/solutions/{repo}/branches`):
 * the cached refs first (no fetch), then again after `git fetch --all --prune`
 * (`fetch=1`); `refresh` fetches again. `target` `null` = not shown (nothing is
 * loaded). A late answer for an earlier target or refresh is dropped.
 */
export function useRepoBranches(target: { readonly repo: string; readonly sessionId: string } | null): { readonly load: PickerLoad; readonly refresh: () => void } {
  const [load, setLoad] = useState<PickerLoad>(EMPTY);
  const run = useRef(0);
  const repo = target?.repo ?? null;
  const sessionId = target?.sessionId ?? null;

  const start = useCallback(
    (cachedFirst: boolean): void => {
      if (repo === null || sessionId === null) return;
      const id = ++run.current;
      const current = (): boolean => run.current === id;
      void (async () => {
        if (cachedFirst) {
          try {
            const list = await api.repoBranches(repo, sessionId, false);
            if (current()) setLoad({ list, fetching: true, error: null });
          } catch (caught) {
            if (current()) setLoad({ list: null, fetching: false, error: isolateErrorText(caught) });
            return;
          }
        } else {
          setLoad((previous) => ({ ...previous, fetching: true, error: null }));
        }
        try {
          const list = await api.repoBranches(repo, sessionId, true);
          if (current()) setLoad({ list, fetching: false, error: null });
        } catch (caught) {
          if (current()) setLoad((previous) => ({ list: previous.list, fetching: false, error: previous.list ? null : isolateErrorText(caught) }));
        }
      })();
    },
    [repo, sessionId],
  );

  useEffect(() => {
    run.current++;
    setLoad(EMPTY);
    start(true);
  }, [start]);

  return { load, refresh: useCallback(() => start(false), [start]) };
}

/**
 * The **Existing branch** choice of the conflict card's confirm step (D60): a
 * search field with ↻ Refresh (`git fetch --all --prune`), the status line (the
 * fetch running, or its failure: the local list still works), and the list:
 * each branch's name, local / remote, its last commit's subject and age; a
 * branch checked out elsewhere is listed but disabled with the reason.
 */
export function ExistingBranchPicker(props: {
  readonly load: PickerLoad;
  readonly search: string;
  readonly picked: string | null;
  readonly disabled: boolean;
  readonly onSearch: (search: string) => void;
  readonly onPick: (branch: RepoBranch) => void;
  readonly onRefresh: () => void;
  readonly onEnter: () => void;
  readonly onEscape: () => void;
}) {
  const { load, search, picked, disabled } = props;
  const branches = load.list ? filterBranches(load.list.branches, search) : [];
  const status = pickerStatus(load);
  return (
    <div className="sb-sol-pick" data-testid="conflict-pick">
      <div className="sb-sol-move-confirm-row">
        <input
          className="sb-sol-move-branch"
          data-testid="conflict-pick-search"
          aria-label="Search branches"
          placeholder="Search branches"
          value={search}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => props.onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') props.onEnter();
            if (event.key === 'Escape') props.onEscape();
          }}
        />
        <button
          type="button"
          className="sb-button sb-sol-move-cancel"
          data-testid="conflict-pick-refresh"
          title="git fetch --all --prune"
          disabled={disabled || load.fetching}
          aria-busy={load.fetching || undefined}
          onClick={props.onRefresh}
        >
          ↻ Refresh
        </button>
      </div>
      {status.text ? (
        <div className="sb-sol-pick-status" data-testid="conflict-pick-status" data-warn={status.warn ? 'true' : 'false'}>
          {status.text}
        </div>
      ) : null}
      {load.list ? (
        <div className="sb-sol-pick-list" role="listbox" aria-label="Branches" data-testid="conflict-pick-list">
          {branches.length === 0 ? (
            <div className="sb-sol-pick-empty" data-testid="conflict-pick-empty">
              {load.list.branches.length === 0 ? 'The repo has no branches yet.' : 'No branch matches the search.'}
            </div>
          ) : (
            branches.map((branch) => {
              const row = branchRow(branch);
              const selected = picked === branch.name;
              return (
                <button
                  key={branch.name}
                  type="button"
                  role="option"
                  className="sb-button sb-sol-pick-option"
                  data-testid="conflict-pick-option"
                  data-branch={branch.name}
                  data-kind={branch.kind}
                  aria-selected={selected}
                  aria-disabled={row.disabled || undefined}
                  disabled={row.disabled || disabled}
                  title={row.reason || row.note || undefined}
                  onClick={() => props.onPick(branch)}
                >
                  <span className="sb-sol-pick-line">
                    <span className="sb-sol-pick-name">{row.name}</span>
                    <span className="sb-sol-pick-kind" data-testid="conflict-pick-kind">
                      {row.kind}
                    </span>
                  </span>
                  {row.detail ? (
                    <span className="sb-sol-pick-detail" data-testid="conflict-pick-detail">
                      {row.detail}
                    </span>
                  ) : null}
                  {row.reason ? (
                    <span className="sb-sol-pick-reason" data-testid="conflict-pick-reason">
                      {row.reason}
                    </span>
                  ) : row.note ? (
                    <span className="sb-sol-pick-note" data-testid="conflict-pick-note">
                      {row.note}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
