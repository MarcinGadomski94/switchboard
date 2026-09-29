import type { Page } from '@playwright/test';
import { OTHER_LABEL } from '../../../src/web/components/question-card.ts';
import { BOX_TOLERANCE_PX, type Box, round } from './harness.ts';

/**
 * D39 (`docs/decisions.md` → *Own answers*): every question card ends each
 * question's options with an **Other…** pill, which the prototype does not have.
 * The Inbox and Chat visual specs keep comparing the prototype's parts at their
 * boxes (the pill is the options row's last child, on the options' line, so no box
 * moves); the one copy difference, a question's (or its options row's) text ending
 * in "Other…", is forgiven by {@link sameCopyBesidesOther}, and the pill is checked
 * on its own here, the way D18 checked its added Name row:
 * - it is the options row's last child, right after the prototype's options (same count);
 * - its copy is "Other…";
 * - it sits on the options' line (same top), one row gap after the last option, as
 *   high as the options, inside the row;
 * - it looks like an option: the same computed styles as an unpicked option pill.
 */

/** Styles an Other… pill shares with an unpicked option pill. */
const PILL_STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'border-radius',
  'border-top-color',
  'border-top-width',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const;

/**
 * `true` when the app's text is the prototype's plus the D39 pill at its end
 * (a question's or its options row's text: the pill is their last text).
 */
export function sameCopyBesidesOther(prototype: string, app: string): boolean {
  return app === `${prototype}${OTHER_LABEL}`;
}

/** One line of the D39 part of a report. */
export interface OtherPillCheck {
  readonly part: string;
  readonly ok: boolean;
  readonly note: string;
}

interface PillFacts {
  readonly count: number;
  readonly otherTestId: string | null;
  readonly otherText: string;
  readonly other: Box | null;
  readonly first: Box | null;
  readonly last: Box | null;
  readonly row: Box | null;
  readonly gap: number;
  readonly otherStyle: Record<string, string>;
  readonly optionStyle: Record<string, string> | null;
}

/** The options row at `rowPath` (from the shell grid) on `page`: its children and the facts the checks read. */
async function pillFacts(page: Page, rowPath: readonly number[]): Promise<PillFacts | null> {
  return page.evaluate(
    ({ wanted, props }) => {
      const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
      });
      let row: Element | undefined = grid;
      for (const index of wanted) row = row?.children[index];
      if (!row) return null;
      const box = (el: Element | undefined) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const styleOf = (el: Element) => {
        const computed = getComputedStyle(el);
        return Object.fromEntries(props.map((prop) => [prop, computed.getPropertyValue(prop)]));
      };
      const children = [...row.children];
      const other = children.at(-1);
      const options = children.slice(0, -1);
      const unpicked = [...options].reverse().find((el) => el.getAttribute('data-selected') !== 'true');
      return {
        count: options.length,
        otherTestId: other?.getAttribute('data-testid') ?? null,
        otherText: (other?.textContent ?? '').trim(),
        other: box(other),
        first: box(options[0]),
        last: box(options.at(-1)),
        row: box(row),
        gap: Number.parseFloat(getComputedStyle(row).columnGap) || 0,
        otherStyle: other ? styleOf(other) : {},
        optionStyle: unpicked ? styleOf(unpicked) : null,
      };
    },
    { wanted: [...rowPath], props: [...PILL_STYLES] },
  );
}

/** The number of children of the element at `path` on the prototype (its options). */
async function childCount(page: Page, path: readonly number[]): Promise<number | null> {
  return page.evaluate((wanted) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const index of wanted) el = el?.children[index];
    return el ? el.children.length : null;
  }, [...path]);
}

function fmt(box: Box | null): string {
  return box ? `${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}` : 'missing';
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= BOX_TOLERANCE_PX;

/**
 * Checks the Other… pill of each options row in `rows` (`name` → the row's path
 * from the shell grid, the same on both pages) against the app's own options and
 * the prototype's option count. Failures are also pushed to `failures`, prefixed
 * with `label`.
 */
export async function checkOtherPills(
  protoPage: Page,
  appPage: Page,
  label: string,
  rows: Readonly<Record<string, readonly number[]>>,
  failures: string[],
): Promise<OtherPillCheck[]> {
  const out: OtherPillCheck[] = [];
  for (const [name, rowPath] of Object.entries(rows)) {
    const facts = await pillFacts(appPage, rowPath);
    const protoCount = await childCount(protoPage, rowPath);
    const checks: Array<[string, boolean, string]> = [];
    if (!facts || !facts.other) {
      checks.push(['Other… pill', false, 'missing']);
    } else {
      const { other, first, last, row } = facts;
      checks.push([
        'Other… is the last pill, after the prototype\'s options',
        facts.otherTestId === 'question-other' && facts.count === protoCount,
        `${facts.count} options + Other… (prototype ${protoCount ?? 'missing'} options)`,
      ]);
      checks.push(['copy', facts.otherText === OTHER_LABEL, JSON.stringify(facts.otherText)]);
      checks.push(['on the options\' line', !!first && near(other.y, first.y), `${fmt(other)} · first option ${fmt(first)}`]);
      checks.push([
        'one row gap after the last option',
        !!last && near(other.x, last.x + last.width + facts.gap),
        `x ${round(other.x)} · last option ends ${last ? round(last.x + last.width) : '—'} + gap ${facts.gap}`,
      ]);
      checks.push(['as high as the options', !!last && near(other.height, last.height), `${round(other.height)} · option ${last ? round(last.height) : '—'}`]);
      checks.push(['inside the row', !!row && other.x + other.width <= row.x + row.width + BOX_TOLERANCE_PX, `ends ${round(other.x + other.width)} · row ends ${row ? round(row.x + row.width) : '—'}`]);
      const differences = facts.optionStyle
        ? PILL_STYLES.filter((prop) => facts.otherStyle[prop] !== facts.optionStyle?.[prop]).map((prop) => `${prop} ${facts.otherStyle[prop]} vs ${facts.optionStyle?.[prop]}`)
        : ['no unpicked option to compare'];
      checks.push(['styled like an unpicked option', differences.length === 0, differences.length ? differences.join('; ') : PILL_STYLES.join(', ')]);
    }
    for (const [what, ok, note] of checks) {
      if (!ok) failures.push(`${label} ${name} · D39 ${what}: ${note}`);
      out.push({ part: `${name} · D39 ${what}`, ok, note });
    }
  }
  return out;
}
