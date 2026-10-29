import type { Page } from '@playwright/test';

/**
 * Composer typing probe (`docs/performance.md` → *Typing in a long chat*): what one
 * keystroke costs in a page, read from inside the page, for the perf spec
 * (`tests/e2e/typing-perf.spec.ts`) and the harness (`tools/bench/typing.ts`).
 *
 * - **Keystroke → next frame** per `keydown` (window, capture phase): from the
 *   event's `timeStamp` to the task after the next animation frame (a
 *   `MessageChannel` message posted from `requestAnimationFrame`, so the frame's
 *   style, layout and paint are inside it).
 * - **Event Timing** entries (`PerformanceObserver` `event`, `durationThreshold` 16)
 *   of the key and input events: duration (input delay + handlers + until the next
 *   paint), per interaction.
 * - **React commits** through a stub of React's DevTools hook (it works on the
 *   production build): commits, components rendered in total, components rendered
 *   whose DOM lies inside the conversation (`chatSelector`), and the names of the
 *   components rendered (to find what renders).
 *
 * Install with {@link installTypingProbe} before the app loads; {@link armTypingProbe}
 * resets the counters and starts recording; {@link readTypingProbe} answers them.
 */

/** What the probe recorded since it was armed. */
export interface TypingProbeReading {
  /** keydown → the task after the next frame, ms, one per key. */
  readonly latencies: readonly number[];
  /** Event Timing: the longest duration per interaction (keydown / keypress / input / keyup), ms. */
  readonly eventDurations: readonly number[];
  readonly commits: number;
  /** Commits that rendered a component inside the conversation. */
  readonly chatCommits: number;
  /** The first 20 such commits: when, how many, the first components in the chat and overall. */
  readonly chatLog: readonly string[];
  readonly rendered: number;
  readonly renderedInChat: number;
  /** Component name → times rendered (top 25). */
  readonly byName: Readonly<Record<string, number>>;
  /** Component name → times rendered inside the conversation (top 25). */
  readonly inChatByName: Readonly<Record<string, number>>;
}

interface ProbeState {
  armed: boolean;
  chatSelector: string;
  latencies: number[];
  events: Map<number, number>;
  commits: number;
  chatCommits: number;
  chatLog: string[];
  rendered: number;
  renderedInChat: number;
  byName: Map<string, number>;
  inChatByName: Map<string, number>;
}

/** Installs the probe (before the page's scripts run: an init script). */
export async function installTypingProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Fiber = { tag: number; flags: number; type: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; stateNode: unknown };
    const state: ProbeStateInPage = { armed: false, chatSelector: '', latencies: [], events: new Map(), commits: 0, chatCommits: 0, chatLog: [], rendered: 0, renderedInChat: 0, byName: new Map(), inChatByName: new Map() };
    type ProbeStateInPage = {
      armed: boolean;
      chatSelector: string;
      latencies: number[];
      events: Map<number, number>;
      commits: number;
      chatCommits: number;
      chatLog: string[];
      rendered: number;
      renderedInChat: number;
      byName: Map<string, number>;
      inChatByName: Map<string, number>;
    };
    (window as unknown as { __sbTyping: ProbeStateInPage }).__sbTyping = state;

    window.addEventListener(
      'keydown',
      (event) => {
        if (!state.armed) return;
        const start = event.timeStamp;
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            if (state.armed) state.latencies.push(performance.now() - start);
          };
          channel.port2.postMessage(0);
        });
      },
      true,
    );
    try {
      new PerformanceObserver((list) => {
        if (!state.armed) return;
        for (const entry of list.getEntries() as Array<PerformanceEntry & { interactionId?: number }>) {
          if (!/^key|^input|^beforeinput/.test(entry.name)) continue;
          const id = entry.interactionId && entry.interactionId > 0 ? entry.interactionId : -Math.round(entry.startTime * 1000);
          state.events.set(id, Math.max(state.events.get(id) ?? 0, entry.duration));
        }
      }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
    } catch {
      // No Event Timing: the frame latencies still count.
    }

    const nameOf = (fiber: Fiber): string => {
      const type = fiber.type as { displayName?: string; name?: string; type?: { name?: string; displayName?: string }; render?: { name?: string } } | null;
      if (!type || typeof type === 'string') return '?';
      return type.displayName ?? type.name ?? type.type?.displayName ?? type.type?.name ?? type.render?.name ?? '?';
    };
    const hostNode = (fiber: Fiber): Node | null => {
      for (let f: Fiber | null = fiber; f; f = f.child) if (f.tag === 5 || f.tag === 6) return f.stateNode as Node;
      return null;
    };
    // Function, class, forwardRef, memo and simple-memo components; PerformedWork = 1.
    const COMPONENT = new Set([0, 1, 11, 14, 15]);
    const bump = (map: Map<string, number>, key: string): void => {
      map.set(key, (map.get(key) ?? 0) + 1);
    };
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
        if (!state.armed) return;
        state.commits += 1;
        const before = state.renderedInChat;
        const names: string[] = [];
        const all: string[] = [];
        const chat = state.chatSelector ? document.querySelector(state.chatSelector) : null;
        const walk = (first: Fiber | null): void => {
          for (let f = first; f; f = f.sibling) {
            const mounted = f.alternate === null;
            if (COMPONENT.has(f.tag) && (mounted || (f.flags & 1) === 1)) {
              state.rendered += 1;
              const name = nameOf(f);
              bump(state.byName, name);
              if (all.length < 12) all.push(name);
              const node = hostNode(f);
              if (chat && node && chat.contains(node)) {
                state.renderedInChat += 1;
                bump(state.inChatByName, name);
                if (names.length < 6) names.push(name);
              }
            }
            // A subtree whose child list is the previous commit's bailed out: nothing in it rendered.
            if (mounted || f.child !== f.alternate?.child) walk(f.child);
          }
        };
        walk(root.current.child);
        if (state.renderedInChat > before) {
          state.chatCommits += 1;
          if (state.chatLog.length < 20) state.chatLog.push(`${Math.round(performance.now())}ms ${state.renderedInChat - before} in chat (${names.join(',')}) under ${all.join(',')}`);
        }
      },
    };
  });
}

/** Resets the counters and starts recording; `chatSelector` = the conversation's element. */
export async function armTypingProbe(page: Page, chatSelector: string): Promise<void> {
  await page.evaluate((selector) => {
    const state = (window as unknown as { __sbTyping: ProbeState }).__sbTyping;
    state.chatSelector = selector;
    state.latencies = [];
    state.events = new Map();
    state.commits = 0;
    state.chatCommits = 0;
    state.chatLog = [];
    state.rendered = 0;
    state.renderedInChat = 0;
    state.byName = new Map();
    state.inChatByName = new Map();
    state.armed = true;
  }, chatSelector);
}

/** Stops recording and answers what was recorded. */
export async function readTypingProbe(page: Page): Promise<TypingProbeReading> {
  return page.evaluate(() => {
    const state = (window as unknown as { __sbTyping: ProbeState }).__sbTyping;
    state.armed = false;
    const top = (map: Map<string, number>): Record<string, number> => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25));
    return {
      latencies: [...state.latencies],
      eventDurations: [...state.events.values()],
      commits: state.commits,
      chatCommits: state.chatCommits,
      chatLog: [...state.chatLog],
      rendered: state.rendered,
      renderedInChat: state.renderedInChat,
      byName: top(state.byName),
      inChatByName: top(state.inChatByName),
    };
  });
}

/** The `p`-th percentile (0–100) of `values` (nearest rank); 0 for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}
