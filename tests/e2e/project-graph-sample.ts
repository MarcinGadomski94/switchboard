import type { Plan, PlanEdge, PlanItem } from '../../src/core/plans.ts';

/**
 * The Project graph's E2E sample (`v2-project-graph.spec.ts`, `v2-project-graph-fullscreen.spec.ts`):
 * a 15-step fan-out / fan-in project over three repositories, served as `GET /api/plans/{id}`.
 */

export const PLAN_ID = 'graph-sample';
const NOW = Date.now();
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const REPOS = ['acme-api', 'acme-web', 'acme-sdk'];

function item(n: number, id: string, title: string, solutions: readonly string[], patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    todoId: `t-${id}`,
    key: `ACME-${n}`,
    title,
    hold: false,
    solutions,
    state: 'waiting',
    reason: null,
    note: null,
    storedState: 'pending',
    waitingOn: null,
    dependsOn: [],
    runSessionId: null,
    branch: null,
    prUrl: null,
    checks: null,
    developerMerges: false,
    developerConfirms: false,
    estimateMinutes: 45,
    actualMinutes: null,
    onCriticalPath: false,
    position: n,
    startedAt: null,
    waitingSince: null,
    mergedAt: null,
    doneAt: null,
    spans: [],
    ...patch,
  };
}

export function samplePlan(): Plan {
  const [api, web, sdk] = REPOS.map((repo) => [repo]) as [string[], string[], string[]];
  const edges: PlanEdge[] = [
    ['a1', 'a2'],
    ['a1', 'a3'],
    ['s1', 's2'],
    ['w1', 'w2'],
    ['a2', 'w2'],
    ['s2', 's3'],
    ['a3', 's4'],
    ['s2', 's4'],
    ['a2', 'a4'],
    ['s3', 'w3'],
    ['w2', 'w3'],
    ['s4', 'w4'],
    ['w3', 'w4'],
    ['a4', 'x1'],
    ['w4', 'w5'],
    ['x1', 'w5'],
    ['w5', 'x2'],
    ['s3', 'x2'],
  ].map(([from, to]) => ({ from: from as string, to: to as string }));
  const items = [
    item(1, 'a1', 'Scaffold the Acme API', api, { state: 'done', storedState: 'done', actualMinutes: 38, startedAt: ago(200), doneAt: ago(160) }),
    item(2, 'w1', 'Scaffold the web app', web, { state: 'needs-you', storedState: 'running', reason: 'Which port should the web app use?', startedAt: ago(90) }),
    item(3, 's1', 'Scaffold the SDK', sdk, { state: 'ready' }),
    item(4, 'a2', 'Orders endpoints with paging and filters', api, { state: 'running', storedState: 'running', startedAt: ago(25), estimateMinutes: 60 }),
    item(5, 'a3', 'Webhooks for order events', api, { state: 'stopped', storedState: 'running', stoppedBy: 'error', reason: 'The agent stopped with an error', startedAt: ago(70) }),
    item(6, 's2', 'SDK client for orders', sdk),
    item(7, 'w2', 'Orders page in the web app', web),
    item(8, 's3', 'SDK retries and timeouts', sdk),
    item(9, 's4', 'SDK webhook verification', sdk),
    item(10, 'a4', 'Rate limits for the Acme API', api),
    item(11, 'w3', 'Order details with live status', web),
    item(12, 'w4', 'Webhook settings page', web),
    item(13, 'x1', 'Shared error codes across the API and the web app', [REPOS[0] as string, REPOS[1] as string]),
    item(14, 'w5', 'End-to-end tests for orders', web),
    item(15, 'x2', 'Release notes and docs', []),
  ].map((entry) => ({ ...entry, dependsOn: edges.filter((edge) => edge.to === entry.id).map((edge) => edge.from) }));
  return {
    id: PLAN_ID,
    title: 'Acme orders',
    sourceSessionId: 'graph-source',
    targetBranch: 'feature/acme-orders',
    allowProtectedTarget: false,
    repos: REPOS,
    baseBranch: 'dev',
    mergeMode: 'agents',
    maxConcurrency: 3,
    usageThreshold: 85,
    answers: null,
    state: 'running',
    external: null,
    held: null,
    pausedReason: null,
    items,
    edges,
    criticalPath: { itemIds: [], minutes: 0 },
    progress: { done: 1, total: 15, percent: 7 },
    estimatedMinutesLeft: 300,
    createdAt: ago(300),
    updatedAt: ago(1),
    startedAt: ago(240),
    finishedAt: null,
    machine: null,
  };
}

