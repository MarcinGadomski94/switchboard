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
 * D42 additions (not findings): the Launch area's **Model row** (the toggles'
 * third row: title, description and D31's picker in the switch's place) and the
 * summary's **`model` line** right after `ultracode`. The prototype has
 * neither: the toggles block is compared with its height less the row's share,
 * the summary label and the summary with their y less it (the summary's height
 * plus it: the side keeps its height, the summary gives way), and the summary
 * lines after `ultracode` at the app's index + 1 more with their y less the
 * added line too. The added parts are checked on their own ({@link d42Additions}).
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
 * Where the D32 / D42 summary additions sit, as the prototype's summary line
 * indexes of the current state (`null` without such a line): the lines after
 * `# worktrees` (D32: the added `branch` line) and after `ultracode` (D42: the
 * added `model` line) sit one more line lower in the app each.
 */
interface SummaryMarks {
  readonly worktrees: number | null;
  readonly ultracode: number | null;
}

const NO_MARKS: SummaryMarks = { worktrees: null, ultracode: null };

/**
 * The app's path of a prototype path (D14, see the module comment); summary
 * lines also move down past the D32 / D42 lines ({@link SummaryMarks}).
 */
function appPathOf(path: readonly number[], marks: SummaryMarks = NO_MARKS): readonly number[] {
  const [a, b, c] = path;
  if (a !== undefined && a === FORM[0] && b !== undefined && b >= 1) return [a, b + 1, ...path.slice(2)];
  if (a !== undefined && a === SIDE[0] && b !== undefined && b === SUMMARY[1] && c !== undefined && c >= 1) {
    const past = (line: number | null): number => (line !== null && c > line ? 1 : 0);
    return [a, b, c + 1 + past(marks.ultracode) + past(marks.worktrees), ...path.slice(3)];
  }
  return path;
}

/**
 * What {@link appPathOf} shifted: section 1 below the Folder row (`form`; D32: its
 * own box, `task`, grows by the Branch row), the sections below it (`belowTask`);
 * D42: the toggles block grows by the Model row (`toggles`), so the summary label
 * and the summary's first line sit lower (`launch`) and the summary box too, less
 * high (`summaryBox`); the summary below the `folder` line (`summary`), the lines
 * below the `model` line (D42, `belowModel`) and (D32) below the `branch` line
 * (`belowBranch`).
 */
type Shift = 'form' | 'task' | 'belowTask' | 'toggles' | 'launch' | 'summaryBox' | 'summary' | 'belowModel' | 'belowBranch';

function shiftOf(path: readonly number[], marks: SummaryMarks = NO_MARKS): Shift | null {
  const [a, b, c] = path;
  if (a === FORM[0] && b === 1) return path.length === 2 ? 'task' : 'form';
  if (a === FORM[0] && b !== undefined && b >= 2) return 'belowTask';
  if (a === SIDE[0] && b === 1 && path.length === 2) return 'toggles';
  if (a === SIDE[0] && b === 2) return 'launch';
  if (a === SIDE[0] && b === SUMMARY[1] && c === undefined) return 'summaryBox';
  if (a === SIDE[0] && b === SUMMARY[1] && c === 0) return 'launch';
  if (a === SIDE[0] && b === SUMMARY[1] && c !== undefined && c >= 1) {
    if (marks.worktrees !== null && c > marks.worktrees) return 'belowBranch';
    return marks.ultracode !== null && c > marks.ultracode ? 'belowModel' : 'summary';
  }
  return null;
}

/** D32 / D42: the prototype's indexes of its `# worktrees` and `ultracode …` summary lines in the current state. */
async function summaryMarksOf(protoPage: Page): Promise<SummaryMarks> {
  return protoPage.evaluate((path) => {
    let el: Element | undefined | null = findPanelIn(document);
    for (const index of path) el = el?.children[index];
    const texts = [...(el?.children ?? [])].map((line) => (line.textContent ?? '').trim());
    const at = (index: number): number | null => (index === -1 ? null : index);
    return { worktrees: at(texts.indexOf('# worktrees')), ultracode: at(texts.findIndex((text) => text.startsWith('ultracode '))) };
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
 * How far the D14 / D32 / D42 additions move the app's parts down (px): section 1
 * and the form below the Folder row (`form`, `task`), the sections below section
 * 1's Branch row too (`belowTask`); D42: the summary label, the summary box and its
 * first line below the Model row (`launch`, `summaryBox`); the summary lines
 * below the `folder` line (`summary`), below the `model` line too (`belowModel`)
 * and below the `branch` line too (`belowBranch`). `taskGrow` = the Branch row's
 * share of section 1's height (taken off its height); `launchGrow` (D42) = the
 * Model row's share of the toggles block's height (taken off it, and given back
 * to the summary box's).
 */
interface Offsets {
  readonly form: number;
  readonly task: number;
  readonly belowTask: number;
  readonly taskGrow: number;
  readonly toggles: number;
  readonly launch: number;
  readonly summaryBox: number;
  readonly launchGrow: number;
  readonly summary: number;
  readonly belowModel: number;
  readonly belowBranch: number;
}

const NO_OFFSETS: Offsets = { form: 0, task: 0, belowTask: 0, taskGrow: 0, toggles: 0, launch: 0, summaryBox: 0, launchGrow: 0, summary: 0, belowModel: 0, belowBranch: 0 };

/**
 * Measures the offsets of a state: the first section's y and height on both
 * pages (D14 / D32), the toggles block's height on both (D42), the added summary
 * lines' heights (D14 `folder`, D42 `model` right after `ultracode`, D32 `branch`
 * right after `# worktrees`).
 */
async function measureOffsets(protoPage: Page, appPage: Page, marks: SummaryMarks): Promise<Offsets> {
  const firstSection = [...FORM, 1];
  const toggles = [...SIDE, 1];
  const proto = await measurePanel(protoPage, { first: firstSection, toggles });
  const app = await measurePanel(appPage, {
    first: appPathOf(firstSection),
    toggles,
    folderLine: FOLDER_LINE,
    // The app's index of a prototype line + 1 is the line added right after it.
    ...(marks.ultracode !== null ? { modelLine: [...SUMMARY, appPathOf([...SUMMARY, marks.ultracode], marks)[2]! + 1] } : {}),
    ...(marks.worktrees !== null ? { branchLine: [...SUMMARY, appPathOf([...SUMMARY, marks.worktrees], marks)[2]! + 1] } : {}),
  });
  const form = (app['first']?.box.y ?? 0) - (proto['first']?.box.y ?? 0);
  const taskGrow = (app['first']?.box.height ?? 0) - (proto['first']?.box.height ?? 0);
  const launch = (app['toggles']?.box.height ?? 0) - (proto['toggles']?.box.height ?? 0);
  const summary = launch + (app['folderLine']?.box.height ?? 0);
  const belowModel = summary + (app['modelLine']?.box.height ?? 0);
  return {
    form,
    task: form,
    belowTask: form + taskGrow,
    taskGrow,
    toggles: 0,
    launch,
    summaryBox: launch,
    launchGrow: launch,
    summary,
    belowModel,
    belowBranch: belowModel + (app['branchLine']?.box.height ?? 0),
  };
}

/** How much a shifted part's height differs from the prototype's: D32's Branch row in section 1, D42's Model row in the toggles (the summary gives it back). */
function heightShift(shift: Shift | null | undefined, offsets: Offsets): number {
  if (shift === 'task') return offsets.taskGrow;
  if (shift === 'toggles') return offsets.launchGrow;
  if (shift === 'summaryBox') return -offsets.launchGrow;
  return 0;
}

/**
 * Compares measured parts; appends report rows and findings. `offsets` (D14 /
 * D32 / D42) are taken off the app's y of shifted parts, section 1's added Branch
 * row off its height (`task`), the Model row off the toggles' (`toggles`) and
 * added back to the summary's (`summaryBox`).
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
    const dh = heightShift(spec.shift, offsets);
    const a: Part = dy || dh ? { ...measured, box: { ...measured.box, y: measured.box.y - dy, height: measured.box.height - dh } } : measured;
    const boxIssues = compareBoxes(label, p.box, a.box, spec.geometry);
    const copyIssues = spec.copy && p.text !== a.text ? [`${label}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`] : [];
    const styleIssues = COMPARED_STYLES.filter((prop) => p.style[prop] !== a.style[prop]).map((prop) => `${label}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
    failures.push(...boxIssues, ...copyIssues, ...styleIssues);
    const ok = boxIssues.length + copyIssues.length + styleIssues.length === 0;
    const geometry = spec.shift ? `${spec.geometry} (y − ${round(dy)}${dh ? `, height ${dh > 0 ? '−' : '+'} ${round(Math.abs(dh))}` : ''})` : spec.geometry;
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
  const marks = await summaryMarksOf(protoPage);
  const protoPaths = Object.fromEntries(Object.entries(specs).map(([name, part]) => [name, part.path]));
  const appPaths = Object.fromEntries(Object.entries(specs).map(([name, part]) => [name, appPathOf(part.path, marks)]));
  const shifted = Object.fromEntries(Object.entries(specs).map(([name, part]) => [name, { ...part, shift: shiftOf(part.path, marks) }]));
  const offsets = await measureOffsets(protoPage, appPage, marks);
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

/** D42: the Model row's copy (`src/web/modals/new-session.ts`). */
const D42_TITLE = 'Model';
const D42_DESCRIPTION = 'Starts on your last choice';
/** D42: the demo reports no models and stores no last choice: the CLI's default, among the CLI's aliases. */
const D42_TRIGGER = 'Default▾';
const D42_LINE = 'model     Default';
const D42_ALIASES = ['default', 'opus', 'sonnet', 'haiku'];

/**
 * The D42 additions of a state, checked on their own (the prototype has none):
 * the **Model row** is the toggles block's third row, the Ultracode row's box
 * (x, width, height) one toggles gap below it, its title and description in the
 * toggle rows' styles; D31's picker sits where the switches do (right edge,
 * centered) in the header actions' look (12px, a 1px `--border-control` line as
 * Cancel's, 6px radius), on the CLI's default; the summary's **`model` line**
 * follows `ultracode` as a value line. With `popover`, the picker opens inside
 * the side column above the actions, offers the CLI's aliases without effort
 * pills, and Esc closes only the popover (the modal stays).
 */
async function d42Additions(state: string, appPage: Page, rows: string[], failures: string[], options: { readonly popover?: boolean } = {}): Promise<void> {
  const facts = await appPage.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-testid="ns-model-row"]');
    const toggles = row?.parentElement;
    const ultracode = toggles?.children[1];
    const worktree = toggles?.children[0];
    const button = document.querySelector<HTMLElement>('[data-testid="ns-model-button"]');
    const switchEl = document.querySelector<HTMLElement>('[data-testid="ns-switch-ultracode"]');
    const cancel = document.querySelector<HTMLElement>('[data-testid="ns-cancel"]');
    if (!row || !toggles || !ultracode || !worktree || !button || !switchEl || !cancel) return null;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const props = ['font-family', 'font-size', 'font-weight', 'color', 'line-height'];
    const styleDiff = (a: Element | null | undefined, b: Element | null | undefined) =>
      a && b ? props.filter((prop) => getComputedStyle(a).getPropertyValue(prop) !== getComputedStyle(b).getPropertyValue(prop)).join(', ') : 'missing';
    const title = row.querySelector('.sb-ns-toggle-title');
    const desc = row.querySelector('.sb-ns-toggle-desc');
    const lines = [...document.querySelectorAll('[data-testid="ns-summary-line"]')];
    const at = lines.findIndex((line) => (line.textContent ?? '').trim().startsWith('ultracode '));
    const modelLine = at === -1 ? null : lines[at + 1];
    const buttonStyle = getComputedStyle(button);
    return {
      index: [...toggles.children].indexOf(row),
      row: box(row),
      ultracode: box(ultracode),
      gap: box(ultracode).y - (box(worktree).y + box(worktree).height),
      below: box(row).y - (box(ultracode).y + box(ultracode).height),
      title: (title?.textContent ?? '').trim(),
      titleStyle: styleDiff(title, ultracode.querySelector('.sb-ns-toggle-title')),
      desc: (desc?.textContent ?? '').trim(),
      descStyle: styleDiff(desc, ultracode.querySelector('.sb-ns-toggle-desc')),
      trigger: (button.textContent ?? '').trim(),
      button: box(button),
      switchBox: box(switchEl),
      look: `${buttonStyle.fontSize} ${buttonStyle.borderTopWidth} ${buttonStyle.borderTopLeftRadius}`,
      border: buttonStyle.borderTopColor === getComputedStyle(cancel).borderTopColor,
      line: (modelLine?.textContent ?? '').trim(),
      lineTone: modelLine?.getAttribute('data-tone') ?? null,
      lineColor: modelLine && lines[2] ? getComputedStyle(modelLine).color === getComputedStyle(lines[2]).color : false,
    };
  });
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;
  const checks: Array<[string, boolean, string]> = [
    ['Model row = the toggles\' third row', facts?.index === 2, facts ? String(facts.index) : 'missing'],
    [
      'Model row = the Ultracode row\'s x, width, height',
      facts !== null && near(facts.row.x, facts.ultracode.x) && near(facts.row.width, facts.ultracode.width) && near(facts.row.height, facts.ultracode.height),
      facts ? `${round(facts.row.x)},${round(facts.row.y)} ${round(facts.row.width)}×${round(facts.row.height)}` : 'missing',
    ],
    ['Model row one toggles gap below Ultracode', facts !== null && near(facts.below, facts.gap), facts ? `${round(facts.below)} px vs ${round(facts.gap)} px` : 'missing'],
    ['title copy', facts?.title === D42_TITLE, JSON.stringify(facts?.title ?? null)],
    ['title style = the toggle titles\'', facts?.titleStyle === '', facts?.titleStyle || 'same'],
    ['description copy', facts?.desc === D42_DESCRIPTION, JSON.stringify(facts?.desc ?? null)],
    ['description style = the toggle descriptions\'', facts?.descStyle === '', facts?.descStyle || 'same'],
    ['picker on the CLI default (the demo reports no models)', facts?.trigger === D42_TRIGGER, JSON.stringify(facts?.trigger ?? null)],
    [
      'picker right edge = the switches\', centered in the row',
      facts !== null && near(facts.button.x + facts.button.width, facts.switchBox.x + facts.switchBox.width) && near(facts.button.y + facts.button.height / 2, facts.row.y + facts.row.height / 2),
      facts ? `${round(facts.button.x + facts.button.width)} vs ${round(facts.switchBox.x + facts.switchBox.width)} · ${round(facts.button.height)} px high` : 'missing',
    ],
    ['picker look = the header actions\' (12px, 1px, 6px; Cancel\'s line color)', facts?.look === '12px 1px 6px' && facts.border === true, facts ? `${facts.look} ${facts.border ? 'same line' : 'other line'}` : 'missing'],
    ['summary model line after ultracode', facts?.line === D42_LINE, JSON.stringify(facts?.line ?? null)],
    ['summary model line = a value line', facts?.lineTone === 'value' && facts.lineColor === true, facts?.lineTone ?? 'missing'],
  ];
  if (options.popover) {
    await appPage.getByTestId('ns-model-button').click();
    const pop = await appPage.evaluate(() => {
      const popover = document.querySelector('[data-testid="ns-model"] [data-testid="model-popover"]');
      const side = document.querySelector('.sb-ns-side');
      const actions = document.querySelector('.sb-ns-actions');
      if (!popover || !side || !actions) return null;
      const p = popover.getBoundingClientRect();
      const sd = side.getBoundingClientRect();
      const a = actions.getBoundingClientRect();
      return {
        inside: p.left >= sd.left - 0.5 && p.right <= sd.right + 0.5 && p.bottom <= a.top + 0.5,
        box: `${Math.round(p.x)},${Math.round(p.y)} ${Math.round(p.width)}×${Math.round(p.height)}`,
        options: [...popover.querySelectorAll('[data-testid="model-option"]')].map((el) => el.getAttribute('data-value')),
        efforts: popover.querySelectorAll('[data-testid="effort-option"]').length,
      };
    });
    checks.push(
      ['popover inside the side column, above the actions', pop?.inside === true, pop?.box ?? 'missing'],
      ['popover: the CLI aliases, no effort pills', JSON.stringify(pop?.options ?? null) === JSON.stringify(D42_ALIASES) && pop?.efforts === 0, JSON.stringify(pop?.options ?? null)],
    );
    await appPage.keyboard.press('Escape');
    const closed = await appPage.evaluate(() => ({
      popover: document.querySelectorAll('[data-testid="model-popover"]').length,
      modal: document.querySelectorAll('[data-testid="modal-new-session"]').length,
    }));
    checks.push(['Esc closes the popover, the modal stays', closed.popover === 0 && closed.modal === 1, JSON.stringify(closed)]);
  }
  for (const [what, ok, note] of checks) {
    if (!ok) failures.push(`${state} · D42 ${what}: ${note}`);
    rows.push(`| ${state} · D42 ${what} | addition | — | ${note.replaceAll('|', '\\|').slice(0, 60)} | ${ok ? 'ok' : 'FAIL'} | |`);
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
  const marks = await summaryMarksOf(protoPage);
  const offsets = await measureOffsets(protoPage, appPage, marks);
  const hintPath = [...SOLUTIONS, 0, 0];
  const linePath = [...SUMMARY, warning];
  const startPath = [...SIDE, 4, 1];
  const proto = await measurePanel(protoPage, { hint: hintPath, line: linePath, start: startPath });
  const app = await measurePanel(appPage, { hint: appPathOf(hintPath), line: appPathOf(linePath, marks), start: startPath, value: [...SUMMARY, 2] });
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
  await d42Additions('draft', appPage, rows, failures, { popover: true });

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
  const qaMarks = await summaryMarksOf(protoPage);
  const protoQa = await measurePanel(protoPage, qaPaths);
  const appQa = await measurePanel(appPage, Object.fromEntries(Object.entries(qa).map(([name, part]) => [name, appPathOf(part.path, qaMarks)])));
  const qaOffsets = await measureOffsets(protoPage, appPage, qaMarks);
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
  compareParts('qa', Object.fromEntries(Object.entries(qa).map(([name, part]) => [name, { ...part, shift: shiftOf(part.path, qaMarks) }])), protoQa, appQa, rows, failures, qaOffsets);

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
  await d42Additions('empty', appPage, rows, failures);

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

## D42 additions (not findings)
The Launch area's **Model row** (the toggles block's third row: title \`Model\`, description \`Starts on your last choice\`, D31's model and effort picker where the switches sit) and the summary's **\`model\` line** right after \`ultracode\` are not in the prototype. The toggles block is compared with its height less the row's share (\`height − <n>\`), the summary label and the summary with their y less it (the side keeps its height: the summary is that much shorter, \`height + <n>\`), and the summary lines after \`ultracode\` at the app's index + 1 more with their y less the added line too. The added parts are checked on their own (\`D42 …\` rows): the row has the Ultracode row's box one toggles gap below it and the toggle rows' type, the picker sits at the switches' right edge in the header actions' look on the CLI's default (the demo reports no models), the summary line is a value line; in the draft the popover opens inside the side column with the CLI's aliases and Esc closes only the popover.

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
