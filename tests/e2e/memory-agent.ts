import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { QuestionWorld } from './question-world.ts';

/**
 * D135 · what the agent's memory tools send, for the Project memory specs: `POST /agent/v1/memory`
 * (`memory_propose`), `…/memory/edit` (`memory_propose_edit`), `…/memory/retract`
 * (`memory_propose_retract`), with the session's agent token.
 */
export async function agentMemory(world: QuestionWorld, sessionId: string, route: '' | '/edit' | '/retract', input: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  const token = createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
  const url = new URL(world.baseUrl);
  const body = JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `/agent/v1/memory${route}`,
        method: 'POST',
        headers: { host: url.host, authorization: `Bearer ${token}`, 'x-switchboard-session': sessionId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** An approved entry, as an agent proposes it and the developer approves it (its id). */
export async function approvedEntry(world: QuestionWorld, page: Page, sessionId: string, title: string, text: string): Promise<string> {
  const proposed = await agentMemory(world, sessionId, '', { title, text, scope: 'workspace' });
  if (proposed.status !== 201) throw new Error(`memory_propose answered ${proposed.status}`);
  const id = String(proposed.body['id']);
  const status = await page.evaluate(async (entryId) => (await fetch(`/api/memory/entries/${entryId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, id);
  if (status !== 200) throw new Error(`approve answered ${status}`);
  return id;
}

/** Until the session's first turn is over (an agent proposes from a settled session). */
export async function settledSession(page: Page, id: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = await page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${sid}`)).json()) as { status: string }).status, id);
    if (status === 'done' || status === 'idle') return;
    await page.waitForTimeout(200);
  }
  throw new Error(`session ${id} did not settle`);
}
