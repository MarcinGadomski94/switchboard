import { type Page, expect, test } from '@playwright/test';
import {
  type Box,
  type DemoApp,
  type Geometry,
  type Part,
  canonicalColors,
  compareBoxes,
  hexToRgb,
  measure,
  newVisualPage,
  openApp,
  openPrototype,
  pixelDiff,
  round,
  sideBySide,
  startDemoApp,
  writeReport,
} from './harness.ts';
import { checkOtherPills, sameCopyBesidesOther } from './own-answer.ts';

/**
 * Visual oracle for the Chat tab (M4.2, D10): the app (demo seed) against the
 * prototype, 1440×900, `simulateIncoming` off, on two sessions:
 * 1. `calendar-func-fix`: its header has the same height on both pages (M4.1), so
 *    every box is absolute: the user bubble, the agent text with its step lines
 *    (`✓ …`, `● …`) and the composer (field, Send; D86: see below).
 * 2. `free-talk-feature` (the prototype's default): the inline question card
 *    (3 questions), then one option picked per question (All answered, Send at
 *    full opacity), then Send → the answers bubble and its note. The prototype's
 *    hand-written chips wrap its header to two rows (M4.1), so the chat area starts
 *    lower there: parts inside the chat are compared with y relative to the chat
 *    area's top, the chat area by x / width / bottom; the composer is absolute.
 * Both chat areas are scrolled to the top before measuring (the app keeps the
 * newest item in view). Gate: boxes ±2 px, exact copy, equal computed styles,
 * SPEC tokens as computed styles. The pixel diff is advisory (`docs/visual/chat.md`).
 * D39 (an addition, checked on its own like D18's Name row): each question's
 * options end with an **Other…** pill the prototype does not have. The prototype's
 * parts keep their boxes; a question's and its options row's text differ only by
 * that pill at the end (`sameCopyBesidesOther`), and the pill is gated on its own
 * (`own-answer.ts`), with the card open and once an option is picked.
 * D86 (deliberate deviation, `docs/decisions.md` → D86, `docs/visual/README.md`):
 * the app has no quick-replies row, which the prototype still has. Its parts (the
 * row, the `QUICK REPLIES` label, the four pills and their computed styles) are not
 * compared any more. What was measured with the row in place is re-anchored on the
 * prototype's own boxes: the composer keeps its x, width and bottom and is shorter
 * by the row + the composer's gap (`freed`, measured on the prototype); the chat
 * area keeps its x, width and top and is taller by the same amount; the field's
 * row and Send keep their boxes; the field is narrower by the 📎 (36 px) + the row's
 * gap (8 px), and the 📎 is checked on its own between the field and Send.
 */

interface PartSpec {
  readonly path: readonly number[];
  /** D86: the app's path when it differs from the prototype's (the composer lost its first row). */
  readonly appPath?: readonly number[];
  /** D86: the box the app should have, from the prototype's box and the height the quick replies freed. */
  readonly expect?: (proto: Box, freed: number) => Box;
  readonly geometry: Geometry;
  readonly copy: boolean;
}

/** D86: the composer's 📎 (width) and the gap of the field's row. */
const ATTACH_WIDTH = 36;
const COMPOSE_GAP = 8;

const MAIN = [1, 0, 0] as const;
const CHAT = [...MAIN, 1] as const;
const COMPOSER = [...MAIN, 2] as const;
const CARD = [...CHAT, 2] as const;

/** Parts inside the chat area (y compared relative to it on free-talk-feature). */
const MESSAGE_PARTS: Readonly<Record<string, PartSpec>> = {
  user: { path: [...CHAT, 0], geometry: 'box', copy: true },
  userBubble: { path: [...CHAT, 0, 0], geometry: 'box', copy: true },
  agent: { path: [...CHAT, 1], geometry: 'box', copy: false },
  agentText: { path: [...CHAT, 1, 0], geometry: 'box', copy: true },
  steps: { path: [...CHAT, 1, 1], geometry: 'box', copy: true },
  step0: { path: [...CHAT, 1, 1, 0], geometry: 'box', copy: true },
  step1: { path: [...CHAT, 1, 1, 1], geometry: 'box', copy: true },
};

/**
 * The composer (anchored at the bottom: absolute on both sessions). D86: the
 * prototype's quick-replies row (`[...COMPOSER, 0]`: label + 4 pills) is excluded;
 * the field's row is the app's first composer row, and the 📎 sits in it before Send.
 */
const COMPOSER_PARTS: Readonly<Record<string, PartSpec>> = {
  composer: { path: COMPOSER, geometry: 'box', copy: false, expect: (p, freed) => ({ ...p, y: p.y + freed, height: p.height - freed }) },
  compose: { path: [...COMPOSER, 1], appPath: [...COMPOSER, 0], geometry: 'box', copy: false },
  input: { path: [...COMPOSER, 1, 0], appPath: [...COMPOSER, 0, 0], geometry: 'box', copy: false, expect: (p) => ({ ...p, width: p.width - ATTACH_WIDTH - COMPOSE_GAP }) },
  send: { path: [...COMPOSER, 1, 1], appPath: [...COMPOSER, 0, 2], geometry: 'box', copy: true },
};

/** D86: the prototype's quick-replies row (measured only to know the height the app freed). */
const PROTO_QUICK = [...COMPOSER, 0] as const;
const PROTO_COMPOSE = [...COMPOSER, 1] as const;

/** D86: the height the quick-replies row took in the prototype's composer: the row + the gap to the field's row. */
async function freedHeight(protoPage: Page): Promise<number> {
  const proto = await measure(protoPage, { quick: [...PROTO_QUICK], compose: [...PROTO_COMPOSE] });
  const quick = proto['quick'];
  const compose = proto['compose'];
  if (!quick || !compose) throw new Error('D86: the prototype has no quick-replies row to measure');
  return compose.box.y - quick.box.y;
}

/**
 * D86: the composer's 📎 (an addition, checked on its own): in the field's row
 * between the field and Send, 8 px from each, 36 px wide, as tall as the field
 * (whose prototype box is the reference), the prototype field's computed
 * border-radius.
 */
async function checkAttach(protoPage: Page, appPage: Page, label: string, failures: string[]): Promise<string> {
  const proto = await measure(protoPage, { input: [...PROTO_COMPOSE, 0], send: [...PROTO_COMPOSE, 1] });
  const shot = await measure(appPage, { attach: [...COMPOSER, 0, 1] });
  const [input, send, attach] = [proto['input'], proto['send'], shot['attach']];
  if (!input || !send || !attach) {
    failures.push(`${label} 📎: missing`);
    return `| ${label} | 📎 (D86) | addition | missing | missing | FAIL | |`;
  }
  const want: Box = { x: input.box.x + input.box.width - ATTACH_WIDTH, y: input.box.y, width: ATTACH_WIDTH, height: input.box.height };
  const issues = [
    ...compareBoxes(`${label} 📎 (D86)`, want, attach.box, 'box'),
    ...(Math.abs(send.box.x - COMPOSE_GAP - (attach.box.x + attach.box.width)) > 0.5 ? [`${label} 📎 (D86): not 8 px before Send`] : []),
    ...(attach.style['border-radius'] !== input.style['border-radius'] ? [`${label} 📎 (D86).border-radius: field ${input.style['border-radius']} vs 📎 ${attach.style['border-radius']}`] : []),
    ...(await appPage.locator('.sb-chat-compose [data-testid="attach-button"]').getAttribute('aria-label')) !== 'Attach files' ? [`${label} 📎 (D86): no "Attach files" label`] : [],
  ];
  failures.push(...issues);
  return `| ${label} | 📎 (D86) | addition | ${fmtBox(want)} | ${fmtBox(attach.box)} | ${issues.length ? 'FAIL' : 'ok'} | |`;
}

function questionParts(index: number): Record<string, PartSpec> {
  const base = [...CARD, 1 + index];
  return {
    [`q${index}`]: { path: base, geometry: 'box', copy: true },
    [`q${index}Source`]: { path: [...base, 0], geometry: 'box', copy: true },
    [`q${index}Quote`]: { path: [...base, 1], geometry: 'box', copy: true },
    [`q${index}Options`]: { path: [...base, 2], geometry: 'box', copy: true },
    [`q${index}Opt0`]: { path: [...base, 2, 0], geometry: 'box', copy: true },
    [`q${index}Opt1`]: { path: [...base, 2, 1], geometry: 'box', copy: true },
  };
}

/** The inline question card (free-talk-feature: 3 questions). */
const CARD_PARTS: Readonly<Record<string, PartSpec>> = {
  card: { path: CARD, geometry: 'box', copy: false },
  cardHead: { path: [...CARD, 0], geometry: 'box', copy: true },
  ...questionParts(0),
  ...questionParts(1),
  ...questionParts(2),
  foot: { path: [...CARD, 4], geometry: 'box', copy: true },
  status: { path: [...CARD, 4, 0], geometry: 'box', copy: true },
  cardSend: { path: [...CARD, 4, 1], geometry: 'box', copy: true },
};

/** After Send: the answers bubble and its note. */
const ANSWERED_PARTS: Readonly<Record<string, PartSpec>> = {
  answers: { path: [...CHAT, 2], geometry: 'box', copy: true },
  answersBubble: { path: [...CHAT, 2, 0], geometry: 'box', copy: true },
  answer0: { path: [...CHAT, 2, 0, 0], geometry: 'box', copy: true },
  answer1: { path: [...CHAT, 2, 0, 1], geometry: 'box', copy: true },
  answer2: { path: [...CHAT, 2, 0, 2], geometry: 'box', copy: true },
  note: { path: [...CHAT, 3], geometry: 'box', copy: true },
};

const COMPARED_STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'border-radius',
  'border-top-color',
  'border-top-width',
  'border-right-color',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const;

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

async function openProtoSession(page: Page, name: string): Promise<void> {
  await page.getByText(name, { exact: true }).first().click();
  await page.getByText('Agents & solutions', { exact: true }).waitFor();
  await page.getByText('Quick replies', { exact: true }).waitFor();
}

async function openAppSession(page: Page, name: string): Promise<void> {
  await openApp(page, app.baseUrl, `/sessions/${name}`);
  await expect(page.getByTestId('session-name')).toHaveText(name);
  await expect(page.getByTestId('chat-text').first()).toBeVisible();
}

/** Scrolls the chat area (the element at CHAT) to the top on either page. */
async function scrollChatTop(page: Page): Promise<void> {
  await page.evaluate((path) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const index of path) el = el?.children[index];
    if (el instanceof HTMLElement) el.scrollTop = 0;
  }, [...CHAT]);
}

/** A part's opacity (the card's Send). */
async function opacityAt(page: Page, path: readonly number[]): Promise<string> {
  return page.evaluate((p) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const index of p) el = el?.children[index];
    return el ? getComputedStyle(el).opacity : 'missing';
  }, [...path]);
}

function relativeTo(box: Box, top: number): Box {
  return { ...box, y: box.y - top };
}

/**
 * Measures `parts` on both pages and gates them. `chatRelative`: the y of every
 * part inside the chat area is taken relative to the chat area's top.
 */
async function compare(
  protoPage: Page,
  appPage: Page,
  label: string,
  parts: Readonly<Record<string, PartSpec>>,
  options: { readonly chatRelative: boolean; readonly inChat: boolean },
  failures: string[],
): Promise<{ rows: string[]; app: Record<string, Part | null> }> {
  await scrollChatTop(protoPage);
  await scrollChatTop(appPage);
  const paths = { ...Object.fromEntries(Object.entries(parts).map(([name, spec]) => [name, spec.path])), __chat: [...CHAT] };
  const appPaths = { ...Object.fromEntries(Object.entries(parts).map(([name, spec]) => [name, spec.appPath ?? spec.path])), __chat: [...CHAT] };
  const proto = await measure(protoPage, paths);
  const shot = await measure(appPage, appPaths);
  // D86: only the composer's parts re-anchor on it.
  const freed = Object.values(parts).some((spec) => spec.expect) ? await freedHeight(protoPage) : 0;
  const rows: string[] = [];
  for (const [name, spec] of Object.entries(parts)) {
    const p = proto[name];
    const a = shot[name];
    if (!p || !a) {
      failures.push(`${label} ${name}: missing (${p ? 'app' : 'prototype'})`);
      rows.push(`| ${label} | ${name} | — | ${p ? fmtBox(p.box) : 'missing'} | ${a ? fmtBox(a.box) : 'missing'} | FAIL | |`);
      continue;
    }
    const relative = options.chatRelative && options.inChat;
    const protoBox = spec.expect ? spec.expect(p.box, freed) : p.box;
    const pBox = relative ? relativeTo(protoBox, proto['__chat']?.box.y ?? 0) : protoBox;
    const aBox = relative ? relativeTo(a.box, shot['__chat']?.box.y ?? 0) : a.box;
    const boxIssues = compareBoxes(`${label} ${name}`, pBox, aBox, spec.geometry);
    // D39: the Other… pill ends a question's (and its options row's) text; it is checked on its own.
    const besidesOther = sameCopyBesidesOther(p.text, a.text);
    const copyIssues = spec.copy && p.text !== a.text && !besidesOther ? [`${label} ${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`] : [];
    const styleIssues = COMPARED_STYLES.filter((prop) => p.style[prop] !== a.style[prop]).map(
      (prop) => `${label} ${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`,
    );
    failures.push(...boxIssues, ...copyIssues, ...styleIssues);
    const ok = boxIssues.length + copyIssues.length + styleIssues.length === 0;
    rows.push(
      `| ${label} | ${name} | ${relative ? `${spec.geometry} (y rel. chat)` : spec.geometry}${spec.expect ? ' (D86: expected from the prototype)' : ''} | ${fmtBox(pBox)} | ${fmtBox(aBox)} | ${ok ? 'ok' : 'FAIL'} | ${spec.copy ? `${JSON.stringify(besidesOther ? p.text : a.text).slice(0, 70)}${besidesOther ? ' + "Other…" (D39)' : ''}` : ''} |`,
    );
  }
  return { rows, app: shot };
}

/**
 * The chat area itself: x, width and bottom (its top follows the header). D86: its
 * bottom is lower than the prototype's by the height the quick replies freed.
 */
async function compareChatArea(protoPage: Page, appPage: Page, label: string, geometry: Geometry, failures: string[]): Promise<string> {
  const proto = await measure(protoPage, { chat: [...CHAT] });
  const shot = await measure(appPage, { chat: [...CHAT] });
  const p = proto['chat'];
  const a = shot['chat'];
  if (!p || !a) {
    failures.push(`${label} chat: missing`);
    return `| ${label} | chat | ${geometry} | missing | missing | FAIL | |`;
  }
  const freed = await freedHeight(protoPage);
  const want: Box = { ...p.box, height: p.box.height + freed };
  const issues = [
    ...compareBoxes(`${label} chat`, want, a.box, geometry),
    ...COMPARED_STYLES.filter((prop) => p.style[prop] !== a.style[prop]).map((prop) => `${label} chat.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`),
  ];
  failures.push(...issues);
  return `| ${label} | chat | ${geometry} (D86: +${round(freed)} px) | ${fmtBox(want)} | ${fmtBox(a.box)} | ${issues.length ? 'FAIL' : 'ok'} | |`;
}

/** Picks option `index` of every question of the card on either page. */
async function pickAll(page: Page, which: 'proto' | 'app', index: number, count: number): Promise<void> {
  for (let q = 0; q < count; q += 1) {
    if (which === 'app') {
      await page.getByTestId('question-card').getByTestId('question').nth(q).getByTestId('question-option').nth(index).click();
    } else {
      // The prototype's option pills are <span onClick>: clicked through their path from the shell grid.
      await page.evaluate((path) => {
        const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
          const style = getComputedStyle(el);
          return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
        });
        let el: Element | undefined = grid;
        for (const i of path) el = el?.children[i];
        if (!(el instanceof HTMLElement)) throw new Error(`no option at ${path.join(',')}`);
        el.click();
      }, [...CARD, 1 + q, 2, index]);
    }
  }
}

test('Chat tab matches the prototype (messages, step lines, question card, answers bubble, composer)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  const failures: string[] = [];
  await openPrototype(protoPage, { simulateIncoming: false });

  // 1. calendar-func-fix: one-row header on both pages → every box absolute.
  await openProtoSession(protoPage, 'calendar-func-fix');
  await openAppSession(appPage, 'calendar-func-fix');
  await expect(appPage.getByTestId('chat-step')).toHaveText(['✓ recon · codebase-memory · ReminderScheduler.cs', '● dotnet build · self-heal 1/3']);
  const calendarChat = await compareChatArea(protoPage, appPage, 'calendar-func-fix', 'box', failures);
  const calendar = await compare(protoPage, appPage, 'calendar-func-fix', MESSAGE_PARTS, { chatRelative: false, inChat: true }, failures);
  const calendarComposer = await compare(protoPage, appPage, 'calendar-func-fix', COMPOSER_PARTS, { chatRelative: false, inChat: false }, failures);
  const calendarAttach = await checkAttach(protoPage, appPage, 'calendar-func-fix', failures);
  if ((await appPage.getByTestId('chat-quick-reply').count()) !== 0) failures.push('D86: the app still shows quick replies');
  const placeholders = await Promise.all(
    [protoPage, appPage].map((page) => page.locator('[placeholder^="Message "]').first().getAttribute('placeholder')),
  );
  if (placeholders[0] !== placeholders[1]) failures.push(`placeholder: prototype ${placeholders[0]} vs app ${placeholders[1]}`);
  const calendarClip = { x: 256, y: 0, width: 804, height: 900 };
  const protoCalendar = await protoPage.screenshot({ clip: calendarClip });
  const appCalendar = await appPage.screenshot({ clip: calendarClip });
  const calendarDiff = await pixelDiff(appPage, protoCalendar, appCalendar);

  // 2. free-talk-feature: the inline card, picks, then the answers bubble (y relative to the chat area).
  await openProtoSession(protoPage, 'free-talk-feature');
  await openAppSession(appPage, 'free-talk-feature');
  await expect(appPage.getByTestId('question-card')).toBeVisible();
  const freeChat = await compareChatArea(protoPage, appPage, 'free-talk-feature', 'bottom', failures);
  const freeMessages = await compare(protoPage, appPage, 'free-talk-feature', MESSAGE_PARTS, { chatRelative: true, inChat: true }, failures);
  const freeCard = await compare(protoPage, appPage, 'free-talk-feature', CARD_PARTS, { chatRelative: true, inChat: true }, failures);
  const freeComposer = await compare(protoPage, appPage, 'free-talk-feature', COMPOSER_PARTS, { chatRelative: false, inChat: false }, failures);
  const freeAttach = await checkAttach(protoPage, appPage, 'free-talk-feature', failures);
  const opacities: string[] = [];
  const sendOpacity = async (state: string, want: string) => {
    const [p, a] = [await opacityAt(protoPage, [...CARD, 4, 1]), await opacityAt(appPage, [...CARD, 4, 1])];
    if (p !== want || a !== want) failures.push(`${state} Send opacity: want ${want}, prototype ${p}, app ${a}`);
    opacities.push(`| ${state} | ${want} | ${p} | ${a} | ${p === want && a === want ? 'ok' : 'FAIL'} |`);
  };
  await sendOpacity('0 of 3 answered', '0.45');
  const optionRows = { q0Options: [...CARD, 1, 2], q1Options: [...CARD, 2, 2], q2Options: [...CARD, 3, 2] };
  const otherOpen = await checkOtherPills(protoPage, appPage, 'free-talk-feature', optionRows, failures);
  const protoOpen = await protoPage.screenshot({ clip: calendarClip });
  const appOpen = await appPage.screenshot({ clip: calendarClip });
  const openDiff = await pixelDiff(appPage, protoOpen, appOpen);

  await pickAll(protoPage, 'proto', 0, 3);
  await pickAll(appPage, 'app', 0, 3);
  await expect(appPage.getByTestId('question-status')).toHaveText('All answered. Each answer is written into the blocked brief word for word.');
  const picked = await compare(protoPage, appPage, 'free-talk-feature picked', CARD_PARTS, { chatRelative: true, inChat: true }, failures);
  const otherPicked = await checkOtherPills(protoPage, appPage, 'free-talk-feature picked', optionRows, failures);
  await sendOpacity('all answered', '1');

  // Send in both: the card becomes the answers bubble + note.
  await protoPage.getByText('Send all answers', { exact: true }).click();
  await appPage.getByTestId('question-send').click();
  await expect(appPage.getByTestId('chat-answers-note')).toBeVisible();
  await protoPage.getByText('● Answers written into the briefs. Blocked agents are resuming…', { exact: true }).waitFor();
  const answered = await compare(protoPage, appPage, 'free-talk-feature answered', ANSWERED_PARTS, { chatRelative: true, inChat: true }, failures);
  const protoAnswered = await protoPage.screenshot({ clip: calendarClip });
  const appAnswered = await appPage.screenshot({ clip: calendarClip });
  const answeredDiff = await pixelDiff(appPage, protoAnswered, appAnswered);

  // SPEC tokens as computed styles on the app.
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const chat = style('.sb-chat');
    const userBubble = style('.sb-chat-message[data-role="user"] .sb-chat-bubble');
    const steps = style('.sb-chat-steps');
    const answers = style('.sb-chat-answers-bubble');
    const note = style('.sb-chat-answers-note');
    const composer = style('.sb-chat-composer');
    const input = style('.sb-chat-input');
    const send = style('.sb-chat-send');
    return {
      chatFont: `${chat.fontSize} ${chat.lineHeight}`,
      chatColor: chat.color,
      chatPadding: `${chat.paddingTop} ${chat.paddingLeft}`,
      chatGap: chat.rowGap,
      userBubble: `${userBubble.backgroundColor} ${userBubble.borderTopLeftRadius} ${userBubble.paddingTop} ${userBubble.paddingLeft}`,
      steps: `${steps.fontSize} ${steps.fontFamily} ${steps.color} ${steps.rowGap}`,
      answers: `${answers.backgroundColor} ${answers.borderRadius} ${answers.paddingTop} ${answers.paddingLeft}`,
      noteFont: `${note.fontSize} ${note.fontFamily}`,
      noteColor: note.color,
      composerBorder: `${composer.borderTopWidth} ${composer.borderTopStyle} ${composer.borderTopColor}`,
      composerPadding: `${composer.paddingTop} ${composer.paddingRight} ${composer.paddingBottom} ${composer.paddingLeft}`,
      input: `${input.fontSize} ${input.borderTopColor} ${input.borderTopLeftRadius} ${input.backgroundColor} ${input.color}`,
      send: `${send.backgroundColor} ${send.color} ${send.borderTopLeftRadius} ${send.fontWeight}`,
    };
  });
  const [noteBlue] = await canonicalColors(appPage, ['oklch(0.74 0.12 250)']);
  const expected: Record<string, string> = {
    chatFont: '13.5px 20.925px',
    chatColor: hexToRgb('#d9d8d3'),
    chatPadding: '20px 26px',
    chatGap: '16px',
    userBubble: `${hexToRgb('#212227')} 12px 10px 14px`,
    steps: `12px "Geist Mono", monospace ${hexToRgb('#8d8c87')} 3px`,
    answers: `${hexToRgb('#212227')} 12px 12px 4px 10px 14px`,
    noteFont: '12px "Geist Mono", monospace',
    noteColor: noteBlue ?? 'oklch(0.74 0.12 250)',
    composerBorder: `1px solid ${hexToRgb('#232428')}`,
    composerPadding: '10px 22px 16px 22px',
    input: `13px ${hexToRgb('#2c2d32')} 10px ${hexToRgb('#111214')} ${hexToRgb('#e8e7e3')}`,
    send: `${hexToRgb('#e8e7e3')} ${hexToRgb('#111214')} 10px 500`,
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  await writeReport({
    'chat.md': report({
      rows: [calendarChat, ...calendar.rows, ...calendarComposer.rows, freeChat, ...freeMessages.rows, ...freeCard.rows, ...freeComposer.rows, ...picked.rows, ...answered.rows],
      otherRows: [
        calendarAttach,
        freeAttach,
        ...otherOpen.map((check) => `| free-talk-feature | ${check.part} | addition | — | ${check.note.replaceAll('|', '\\|')} | ${check.ok ? 'ok' : 'FAIL'} | |`),
        ...otherPicked.map((check) => `| free-talk-feature picked | ${check.part} | addition | — | ${check.note.replaceAll('|', '\\|')} | ${check.ok ? 'ok' : 'FAIL'} | |`),
      ],
      opacities,
      computedRows,
      failures,
      diffs: { calendar: calendarDiff.percent, open: openDiff.percent, answered: answeredDiff.percent },
    }),
    'chat-calendar-side-by-side.png': await sideBySide(appPage, protoCalendar, appCalendar),
    'chat-card-side-by-side.png': await sideBySide(appPage, protoOpen, appOpen),
    'chat-answered-side-by-side.png': await sideBySide(appPage, protoAnswered, appAnswered),
  });

  expect(failures).toEqual([]);
});

function fmtBox(box: Box): string {
  return `${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}`;
}

function report(input: {
  rows: string[];
  otherRows: string[];
  opacities: string[];
  computedRows: string[];
  failures: string[];
  diffs: { calendar: number; open: number; answered: number };
}): string {
  return `# Visual oracle · Chat tab (M4.2)

Generated by \`tests/e2e/visual/session-chat.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/sessions/calendar-func-fix\` and \`/sessions/free-talk-feature\` (Chat tab).
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, the same sessions opened from their sidebar rows. Both chat areas scrolled to the top before measuring.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24) of the main column (256,0 804×900): calendar-func-fix **${input.diffs.calendar.toFixed(2)}%**, free-talk-feature with the open card **${input.diffs.open.toFixed(2)}%**, after Send **${input.diffs.answered.toFixed(2)}%**. The header rows differ where M4.1 recorded it (hand-written mock chips wrap the prototype's free-talk-feature header to two rows).

Side by side (prototype left, app right): \`chat-calendar-side-by-side.png\`, \`chat-card-side-by-side.png\`, \`chat-answered-side-by-side.png\`.

## Boxes (±2 px), copy and computed styles
Geometry: \`box\` = x, y, width, height; \`bottom\` = x, width and the bottom edge. On free-talk-feature the y of every part inside the chat area is relative to the chat area's top (the prototype's header is taller there, M4.1). Styles compared: ${COMPARED_STYLES.join(', ')}.

| Session | Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|---|
${input.rows.join('\n')}

## D39 · Other… and D86 · 📎 (additions, checked on their own)
| Session | Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|---|
${input.otherRows.join('\n')}

## Send opacity (question card)
| State | Expected | Prototype | App | Result |
|---|---|---|---|---|
${input.opacities.join('\n')}

## SPEC tokens (computed)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Known differences (not findings)
- D86 (deliberate deviation): the prototype's quick-replies row (\`QUICK REPLIES\` label + four pills) is gone from the app, so it is not compared (nor the label's and pills' SPEC tokens). The composer keeps its x, width and bottom and is shorter by that row + the composer's 8 px gap (measured on the prototype); the chat area is taller by the same height; the field's row and Send keep their boxes; the field is 44 px narrower (the 📎, 36 px, + 8 px gap), and the 📎 is checked on its own above. Rows marked "D86: expected from the prototype" show the expected box.
- D39: every question ends its options with an **Other…** pill (the developer's own answer), which the prototype does not have. It is the options row's last child, on the options' line, so every prototype part keeps its box; the text of a question and of its options row is the prototype's plus "Other…" at its end, and the pill is checked on its own (the D39 section above).
- The prototype's \`•\` note line (prod-monitoring only) shows as \`✓\` in the app: the demo seed turns every prototype tool line into a real step event, and a note has no event of its own (\`docs/chat.md\`). Not in the compared sessions.
- After Send the prototype also flips its mock agent statuses; the app's demo answers are queued for the session's next run (no live process), which the chat does not show differently.

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
