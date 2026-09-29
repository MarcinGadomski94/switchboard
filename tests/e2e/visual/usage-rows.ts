import type { Page } from '@playwright/test';
import { BOX_TOLERANCE_PX, type Box, type Part, measure, round } from './harness.ts';

/**
 * D17 (`docs/decisions.md`, `docs/usage.md` → *Footer*): the prototype's footer has
 * one "Max" row; the app shows **Session** and **Week** rows (plus a model row
 * while one is in use) in its place. The shell / full-pass specs compare the rows
 * above them with the prototype as before (y relative to the footer's top, which
 * moves up by the added rows) and use this module for the new rows: they are
 * **listed** next to the prototype's Max row, not gated against it, and gated only
 * on the footer's own rules:
 * - labels: `Session`, `Week` first;
 * - text styles equal to the app's RAM row (itself gated against the prototype);
 * - the bar: 4 px, the prototype Max bar's radius, track and fill colors;
 *   D23 / D46: a row with a pace (`data-pace`: the Week, the Session) fills its bar
 *   with SPEC status done (`on`) or status need (`ahead`) instead, and carries a
 *   2 px `--muted-3` marker as high as the bar, inside it. The demo's Session
 *   window (the prototype's `62% · 1h48`) is about 192 minutes into its 5 hours,
 *   so it is on pace (about 64 % allowed) and green;
 * - the rhythm: each row as high as the prototype's Max row, 7 px below the row
 *   above it, the rows' x / width and the bars' and values' right edges equal to
 *   the RAM row's;
 * - the footer keeps the prototype's bottom edge and grows by exactly the added rows.
 */

/** The machine footer, from the shell grid (both pages). */
export const FOOTER_PATH = [0, 8] as const;

/** The usage rows' container in the app (`.sb-usage`): the footer's 4th child, where the prototype has its Max row. */
const USAGE_PATH = [...FOOTER_PATH, 3] as const;

/** The footer's vertical gap (SPEC shell footer: `gap: 7px`). */
const ROW_GAP_PX = 7;

/** Text styles a usage row shares with the RAM row. */
const TEXT_STYLES = ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform'] as const;

/** One line of the D17 part of a report. */
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

/** D23 / D46: one usage row's pace as the app renders it (`data-pace`, `title`, the marker). */
interface PaceFact {
  readonly state: string | null;
  readonly title: string | null;
  /** The marker's inline `left` (`calc(64% - 1px)`), for the report. */
  readonly markerLeft: string | null;
  readonly marker: (Box & { readonly color: string }) | null;
}

/** The app's usage rows' paces, in row order, and the pace token colors as the page computes them. */
async function paceFacts(appPage: Page): Promise<{ rows: PaceFact[]; done: string; need: string; markerColor: string }> {
  return appPage.evaluate(() => {
    const token = (name: string): string => {
      const probe = document.createElement('div');
      probe.style.background = `var(${name})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="usage-meters"] > .sb-meter')].map((row) => {
      const marker = row.querySelector<HTMLElement>('.sb-meter-marker');
      const rect = marker?.getBoundingClientRect();
      return {
        state: row.getAttribute('data-pace'),
        title: row.getAttribute('title'),
        markerLeft: marker?.style.left ?? null,
        marker: marker && rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: getComputedStyle(marker).backgroundColor } : null,
      };
    });
    return { rows, done: token('--status-done'), need: token('--status-need'), markerColor: token('--muted-3') };
  });
}

/**
 * Measures both footers and returns the D17 lines: `listed` (the new rows next to
 * the prototype's Max row) and gated (`ok` / `FAIL`, their failures also in
 * `failures`, prefixed with `label`).
 */
export async function usageRowChecks(protoPage: Page, appPage: Page, label: string): Promise<{ checks: UsageRowCheck[]; failures: string[] }> {
  const count = await appPage.locator('[data-testid="usage-meters"] > .sb-meter').count();
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
  };
  for (let i = 0; i < count; i++) {
    appPaths[`row${i}`] = [...USAGE_PATH, i];
    appPaths[`row${i}:label`] = [...USAGE_PATH, i, 0];
    appPaths[`row${i}:track`] = [...USAGE_PATH, i, 1];
    appPaths[`row${i}:fill`] = [...USAGE_PATH, i, 1, 0];
    appPaths[`row${i}:value`] = [...USAGE_PATH, i, 2];
  }
  const app = await measure(appPage, appPaths);
  const paces = await paceFacts(appPage);
  const checks: UsageRowCheck[] = [];
  const failures: string[] = [];
  const gate = (part: string, issues: string[], protoText: string, appText: string, ok: string): void => {
    checks.push({ part, proto: protoText, app: appText, result: issues.length ? 'FAIL' : 'ok', note: issues.join('; ') || ok });
    failures.push(...issues.map((issue) => `${label} · ${part}: ${issue}`));
  };

  // Listed: every usage row next to the prototype's one Max row (D17 addition, not compared with it).
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = app[`row${i}`];
    const rowLabel = app[`row${i}:label`]?.text ?? '';
    labels.push(rowLabel);
    checks.push({
      part: `usage:${rowLabel || i}`,
      proto: i === 0 ? `Max row ${fmt(proto['max'])} ${JSON.stringify(proto['max']?.text ?? '')}` : '— (none)',
      app: `${fmt(row)} ${JSON.stringify(`${rowLabel} ${app[`row${i}:value`]?.text ?? ''}`)}`,
      result: 'listed',
      note: `D17 addition: label ${fmt(app[`row${i}:label`])}, bar ${fmt(app[`row${i}:track`])}, value ${fmt(app[`row${i}:value`])}`,
    });
  }

  // Gated on the footer's own rules.
  const ram = app['ram'];
  const maxRow = proto['max'];
  const maxTrack = proto['maxTrack'];
  const maxFill = proto['maxFill'];
  const labelIssues = labels.slice(0, 2).join(',') === 'Session,Week' ? [] : [`labels ${JSON.stringify(labels)}, expected Session, Week first`];
  gate('usage:labels', labelIssues, '"Max"', JSON.stringify(labels), 'Session, Week first (D17)');
  if (!ram || !maxRow || !maxTrack || !maxFill || count === 0) {
    gate('usage:measure', ['footer rows missing'], fmt(maxRow), fmt(ram), '');
    return { checks, failures };
  }
  let above: Box = ram.box;
  let added = 0;
  for (let i = 0; i < count; i++) {
    const row = app[`row${i}`];
    const rowLabel = app[`row${i}:label`];
    const track = app[`row${i}:track`];
    const fill = app[`row${i}:fill`];
    const value = app[`row${i}:value`];
    const name = `usage:${rowLabel?.text || i}`;
    if (!row || !rowLabel || !track || !fill || !value) {
      gate(`${name}:parts`, ['row parts missing'], '', '', '');
      continue;
    }
    const issues: string[] = [];
    for (const [part, own] of [
      ['label', rowLabel],
      ['value', value],
    ] as const) {
      const reference = part === 'label' ? app['ramLabel'] : app['ramValue'];
      for (const prop of TEXT_STYLES) {
        if (own.style[prop] !== reference?.style[prop]) issues.push(`${part}.${prop} ${own.style[prop]} vs RAM ${reference?.style[prop]}`);
      }
    }
    if (!near(track.box.height, maxTrack.box.height)) issues.push(`bar height ${round(track.box.height)} vs ${round(maxTrack.box.height)}`);
    if (track.style['border-radius'] !== maxTrack.style['border-radius']) issues.push(`bar radius ${track.style['border-radius']} vs ${maxTrack.style['border-radius']}`);
    if (track.style['background-color'] !== maxTrack.style['background-color']) issues.push(`track ${track.style['background-color']} vs ${maxTrack.style['background-color']}`);
    const pace = paces.rows[i];
    const wantFill = pace?.state === 'on' ? paces.done : pace?.state === 'ahead' ? paces.need : maxFill.style['background-color'];
    const fillRule = pace?.state ? `the ${pace.state === 'on' ? 'status done' : 'status need'} color (D23 / D46 pace ${pace.state})` : "the prototype Max bar's";
    if (fill.style['background-color'] !== wantFill) issues.push(`fill ${fill.style['background-color']} vs ${wantFill}, ${fillRule}`);
    if (pace?.state) {
      const marker = pace.marker;
      if (!marker) issues.push('pace marker missing');
      else {
        if (!near(marker.width, 2) || !near(marker.height, track.box.height)) issues.push(`pace marker ${round(marker.width)}×${round(marker.height)} vs 2×${round(track.box.height)}`);
        if (marker.x < track.box.x - 1 || right(marker) > right(track.box) + 1) issues.push(`pace marker x ${round(marker.x)} outside the bar ${round(track.box.x)}–${round(right(track.box))}`);
        if (marker.color !== paces.markerColor) issues.push(`pace marker ${marker.color} vs --muted-3 ${paces.markerColor}`);
      }
    } else if (pace?.marker) issues.push('a marker without a pace');
    if (!near(row.box.height, maxRow.box.height)) issues.push(`row height ${round(row.box.height)} vs the Max row's ${round(maxRow.box.height)}`);
    if (!near(row.box.y - bottom(above), ROW_GAP_PX)) issues.push(`gap above ${round(row.box.y - bottom(above))} vs ${ROW_GAP_PX}`);
    if (!near(row.box.x, ram.box.x) || !near(row.box.width, ram.box.width)) issues.push(`row x/width ${round(row.box.x)}/${round(row.box.width)} vs RAM ${round(ram.box.x)}/${round(ram.box.width)}`);
    const ramTrack = app['ramTrack'];
    const ramValue = app['ramValue'];
    if (ramTrack && !near(right(track.box), right(ramTrack.box))) issues.push(`bar right edge ${round(right(track.box))} vs RAM ${round(right(ramTrack.box))}`);
    if (ramValue && !near(right(value.box), right(ramValue.box))) issues.push(`value right edge ${round(right(value.box))} vs RAM ${round(right(ramValue.box))}`);
    gate(
      `${name}:style`,
      issues,
      `Max bar ${round(maxTrack.box.height)} px ${maxFill.style['background-color']}`,
      `${fmt(row)}, bar ${fmt(track)}`,
      `text styles = RAM row; bar ${round(track.box.height)} px, radius ${track.style['border-radius']}, track ${track.style['background-color']}, fill ${fill.style['background-color']}${pace?.state ? ` (pace ${pace.state}, marker at ${pace.markerLeft}: ${JSON.stringify(pace.title)})` : ''}; ${ROW_GAP_PX} px below the row above; x / width and right edges = RAM row`,
    );
    if (i > 0) added += row.box.height + ROW_GAP_PX;
    above = row.box;
  }
  const protoFooter = proto['footer'];
  const appFooter = app['footer'];
  if (protoFooter && appFooter) {
    const issues: string[] = [];
    if (!near(bottom(appFooter.box), bottom(protoFooter.box))) issues.push(`bottom ${round(bottom(appFooter.box))} vs prototype ${round(bottom(protoFooter.box))}`);
    const grown = appFooter.box.height - protoFooter.box.height;
    if (!near(grown, added)) issues.push(`grew by ${round(grown)} px, the added rows take ${round(added)} px`);
    gate('usage:footer', issues, fmt(protoFooter), fmt(appFooter), `bottom edge kept; ${round(grown)} px taller = the ${count - 1} added row(s) + ${ROW_GAP_PX} px gaps`);
  }
  return { checks, failures };
}
