import { describe, expect, it } from 'vitest';
import {
  JIRA_RUN_EPIC_MAX,
  type JiraIssueContext,
  buildJiraIssueContext,
  jiraContextCounts,
  jiraCountsText,
  jiraOutsideLinks,
  renderJiraComments,
  renderJiraEpicShort,
  renderJiraIssueContext,
  renderRunJiraContext,
} from '../../src/core/plans-jira-context.ts';
import { type JiraIssueInput, isImportedJiraText, JIRA_TODO_CONTEXT_LINE, jiraItemTodo } from '../../src/core/plans-jira.ts';
import { planItemBrief } from '../../src/core/plans.ts';

/** D118 · the Jira context's pure rules, over Jira REST v3's real shapes. */

const BASE = 'https://acme.atlassian.net';
const BLOCKS = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const CLONERS = { name: 'Cloners', inward: 'is cloned by', outward: 'clones' };

function adf(...paragraphs: string[]): unknown {
  return { type: 'doc', version: 1, content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) };
}

function comment(id: string, author: string, created: string, ...text: string[]) {
  return { id, author: { accountId: `acc-${author}`, displayName: author }, body: adf(...text), created, updated: created };
}

function other(key: string, summary: string, status: string) {
  return { id: key, key, fields: { summary, status: { name: status, statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Story' } } };
}

/** PROJ-12 as `GET /rest/api/3/issue/PROJ-12` answers it (fields of the context). */
function cartIssue(): JiraIssueInput {
  return {
    key: 'PROJ-12',
    fields: {
      summary: 'Cart page',
      description: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Show the cart.' }] },
          { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lists the items' }] }] }] },
        ],
      },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      assignee: { displayName: 'Ada Acme' },
      components: [{ name: 'acme-front' }],
      issuelinks: [
        // "PROJ-11 blocks PROJ-12": on PROJ-12 an outwardIssue (inside the epic: not "outside").
        { id: '1', type: BLOCKS, outwardIssue: other('PROJ-11', 'Cart API', 'Done') },
        // "PROJ-99 blocks PROJ-12": on PROJ-12 Jira says "is blocked by PROJ-99".
        { id: '2', type: BLOCKS, outwardIssue: other('PROJ-99', 'Mail service', 'In Progress') },
        // "PROJ-12 blocks PROJ-97": on PROJ-12 an inwardIssue, "blocks PROJ-97".
        { id: '3', type: BLOCKS, inwardIssue: other('PROJ-97', 'Acme analytics', 'To Do') },
        // "PROJ-12 clones PROJ-98": on PROJ-12 an inwardIssue, read with the outward phrase "clones".
        { id: '4', type: CLONERS, inwardIssue: other('PROJ-98', 'Old cart page', 'Done') },
        // "PROJ-96 clones PROJ-12": on PROJ-12 an outwardIssue, "is cloned by PROJ-96".
        { id: '5', type: CLONERS, outwardIssue: other('PROJ-96', 'Cart page v3', 'To Do') },
        // To the epic: never "outside".
        { id: '6', type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, outwardIssue: { id: 'PROJ-10', key: 'PROJ-10' } },
      ],
      subtasks: [
        { id: '21', key: 'PROJ-21', fields: { summary: 'Cart empty state', status: { name: 'To Do' }, issuetype: { name: 'Sub-task' } } },
        { id: '22', key: 'PROJ-22', fields: { summary: 'Cart totals row', status: { name: 'Done' }, issuetype: { name: 'Sub-task' } } },
      ],
      attachment: [
        { id: 'a1', filename: 'cart-mockup.png', size: 10, mimeType: 'image/png' },
        { id: 'a2', filename: 'totals.pdf', size: 10, mimeType: 'application/pdf' },
      ],
      comment: {
        comments: [comment('c1', 'Ada Acme', '2026-10-01T10:00:00.000+0000', 'Use the new price formatter.'), comment('c2', 'Grace Acme', '2026-10-02T11:30:00.000+0000', 'Design updated:', 'empty state added.')],
        maxResults: 2,
        total: 2,
        startAt: 0,
      },
    },
  };
}

const INSIDE = new Set(['PROJ-10', 'PROJ-11', 'PROJ-12', 'PROJ-13']);

function cartContext(overrides: Partial<Parameters<typeof buildJiraIssueContext>[0]> = {}): JiraIssueContext {
  return buildJiraIssueContext({
    issue: cartIssue(),
    baseUrl: BASE,
    acceptanceField: null,
    remoteLinks: [
      { id: 1, self: `${BASE}/rest/api/3/issue/PROJ-12/remotelink/1`, object: { url: 'https://www.figma.com/design/AcmeFile/Cart?node-id=1-2', title: 'Cart page (Figma)', icon: {} } },
      { id: 2, object: { url: `${BASE}/wiki/spaces/ACME/pages/101/Cart`, title: 'Cart rules' } },
      { id: 3, object: { title: 'no url' } },
    ],
    exclude: INSIDE,
    ...overrides,
  });
}

describe('D118 · an issue context from Jira REST v3', () => {
  it('reads the description, acceptance criteria, comments (ADF, author, date), sub-tasks, remote links and attachment names', () => {
    const context = cartContext();
    expect(context.description).toBe('Show the cart.');
    expect(context.acceptanceCriteria).toBe('- Lists the items');
    expect(context.comments).toEqual([
      { author: 'Ada Acme', created: '2026-10-01T10:00:00.000+0000', text: 'Use the new price formatter.' },
      { author: 'Grace Acme', created: '2026-10-02T11:30:00.000+0000', text: 'Design updated:\n\nempty state added.' },
    ]);
    expect(context.commentsTotal).toBe(2);
    // fields.subtasks has no descriptions (real Jira).
    expect(context.subtasks).toEqual([
      { key: 'PROJ-21', summary: 'Cart empty state', status: 'To Do', description: null },
      { key: 'PROJ-22', summary: 'Cart totals row', status: 'Done', description: null },
    ]);
    expect(context.remoteLinks).toEqual([
      { title: 'Cart page (Figma)', url: 'https://www.figma.com/design/AcmeFile/Cart?node-id=1-2' },
      { title: 'Cart rules', url: `${BASE}/wiki/spaces/ACME/pages/101/Cart` },
    ]);
    expect(context.attachments).toEqual(['cart-mockup.png', 'totals.pdf']);
  });

  it('takes sub-task descriptions from a search, and comments from GET …/comment when given', () => {
    const context = cartContext({
      subtasks: [{ key: 'PROJ-21', fields: { summary: 'Cart empty state', status: { name: 'To Do' }, description: adf('Show "Your cart is empty".') } }],
      comments: [comment('c9', 'Ada Acme', '2026-10-05T08:00:00.000+0000', 'Added after the import.')],
      commentsTotal: 7,
    });
    expect(context.subtasks).toEqual([{ key: 'PROJ-21', summary: 'Cart empty state', status: 'To Do', description: 'Show "Your cart is empty".' }]);
    expect(context.comments.map((entry) => entry.text)).toEqual(['Added after the import.']);
    expect(context.commentsTotal).toBe(7);
  });

  it("names linked tickets outside the epic with the phrase Jira shows on this ticket (D117's rule for every type)", () => {
    const links = jiraOutsideLinks(cartIssue(), INSIDE);
    expect(links.map((link) => link.text)).toEqual([
      'PROJ-12 is blocked by PROJ-99 Mail service (In Progress)',
      'PROJ-12 blocks PROJ-97 Acme analytics (To Do)',
      'PROJ-12 clones PROJ-98 Old cart page (Done)',
      'PROJ-12 is cloned by PROJ-96 Cart page v3 (To Do)',
    ]);
    expect(links[0]).toMatchObject({ key: 'PROJ-99', phrase: 'is blocked by', summary: 'Mail service', status: 'In Progress' });
  });

  it('counts what the preview shows', () => {
    const counts = jiraContextCounts(cartIssue(), INSIDE, 2);
    expect(counts).toEqual({ comments: 2, subtasks: 2, links: 6, attachments: 2 });
    expect(jiraCountsText(counts)).toBe('2 comments · 2 sub-tasks · 6 links · 2 attachments');
    expect(jiraCountsText({ comments: 1, subtasks: 0, links: 1, attachments: 0 })).toBe('1 comment · 1 link');
    expect(jiraCountsText({ comments: 0, subtasks: 0, links: 0, attachments: 0 })).toBe('');
  });
});

describe('D118 · rendering and caps', () => {
  it('renders a ticket: acceptance criteria before the description, then sub-tasks, links, attachments, comments oldest first', () => {
    const { text, trimmed } = renderJiraIssueContext(cartContext(), { heading: 'Ticket PROJ-12 Cart page', max: 20_000 });
    expect(trimmed).toEqual([]);
    const order = ['Ticket PROJ-12', 'Acceptance criteria:', 'Description:', 'Sub-tasks:', 'Linked tickets outside the epic:', 'Links (Confluence, Figma', 'Attachments (names only, not downloaded): cart-mockup.png, totals.pdf', 'Comments (2, oldest first):', 'Ada Acme, 2026-10-01', 'Grace Acme, 2026-10-02'];
    const at = order.map((part) => text.indexOf(part));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('cuts comments first, keeping the newest, and says so', () => {
    const many = Array.from({ length: 30 }, (_, index) => comment(`c${index}`, 'Ada Acme', `2026-10-${String(index + 1).padStart(2, '0')}T08:00:00.000+0000`, `Comment number ${index} ${'x'.repeat(300)}`));
    const context = cartContext({ comments: many });
    const out = renderJiraComments(context, 2_000, true);
    expect(out.dropped).toBeGreaterThan(20);
    expect(out.text).toContain(`the ${out.dropped} oldest left out to keep this short, plan_jira_context has them all`);
    expect(out.text).toContain('Comment number 29');
    expect(out.text).not.toContain('Comment number 0 ');
    expect(out.text.indexOf('Comment number 28')).toBeLessThan(out.text.indexOf('Comment number 29'));
  });

  it('shortens the epic for a run: acceptance criteria first, within the cap', () => {
    const epic: JiraIssueContext = { ...cartContext(), key: 'PROJ-10', summary: 'Acme checkout', description: 'd'.repeat(10_000), acceptanceCriteria: '- A customer can pay' };
    const text = renderJiraEpicShort(epic);
    expect(text.length).toBeLessThanOrEqual(JIRA_RUN_EPIC_MAX);
    expect(text).toContain('Epic context: PROJ-10 Acme checkout (shortened; the full text is available via plan_jira_context)');
    expect(text.indexOf('Acceptance criteria:')).toBeLessThan(text.indexOf('Description:'));
  });

  it('a run block trims the ticket comments first, then the epic, then the ticket, and notes it', () => {
    const many = Array.from({ length: 40 }, (_, index) => comment(`c${index}`, 'Ada Acme', '2026-10-03T08:00:00.000+0000', `Comment ${index} ${'y'.repeat(500)}`));
    const item = cartContext({ comments: many });
    const epic: JiraIssueContext = { ...cartContext(), key: 'PROJ-10', summary: 'Acme checkout', comments: [] };
    const readAt = '2026-10-20T09:15:00.000Z';
    // Room for everything.
    const full = renderRunJiraContext({ item, epic, budget: 60_000, readAt });
    expect(full).toContain('Jira context (read from Jira when this run started, 2026-10-20 09:15 UTC):');
    expect(full).toContain('Comment 0 ');
    expect(full).toContain('Epic context: PROJ-10');
    expect(full).not.toContain('Trimmed');
    // 1. Comments go first; the epic stays.
    const tight = renderRunJiraContext({ item, epic, budget: 10_000, readAt });
    expect(tight.length).toBeLessThanOrEqual(10_000);
    expect(tight).toContain('Epic context: PROJ-10');
    expect(tight).toContain('Comment 39');
    expect(tight).not.toContain('Comment 0 ');
    expect(tight).toMatch(/Trimmed to keep this message short: \d+ older comment\(s\) of PROJ-12\. Call plan_jira_context for everything\./);
    // 2. Then the epic.
    const bigItem: JiraIssueContext = { ...item, description: 'z'.repeat(5_000) };
    const tighter = renderRunJiraContext({ item: bigItem, epic, budget: 6_000, readAt });
    expect(tighter.length).toBeLessThanOrEqual(6_000);
    expect(tighter).toContain("the epic's section");
    // 3. Then the ticket's own text.
    const huge: JiraIssueContext = { ...item, description: 'z'.repeat(20_000) };
    const cut = renderRunJiraContext({ item: huge, epic, budget: 6_000, readAt });
    expect(cut.length).toBeLessThanOrEqual(6_000);
    expect(cut).toContain("the epic's section (left out)");
    expect(cut).toContain('the rest of PROJ-12');
  });

  it('a run block names the half that could not be read', () => {
    const text = renderRunJiraContext({ item: cartContext(), epic: null, budget: 40_000, readAt: '2026-10-20T09:15:00.000Z' });
    expect(text).toContain('The epic could not be read from Jira now; use plan_jira_context.');
  });
});

describe('D118 · the todo and the brief', () => {
  const item = { key: 'PROJ-1', summary: 'Cart', description: 'x'.repeat(10_000), acceptanceCriteria: '- AC', acceptanceSource: 'field' as const, components: ['acme-front'], status: 'To Do', assignee: null, estimateMinutes: null, url: `${BASE}/browse/PROJ-1`, unlinked: true };

  it('the todo is a short summary that never drops the facts', () => {
    const todo = jiraItemTodo(item);
    expect(todo.description.length).toBeLessThan(3_000);
    expect(todo.description).toContain('Acceptance criteria:\n- AC');
    expect(todo.description).toContain(`Jira: ${BASE}/browse/PROJ-1 · components acme-front`);
    expect(todo.description.endsWith(JIRA_TODO_CONTEXT_LINE)).toBe(true);
  });

  it("recognises the import's text, before and after D118, but not a rewritten description", () => {
    const url = `${BASE}/browse/PROJ-1`;
    const preD118 = `Long description\n\nAcceptance criteria:\n- AC\n\nJira: ${url} · components acme-front`;
    expect(isImportedJiraText(preD118, url)).toBe(true);
    expect(isImportedJiraText(jiraItemTodo(item).description, url)).toBe(true);
    expect(isImportedJiraText(`Jira: ${url}`, url)).toBe(true);
    expect(isImportedJiraText(`Jira: ${BASE}/browse/PROJ-10 · x`, url)).toBe(false);
    expect(isImportedJiraText('My own notes for this item.', url)).toBe(false);
    expect(isImportedJiraText(null, url)).toBe(false);
  });

  it('the brief puts the context after the brief and before the merge rule, and can leave the imported description out', () => {
    const input = {
      planTitle: 'PROJ-10 Acme checkout',
      targetBranch: 'feature/PROJ-10',
      notes: 'Be careful.',
      key: 'PROJ-1',
      branch: 'PROJ-1-cart',
      developerMerges: false,
      todo: { id: 't1', title: 'PROJ-1 Cart', description: 'IMPORTED TEXT', plan: null },
      context: 'Jira context (read from Jira when this run started):\n\nTicket PROJ-1',
    };
    const brief = planItemBrief(input);
    expect(brief.indexOf('IMPORTED TEXT')).toBeGreaterThan(0);
    expect(brief.indexOf('Notes for every item')).toBeLessThan(brief.indexOf('Jira context'));
    expect(brief.indexOf('Jira context')).toBeLessThan(brief.indexOf('When the work is done:'));
    expect(planItemBrief({ ...input, omitDescription: true })).not.toContain('IMPORTED TEXT');
    expect(planItemBrief({ ...input, context: null })).not.toContain('Jira context');
  });
});
