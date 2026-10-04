import type { Page } from '@playwright/test';
import { BOX_TOLERANCE_PX, type Box, type Part, measure, round } from './harness.ts';

/**
 * D66 (`docs/decisions.md`, `docs/accounts.md` → *Usage per account*): the
 * prototype's footer has one "Max" row; the app shows a **usage grid** in its
 * place (D17's Session / Week rows and D63's account line before it): a small
 * header (`5h`, `Week`), then one line per account, each with a mini-bar and a %
 * per window. The shell / full-pass specs compare the rows above it with the
 * prototype as before (y relative to the footer's top, which moves with the grid's
 * height) and use this module for the grid: it is **listed** next to the
 * prototype's Max row, not gated against it, and gated only on the footer's own rules:
 * - the header reads `5h`, `Week`;
 * - every line has one fixed height; label and % text styles equal to the app's RAM
 *   row (itself gated against the prototype);
 * - each bar: 4 px, the prototype Max bar's radius, track and fill colors;
 *   D23 / D46: a bar with a pace (`data-pace`) fills with SPEC status done (`on`) or
 *   status need (`ahead`) instead, and carries a 2 px `--muted-3` marker as high as
 *   the bar, inside it. The demo's Session window (the prototype's `62% · 1h48`) is
 *   about 192 minutes into its 5 hours, so it is on pace (about 64 % allowed) and green;
 * - the rhythm: the header 7 px below the RAM row (the footer's gap), each line
 *   {@link ROW_GAP_PX} below the row above it; header and lines as wide as the RAM
 *   row; the Week % ends where the RAM value ends; the bars line up across lines;
 * - the footer keeps the prototype's bottom edge and grows by exactly the grid's
 *   height less the prototype's Max row.
 */

/** The machine footer, from the shell grid (both pages). */
export const FOOTER_PATH = [0, 8] as const;

/** The usage grid in the app (`.sb-usage`): the footer's 4th child, where the prototype has its Max row. */
const USAGE_PATH = [...FOOTER_PATH, 3] as const;

/** The footer's vertical gap (SPEC shell footer: `gap: 7px`). */
const FOOTER_GAP_PX = 7;

/** D66: the grid's own row gap (shell.css `.sb-usage`). */
const ROW_GAP_PX = 6;

/** D66: a line's fixed height (shell.css `.sb-usage-line`). */
const LINE_HEIGHT_PX = 14;

/** Text styles a grid line's label and % share with the RAM row. */
const TEXT_STYLES = ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform'] as const;

/** One line of the D66 part of a report. */
export interface UsageRowCheck {
  readonly part: string;
  /** What the prototype has there (its Max row), for the listing. */
  readonly proto: string;
  readonly app: string;
  readonly result: 'ok' | 'FAIL' | 'listed';
  readonly note: string;
}

function fmt(part: Part | null | undefined): string {
  if (!part) return '—';
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= BOX_TOLERANCE_PX;
}

const bottom = (box: Box): number => box.y + box.height;
const right = (box: Box): number => box.x + box.width;

/** D23 / D46: one bar's pace as the app renders it (`data-pace`, the marker). */
interface PaceFact {
  readonly state: string | null;
  /** The marker's inline `left` (`calc(64% - 1px)`), for the report. */
  readonly markerLeft: string | null;
  readonly marker: (Box & { readonly color: string }) | null;
}

/** Per line: whether it is spent, and its two bars' paces; plus the pace token colors as the page computes them. */
async function lineFacts(appPage: Page): Promise<{ lines: { spent: boolean; cells: PaceFact[] }[]; done: string; need: string; markerColor: string }> {
  return appPage.evaluate(() => {
    const token = (name: string): string => {
      const probe = document.createElement('div');
      probe.style.background = `var(${name})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const lines = [...document.querySelectorAll<HTMLElement>('[data-testid="usage-meters"] > [data-testid="usage-line"]')].map((line) => ({
      spent: line.getAttribute('data-spent') === 'true',
      cells: [...line.querySelectorAll<HTMLElement>('.sb-usage-cell')].map((cell) => {
        const marker = cell.querySelector<HTMLElement>('.sb-meter-marker');
        const rect = marker?.getBoundingClientRect();
        return {
          state: cell.getAttribute('data-pace'),
          markerLeft: marker?.style.left ?? null,
          marker: marker && rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: getComputedStyle(marker).backgroundColor } : null,
        };
      }),
    }));
    return { lines, done: token('--status-done'), need: token('--status-need'), markerColor: token('--muted-3') };
  });
}

/**
 * Measures both footers and returns the D66 lines: `listed` (the grid next to the
 * prototype's Max row) and gated (`ok` / `FAIL`, their failures also in
 * `failures`, prefixed with `label`).
 */
export async function usageRowChecks(protoPage: Page, appPage: Page, label: string): Promise<{ checks: UsageRowCheck[]; failures: string[] }> {
  const facts = await lineFacts(appPage);
  const count = facts.lines.length;
  const proto = await measure(protoPage, {
    footer: FOOTER_PATH,
    max: [...FOOTER_PATH, 3],
    maxLabel: [...FOOTER_PATH, 3, 0],
    maxTrack: [...FOOTER_PATH, 3, 1],
    maxFill: [...FOOTER_PATH, 3, 1, 0],
    maxValue: [...FOOTER_PATH, 3, 2],
  });
  const appPaths: Record<string, readonly number[]> = {
    footer: FOOTER_PATH,
    ram: [...FOOTER_PATH, 2],
    ramLabel: [...FOOTER_PATH, 2, 0],
    ramTrack: [...FOOTER_PATH, 2, 1],
    ramValue: [...FOOTER_PATH, 2, 2],
    grid: USAGE_PATH,
    head: [...USAGE_PATH, 0],
    head5h: [...USAGE_PATH, 0, 0],
    headWeek: [...USAGE_PATH, 0, 1],
  };
  for (let i = 0; i < count; i++) {
    const line = [...USAGE_PATH, i + 1];
    appPaths[`line${i}`] = line;
    appPaths[`line${i}:label`] = [...line, 1];
    for (const [c, window] of ['session', 'week'].entries()) {
      appPaths[`line${i}:${window}:track`] = [...line, 2 + c, 0];
      appPaths[`line${i}:${window}:fill`] = [...line, 2 + c, 0, 0];
      appPaths[`line${i}:${window}:pct`] = [...line, 2 + c, 1];
    }
  }
  const app = await measure(appPage, appPaths);
  const checks: UsageRowCheck[] = [];
  const failures: string[] = [];
  const gate = (part: string, issues: string[], protoText: string, appText: string, ok: string): void => {
    checks.push({ part, proto: protoText, app: appText, result: issues.length ? 'FAIL' : 'ok', note: issues.join('; ') || ok });
    failures.push(...issues.map((issue) => `${label} · ${part}: ${issue}`));
  };

  // Listed: the grid's header and every line next to the prototype's one Max row (D66, not compared with it).
  checks.push({
    part: 'usage:header',
    proto: `Max row ${fmt(proto['max'])} ${JSON.stringify(proto['max']?.text ?? '')}`,
    app: `${fmt(app['head'])} ${JSON.stringify(`${app['head5h']?.text ?? ''} ${app['headWeek']?.text ?? ''}`)}`,
    result: 'listed',
    note: 'D66 addition: the grid header',
  });
  for (let i = 0; i < count; i++) {
    checks.push({
      part: `usage:${app[`line${i}:label`]?.text || i}`,
      proto: '— (none)',
      app: `${fmt(app[`line${i}`])} ${JSON.stringify(app[`line${i}`]?.text ?? '')}`,
      result: 'listed',
      note: `D66 addition: label ${fmt(app[`line${i}:label`])}, 5h bar ${fmt(app[`line${i}:session:track`])}, Week bar ${fmt(app[`line${i}:week:track`])}`,
    });
  }

  // Gated on the footer's own rules.
  const ram = app['ram'];
  const head = app['head'];
  const maxRow = proto['max'];
  const maxTrack = proto['maxTrack'];
  const maxFill = proto['maxFill'];
  const headIssues = `${app['head5h']?.text ?? ''},${app['headWeek']?.text ?? ''}` === '5h,Week' ? [] : [`header ${JSON.stringify([app['head5h']?.text, app['headWeek']?.text])}, expected 5h, Week`];
  if (ram && head && (!near(head.box.y - bottom(ram.box), FOOTER_GAP_PX) || !near(head.box.x, ram.box.x) || !near(head.box.width, ram.box.width))) {
    headIssues.push(`header ${fmt(head)}: expected ${FOOTER_GAP_PX} px below the RAM row and its x / width ${round(ram.box.x)}/${round(ram.box.width)}`);
  }
  gate('usage:header', headIssues, '"Max"', fmt(head), `5h, Week; ${FOOTER_GAP_PX} px below the RAM row, its x / width`);
  if (!ram || !head || !maxRow || !maxTrack || !maxFill || count === 0) {
    gate('usage:measure', ['footer rows missing'], fmt(maxRow), fmt(ram), '');
    return { checks, failures };
  }
  let above: Box = head.box;
  const barLefts: Record<string, number[]> = { session: [], week: [] };
  for (let i = 0; i < count; i++) {
    const line = app[`line${i}`];
    const lineLabel = app[`line${i}:label`];
    const name = `usage:${lineLabel?.text || i}`;
    const fact = facts.lines[i];
    if (!line || !lineLabel || !fact) {
      gate(`${name}:parts`, ['line parts missing'], '', '', '');
      continue;
    }
    const issues: string[] = [];
    if (!near(line.box.height, LINE_HEIGHT_PX)) issues.push(`line height ${round(line.box.height)} vs ${LINE_HEIGHT_PX}`);
    if (!near(line.box.y - bottom(above), ROW_GAP_PX)) issues.push(`gap above ${round(line.box.y - bottom(above))} vs ${ROW_GAP_PX}`);
    if (!near(line.box.x, ram.box.x) || !near(line.box.width, ram.box.width)) issues.push(`line x/width ${round(line.box.x)}/${round(line.box.width)} vs RAM ${round(ram.box.x)}/${round(ram.box.width)}`);
    for (const prop of TEXT_STYLES) {
      if (lineLabel.style[prop] !== app['ramLabel']?.style[prop]) issues.push(`label.${prop} ${lineLabel.style[prop]} vs RAM ${app['ramLabel']?.style[prop]}`);
    }
    const notes: string[] = [];
    if (!fact.spent) {
      for (const [c, window] of (['session', 'week'] as const).entries()) {
        const track = app[`line${i}:${window}:track`];
        const fill = app[`line${i}:${window}:fill`];
        const pct = app[`line${i}:${window}:pct`];
        if (!track || !fill || !pct) {
          issues.push(`${window} parts missing`);
          continue;
        }
        barLefts[window]?.push(track.box.x);
        for (const prop of TEXT_STYLES) {
          if (pct.style[prop] !== app['ramValue']?.style[prop]) issues.push(`${window} %.${prop} ${pct.style[prop]} vs RAM ${app['ramValue']?.style[prop]}`);
        }
        if (!near(track.box.height, maxTrack.box.height)) issues.push(`${window} bar height ${round(track.box.height)} vs ${round(maxTrack.box.height)}`);
        if (track.style['border-radius'] !== maxTrack.style['border-radius']) issues.push(`${window} bar radius ${track.style['border-radius']} vs ${maxTrack.style['border-radius']}`);
        if (track.style['background-color'] !== maxTrack.style['background-color']) issues.push(`${window} track ${track.style['background-color']} vs ${maxTrack.style['background-color']}`);
        const pace = fact.cells[c];
        const wantFill = pace?.state === 'on' ? facts.done : pace?.state === 'ahead' ? facts.need : maxFill.style['background-color'];
        const fillRule = pace?.state ? `the ${pace.state === 'on' ? 'status done' : 'status need'} color (D23 / D46 pace ${pace.state})` : "the prototype Max bar's";
        if (fill.style['background-color'] !== wantFill) issues.push(`${window} fill ${fill.style['background-color']} vs ${wantFill}, ${fillRule}`);
        if (pace?.state) {
          const marker = pace.marker;
          if (!marker) issues.push(`${window} pace marker missing`);
          else {
            if (!near(marker.width, 2) || !near(marker.height, track.box.height)) issues.push(`${window} pace marker ${round(marker.width)}×${round(marker.height)} vs 2×${round(track.box.height)}`);
            if (marker.x < track.box.x - 1 || right(marker) > right(track.box) + 1) issues.push(`${window} pace marker x ${round(marker.x)} outside the bar ${round(track.box.x)}–${round(right(track.box))}`);
            if (marker.color !== facts.markerColor) issues.push(`${window} pace marker ${marker.color} vs --muted-3 ${facts.markerColor}`);
          }
          notes.push(`${window} pace ${pace.state}, marker at ${pace.markerLeft}`);
        } else if (pace?.marker) issues.push(`${window}: a marker without a pace`);
        const ramValue = app['ramValue'];
        if (window === 'week' && ramValue && !near(right(pct.box), right(ramValue.box))) issues.push(`Week % right edge ${round(right(pct.box))} vs RAM value ${round(right(ramValue.box))}`);
      }
    }
    gate(
      `${name}:style`,
      issues,
      `Max bar ${round(maxTrack.box.height)} px ${maxFill.style['background-color']}`,
      fmt(line),
      `${LINE_HEIGHT_PX} px line, ${ROW_GAP_PX} px below the row above; text styles = RAM row; bars ${round(maxTrack.box.height)} px, the Max bar's radius / track / fill${notes.length ? ` (${notes.join('; ')})` : ''}; Week % right edge = RAM value's`,
    );
    above = line.box;
  }
  const misaligned = Object.entries(barLefts).filter(([, lefts]) => lefts.some((x) => !near(x, lefts[0] ?? x)));
  gate('usage:columns', misaligned.map(([window]) => `${window} bars do not line up across lines`), '—', `${count} line(s)`, 'each window\'s bars line up across lines');
  const protoFooter = proto['footer'];
  const appFooter = app['footer'];
  const grid = app['grid'];
  if (protoFooter && appFooter && grid) {
    const issues: string[] = [];
    if (!near(bottom(appFooter.box), bottom(protoFooter.box))) issues.push(`bottom ${round(bottom(appFooter.box))} vs prototype ${round(bottom(protoFooter.box))}`);
    const grown = appFooter.box.height - protoFooter.box.height;
    const expected = grid.box.height - maxRow.box.height;
    if (!near(grown, expected)) issues.push(`grew by ${round(grown)} px, the grid takes ${round(expected)} px more than the Max row`);
    gate('usage:footer', issues, fmt(protoFooter), fmt(appFooter), `bottom edge kept; ${round(grown)} px taller = the grid (${round(grid.box.height)} px) less the Max row (${round(maxRow.box.height)} px)`);
  }
  return { checks, failures };
}
