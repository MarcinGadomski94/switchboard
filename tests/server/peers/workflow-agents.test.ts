import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionDetail, WorkflowAgentChat } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { fakeAgentBrief, fakeAgentLabel } from '../../../tools/fake-claude/workflow.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D51 × D48 with two real Switchboard processes: a Workflow on A's session shows its
 * agents on B (A derives them; the proxy passes them), and B opens one agent's chat
 * through the proxy (`/api/sessions/{remote id}/workflow-agents/{agentId}/chat`,
 * allowed in `PEER_API_ALLOW`), its events namespaced like every other event.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-workflow');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('D51 · a peer\'s workflow agents', () => {
  it('the chat route is part of the peer API', () => {
    expect(peerApiAllowed('GET', '/api/sessions/s1/workflow-agents/wf_abc--a1/chat')).toBe(true);
    expect(peerApiAllowed('POST', '/api/sessions/s1/workflow-agents/wf_abc--a1/chat')).toBe(false);
    expect(peerApiAllowed('GET', `/api/sessions/${encodeURIComponent(remoteId('abcdefabcdef', 's1'))}/workflow-agents/x/chat`)).toBe(false);
  });

  it('B lists A\'s workflow agents under their run and opens one\'s chat through the proxy', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'wf-on-a', task: 'Audit. [fake:workflow 6 1x2]', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = remoteId(aId, (created.body as Session).id);

    const detail = await waitFor('B sees the running workflow agents', async () => {
      const answer = await b.call('GET', `/api/sessions/${encodeURIComponent(id)}`);
      const d = answer.body as SessionDetail;
      return answer.status === 200 && d.agents.filter((agent) => agent.kind === 'workflow' && agent.workflow?.agentId).length === 2 ? d : null;
    });
    expect(detail.workflows?.[0]).toMatchObject({ phases: ['Audit'], agentCount: 2 });
    const agent = detail.agents.find((candidate) => candidate.name === fakeAgentLabel(0, 1));
    expect(agent?.workflow?.runId).toBe(detail.workflows?.[0]?.runId);

    const chat = await waitFor('the agent\'s chat through the proxy', async () => {
      const answer = await b.call('GET', `/api/sessions/${encodeURIComponent(id)}/workflow-agents/${encodeURIComponent(agent?.id ?? '')}/chat`);
      return answer.status === 200 && (answer.body as WorkflowAgentChat).events.length > 0 ? (answer.body as WorkflowAgentChat) : null;
    });
    expect(chat.events[0]).toMatchObject({ sessionId: id, agentId: agent?.id, payload: { type: 'agent-prompt', text: fakeAgentBrief(0, 1) } });
    expect(chat.events.every((event) => event.sessionId === id)).toBe(true);
  }, 60_000);
});
