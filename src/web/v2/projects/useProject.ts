import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionTodo } from '../../../core/api.ts';
import type { Plan } from '../../../core/plans.ts';
import type { PlanEdgeProposal, PlanJiraState } from '../../../core/plans-jira.ts';
import { ApiError, api } from '../../api/client.ts';
import { useHubEvent, onHubStatus } from '../../api/useHub.ts';
import { refusalText, plansApi } from '../../plans/api.ts';
import { jiraApi } from '../../plans/jira/api.ts';
import { putPlan } from '../../plans/store.ts';

/**
 * D131 · lane P · one project, live: `GET /api/plans/{id}` read again on its `planChanged`
 * (coalesced) and after the hub reconnects; with it, for a Jira project, its Jira state
 * (sync, tickets, activity) and the dependency proposals; and the source agent's tasks (each
 * step's todo: its description is the D118 Jira summary shown under "From Jira").
 */
export interface ProjectData {
  readonly plan: Plan | null;
  /** The project was deleted meanwhile (its `planChanged` said `state: null`, or a read answered 404). */
  readonly gone: boolean;
  readonly error: string | null;
  readonly jira: PlanJiraState | null;
  readonly proposals: readonly PlanEdgeProposal[];
  readonly todos: ReadonlyMap<string, SessionTodo>;
  readonly reload: () => Promise<void>;
  /** Puts a plan an action answered in place at once (the next read confirms it). */
  readonly put: (plan: Plan) => void;
}

const COALESCE_MS = 200;

/** The project `id`, its Jira side and its steps' tasks, live. */
export function useProject(id: string): ProjectData {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jira, setJira] = useState<PlanJiraState | null>(null);
  const [proposals, setProposals] = useState<readonly PlanEdgeProposal[]>([]);
  const [todos, setTodos] = useState<ReadonlyMap<string, SessionTodo>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await plansApi.get(id);
      if (!alive.current) return;
      setPlan(next);
      setError(null);
      setGone(false);
      if (next.external?.system === 'jira') {
        void jiraApi
          .state(id)
          .then((state) => alive.current && setJira(state))
          .catch(() => alive.current && setJira(null));
      }
      void jiraApi
        .proposals(id)
        .then((list) => alive.current && setProposals(list))
        .catch(() => alive.current && setProposals([]));
      void api
        .sessionTodos(next.sourceSessionId)
        .then((list) => alive.current && setTodos(new Map(list.todos.map((todo) => [todo.id, todo]))))
        .catch(() => undefined);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else setError(refusalText(e));
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    void load();
    const off = onHubStatus((status) => {
      if (status === 'open') void load();
    });
    return () => {
      alive.current = false;
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useHubEvent('planChanged', (event) => {
    if (event.planId !== id) return;
    if (event.state === null) {
      setGone(true);
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void load();
    }, COALESCE_MS);
  });

  const put = useCallback((next: Plan) => {
    setPlan(next);
    putPlan(next);
  }, []);

  return { plan, gone, error, jira, proposals, todos, reload: load, put };
}
