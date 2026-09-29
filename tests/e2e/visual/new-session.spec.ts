import { type Page, expect, test } from '@playwright/test';
import {
  type DemoApp,
  type Geometry,
  type Part,
  STYLE_PROPS,
  canonicalColors,
  compareBoxes,
  hexToRgb,
  newVisualPage,
  openApp,
  openPrototype,
  pixelDiff,
  round,
  sideBySide,
  startDemoApp,
  writeReport,
} from './harness.ts';

/**
 * Visual oracle for the New-session modal (M5.1, D10): the app (demo seed) against
 * the prototype's `mNew` at 1440×900. The prototype opens with its draft (`ns`:
 * `free-talk-640`, orchestrator, acme-app-front + mobile); the app's form is filled
 * to the same values through the UI (its own defaults are the router's
 * recommended answers, `docs/new-session.md`). Four states are compared: the
 * draft, single-solution (section 6 · Mobile coordination), test-authoring with
 * stack Both (section 6 · QA contract) and no solutions (Start at 45%). Gate:
 * boxes ±2 px, exact copy, equal computed styles, SPEC tokens; the pixel diff is
 * advisory (`docs/visual/new-session.md`).
 *
 * Known data differences, not findings: the chips come from the demo's workspace
 * scan (the Solutions view's rows), which lists fewer nugets / microservices /
 * functions than the prototype's hard-coded `G` and no `other/` row, so the
 * solutions section is shorter and everything below it sits higher (those parts
 * are compared with geometry `size`: x, width, height).
 *
 * D14 additions (not findings): the **Folder row** above section 1 (the saved
 * folder dropdown, Browse… and the check line) and the summary's **`folder`
 * line** before `cwd`. The prototype has neither, so the app's form child k + 1
 * is compared with the prototype's child k (k ≥ 1, {@link appPathOf}) and their
 * y relative to the first section (1 · Task definition), and the app's summary
 * line i + 1 with the prototype's line i (i ≥ 1) with its y less the added
 * line's height. The added parts are checked on their own ({@link d14Additions}).
 *
 * D32 additions (not findings): with Worktree on (the prototype's draft) the form
 * has a **Branch row** inside section 1, under the name / task row, and the
 * summary a **`branch` line** under `# worktrees`. Section 1 is compared with its
 * height less the row's, the sections below it with their y less that too, and
 * the summary lines after `# worktrees` at the app's index + 2 with their y less
 * both added lines. The branch is filled through the form like the draft's other
 * values (Start needs it); the added parts are checked on their own
 * ({@link d32Additions}).
 *
 * D38 (developer ruling, not findings): picking solutions is optional. In the
 * `empty` state the prototype's `⚠ pick at least one solution` line reads
 * `solutions  chosen by the agent` (a value line), Start is enabled (the app's
 * Branch field holds the draft's ticket branch) and section 4's hint says
 * `0 selected · leave empty to let the agent choose · read-only folders locked`.
 * Those three parts leave the prototype comparison and are checked on their own
 * ({@link d38Additions}); the draft state (solutions picked) is unchanged.
 *
 * D40 addition (not a finding): with Worktree on the form ends with the
 * **Branching** section (epic key, summary, creation line, preflight table),
 * after every prototype section, so no compared part moves; its inputs are left
 * out of the draft's input list like D32's Branch field. Its behavior is
 * `tests/e2e/branching.spec.ts`.
 */

interface PartSpec {
  /** Child indexes from the modal panel (the 1080px box with the 14px radius). */
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

const FORM = [0];
const SIDE = [1];
const SUMMARY = [...SIDE, 3];
const SOLUTIONS = [...FORM, 4];
const PHASE = [...FORM, 5];

/** D14: the app's Folder row is the form's child 1 (after the head), so the prototype's form child k ≥ 1 is the app's k + 1. */
const FOLDER_ROW = [...FORM, 1];
/** D14: the app's summary line 1 is the added `folder` line, so the prototype's summary line i ≥ 1 is the app's i + 1. */
const FOLDER_LINE = [...SUMMARY, 1];

/**
 * The app's path of a prototype path (D14, see the module comment). D32:
 * `worktreesLine` is the prototype's index of the `# worktrees` summary line
 * (`null` when the state compares no line after it): the lines after it sit one
 * more line lower in the app (the added `branch` line).
 */
function appPathOf(path: readonly number[], worktreesLine: number | null = null): readonly number[] {
  const [a, b, c] = path;
  if (a !== undefined && a === FORM[0] && b !== undefined && b >= 1) return [a, b + 1, ...path.slice(2)];
  if (a !== undefined && a === SIDE[0] && b !== undefined && b === SUMMARY[1] && c !== undefined && c >= 1) {
    return [a, b, c + (worktreesLine !== null && c > worktreesLine ? 2 : 1), ...path.slice(3)];
  }
  return path;
}

/**
 * What {@link appPathOf} shifted: section 1 below the Folder row (`form`; D32: its
 * own box, `task`, grows by the Branch row), the sections below it (`belowTask`),
 * the summary below the `folder` line (`summary`), and (D32) the summary lines
 * below the `branch` line (`belowBranch`).
 */
type Shift = 'form' | 'task' | 'belowTask' | 'summary' | 'belowBranch';

function shiftOf(path: readonly number[], worktreesLine: number | null = null): Shift | null {
  const [a, b, c] = path;
  if (a === FORM[0] && b === 1) return path.length === 2 ? 'task' : 'form';
  if (a === FORM[0] && b !== undefined && b >= 2) return 'belowTask';
  if (a === SIDE[0] && b === SUMMARY[1] && c !== undefined && c >= 1) return worktreesLine !== null && c > worktreesLine ? 'belowBranch' : 'summary';
  return null;
}

/** D32: the prototype's index of its `# worktrees` summary line in the current state (`null` without one). */
async function worktreesLineOf(protoPage: Page): Promise<number | null> {
  return protoPage.evaluate((path) => {
    let el: Element | undefined | null = findPanelIn(document);
    for (const index of path) el = el?.children[index];
    const index = [...(el?.children ?? [])].findIndex((line) => (line.textContent ?? '').trim() === '# worktrees');
    return index === -1 ? null : index;
  }, [...SUMMARY]);
}

/** Parts of the draft state. */
function draftParts(): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    panel: { path: [], geometry: 'box', copy: false },
    form: { path: FORM, geometry: 'box', copy: false },
    side: { path: SIDE, geometry: 'box', copy: false },
    head: { path: [...FORM, 0], geometry: 'box', copy: false },
    title: { path: [...FORM, 0, 0], geometry: 'box', copy: true },
    sub: { path: [...FORM, 0, 1], geometry: 'box', copy: true },
    recommended: { path: [...FORM, 0, 2], geometry: 'box', copy: true },
    taskSection: { path: [...FORM, 1], geometry: 'box', copy: false },
    taskLabel: { path: [...FORM, 1, 0], geometry: 'box', copy: true },
    nameInput: { path: [...FORM, 1, 1, 0], geometry: 'box', copy: false },
    taskInput: { path: [...FORM, 1, 1, 1], geometry: 'box', copy: false },
    workLabel: { path: [...FORM, 2, 0], geometry: 'box', copy: true },
    workFeature: { path: [...FORM, 2, 1, 0], geometry: 'box', copy: true },
    workQa: { path: [...FORM, 2, 1, 1], geometry: 'box', copy: true },
    modeLabel: { path: [...FORM, 3, 0], geometry: 'box', copy: true },
    modeSingle: { path: [...FORM, 3, 1, 0], geometry: 'box', copy: true },
    modeOrch: { path: [...FORM, 3, 1, 1], geometry: 'box', copy: true },
    solutionsLabel: { path: [...SOLUTIONS, 0], geometry: 'box', copy: true },
    solutionsHint: { path: [...SOLUTIONS, 0, 0], geometry: 'box', copy: true },
    microfrontendsFolder: { path: [...SOLUTIONS, 1, 0], geometry: 'box', copy: true },
    mobileFolder: { path: [...SOLUTIONS, 2, 0], geometry: 'box', copy: true },
    mobileChip: { path: [...SOLUTIONS, 2, 1, 0], geometry: 'box', copy: true },
    nugetsFolder: { path: [...SOLUTIONS, 3, 0], geometry: 'box', copy: true },
    nugetsChip1: { path: [...SOLUTIONS, 3, 1, 0], geometry: 'box', copy: true },
    nugetsChip2: { path: [...SOLUTIONS, 3, 1, 1], geometry: 'box', copy: true },
    phaseSection: { path: PHASE, geometry: 'size', copy: false },
    phaseLabel: { path: [...PHASE, 0], geometry: 'size', copy: true },
    phaseUi: { path: [...PHASE, 1, 0], geometry: 'size', copy: true },
    phaseIntegration: { path: [...PHASE, 1, 1], geometry: 'size', copy: true },
    launchLabel: { path: [...SIDE, 0], geometry: 'box', copy: true },
    toggles: { path: [...SIDE, 1], geometry: 'box', copy: false },
    summaryLabel: { path: [...SIDE, 2], geometry: 'box', copy: true },
    summary: { path: [...SIDE, 3], geometry: 'box', copy: false },
    actions: { path: [...SIDE, 4], geometry: 'box', copy: false },
    cancel: { path: [...SIDE, 4, 0], geometry: 'box', copy: true },
    start: { path: [...SIDE, 4, 1], geometry: 'box', copy: true },
  };
  for (let i = 0; i < 4; i++) out[`microfrontendsChip${i + 1}`] = { path: [...SOLUTIONS, 1, 1, i], geometry: 'box', copy: true };
  for (const [index, name] of [
    [0, 'worktree'],
    [1, 'ultracode'],
  ] as const) {
    out[`${name}Row`] = { path: [...SIDE, 1, index], geometry: 'box', copy: false };
    out[`${name}Title`] = { path: [...SIDE, 1, index, 0, 0], geometry: 'box', copy: true };
    out[`${name}Desc`] = { path: [...SIDE, 1, index, 0, 1], geometry: 'box', copy: true };
    out[`${name}Switch`] = { path: [...SIDE, 1, index, 1], geometry: 'box', copy: false };
    out[`${name}Knob`] = { path: [...SIDE, 1, index, 1, 0], geometry: 'box', copy: false };
  }
  for (let i = 0; i < 12; i++) out[`summaryLine${i}`] = { path: [...SIDE, 3, i], geometry: 'box', copy: true };
  return out;
}

/** The read-only row: last group of section 4 in both pages (`size`: it sits higher in the app, see above). */
function readOnlyParts(protoIndex: number, appIndex: number): Record<string, { readonly proto: readonly number[]; readonly app: readonly number[]; readonly geometry: Geometry; readonly copy: boolean }> {
  return {
    readOnlyFolder: { proto: [...SOLUTIONS, protoIndex, 0], app: [...SOLUTIONS, appIndex, 0], geometry: 'size', copy: true },
    readOnlyChip1: { proto: [...SOLUTIONS, protoIndex, 1, 0], app: [...SOLUTIONS, appIndex, 1, 0], geometry: 'size', copy: true },
    readOnlyChip2: { proto: [...SOLUTIONS, protoIndex, 1, 1], app: [...SOLUTIONS, appIndex, 1, 1], geometry: 'size', copy: true },
  };
}

/** Section 6 parts (below the solutions section: `size`). */
function sectionSixParts(pills: number): Record<string, PartSpec> {
  const out: Record<string, PartSpec> = {
    six: { path: [...FORM, 6], geometry: 'size', copy: false },
    sixLabel: { path: [...FORM, 6, 0], geometry: 'size', copy: true },
    sixPills: { path: [...FORM, 6, 1], geometry: 'size', copy: false },
  };
  for (let i = 0; i < pills; i++) out[`sixPill${i + 1}`] = { path: [...FORM, 6, 1, i], geometry: 'size', copy: true };
  return out;
}

/** Computed styles compared between the two pages for every part. */
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
  'padding-left',
  'opacity',
  'cursor',
  'white-space',
] as const;

/** Set in the page by {@link installPanelFinder}: the modal panel (the 1080px grid box with the 14px radius). */
declare function findPanelIn(doc: Document): HTMLElement | undefined;

/** Defines `findPanelIn` in the page, for the `page.evaluate` callbacks below. */
async function installPanelFinder(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { findPanelIn: (doc: Document) => HTMLElement | undefined }).findPanelIn = (doc) =>
      [...doc.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return style.width === '1080px' && style.borderTopLeftRadius === '14px' && style.display === 'grid';
      });
  });
}

/** Measures parts addressed by child-index paths from the modal panel. */
async function measurePanel(page: Page, paths: Readonly<Record<string, readonly number[]>>): Promise<Record<string, Part | null>> {
  return page.evaluate(
    ({ wanted, props }) => {
      const panel = findPanelIn(document);
      const out: Record<string, { box: { x: number; y: number; width: number; height: number }; text: string; style: Record<string, string> } | null> = {};
      for (const [name, indexes] of Object.entries(wanted)) {
        let el: Element | undefined = panel;
        for (const index of indexes) el = el?.children[index];
        if (!el) {
          out[name] = null;
          continue;
        }
        const rect = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        out[name] = { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, text: (el.textContent ?? '').trim(), style };
      }
      return out;
    },
    { wanted: paths, props: [...new Set<string>([...STYLE_PROPS, ...COMPARED_STYLES])] },
  );
}

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

/**
 * How far the D14 / D32 additions move the app's parts down (px): section 1 and
 * the form below the Folder row (`form`, `task`), the sections below section 1's
 * Branch row too (`belowTask`), the summary below the `folder` line, the summary
 * lines below the `branch` line too (`belowBranch`). `taskGrow` = the Branch row's
 * share of section 1's height (taken off its height).
 */
interface Offsets {
  readonly form: number;
  readonly task: number;
  readonly belowTask: number;
  readonly taskGrow: number;
  readonly summary: number;
  readonly belowBranch: number;
}

const NO_OFFSETS: Offsets = { form: 0, task: 0, belowTask: 0, taskGrow: 0, summary: 0, belowBranch: 0 };

/**
 * Measures the offsets of a state: the first section's y and height on both
 * pages (D14 / D32), the added summary lines' heights (D14 `folder`, D32
 * `branch` right after `# worktrees`).
 */
async function measureOffsets(protoPage: Page, appPage: Page, worktreesLine: number | null): Promise<Offsets> {
  const firstSection = [...FORM, 1];
  const proto = await measurePanel(protoPage, { first: firstSection });
  const app = await measurePanel(appPage, {
    first: appPathOf(firstSection),
    folderLine: FOLDER_LINE,
    ...(worktreesLine !== null ? { branchLine: [...SUMMARY, worktreesLine + 2] } : {}),
  });
  const form = (app['first']?.box.y ?? 0) - (proto['first']?.box.y ?? 0);
  const taskGrow = (app['first']?.box.height ?? 0) - (proto['first']?.box.height ?? 0);
  const summary = app['folderLine']?.box.height ?? 0;
  return { form, task: form, belowTask: form + taskGrow, taskGrow, summary, belowBranch: summary + (app['branchLine']?.box.height ?? 0) };
}

/**
 * Compares measured parts; appends report rows and findings. `offsets` (D14 /
 * D32) are taken off the app's y of shifted parts, and section 1's added Branch
 * row off its height (`task`).
 */
function compareParts(
  state: string,
  specs: Record<string, { readonly geometry: Geometry; readonly copy: boolean; readonly shift?: Shift | null }>,
  proto: Record<string, Part | null>,
  app: Record<string, Part | null>,
  rows: string[],
  failures: string[],
  offsets: Offsets = NO_OFFSETS,
): void {
  for (const [name, spec] of Object.entries(specs)) {
    const label = `${state} · ${name}`;
    const p = proto[name];
    const measured = app[name];
    if (!p || !measured) {
      failures.push(`${label}: missing (${p ? 'app' : 'prototype'})`);
      continue;
    }
    const dy = spec.shift ? offsets[spec.shift] : 0;
    const dh = spec.shift === 'task' ? offsets.taskGrow : 0;
    const a: Part = dy || dh ? { ...measured, box: { ...measured.box, y: measured.box.y - dy, height: measured.box.height - dh } } : measured;
    const boxIssues = compareBoxes(label, p.box, a.box, spec.geometry);
    const copyIssues = spec.copy && p.text !== a.text ? [`${label}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`] : [];
    const styleIssues = COMPARED_STYLES.filter((prop) => p.style[prop] !== a.style[prop]).map((prop) => `${label}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
    failures.push(...boxIssues, ...copyIssues, ...styleIssues);
    const ok = boxIssues.length + copyIssues.length + styleIssues.length === 0;
    const geometry = spec.shift ? `${spec.geometry} (y − ${round(dy)}${dh ? `, height − ${round(dh)}` : ''})` : spec.geometry;
    rows.push(`| ${label} | ${geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${ok ? 'ok' : 'FAIL'} | ${spec.copy ? JSON.stringify(a.text).slice(0, 70) : ''} |`);
  }
}

async function measureAndCompare(
  state: string,
  protoPage: Page,
  appPage: Page,
  specs: Record<string, PartSpec>,
  rows: string[],
  failures: string[],
): Promise<void> {
  const worktreesLine = await worktreesLineOf(protoPage);
  const protoPaths = Object.fromEntries(Object.entries(specs).map(([name, part]) => [name, part.path]));
  const appPaths = Object.fromEntries(Object.entries(specs).map(([name, part]) => [name, appPathOf(part.path, worktreesLine)]));
  const shifted = Object.fromEntries(Object.entries(specs).map(([name, part]) => [name, { ...part, shift: shiftOf(part.path, worktreesLine) }]));
  const offsets = await measureOffsets(protoPage, appPage, worktreesLine);
  compareParts(state, shifted, await measurePanel(protoPage, protoPaths), await measurePanel(appPage, appPaths), rows, failures, offsets);
}

/**
 * The D14 additions of a state, checked on their own (the prototype has none):
 * the Folder row sits between the head and section 1 with the section label's
 * style, its dropdown shows the demo's folder, Browse… and the check line are in
 * the row, and the summary's `folder` line names the folder.
 */
async function d14Additions(state: string, appPage: Page, rows: string[], failures: string[]): Promise<void> {
  const app = await measurePanel(appPage, {
    head: [...FORM, 0],
    row: FOLDER_ROW,
    label: [...FOLDER_ROW, 0],
    controls: [...FOLDER_ROW, 1],
    select: [...FOLDER_ROW, 1, 0],
    browse: [...FOLDER_ROW, 1, 1],
    first: [...FORM, 2],
    firstLabel: [...FORM, 2, 0],
    folderLine: FOLDER_LINE,
    cwdLine: [...SUMMARY, 2],
  });
  const selected = await appPage.evaluate(() => (document.querySelector('[data-testid="ns-folder"]') as HTMLSelectElement | null)?.selectedOptions[0]?.textContent ?? null);
  const checks: Array<[string, boolean, string]> = [];
  const row = app['row'];
  const head = app['head'];
  const first = app['first'];
  const label = app['label'];
  const firstLabel = app['firstLabel'];
  checks.push(['Folder row between the head and section 1', !!row && !!head && !!first && row.box.y >= head.box.y + head.box.height && first.box.y >= row.box.y + row.box.height, row ? fmtBox(row) : 'missing']);
  checks.push(['label copy', label?.text === 'Folder', JSON.stringify(label?.text ?? null)]);
  const labelStyle = COMPARED_STYLES.filter((prop) => label?.style[prop] !== firstLabel?.style[prop]);
  checks.push(['label style = section 1 label', !!label && !!firstLabel && labelStyle.length === 0, labelStyle.join(', ') || 'same']);
  checks.push(['dropdown: the demo folder (the default)', selected?.endsWith('(default)') === true, JSON.stringify(selected)]);
  checks.push(['Browse…', app['browse']?.text === 'Browse…', JSON.stringify(app['browse']?.text ?? null)]);
  checks.push(['summary folder line', app['folderLine']?.text.startsWith('folder    ') === true && app['folderLine']?.text.endsWith(' · workspace') === true, JSON.stringify(app['folderLine']?.text ?? null)]);
  checks.push(['summary cwd line after it', app['cwdLine']?.text.startsWith('cwd ') === true, JSON.stringify(app['cwdLine']?.text ?? null)]);
  for (const [what, ok, note] of checks) {
    if (!ok) failures.push(`${state} · D14 ${what}: ${note}`);
    rows.push(`| ${state} · D14 ${what} | addition | — | ${note.replaceAll('|', '\\|').slice(0, 60)} | ${ok ? 'ok' : 'FAIL'} | |`);
  }
}

/**
 * The D16 addition of a state, checked on its own (the prototype has none):
 * **Resume a terminal conversation** sits in section 1 out of the flow (absolute,
 * so the section's box above is the prototype's), on the label line's right edge,
 * clear of the label's text and above the name / task row.
 */
async function d16Addition(state: string, appPage: Page, rows: string[], failures: string[]): Promise<void> {
  const facts = await appPage.evaluate(() => {
    const toggle = document.querySelector<HTMLElement>('[data-testid="ns-resume"]');
    const section = toggle?.parentElement;
    const label = section?.children[0];
    const inputs = section?.children[1];
    if (!toggle || !section || !label || !inputs) return null;
    const range = document.createRange();
    range.selectNodeContents(label);
    const text = range.getBoundingClientRect();
    const box = toggle.getBoundingClientRect();
    return {
      copy: (toggle.textContent ?? '').trim(),
      position: getComputedStyle(toggle).position,
      rightGap: section.getBoundingClientRect().right - box.right,
      clearOfLabel: box.left - text.right,
      aboveInputs: inputs.getBoundingClientRect().top - box.bottom,
      box: `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`,
    };
  });
  const checks: Array<[string, boolean, string]> = [
    ['Resume toggle copy', facts?.copy === '↻ Resume a terminal conversation', JSON.stringify(facts?.copy ?? null)],
    ['Resume toggle out of the flow', facts?.position === 'absolute', facts?.position ?? 'missing'],
    ['Resume toggle on the right edge', facts !== null && Math.abs(facts.rightGap) <= 2, facts ? `${round(facts.rightGap)} px · ${facts.box}` : 'missing'],
    ['Resume toggle clear of the label', facts !== null && facts.clearOfLabel > 0, facts ? `${round(facts.clearOfLabel)} px` : 'missing'],
    ['Resume toggle above the name / task row', facts !== null && facts.aboveInputs >= 0, facts ? `${round(facts.aboveInputs)} px` : 'missing'],
  ];
  for (const [what, ok, note] of checks) {
    if (!ok) failures.push(`${state} · D16 ${what}: ${note}`);
    rows.push(`| ${state} · D16 ${what} | addition | — | ${note.replaceAll('|', '\\|').slice(0, 60)} | ${ok ? 'ok' : 'FAIL'} | |`);
  }
}

/**
 * The D25 addition of a state, checked on its own (the prototype has none):
 * **From a remote session** sits in the Folder section out of the flow (absolute,
 * so the Folder row's box, which the D14 rows check, is unchanged), on the Folder
 * label line's right edge, clear of the label's text and above the folder row.
 */
async function d25Addition(state: string, appPage: Page, rows: string[], failures: string[]): Promise<void> {
  const facts = await appPage.evaluate(() => {
    const toggle = document.querySelector<HTMLElement>('[data-testid="ns-remote"]');
    const section = toggle?.parentElement;
    const label = section?.children[0];
    const row = section?.children[1];
    if (!toggle || !section || !label || !row || section.getAttribute('data-section') !== 'folder') return null;
    const range = document.createRange();
    range.selectNodeContents(label);
    const text = range.getBoundingClientRect();
    const box = toggle.getBoundingClientRect();
    return {
      copy: (toggle.textContent ?? '').trim(),
      pressed: toggle.getAttribute('aria-pressed'),
      position: getComputedStyle(toggle).position,
      rightGap: section.getBoundingClientRect().right - box.right,
      clearOfLabel: box.left - text.right,
      aboveRow: row.getBoundingClientRect().top - box.bottom,
      box: `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`,
    };
  });
  const checks: Array<[string, boolean, string]> = [
    ['Remote toggle copy', facts?.copy === '⇣ From a remote session', JSON.stringify(facts?.copy ?? null)],
    ['Remote toggle off', facts?.pressed === 'false', JSON.stringify(facts?.pressed ?? null)],
    ['Remote toggle out of the flow', facts?.position === 'absolute', facts?.position ?? 'missing'],
    ['Remote toggle on the right edge', facts !== null && Math.abs(facts.rightGap) <= 2, facts ? `${round(facts.rightGap)} px · ${facts.box}` : 'missing'],
    ['Remote toggle clear of the label', facts !== null && facts.clearOfLabel > 0, facts ? `${round(facts.clearOfLabel)} px` : 'missing'],
    ['Remote toggle above the folder row', facts !== null && facts.aboveRow >= 0, facts ? `${round(facts.aboveRow)} px` : 'missing'],
  ];
  for (const [what, ok, note] of checks) {
    if (!ok) failures.push(`${state} · D25 ${what}: ${note}`);
    rows.push(`| ${state} · D25 ${what} | addition | — | ${note.replaceAll('|', '\\|').slice(0, 60)} | ${ok ? 'ok' : 'FAIL'} | |`);
  }
}

/**
 * The D32 additions of a state, checked on their own (the prototype has none):
 * the **Branch row** sits in section 1 under the name / task row, its field has
 * the name field's box (x, width, height) and computed styles, the
 * `PROJ-0001-short-description` placeholder and the branch entered, its note
 * beside it; the summary's **`branch` line** follows `# worktrees` in the value
 * lines' style.
 */
async function d32Additions(state: string, appPage: Page, branch: string, rows: string[], failures: string[]): Promise<void> {
  const facts = await appPage.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-testid="ns-branch-row"]');
    const field = document.querySelector<HTMLInputElement>('[data-testid="ns-branch"]');
    const name = document.querySelector<HTMLInputElement>('[data-testid="ns-name"]');
    const note = document.querySelector<HTMLElement>('[data-testid="ns-branch-note"]');
    const inputs = name?.parentElement;
    if (!row || !field || !name || !note || !inputs) return null;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const props = ['font-family', 'font-size', 'font-weight', 'color', 'background-color', 'border-top-color', 'border-top-width', 'border-radius', 'padding-top', 'padding-left'];
    const styleOf = (el: Element) => props.map((prop) => getComputedStyle(el).getPropertyValue(prop)).join(' | ');
    const lines = [...document.querySelectorAll('[data-testid="ns-summary-line"]')];
    const at = lines.findIndex((line) => (line.textContent ?? '').trim() === '# worktrees');
    const branchLine = at === -1 ? null : lines[at + 1];
    const valueLine = lines[2];
    return {
      inSection: row.parentElement === inputs.parentElement,
      below: box(row).y - (box(inputs).y + box(inputs).height),
      field: box(field),
      name: box(name),
      sameStyle: styleOf(field) === styleOf(name),
      styleDiff: props.filter((prop) => getComputedStyle(field).getPropertyValue(prop) !== getComputedStyle(name).getPropertyValue(prop)).join(', '),
      placeholder: field.placeholder,
      value: field.value,
      note: (note.textContent ?? '').trim(),
      noteFont: `${getComputedStyle(note).fontSize} ${getComputedStyle(note).fontFamily}`,
      branchLine: (branchLine?.textContent ?? '').trim(),
      branchTone: branchLine?.getAttribute('data-tone') ?? null,
      branchStyle: branchLine && valueLine ? getComputedStyle(branchLine).color === getComputedStyle(valueLine).color : false,
    };
  });
  const checks: Array<[string, boolean, string]> = [
    ['Branch row in section 1', facts?.inSection === true, facts ? String(facts.inSection) : 'missing'],
    ['Branch row under the name / task row', facts !== null && facts.below >= 0, facts ? `${round(facts.below)} px` : 'missing'],
    [
      'Branch field = the name field\'s x, width, height',
      facts !== null && Math.abs(facts.field.x - facts.name.x) <= 2 && Math.abs(facts.field.width - facts.name.width) <= 2 && Math.abs(facts.field.height - facts.name.height) <= 2,
      facts ? `${round(facts.field.x)} ${round(facts.field.width)}×${round(facts.field.height)} vs ${round(facts.name.x)} ${round(facts.name.width)}×${round(facts.name.height)}` : 'missing',
    ],
    ['Branch field style = the name field\'s', facts?.sameStyle === true, facts?.styleDiff || 'same'],
    ['Branch placeholder', facts?.placeholder === 'PROJ-0001-short-description', JSON.stringify(facts?.placeholder ?? null)],
    ['Branch value', facts?.value === branch, JSON.stringify(facts?.value ?? null)],
    ['Branch note', facts?.note === '⎇ the branch of every worktree', JSON.stringify(facts?.note ?? null)],
    ['Branch note font (mono meta)', facts?.noteFont === '11px "Geist Mono", monospace', facts?.noteFont ?? 'missing'],
    ['summary branch line after # worktrees', facts?.branchLine === `branch    ${branch}`, JSON.stringify(facts?.branchLine ?? null)],
    ['summary branch line = a value line', facts?.branchTone === 'value' && facts.branchStyle === true, `${facts?.branchTone ?? 'missing'}`],
  ];
  for (const [what, ok, note] of checks) {
    if (!ok) failures.push(`${state} · D32 ${what}: ${note}`);
    rows.push(`| ${state} · D32 ${what} | addition | — | ${note.replaceAll('|', '\\|').slice(0, 60)} | ${ok ? 'ok' : 'FAIL'} | |`);
  }
}

/** D38: the hint while no solution is picked. */
const D38_HINT = '0 selected · leave empty to let the agent choose · read-only folders locked';
/** D38: the summary line in place of the prototype's warning. */
const D38_LINE = 'solutions  chosen by the agent';
/** The prototype's summary line D38 replaces. */
const PROTO_WARNING = '⚠ pick at least one solution';

/** The prototype's index of the summary line with this text (`null` without one). */
async function protoLineIndex(protoPage: Page, text: string): Promise<number | null> {
  return protoPage.evaluate(
    ({ path, wanted }) => {
      let el: Element | undefined | null = findPanelIn(document);
      for (const index of path) el = el?.children[index];
      const index = [...(el?.children ?? [])].findIndex((line) => (line.textContent ?? '').trim() === wanted);
      return index === -1 ? null : index;
    },
    { path: [...SUMMARY], wanted: text },
  );
}

/**
 * The D38 parts of the `empty` state, checked on their own against the
 * prototype's parts they replace: section 4's hint (the ruled copy, the
 * prototype hint's styles, right edge, y and height), the summary line in place
 * of `⚠ pick at least one solution` (the ruled copy, a value line: the value
 * lines' color, the warning line's x, y and height) and Start (the prototype's
 * box, copy and styles, but enabled: opacity 1 where the prototype has 45%).
 */
async function d38Additions(state: string, protoPage: Page, appPage: Page, warning: number, rows: string[], failures: string[]): Promise<void> {
  const worktreesLine = await worktreesLineOf(protoPage);
  const offsets = await measureOffsets(protoPage, appPage, worktreesLine);
  const hintPath = [...SOLUTIONS, 0, 0];
  const linePath = [...SUMMARY, warning];
  const startPath = [...SIDE, 4, 1];
  const proto = await measurePanel(protoPage, { hint: hintPath, line: linePath, start: startPath });
  const app = await measurePanel(appPage, { hint: appPathOf(hintPath), line: appPathOf(linePath, worktreesLine), start: startPath, value: [...SUMMARY, 2] });
  const facts = await appPage.evaluate(() => {
    const lines = [...document.querySelectorAll('[data-testid="ns-summary-line"]')];
    const line = lines.find((el) => (el.textContent ?? '').trim() === 'solutions  chosen by the agent');
    const start = document.querySelector<HTMLButtonElement>('[data-testid="ns-start"]');
    return { tone: line?.getAttribute('data-tone') ?? null, startDisabled: start?.disabled ?? null };
  });
  const near = (a: number | undefined, b: number | undefined): boolean => a !== undefined && b !== undefined && Math.abs(a - b) <= 2;
  const styleDiff = (a: Part | null | undefined, b: Part | null | undefined, skip: readonly string[] = []): string[] =>
    COMPARED_STYLES.filter((prop) => !skip.includes(prop) && a?.style[prop] !== b?.style[prop]).map((prop) => `${prop}: ${a?.style[prop]} vs ${b?.style[prop]}`);
  const [ph, ah, pl, al, ps, as, av] = [proto['hint'], app['hint'], proto['line'], app['line'], proto['start'], app['start'], app['value']];
  const hintStyle = styleDiff(ph, ah);
  // The border colors are `currentColor` (the text color): a value line's, not the warning's amber.
  const lineStyle = styleDiff(pl, al, ['color', 'border-top-color', 'border-right-color']);
  const startStyle = styleDiff(ps, as, ['opacity']);
  const checks: Array<[string, boolean, string]> = [
    ['hint copy', ah?.text === D38_HINT, JSON.stringify(ah?.text ?? null)],
    ['hint style = the prototype hint', !!ph && !!ah && hintStyle.length === 0, hintStyle.join(', ') || 'same'],
    [
      'hint right edge, y and height = the prototype hint',
      !!ph && !!ah && near(ph.box.x + ph.box.width, ah.box.x + ah.box.width) && near(ph.box.y, ah.box.y - offsets.belowTask) && near(ph.box.height, ah.box.height),
      ph && ah ? `${round(ah.box.x + ah.box.width)} vs ${round(ph.box.x + ph.box.width)}` : 'missing',
    ],
    ['summary line copy (the prototype warning\'s place)', al?.text === D38_LINE, JSON.stringify(al?.text ?? null)],
    ['summary line = a value line', facts.tone === 'value' && !!al && !!av && al.style['color'] === av.style['color'], `${facts.tone ?? 'missing'} ${al?.style['color'] ?? ''}`],
    [
      'summary line x, y and height = the warning line',
      !!pl && !!al && near(pl.box.x, al.box.x) && near(pl.box.y, al.box.y - offsets.belowBranch) && near(pl.box.height, al.box.height),
      pl && al ? fmtBox(al) : 'missing',
    ],
    ['summary line style = the warning line (color aside)', !!pl && !!al && lineStyle.length === 0, lineStyle.join(', ') || 'same'],
    ['Start box and copy = the prototype', !!ps && !!as && compareBoxes('Start', ps.box, as.box, 'box').length === 0 && ps.text === as.text, as ? `${fmtBox(as)} ${JSON.stringify(as.text)}` : 'missing'],
    ['Start enabled (opacity 1; the prototype 0.45)', facts.startDisabled === false && as?.style['opacity'] === '1' && ps?.style['opacity'] === '0.45', `${as?.style['opacity'] ?? ''} vs ${ps?.style['opacity'] ?? ''}`],
    ['Start style = the prototype (opacity aside)', !!ps && !!as && startStyle.length === 0, startStyle.join(', ') || 'same'],
  ];
  for (const [what, ok, note] of checks) {
    if (!ok) failures.push(`${state} · D38 ${what}: ${note}`);
    rows.push(`| ${state} · D38 ${what} | ruling | — | ${note.replaceAll('|', '\\|').slice(0, 60)} | ${ok ? 'ok' : 'FAIL'} | |`);
  }
}

/** Clicks the prototype's pill or chip with exactly this text (its onClick sits on the text's parent span). */
async function protoClick(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().click();
}

let app: DemoApp;

/** D32: the branch entered for the draft (the prototype's draft has Worktree on). */
const DRAFT_BRANCH = 'PROJ-640-free-talk';

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

test('New-session modal matches the prototype (tokens, boxes ±2 px, copy, four states)', async ({ browser }) => {
  test.setTimeout(90_000);
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoClick(protoPage, '+ New session');
  await protoPage.getByText('Start session', { exact: true }).waitFor();
  await installPanelFinder(protoPage);

  await openApp(appPage, app.baseUrl, '/');
  await appPage.getByTestId('new-session').click();
  const modal = appPage.getByTestId('modal-new-session');
  await modal.getByTestId('ns-group').first().waitFor();
  await installPanelFinder(appPage);
  // The prototype's draft (`ns`), entered through the form.
  await modal.getByTestId('ns-name').fill('free-talk-640');
  await modal.getByTestId('ns-task').fill('Free talk screen at 640, web and mobile. Figma node 2231:902.');
  await modal.locator('[data-group="mode"][data-value="orchestrator"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="acme-app-front"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="mobile"]').click();
  // D32: with Worktree on, Start needs the ticket branch (the prototype has no such field; checked on its own).
  await modal.getByTestId('ns-branch').fill(DRAFT_BRANCH);

  const rows: string[] = [];
  const failures: string[] = [];

  // State 1: the draft.
  await measureAndCompare('draft', protoPage, appPage, draftParts(), rows, failures);
  // D32: the Branch field is an addition, checked on its own (d32Additions).
  const inputs = async (page: Page) =>
    page.evaluate(() =>
      [...(findPanelIn(document)?.querySelectorAll('input:not([data-testid="ns-branch"]):not([data-section="branching"] input)') ?? [])].map((input) => ({ value: (input as HTMLInputElement).value, placeholder: (input as HTMLInputElement).placeholder })),
    );
  const protoInputs = await inputs(protoPage);
  const appInputs = await inputs(appPage);
  if (JSON.stringify(protoInputs) !== JSON.stringify(appInputs)) failures.push(`draft · inputs: prototype ${JSON.stringify(protoInputs)} vs app ${JSON.stringify(appInputs)}`);
  rows.push(`| draft · inputs (value, placeholder) | — | ${JSON.stringify(protoInputs).slice(0, 60)}… | same | ${JSON.stringify(protoInputs) === JSON.stringify(appInputs) ? 'ok' : 'FAIL'} | |`);
  // Section 4's last child is the read-only row (label + one row per group).
  const lastGroup = (page: Page, section: readonly number[]) =>
    page.evaluate((path) => {
      let el: Element | undefined | null = findPanelIn(document);
      for (const index of path) el = el?.children[index];
      return (el?.children.length ?? 0) - 1;
    }, [...section]);
  const protoGroups = await lastGroup(protoPage, SOLUTIONS);
  const appGroups = await lastGroup(appPage, appPathOf(SOLUTIONS));
  const readOnly = readOnlyParts(protoGroups, appGroups);
  const protoRo = await measurePanel(protoPage, Object.fromEntries(Object.entries(readOnly).map(([n, s]) => [n, s.proto])));
  const appRo = await measurePanel(appPage, Object.fromEntries(Object.entries(readOnly).map(([n, s]) => [n, appPathOf(s.app)])));
  compareParts('draft', readOnly, protoRo, appRo, rows, failures);
  await d14Additions('draft', appPage, rows, failures);
  await d16Addition('draft', appPage, rows, failures);
  await d25Addition('draft', appPage, rows, failures);
  await d32Additions('draft', appPage, DRAFT_BRANCH, rows, failures);

  // SPEC tokens as computed styles of the app (New session: 1080px, `1fr | 360px`, pills, chips, toggles, summary).
  const computed = await appPage.evaluate(() => {
    const one = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const panel = one('.sb-modal-new');
    const pillOn = one('[data-group="mode"][data-selected="true"]');
    const chipOn = one('[data-testid="ns-chip"][data-selected="true"]');
    const locked = one('[data-testid="ns-chip"][data-locked="true"]');
    const switchOn = one('[data-testid="ns-switch-worktrees"]');
    const switchOff = one('[data-testid="ns-switch-ultracode"]');
    const summary = one('.sb-ns-summary');
    const start = one('[data-testid="ns-start"]');
    const label = one('.sb-ns-label');
    const switchBox = document.querySelector('[data-testid="ns-switch-worktrees"]')!.getBoundingClientRect();
    return {
      panelWidth: panel.width,
      panelColumns: panel.gridTemplateColumns,
      panelRadius: panel.borderTopLeftRadius,
      panelShadow: panel.boxShadow,
      panelBg: panel.backgroundColor,
      pillOnBg: pillOn.backgroundColor,
      pillOnBorder: pillOn.borderTopColor,
      chipOnBg: chipOn.backgroundColor,
      chipOnBorder: chipOn.borderTopColor,
      lockedOpacity: locked.opacity,
      lockedCursor: locked.cursor,
      switchSize: `${switchBox.width}×${switchBox.height}`,
      switchOnBg: switchOn.backgroundColor,
      switchOffBg: switchOff.backgroundColor,
      summaryFont: `${summary.fontSize} ${summary.fontFamily}`,
      summaryBg: summary.backgroundColor,
      startBg: start.backgroundColor,
      startFg: start.color,
      startOpacity: start.opacity,
      labelFont: `${label.fontWeight} ${label.fontSize} ${label.fontFamily}`,
      labelSpacing: `${label.letterSpacing} ${label.textTransform}`,
      labelColor: label.color,
    };
  });
  const [blueBg, blueBorder] = await canonicalColors(appPage, ['oklch(0.25 0.04 250)', 'oklch(0.55 0.09 250)']);
  const expected: Record<string, string> = {
    panelWidth: '1080px',
    panelColumns: '720px 360px',
    panelRadius: '14px',
    panelShadow: 'rgba(0, 0, 0, 0.6) 0px 30px 80px 0px',
    panelBg: hexToRgb('#141518'),
    pillOnBg: hexToRgb('#26272c'),
    pillOnBorder: hexToRgb('#8d8c87'),
    chipOnBg: blueBg ?? '',
    chipOnBorder: blueBorder ?? '',
    lockedOpacity: '0.4',
    lockedCursor: 'not-allowed',
    switchSize: '32×18',
    switchOnBg: hexToRgb('#e8e7e3'),
    switchOffBg: hexToRgb('#33343a'),
    summaryFont: '11.5px "Geist Mono", monospace',
    summaryBg: hexToRgb('#0c0d0f'),
    startBg: hexToRgb('#e8e7e3'),
    startFg: hexToRgb('#111214'),
    startOpacity: '1',
    labelFont: '500 10.5px "Geist Mono", monospace',
    labelSpacing: '0.63px uppercase',
    labelColor: hexToRgb('#8d8c87'),
  };
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = computed[key as keyof typeof computed];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${got}`);
    computedRows.push(`| ${key} | ${want} | ${got} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  // Captures of the draft (the panel, then the page).
  const clip = { x: 179, y: 49, width: 1082, height: 802 };
  const protoPanel = await protoPage.screenshot({ clip });
  const appPanel = await appPage.screenshot({ clip });
  const protoFull = await protoPage.screenshot();
  const appFull = await appPage.screenshot();
  const panelDiff = await pixelDiff(appPage, protoPanel, appPanel);
  const fullDiff = await pixelDiff(appPage, protoFull, appFull);

  // State 2: single-solution → section 6 · Mobile coordination (a *-front is in scope).
  await protoClick(protoPage, 'Single-solution');
  await modal.locator('[data-group="mode"][data-value="single"]').click();
  await expect(modal.locator('[data-section="coordination"]')).toBeVisible();
  const coordination = { ...sectionSixParts(3), summaryLine5: { path: [...SIDE, 3, 5], geometry: 'box', copy: true } } satisfies Record<string, PartSpec>;
  await measureAndCompare('single', protoPage, appPage, coordination, rows, failures);

  // State 3: test-authoring, stack Both → section 6 · QA contract (the prototype's stack default).
  await protoClick(protoPage, 'Test-authoring (QA)');
  await modal.locator('[data-group="work-type"][data-value="qa"]').click();
  await modal.locator('[data-group="stack"][data-value="both"]').click();
  const qa: Record<string, PartSpec> = {
    ...sectionSixParts(3),
    qaFields: { path: [...FORM, 6, 2], geometry: 'size', copy: false },
    qaConfluence: { path: [...FORM, 6, 2, 0], geometry: 'size', copy: false },
    qaFigma: { path: [...FORM, 6, 2, 1], geometry: 'size', copy: false },
    summaryLine2: { path: [...SIDE, 3, 2], geometry: 'box', copy: true },
    summaryLine5: { path: [...SIDE, 3, 5], geometry: 'box', copy: true },
  };
  const qaPaths = Object.fromEntries(Object.entries(qa).map(([name, part]) => [name, part.path]));
  const qaWorktreesLine = await worktreesLineOf(protoPage);
  const protoQa = await measurePanel(protoPage, qaPaths);
  const appQa = await measurePanel(appPage, Object.fromEntries(Object.entries(qa).map(([name, part]) => [name, appPathOf(part.path, qaWorktreesLine)])));
  const qaOffsets = await measureOffsets(protoPage, appPage, qaWorktreesLine);
  // The prototype draws the two sources as static boxes; the app's are inputs whose placeholder is that copy (muted, #76756f).
  const placeholderCopy = await appPage.evaluate(() => [
    (document.querySelector('[data-testid="ns-confluence"]') as HTMLInputElement).placeholder,
    (document.querySelector('[data-testid="ns-figma"]') as HTMLInputElement).placeholder,
    getComputedStyle(document.querySelector('[data-testid="ns-confluence"]')!, '::placeholder').color,
  ]);
  for (const [index, name] of [
    [0, 'qaConfluence'],
    [1, 'qaFigma'],
  ] as const) {
    if (protoQa[name]?.text !== placeholderCopy[index]) failures.push(`qa · ${name} copy: prototype ${protoQa[name]?.text} vs app placeholder ${placeholderCopy[index]}`);
    // Known difference: the prototype's static box vs a real input. Its color is compared with the placeholder's
    // (the input's own text is the entered URL) and its text cursor is the input's (the static box has none).
    const a = appQa[name];
    if (a) appQa[name] = { ...a, style: { ...a.style, color: placeholderCopy[2] ?? '', cursor: a.style['cursor'] === 'text' ? 'auto' : (a.style['cursor'] ?? '') } };
  }
  compareParts('qa', Object.fromEntries(Object.entries(qa).map(([name, part]) => [name, { ...part, shift: shiftOf(part.path, qaWorktreesLine) }])), protoQa, appQa, rows, failures, qaOffsets);

  // State 4: back to the draft's work type, no solutions → the prototype's "⚠ pick at least one solution", Start at 45%.
  // D38 (ruling): the app reads `solutions  chosen by the agent` there, Start is enabled and the hint says to leave
  // them empty; those parts are checked on their own (d38Additions), every other line against the prototype.
  await protoClick(protoPage, 'Feature-building');
  await protoClick(protoPage, '✓ acme-app-front');
  await protoClick(protoPage, '✓ mobile');
  await modal.locator('[data-group="work-type"][data-value="feature"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="acme-app-front"]').click();
  await modal.locator('[data-testid="ns-chip"][data-solution="mobile"]').click();
  const warning = await protoLineIndex(protoPage, PROTO_WARNING);
  if (warning === null) failures.push(`empty · the prototype's "${PROTO_WARNING}" line is missing`);
  const empty: Record<string, PartSpec> = {};
  for (let i = 0; i < 10; i++) if (i !== warning) empty[`summaryLine${i}`] = { path: [...SIDE, 3, i], geometry: 'box', copy: true };
  await measureAndCompare('empty', protoPage, appPage, empty, rows, failures);
  await d14Additions('empty', appPage, rows, failures);
  await d32Additions('empty', appPage, DRAFT_BRANCH, rows, failures);
  if (warning !== null) await d38Additions('empty', protoPage, appPage, warning, rows, failures);

  await writeReport({
    'new-session.md': report({ rows, computedRows, failures, panel: panelDiff.percent, full: fullDiff.percent }),
    'new-session-side-by-side.png': await sideBySide(appPage, protoPanel, appPanel),
    'new-session-page-side-by-side.png': await sideBySide(appPage, protoFull, appFull),
  });

  expect(failures).toEqual([]);
});

function report(input: { rows: string[]; computedRows: string[]; failures: string[]; panel: number; full: number }): string {
  return `# Visual oracle · New-session modal (M5.1)

Generated by \`tests/e2e/visual/new-session.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, "+ New session" with the form filled to the prototype's draft through the UI (name \`free-talk-640\`, its task, Workspace orchestrator, acme-app-front + mobile).
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, "+ New session" (its draft \`ns\`).

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff of the draft (advisory, channel threshold 24): modal panel (179,49 1082×802) **${input.panel.toFixed(2)}%**, full page **${input.full.toFixed(2)}%**.
Known data differences: the solution chips come from the demo's workspace scan (the Solutions view's rows): nugets/ has 2 chips instead of 4, microservices/ lists notifications before auth, functions/ has 1, and there is no other/ row, so the solutions section is 66 px shorter and everything below it (read-only row, phase, section 6) is compared by size only. Behind the overlay the sidebar differs where other lanes' routes still answer 501 in this lane.

Side by side (prototype left, app right): \`new-session-side-by-side.png\` (the panel), \`new-session-page-side-by-side.png\` (page).

## D14 additions (not findings)
The Folder row above section 1 (saved-folder dropdown, Browse…, check line) and the summary's \`folder\` line before \`cwd\` are not in the prototype. The app's form child k + 1 is compared with the prototype's child k (k ≥ 1), with y relative to section 1 (\`y − <offset>\` in the table); the app's summary line i + 1 with the prototype's line i (i ≥ 1), with y less the added line's height. The added parts are checked on their own (\`D14 …\` rows): the row sits between the head and section 1 with the section label's style, the dropdown shows the default folder, the summary names it.

## D16 addition (not a finding)
**Resume a terminal conversation** (\`↻\` pill) is not in the prototype. It sits in section 1 out of the flow (absolute), on the right of the label line, so section 1 and everything below keep the prototype's boxes; it is checked on its own (\`D16 …\` rows): copy, out of the flow, on the section's right edge, clear of the label's text, above the name / task row.

## D32 additions (not findings)
With Worktree on (the prototype's draft) the app's form has a **Branch row** inside section 1 under the name / task row (the name field's box and style, placeholder \`PROJ-0001-short-description\`, the ticket branch entered through the form like the draft's other values, since Start needs it), and the summary a **\`branch\` line** right after \`# worktrees\`. The prototype has neither: section 1 is compared with its height less the row's (\`height − <n>\` in the table), the sections below it with their y less that too, and the summary lines after \`# worktrees\` at the app's index + 2 with their y less both added lines. The added parts are checked on their own (\`D32 …\` rows).

## D38 ruling (not findings)
Picking solutions is optional (the agent determines them when none is picked). In the \`empty\` state the prototype's \`⚠ pick at least one solution\` line reads \`solutions  chosen by the agent\` in the app (a value line at the warning's place), Start is enabled (the app's Branch field holds the draft's ticket branch; the prototype shows it at 45%) and section 4's hint reads \`0 selected · leave empty to let the agent choose · read-only folders locked\`. Those three parts leave the prototype comparison and are checked on their own (\`D38 …\` rows): the hint has the prototype hint's styles, right edge, y and height; the line the warning line's box and style (color aside: a value line's); Start the prototype's box, copy and styles with opacity 1. The draft state (solutions picked) is compared as before.

## D25 addition (not a finding)
**From a remote session** (\`⇣\` pill) is not in the prototype. It sits in the Folder section (itself a D14 addition) out of the flow (absolute), on the right of the Folder label line, so the Folder row and everything below keep their boxes; it is checked on its own (\`D25 …\` rows): copy, off by default, out of the flow, on the section's right edge, clear of the label's text, above the folder row.

## Boxes (±2 px), copy and computed styles
Geometry: \`box\` = x, y, width, height; \`size\` = x, width, height. States: \`draft\` (the prototype's draft), \`single\` (Single-solution: section 6 · Mobile coordination), \`qa\` (Test-authoring, stack Both: section 6 · QA contract; the prototype's static source boxes against the app's inputs, copy = placeholder, color = placeholder color), \`empty\` (no solutions: the prototype's warning line and Start at 45%, D38's line, Start and hint checked on their own). Styles compared: ${COMPARED_STYLES.join(', ')}.

| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.rows.join('\n')}

## SPEC tokens (computed)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
