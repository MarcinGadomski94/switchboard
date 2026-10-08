import { type Browser, type Page, expect, test } from '@playwright/test';
import type { SessionEvent } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * Typing lag fix (developer report 2026-10-08: typing in the composer lagged in a
 * long conversation on a phone; `docs/chat.md` → *Composer*). A real fake-claude
 * session whose `GET /events` is answered with a long conversation (200 turns: the
 * user's message, two tool steps, a Markdown answer with a code block, a table and
 * a list: 600 messages), at desktop and at phone size. Guards, both deterministic
 * or self-relative (no absolute timings):
 * 1. **No message re-renders while typing.** A stub of React's DevTools hook (it
 *    works on the production build) walks every commit and counts the components
 *    that rendered whose DOM lies in the conversation (`session-chat`). Typing 20
 *    characters must count 0 there (the composer owns its draft).
 * 2. **Typing one line does not touch the field's size.** No write to the field's
 *    `style` (a MutationObserver) and no resize of the chat area (a ResizeObserver)
 *    while one line is typed: the old autosize collapsed the field and set its
 *    height again on every key, laying the composer and the chat out twice per key.
 * 3. **A keystroke does not lay the conversation out again.** The cost of a value
 *    change + layout in the field is measured with the conversation shown and with
 *    it hidden, interleaved in the same page; shown may cost at most 20× hidden. At
 *    phone size the chat's `flex: 1` (a 0% basis) made it ~35× (≈38 ms vs 1.1 ms
 *    per 20 changes; ~9× with the 0px basis), sizing the chat from its content on
 *    every layout. Desktop costs too little to compare (under 2 ms).
 */
test.use({ trace: 'off' });

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('typing-long-chat');
});

test.afterAll(async () => {
  await world?.stop();
});

const TURNS = 200;

function markdown(i: number): string {
  return [
    `Turn ${i}: here is what I changed in **the upload flow** and why. See \`src/upload/${i}.ts\`.`,
    '',
    '```ts',
    `export function handler${i}(input: string): number {`,
    '  const parts = input.split(",").map((part) => part.trim());',
    `  return parts.filter((part) => part.length > ${i % 7}).length;`,
    '}',
    '```',
    '',
    '| File | Lines | Status |',
    '|---|---|---|',
    `| upload-${i}.ts | ${i * 3} | changed |`,
    `| upload-${i}.test.ts | ${i * 2} | added |`,
    '',
    `- first point ${i}`,
    `- second point with a [link](https://example.com/${i})`,
  ].join('\n');
}

/** The real session's events as templates, repeated into a long conversation. */
function longConversation(real: readonly SessionEvent[]): SessionEvent[] {
  const of = (type: string) => real.filter((event) => (event.payload as { type: string }).type === type);
  const [user] = of('user');
  const [assistant] = of('assistant');
  const [result] = of('result');
  const tools = of('tool');
  if (!user || !assistant || !result || tools.length === 0 || !real[0]) throw new Error('the fake session lacks a template event');
  const out: SessionEvent[] = [real[0]];
  let id = 1;
  const base = Date.parse(real[0].ts) - TURNS * 60_000;
  for (let i = 0; i < TURNS; i += 1) {
    const ts = (k: number): string => new Date(base + i * 60_000 + k * 1000).toISOString();
    out.push({ ...user, id: ++id, ts: ts(0), label: `Look at item ${i}`, payload: { ...(user.payload as object), text: `Please look at item ${i} and fix the **upload** bug.`, origin: 'user', delivered: true } });
    for (const tool of tools) out.push({ ...tool, id: ++id, ts: ts(1), endTs: ts(2), payload: { ...(tool.payload as object), toolUseId: `toolu_${i}_${id}` } });
    out.push({ ...assistant, id: ++id, ts: ts(3), label: `Turn ${i}`, payload: { ...(assistant.payload as object), text: markdown(i), messageId: `msg_${i}` } });
    out.push({ ...result, id: ++id, ts: ts(4), payload: { ...(result.payload as object), text: markdown(i) } });
  }
  return out;
}

/** Installs the React DevTools hook stub that counts rendered components per commit (in the chat and in total). */
async function countRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Fiber = { tag: number; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; stateNode: unknown };
    const counts = { commits: 0, inChat: 0, total: 0 };
    (window as unknown as { __sbRenders: typeof counts }).__sbRenders = counts;
    const hostNode = (fiber: Fiber): Node | null => {
      for (let f: Fiber | null = fiber; f; f = f.child) if (f.tag === 5 || f.tag === 6) return f.stateNode as Node;
      return null;
    };
    // Function, class, forwardRef, memo and simple-memo components; PerformedWork = 1.
    const COMPONENT = new Set([0, 1, 11, 14, 15]);
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
        counts.commits += 1;
        const chat = document.querySelector('[data-testid="session-chat"]');
        const walk = (first: Fiber | null): void => {
          for (let f = first; f; f = f.sibling) {
            const mounted = f.alternate === null;
            if (COMPONENT.has(f.tag) && (mounted || (f.flags & 1) === 1)) {
              counts.total += 1;
              const node = hostNode(f);
              if (chat && node && chat.contains(node)) {
                counts.inChat += 1;
                const el = node instanceof Element ? node : node.parentElement;
                ((window as unknown as { __sbWhere: string[] }).__sbWhere ??= []).push(`${el?.getAttribute('data-testid') ?? ''}.${el?.className ?? ''}`);
              }
            }
            // A subtree whose child list is the previous commit's bailed out: nothing in it rendered.
            if (mounted || f.child !== f.alternate?.child) walk(f.child);
          }
        };
        walk(root.current.child);
      },
    };
  });
}

async function openLongChat(browser: Browser, phone: boolean): Promise<Page> {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await countRenders(page);
  await page.goto(world.baseUrl);
  const { id } = await world.startSession(page, phone ? 'long-chat-phone' : 'long-chat-desktop', '[fake:tool-use] Create out.txt and list the files.');
  await expect.poll(async () => page.evaluate(async (sid) => ((await (await fetch(`/api/sessions/${sid}`)).json()) as { status: string }).status, id), { timeout: 15_000 }).toBe('done');
  const real = (await page.evaluate(async (sid) => (await fetch(`/api/sessions/${sid}/events`)).json(), id)) as SessionEvent[];
  const events = longConversation(real);
  await page.route(
    (url) => url.pathname === `/api/sessions/${id}/events`,
    (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.has('since') ? [] : events }),
  );
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-message')).toHaveCount(TURNS * 3, { timeout: 30_000 });
  return page;
}

for (const phone of [false, true]) {
  test(`${phone ? 'phone 390×844' : 'desktop 1440×900'}: typing in a 600-message chat re-renders no message, does not resize the chat, and does not lay it out again`, async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await openLongChat(browser, phone);
    const input = page.getByTestId('chat-input');
    await input.focus();
    // Quiet first: no React commit for a second (the session's own late updates are not typing).
    let last = -1;
    await expect
      .poll(
        async () => {
          const now = await page.evaluate(() => (window as unknown as { __sbRenders: { commits: number } }).__sbRenders.commits);
          const quiet = now === last;
          last = now;
          return quiet;
        },
        { intervals: [1000], timeout: 20_000 },
      )
      .toBe(true);
    await page.evaluate(() => {
      const w = window as unknown as { __sbRenders: { commits: number; inChat: number; total: number }; __sbResizes: number };
      w.__sbRenders.commits = 0;
      w.__sbRenders.inChat = 0;
      w.__sbRenders.total = 0;
      w.__sbResizes = 0;
      (window as unknown as { __sbStyleWrites: number }).__sbStyleWrites = 0;
      new MutationObserver((records) => {
        (window as unknown as { __sbStyleWrites: number }).__sbStyleWrites += records.length;
      }).observe(document.querySelector('[data-testid="chat-input"]')!, { attributes: true, attributeFilter: ['style'] });
      (window as unknown as { __sbWhere: string[] }).__sbWhere = [];
      let first = true;
      new ResizeObserver(() => {
        // The first callback reports the current size.
        if (first) first = false;
        else w.__sbResizes += 1;
      }).observe(document.querySelector('.sb-chat')!);
    });
    await page.keyboard.type('fix the upload ', { delay: 20 });
    await page.keyboard.type('please', { delay: 20 });
    await expect(input).toHaveValue('fix the upload please');
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const w = window as unknown as { __sbRenders: { commits: number; inChat: number; total: number }; __sbResizes: number };
      return { ...w.__sbRenders, resizes: w.__sbResizes, styleWrites: (window as unknown as { __sbStyleWrites: number }).__sbStyleWrites, where: ((window as unknown as { __sbWhere?: string[] }).__sbWhere ?? []).slice(-20) };
    });
    // The hook saw the typing (the composer rendered), and nothing in the conversation rendered.
    expect(after.commits).toBeGreaterThanOrEqual(21);
    expect(after.total).toBeGreaterThan(0);
    expect(after.inChat, `components rendered inside the conversation while typing (last: ${after.where.join(', ')})`).toBe(0);
    expect(after.styleWrites, "writes to the field's style while typing one line").toBe(0);
    expect(after.resizes, 'chat area resizes while typing one line').toBe(0);

    // 3. A keystroke's layout with the conversation shown vs hidden (interleaved, medians).
    const ratio = await page.evaluate(() => {
      const field = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
      const chat = document.querySelector<HTMLElement>('.sb-chat')!;
      const batch = (): number => {
        const start = performance.now();
        for (let i = 0; i < 20; i += 1) {
          field.value += 'a';
          void field.offsetHeight;
        }
        field.value = 'fix the upload please';
        void field.offsetHeight;
        return performance.now() - start;
      };
      const shown: number[] = [];
      const hidden: number[] = [];
      for (let round = 0; round < 7; round += 1) {
        shown.push(batch());
        // Hidden: the conversation is taken out of the layout.
        chat.style.display = 'none';
        void chat.offsetHeight;
        hidden.push(batch());
        chat.style.display = '';
        void chat.offsetHeight;
      }
      const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      return { shown: median(shown), hidden: median(hidden) };
    });
    // Sub-millisecond batches are noise: only a measurable cost is compared.
    if (ratio.shown > 2) expect(ratio.shown / Math.max(ratio.hidden, 0.5), `layout per batch: shown ${ratio.shown.toFixed(2)} ms vs hidden ${ratio.hidden.toFixed(2)} ms`).toBeLessThanOrEqual(20);
    await page.context().close();
  });
}
