import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStreamObject } from '../../../src/core/stream-json.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { StreamRecorder } from '../../../src/server/supervisor/recorder.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * M4.3: where an agent works (the agent card's path + ⎇ branch,
 * docs/derivations.md → Agents): its first successful write into a solution sets
 * `solutionPath` (the repo folder) and `branch` (the session's registered
 * worktree holding the file). Workspace-root files place nobody; later writes
 * elsewhere do not move it.
 */

let world: SupervisorWorld | undefined;
let tmp: string | undefined;
let store: Store | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
  await store?.close();
  store = undefined;
  if (tmp) await removeTempDir(tmp);
  tmp = undefined;
});

describe('agent placement · real path (fake-claude Write turns)', () => {
  it('the main agent is placed by its first write into a solution, with the worktree branch; root files and later writes do not move it', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession({ task: 'Write the contract. [fake:write contracts/free-talk.md]' }));
    await waitForStatus(w.store, session.id, ['done']);
    const main = async () => (await w.store.agents.listBySession(session.id)).find((a) => a.kind === 'main');
    expect(await main()).toMatchObject({ name: 'acme-app-front', solutionPath: null, branch: null });

    // The session's worktree of acme-app-front (gap #1 naming), registered as M2.2 does.
    const worktree = path.join(w.workspace, 'microfrontends', 'acme-app-front-wt-demo-session');
    await w.store.worktrees.create({
      repo: 'acme-app-front',
      repoPath: 'microfrontends/acme-app-front',
      branch: 'session/demo-session',
      path: worktree,
      sessionId: session.id,
    });
    await w.supervisor.sendMessage(session.id, 'Now the page. [fake:write microfrontends/acme-app-front-wt-demo-session/Pages/Talk.razor]');
    await until(async () => (await main())?.solutionPath ?? undefined, 'the main agent placed');
    expect(await main()).toMatchObject({ solutionPath: 'microfrontends/acme-app-front', branch: 'session/demo-session' });

    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.sendMessage(session.id, 'And a mobile note. [fake:write mobile/notes.md]');
    await until(async () => (await w.store.artifacts.list({ sessionId: session.id })).some((a) => a.solution === 'mobile') || undefined, 'the mobile write');
    expect(await main()).toMatchObject({ solutionPath: 'microfrontends/acme-app-front', branch: 'session/demo-session' });
  });
});

describe('agent placement · recorder (a subagent writes)', () => {
  it('a subagent\'s write places the subagent, not the main agent; a failed write places nobody', async () => {
    tmp = await makeTempDir('placement');
    store = await openTempStore(tmp);
    const root = path.join(tmp, 'ws');
    const session = await store.sessions.create({ name: 'orch', claudeSessionId: 'c-1', task: 't', mode: 'orchestrator', cwd: root, status: 'run' });
    const mainAgent = await store.agents.create({ sessionId: session.id, kind: 'main', name: 'orchestrator', status: 'run' });
    const recorder = new StreamRecorder({ store, session, mainAgentId: mainAgent.id, onEvent: () => undefined });
    const assistant = (id: string, parent: string | null, block: Record<string, unknown>) =>
      parseStreamObject({ type: 'assistant', uuid: `u-${id}`, parent_tool_use_id: parent, message: { id: `m-${id}`, content: [block] } });
    const result = (toolUseId: string, parent: string | null, isError = false) =>
      parseStreamObject({
        type: 'user',
        uuid: `r-${toolUseId}`,
        parent_tool_use_id: parent,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: isError ? 'failed' : 'ok', is_error: isError }] },
      });

    await recorder.handle(assistant('1', null, { type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Build the view' } }));
    await recorder.handle(assistant('2', 'tu_agent', { type: 'tool_use', id: 'tu_fail', name: 'Write', input: { file_path: path.join(root, 'nugets', 'lib-nuget', 'x.cs') } }));
    await recorder.handle(result('tu_fail', 'tu_agent', true));
    await recorder.handle(assistant('3', 'tu_agent', { type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: path.join(root, 'mobile', 'Views', 'X.xaml') } }));
    await recorder.handle(result('tu_w', 'tu_agent'));
    await recorder.handle(assistant('4', 'tu_agent', { type: 'tool_use', id: 'tu_w2', name: 'Edit', input: { file_path: path.join(root, 'microfrontends', 'app-front', 'a.razor') } }));
    await recorder.handle(result('tu_w2', 'tu_agent'));

    const agents = await store.agents.listBySession(session.id);
    expect(agents.map((a) => [a.kind, a.name, a.solutionPath, a.branch])).toEqual([
      ['main', 'orchestrator', null, null],
      ['subagent', 'general-purpose', 'mobile/', null],
    ]);
  });
});
