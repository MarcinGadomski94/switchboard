import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/db/store.ts';
import { REPORTED_TABLE_PAGE, reportedTable } from '../../../src/server/sessions/reported-table.ts';
import { toSessionDetail } from '../../../src/server/sessions/wire.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D21: `SessionDetail.reportedTable` (additive) is the newest status table the
 * agent printed in the chat (the main conversation's assistant messages), found in
 * the whole stored chat (not only the detail's recent events), as printed.
 */

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await makeTempDir('reported-table');
  store = await openTempStore(tmp);
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

const BOX = ['┌───────┬─────────┐', '│ Agent │ Status  │', '├───────┼─────────┤', '│ web   │ running │', '└───────┴─────────┘'].join('\n');
const BOX_DONE = BOX.replace('running', 'done   ');
const PIPE = ['| Agent | Status |', '|---|---|', '| web | done |'].join('\n');

let second = 0;
function ts(): string {
  second += 1;
  return new Date(Date.UTC(2026, 8, 28, 10, 0, second)).toISOString();
}

async function say(sessionId: string, agentId: string | null, text: string, at = ts()) {
  return store.events.append({ sessionId, agentId, kind: 'text', label: text.split('\n', 1)[0] ?? '', ts: at, payload: { type: 'assistant', text, messageId: null } });
}

async function world() {
  const session = await store.sessions.create({ id: 's1', name: 'overview', claudeSessionId: 'c1' });
  const main = await store.agents.create({ sessionId: session.id, kind: 'main', name: 'main' });
  const sub = await store.agents.create({ sessionId: session.id, kind: 'subagent', name: 'general-purpose' });
  return { session, main, sub };
}

describe('reportedTable / SessionDetail.reportedTable', () => {
  it('null when the agent printed no status table', async () => {
    const { session, main } = await world();
    await say(session.id, main.id, 'Working on it. The agent status is fine.');
    expect(await reportedTable(store, session.id, main.id)).toBeNull();
    expect((await toSessionDetail(store, {}, session)).reportedTable).toBeNull();
  });

  it('the newest table of the main conversation, as printed, with its message time; a newer one replaces it', async () => {
    const { session, main } = await world();
    const first = await say(session.id, main.id, `Status:\n\n\`\`\`\n${BOX}\n\`\`\``);
    await say(session.id, main.id, 'No table in this one.');
    expect((await toSessionDetail(store, {}, session)).reportedTable).toEqual({ text: BOX, format: 'box', at: first.ts });

    const next = await say(session.id, null, `Update:\n\n${PIPE}`);
    expect(await reportedTable(store, session.id, main.id)).toEqual({ text: PIPE, format: 'gfm', at: next.ts });
    const last = await say(session.id, main.id, BOX_DONE);
    expect(await reportedTable(store, session.id, main.id)).toEqual({ text: BOX_DONE, format: 'box', at: last.ts });
  });

  it("a subagent's text is not the chat's (the chat shows the main conversation only); other kinds of events are not messages", async () => {
    const { session, main, sub } = await world();
    const mine = await say(session.id, main.id, PIPE);
    await say(session.id, sub.id, BOX);
    await store.events.append({ sessionId: session.id, agentId: main.id, kind: 'text', ts: ts(), payload: { type: 'user', text: BOX, origin: 'user', delivered: true } });
    await store.events.append({ sessionId: session.id, agentId: sub.id, kind: 'text', ts: ts(), payload: { type: 'agent-prompt', text: BOX } });
    expect(await reportedTable(store, session.id, main.id)).toEqual({ text: PIPE, format: 'gfm', at: mine.ts });
    // Without a main agent every agent's messages count (the chat then shows them all).
    expect((await reportedTable(store, session.id, null))?.format).toBe('box');
  });

  it('finds a table printed long ago, past the detail\'s recent events and several pages of candidates', async () => {
    const { session, main } = await world();
    const old = await say(session.id, main.id, BOX);
    // Messages that pass the words pre-filter but hold no table, more than two pages of them.
    for (let i = 0; i < REPORTED_TABLE_PAGE * 2 + 5; i += 1) await say(session.id, main.id, `Agent ${i}: status unchanged.`);
    for (let i = 0; i < 210; i += 1) {
      await store.events.append({ sessionId: session.id, agentId: main.id, kind: 'impl', ts: ts(), payload: { type: 'tool', name: 'Bash', toolUseId: `t${i}`, input: { command: 'ls' } } });
    }
    const detail = await toSessionDetail(store, {}, session);
    expect(detail.events.some((event) => event.id === old.id)).toBe(false);
    expect(detail.reportedTable).toEqual({ text: BOX, format: 'box', at: old.ts });
  });

  it('an older message wins over a newer one only by time: an imported terminal turn with an older timestamp is older', async () => {
    const { session, main } = await world();
    const live = await say(session.id, main.id, BOX, '2026-09-28T11:00:00.000Z');
    await say(session.id, main.id, PIPE, '2026-09-28T09:00:00.000Z');
    expect(await reportedTable(store, session.id, main.id)).toEqual({ text: BOX, format: 'box', at: live.ts });
  });
});
