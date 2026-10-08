import { useLayoutEffect, useState } from 'react';
import { type HeaderOverflow, NO_OVERFLOW, type OverflowKey, headerOverflow } from './header-overflow.ts';

const MATCHERS: ReadonlyArray<readonly [OverflowKey, string]> = [
  ['cli', '[data-testid="session-cli"]'],
  ['account', '[data-testid="session-account"]'],
  ['model', '[data-testid="session-model"]'],
  ['close', '[data-testid="session-close"]'],
  ['remote', '[data-testid="session-remote"]'],
  ['takeover', '[data-testid="session-takeover"]'],
  ['pause', '[data-testid="session-pause"]'],
  ['handoff', '[data-testid="session-handoff"]'],
];

/** The overflowable action an element of the actions row (or the ⋯ menu) is. */
function keyOf(element: Element): OverflowKey | null {
  for (const [key, selector] of MATCHERS) if (element.matches(selector) || element.querySelector(`:scope > ${selector}`)) return key;
  return null;
}

function same(a: HeaderOverflow, b: HeaderOverflow): boolean {
  return a.short === b.short && a.hidden.length === b.hidden.length && a.hidden.every((key, index) => key === b.hidden[index]);
}

/**
 * Measures the header's top row (`top`), its actions row (`actions`) and the ⋯ menu
 * (`menu`) after every render and on every size change, and answers how the actions
 * render. `enabled` = false (D74's compact ⋯ menu below 1024 px) answers {@link NO_OVERFLOW}.
 */
export function useHeaderOverflow(
  enabled: boolean,
  refs: { readonly top: React.RefObject<HTMLElement | null>; readonly actions: React.RefObject<HTMLElement | null>; readonly menu: React.RefObject<HTMLElement | null> },
): HeaderOverflow {
  const [state, setState] = useState<HeaderOverflow>(NO_OVERFLOW);
  const [tick, setTick] = useState(0);
  const [memory] = useState(() => ({ widths: {} as Partial<Record<OverflowKey, number>>, shortWidths: {} as Partial<Record<OverflowKey, number>> }));

  useLayoutEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setTick((n) => n + 1));
    // The actions row keeps its natural width (`flex: none`): a label that changes (the model picker) or an action
    // that comes or goes changes its size too.
    for (const element of [refs.top.current, refs.actions.current]) if (element) observer.observe(element);
    // An action that renders itself (the take-over once the paired machines are read) or changes its label.
    const mutations = new MutationObserver(() => setTick((n) => n + 1));
    if (refs.actions.current) mutations.observe(refs.actions.current, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [enabled, refs.top, refs.actions]);

  useLayoutEffect(() => {
    if (!enabled) {
      if (state !== NO_OVERFLOW) setState(NO_OVERFLOW);
      return;
    }
    const top = refs.top.current;
    const actions = refs.actions.current;
    if (!top || !actions) return;
    const present: OverflowKey[] = [];
    for (const child of actions.children) {
      const key = keyOf(child);
      if (!key) continue;
      present.push(key);
      const width = child.getBoundingClientRect().width;
      if (key === 'takeover' && state.short) memory.shortWidths[key] = width;
      else memory.widths[key] = width;
    }
    for (const child of refs.menu.current?.children ?? []) {
      const key = keyOf(child);
      if (key) present.push(key);
    }
    const gap = Number.parseFloat(getComputedStyle(top).columnGap) || 0;
    const actionsGap = Number.parseFloat(getComputedStyle(actions).columnGap) || 0;
    // Everything in the top row but the root path (it gives way), the actions and the ⋯ holder.
    let others = 0;
    let count = 0;
    for (const child of top.children) {
      if (child === actions || child.classList.contains('sb-sv-root') || child.classList.contains('sb-sv-overflow-holder')) continue;
      others += child.getBoundingClientRect().width;
      count += 1;
    }
    // The gaps: between the others, the root path and the actions.
    const available = top.clientWidth - others - gap * (count + 1);
    const next = headerOverflow({ available, gap: actionsGap, moreWidth: 30, present, widths: memory.widths, shortWidths: memory.shortWidths });
    if (!same(next, state)) setState(next);
  }, [enabled, tick, state, memory, refs]);

  return enabled ? state : NO_OVERFLOW;
}
