import type { ReportedTable } from '../../core/api.ts';
import type { AssistantPayload } from '../../core/event-payload.ts';
import { STATUS_TABLE_COLUMNS, newestStatusTable } from '../../core/derive/status-table.ts';
import type { Store } from '../db/store.ts';
import { EventMemo, payloadType } from '../db/event-memo.ts';

/** How many candidate messages one query reads (newest first) before looking further back. */
export const REPORTED_TABLE_PAGE = 50;

function assistantText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const text = (payload as Partial<AssistantPayload>).text;
  return typeof text === 'string' ? text : null;
}

/**
 * D21: the newest status table the agent printed in the session's chat
 * (`SessionDetail.reportedTable`; `docs/derivations.md` → *Agent overview*): the
 * main conversation's assistant messages (those of `mainAgentId` or of no agent,
 * as the chat shows them; every agent's when `mainAgentId` is `null`), read newest
 * first a page at a time, skipping messages that cannot hold one (the words
 * `agent` and `status` must both appear), until one holds a status table
 * (`src/core/derive/status-table.ts`). Reads the whole stored chat, not only the
 * detail's recent events, so a table printed long ago still shows until a newer
 * one replaces it.
 */
export async function reportedTable(store: Store, sessionId: string, mainAgentId: string | null): Promise<ReportedTable | null> {
  // D95: kept until an assistant message of the session is written (each detail read scanned the whole history).
  return memoOf(store).get(store.events, sessionId, mainAgentId ?? '', () => readReportedTable(store, sessionId, mainAgentId));
}

/** D95: one memo per store (tests open many). */
const memos = new WeakMap<Store, EventMemo<ReportedTable | null>>();

function memoOf(store: Store): EventMemo<ReportedTable | null> {
  let memo = memos.get(store);
  if (!memo) {
    memo = new EventMemo((event) => payloadType(event) === 'assistant');
    memos.set(store, memo);
  }
  return memo;
}

async function readReportedTable(store: Store, sessionId: string, mainAgentId: string | null): Promise<ReportedTable | null> {
  let before: { ts: string; id: number } | undefined;
  for (;;) {
    const page = await store.events.assistantTextsNewestFirst(sessionId, {
      agentId: mainAgentId,
      words: STATUS_TABLE_COLUMNS,
      ...(before ? { before } : {}),
      limit: REPORTED_TABLE_PAGE,
    });
    const found = newestStatusTable(
      page.flatMap((event) => {
        const text = assistantText(event.payload);
        return text === null ? [] : [{ text, at: event.ts, id: event.id }];
      }),
    );
    if (found) return { text: found.text, format: found.format, at: found.at };
    const last = page.at(-1);
    if (!last || page.length < REPORTED_TABLE_PAGE) return null;
    before = { ts: last.ts, id: last.id };
  }
}
