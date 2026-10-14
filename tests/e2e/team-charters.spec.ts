import { createHmac } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { TEAM_TEMPLATES } from '../../src/core/team-templates.ts';
import { openWithHub } from './question-world.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';

/**
 * D105 · better charters on the Team page, on the real code path with fake-claude
 * as the member's agent (`docs/team.md` → *Better charters*): the one-time offer
 * (shown once: gone after it was acted on, also after a reload), "Draft better
 * charters" sending the ask into the member's own chat, the agent's
 * `team_propose_charter` (its session's agent token, as the MCP helper calls it)
 * making a proposal that Needs you and the member's Settings show, Accept replacing
 * the charter, Edit… opening Settings with the proposal filled in, Dismiss, and
 * Redraft charter from the ⋯ menu; the Adopt form asking the new member's agent.
 * D100 follow-up 2026-10-14 (activity redesign): a run of charter proposals and
 * acceptances groups in Activity and expands; Activity and Needs you collapse, the
 * state survives a reload, a collapsed Activity counts what is new, and a new item
 * opens a collapsed Needs you.
 */

let world: TeamWorld;

/** Screenshots for the report (outside the repo). */
const SHOTS = process.env['SWITCHBOARD_D105_SHOTS'] ?? path.join(process.env['TMPDIR'] ?? '/tmp', 'switchboard-d105-shots');
/** The activity redesign's screenshots (outside the repo). */
const ACTIVITY_SHOTS = process.env['SWITCHBOARD_ACTIVITY_SHOTS'] ?? path.join(process.env['TMPDIR'] ?? '/tmp', 'switchboard-activity-shots');

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-team-charters', { plain: true });
  await mkdir(SHOTS, { recursive: true });
  await mkdir(ACTIVITY_SHOTS, { recursive: true });
});

test.afterAll(async () => {
  await world?.stop();
});

test.describe.configure({ mode: 'serial' });

const DEVELOPER = TEAM_TEMPLATES.find((t) => t.id === 'developer')?.charter;

/** What the member's agent does with `team_propose_charter` (POST /agent/v1/team/charter with its session's agent token). */
async function agentProposes(sessionId: string, fields: Record<string, unknown>): Promise<number> {
  const secret = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  const token = createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
  const url = new URL(world.baseUrl);
  const body = JSON.stringify(fields);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(url.port),
        path: '/agent/v1/team/charter',
        method: 'POST',
        headers: { host: url.host, authorization: `Bearer ${token}`, 'x-switchboard-session': sessionId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function card(page: Page, role: string) {
  return page.getByTestId('team-card').filter({ has: page.getByTestId('team-card-role').getByText(role, { exact: true }) });
}

async function closeToasts(page: Page): Promise<void> {
  for (const close of await page.getByTestId('toast').getByRole('button', { name: 'Close' }).all()) await close.click().catch(() => undefined);
}

const PROPOSAL = {
  owns: 'The Acme Studio feature in acme-app: its editor and its preview.',
  produces: 'Commits on feature/studio with tests, and a short note per feedback round.',
  howItWorks: 'Runs feedback rounds: the developer and the testers send feedback, it adjusts the feature and reports what changed.',
  neverDoes: 'Works outside acme-app, or merges into the default branch.',
  notes: 'Based on the rounds in this session.',
};

test('the offer, Draft better charters, the proposal in Needs you and Settings, Accept', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setTeam(page, true);
  const session = await world.startSession(page, 'studio-work', 'Reply with just OK.');
  await world.settle(page, session.id);
  // Adopted with the template's charter and the review's drafted line: a template-only charter.
  await world.adopt(page, session.id, 'Studio', { templateId: 'developer', charter: { ...DEVELOPER, owns: `${DEVELOPER?.owns} Continues the work of “studio-work”.` } });
  await world.settle(page, session.id);

  await page.goto(`${world.baseUrl}/team`);
  const offer = page.getByTestId('team-charter-offer');
  await expect(offer).toContainText('Switchboard can draft specific charters for your 1 member from their own sessions.');
  await page.screenshot({ path: path.join(SHOTS, 'd105-offer-banner.png') });
  await offer.getByTestId('team-charter-offer-draft').click();
  await expect(page.getByTestId('toast')).toContainText('Asked Studio to draft a specific charter');
  await closeToasts(page);
  await expect(offer).toHaveCount(0);
  // Shown once: acted on, it does not come back.
  await page.reload();
  await expect(card(page, 'Studio')).toBeVisible();
  await expect(page.getByTestId('team-charter-offer')).toHaveCount(0);

  // The ask is a normal message in its own chat.
  await card(page, 'Studio').click();
  const panel = page.getByTestId('team-panel');
  await expect(panel.getByTestId('team-chat')).toContainText('Switchboard asks you, Studio in team Team, to draft a specific charter for yourself.', { timeout: 20_000 });
  await world.settle(page, session.id);
  // Settings: waiting for the agent; a second ask is not offered.
  await panel.getByTestId('team-tab-settings').click();
  await expect(panel.getByTestId('team-settings-asked')).toContainText('Studio was asked to propose a specific charter');
  await expect(panel.getByTestId('team-settings-redraft')).toHaveCount(0);
  await expect((await world.call(page, 'POST', '/api/team/charters/ask', {})).body.skipped).toEqual([expect.objectContaining({ name: 'Studio', reason: 'asked already' })]);

  // The agent proposes.
  expect(await agentProposes(session.id, PROPOSAL)).toBe(201);
  const need = page.locator('[data-testid="team-need"][data-kind="charter"]');
  await expect(need).toContainText('Studio · charter');
  await expect(need.getByTestId('team-need-title')).toHaveText('Studio proposes a new charter');
  await expect(need.locator('[data-field="howItWorks"] [data-testid="team-charter-after"]')).toHaveText(PROPOSAL.howItWorks);
  await expect(need.locator('[data-field="owns"] [data-testid="team-charter-before"]')).toContainText(DEVELOPER?.owns ?? '');
  await expect(need.getByTestId('team-charter-notes')).toHaveText(`Notes: ${PROPOSAL.notes}`);
  // The member's Settings shows it above the form too.
  const settingsProposal = panel.getByTestId('team-settings-charter-state');
  await expect(settingsProposal).toHaveAttribute('data-state', 'proposed');
  await expect(settingsProposal).toContainText('Studio proposes a new charter');
  await page.screenshot({ path: path.join(SHOTS, 'd105-needs-you-and-settings-proposal.png') });
  await need.screenshot({ path: path.join(SHOTS, 'd105-needs-you-proposal.png') });
  await settingsProposal.screenshot({ path: path.join(SHOTS, 'd105-settings-proposal.png') });

  await need.getByTestId('team-charter-accept').click();
  await expect(need).toHaveCount(0);
  await expect(panel.getByTestId('team-form-how')).toHaveValue(PROPOSAL.howItWorks, { timeout: 10_000 });
  await expect(panel.getByTestId('team-form-owns')).toHaveValue(PROPOSAL.owns);
  await expect(page.getByTestId('team-activity')).toContainText('new charter accepted');
  const member = (await world.call(page, 'GET', '/api/team')).body.members[0];
  expect(member.charter).toEqual({ owns: PROPOSAL.owns, produces: PROPOSAL.produces, howItWorks: PROPOSAL.howItWorks, neverDoes: PROPOSAL.neverDoes });
});

test('Redraft charter from the ⋯ menu; Edit… fills Settings and Save accepts with the edits; Dismiss', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/team`);
  const view = (await world.call(page, 'GET', '/api/team')).body;
  const member = view.members[0] as { id: string; sessionId: string };
  await world.settle(page, member.sessionId);
  await card(page, 'Studio').click();
  const panel = page.getByTestId('team-panel');
  await panel.getByTestId('team-panel-menu').click();
  await page.getByTestId('team-member-menu').getByTestId('team-menu-redraft').click();
  await expect(page.getByTestId('toast')).toContainText('Asked Studio to draft a specific charter from its own session.');
  await closeToasts(page);
  await world.settle(page, member.sessionId);

  // Edit…: Settings opens with the proposal; Save accepts it with the edits.
  expect(await agentProposes(member.sessionId, { ...PROPOSAL, owns: 'The Acme Studio editor.' })).toBe(201);
  const need = page.locator('[data-testid="team-need"][data-kind="charter"]');
  await need.getByTestId('team-charter-edit').click();
  await expect(panel.getByTestId('team-tab-settings')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByTestId('team-settings-editing-proposal')).toContainText('Save accepts it with your edits');
  await expect(panel.getByTestId('team-form-owns')).toHaveValue('The Acme Studio editor.');
  await panel.getByTestId('team-form-owns').fill('The Acme Studio editor and its preview.');
  await panel.getByTestId('team-settings-save').click();
  await expect(need).toHaveCount(0);
  await expect.poll(async () => (await world.call(page, 'GET', `/api/team/members/${member.id}`)).body.charter.owns).toBe('The Acme Studio editor and its preview.');
  await expect(page.getByTestId('team-activity')).toContainText('new charter accepted (with your edits)');

  // Dismiss records it; the charter stays.
  await world.settle(page, member.sessionId);
  expect((await world.call(page, 'POST', `/api/team/members/${member.id}/charter/ask`)).status).toBe(201);
  await world.settle(page, member.sessionId);
  expect(await agentProposes(member.sessionId, { ...PROPOSAL, owns: 'Something else.' })).toBe(201);
  await need.getByTestId('team-charter-dismiss').click();
  await expect(need).toHaveCount(0);
  await expect(page.getByTestId('team-activity')).toContainText('charter proposal dismissed');
  expect((await world.call(page, 'GET', `/api/team/members/${member.id}`)).body.charter.owns).toBe('The Acme Studio editor and its preview.');
});

test('the Adopt form asks the new member\'s agent for a specific charter', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const session = await world.startSession(page, 'board-sweep', 'Reply with just OK.');
  await world.settle(page, session.id);
  await page.goto(`${world.baseUrl}/team`);
  await page.getByTestId('team-add').click();
  await page.getByTestId('team-add-adopt').click();
  const review = page.getByTestId('team-review-dialog');
  if (await review.isVisible().catch(() => false)) await review.locator(`[data-testid="team-not-suggested-row"][data-session-id="${session.id}"]`).getByTestId('team-not-suggested-adopt').click();
  else await page.locator(`[data-testid="team-session-pick"][data-session-id="${session.id}"]`).click();
  const form = page.getByTestId('team-form-dialog');
  await expect(form.getByTestId('team-adopt-charter-note')).toContainText('its agent is asked to propose a specific charter');
  await form.getByTestId('team-form-name').fill('Sweeper');
  await form.getByTestId('team-form-submit').click();
  await expect(card(page, 'Sweeper')).toBeVisible();
  await card(page, 'Sweeper').click();
  await expect(page.getByTestId('team-panel').getByTestId('team-chat')).toContainText('Switchboard asks you, Sweeper in team Team', { timeout: 20_000 });
  const sweeper = ((await world.call(page, 'GET', '/api/team')).body.members as Array<{ name: string; charterRequest: { state: string } | null }>).find((m) => m.name === 'Sweeper');
  expect(sweeper?.charterRequest?.state).toBe('asked');
});

test('Activity: a run of 4 charter acceptances groups and expands; Activity and Needs you collapse and remember it', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWithHub(page, `${world.baseUrl}/inbox`);
  const names = ['Tech debt handler', 'Marketing delivery tracking', 'Release notes', 'Board triage'];
  const members: { sessionId: string; id: string }[] = [];
  for (const [index, name] of names.entries()) {
    const session = await world.startSession(page, `run-${index}`, 'Reply with just OK.');
    await world.settle(page, session.id);
    const member = await world.adopt(page, session.id, name, { templateId: 'developer' });
    members.push({ sessionId: session.id, id: member.id });
  }
  await page.goto(`${world.baseUrl}/team`);
  const needs = page.getByTestId('team-needs-you');
  const charterNeeds = page.locator('[data-testid="team-need"][data-kind="charter"]');
  // Three proposals; collapse Needs you; the fourth opens it again.
  for (const m of members.slice(0, 3)) expect(await agentProposes(m.sessionId, PROPOSAL)).toBe(201);
  await expect(charterNeeds).toHaveCount(3);
  await needs.getByTestId('team-needs-toggle').click();
  await expect(needs.getByTestId('team-needs-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(charterNeeds).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('team-needs-toggle')).toHaveAttribute('aria-expanded', 'false');
  expect(await agentProposes(members[3]!.sessionId, PROPOSAL)).toBe(201);
  await expect(charterNeeds).toHaveCount(4);
  await expect(needs.getByTestId('team-needs-toggle')).toHaveAttribute('aria-expanded', 'true');
  // The four proposals are one group row.
  const proposed = page.locator('[data-testid="team-activity-group"][data-variant="charter-proposed"]').first();
  await expect(proposed).toHaveAttribute('data-count', '4');
  await expect(proposed.getByTestId('team-activity-group-label')).toHaveText('4 new charters proposed — waiting in Needs you');
  await page.getByTestId('team-split').locator('.sb-team-left').screenshot({ path: path.join(ACTIVITY_SHOTS, 'column-desktop-needs.png') });

  // Accept all four: one group "✓ 4 new charters accepted · hh:mm" with the names as chips.
  const items = (await world.call(page, 'GET', '/api/team/needs-you')).body;
  const list = (items.items ?? items) as Array<{ id: string; kind: string; memberId: string }>;
  for (const m of members) {
    const item = list.find((i) => i.kind === 'charter' && i.memberId === m.id);
    expect((await world.call(page, 'POST', `/api/team/requests/${item?.id}/approve`, {})).status).toBe(200);
  }
  await expect(charterNeeds).toHaveCount(0);
  await expect(needs.getByTestId('team-needs-none')).toHaveText('Nothing waits for you ✓');
  const accepted = page.locator('[data-testid="team-activity-group"][data-variant="charter-accepted"]').first();
  await expect(accepted).toHaveAttribute('data-count', '4');
  await expect(accepted.getByTestId('team-activity-group-label')).toHaveText('4 new charters accepted');
  await expect(accepted.getByTestId('team-activity-time')).toHaveText(/^\d\d:\d\d(–\d\d:\d\d)?$/);
  await expect(accepted.locator('.sb-team-act__chip')).toHaveText([names[3]!, names[2]!, '+2']);
  await expect(accepted.getByTestId('team-activity-group-rows')).toHaveCount(0);
  await page.getByTestId('team-split').locator('.sb-team-left').screenshot({ path: path.join(ACTIVITY_SHOTS, 'column-desktop-grouped.png') });
  await accepted.getByTestId('team-activity-group-toggle').click();
  const rows = accepted.getByTestId('team-activity-group-rows').getByTestId('team-activity-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.getByTestId('team-activity-actor')).toHaveText([...names].reverse());
  // The actor is not repeated in the text.
  await expect(rows.getByTestId('team-activity-text')).toHaveText(['new charter accepted', 'new charter accepted', 'new charter accepted', 'new charter accepted']);
  await page.getByTestId('team-split').locator('.sb-team-left').screenshot({ path: path.join(ACTIVITY_SHOTS, 'column-desktop-expanded.png') });

  // Collapse Activity: it stays collapsed after a reload and counts what is new.
  const activity = page.getByTestId('team-activity');
  await activity.getByTestId('team-activity-toggle').click();
  await expect(activity.getByTestId('team-activity-list')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('team-activity-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('team-activity-list')).toHaveCount(0);
  await expect(page.getByTestId('team-activity-new')).toHaveCount(0);
  expect((await world.call(page, 'POST', `/api/team/members/${members[0]!.id}/pause`)).status).toBe(200);
  await expect(page.getByTestId('team-activity-new')).toHaveText('· 1 new');
  await page.getByTestId('team-split').locator('.sb-team-left').screenshot({ path: path.join(ACTIVITY_SHOTS, 'column-desktop-collapsed.png') });
  await page.getByTestId('team-activity-toggle').click();
  await expect(page.getByTestId('team-activity-new')).toHaveCount(0);
  const paused = page.getByTestId('team-activity-list').getByTestId('team-activity-row').first();
  await expect(paused).toHaveAttribute('data-variant', 'pause');
  await expect(paused.getByTestId('team-activity-actor')).toHaveText(names[0]!);
  await expect(paused.getByTestId('team-activity-text')).toHaveText('paused');
  await page.reload();
  await expect(page.getByTestId('team-activity-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('team-activity-list')).toBeVisible();

  // Phone: the same rows, full width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('view-team')).toHaveAttribute('data-layout', 'phone');
  const phoneActivity = page.getByTestId('team-activity');
  await phoneActivity.scrollIntoViewIfNeeded();
  const widths = await page.evaluate(() => ({ list: document.querySelector('[data-testid="team-activity-list"]')?.getBoundingClientRect().width ?? 0, body: document.querySelector('[data-testid="team-body"]')?.getBoundingClientRect().width ?? 0 }));
  expect(widths.list).toBeGreaterThan(widths.body - 40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await closeToasts(page);
  await phoneActivity.getByTestId('team-activity-toggle').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(ACTIVITY_SHOTS, 'phone-activity.png') });
});
