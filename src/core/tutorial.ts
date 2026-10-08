import { compareSemVer, parseSemVer } from './semver.ts';

/**
 * D85 · the interactive tutorial (`docs/tutorial.md`): the main tour, the
 * "What's new" registry and the rules that decide what opens by itself. Shared
 * by the service (`src/server/tutorial/`, which stores what was seen) and the UI
 * (`src/web/tutorial/`, which spotlights the elements). Plain data: every step
 * names the `data-tour="…"` anchors it highlights, never a test id or a class.
 *
 * **Adding a feature?** Add a {@link WhatsNewFeature} to {@link WHATS_NEW}
 * (its id, the version it ships in, 2–3 steps) and put `data-tour` on what it
 * points at. Existing installs see it once after they update; new installs see
 * the main tour instead (`docs/tutorial.md` → *Adding a What's-new mini-tour*).
 */

/** Where a step goes before it looks for its anchor. `session` = the newest open session (none: the step's {@link TourStep.missing} card). */
export type TourRoute =
  | { readonly view: 'inbox' | 'todos' | 'schedules' | 'mcp' }
  | { readonly view: 'settings'; readonly section: string }
  | { readonly view: 'session' };

/** One step of a tour: a spotlight on an element and a card next to it. */
export interface TourStep {
  /** Stable within its tour. */
  readonly id: string;
  readonly title: string;
  /** What it is (one or two sentences). */
  readonly what: string;
  /** What to do: the steps the developer would take, in order. */
  readonly todo: readonly string[];
  /** `data-tour` names, in order of preference: the first one on screen (visible) is highlighted. */
  readonly anchors: readonly string[];
  /** Go here first (unset = stay where the tour is). */
  readonly route?: TourRoute;
  /** On tablets and phones the element sits in the sidebar: open the ☰ drawer first. */
  readonly drawer?: boolean;
  /**
   * No anchor on screen (no sessions yet, a feature switched off): `null` skips
   * the step; a text shows a centred card with it instead of the spotlight.
   */
  readonly missing: string | null;
}

/** A "What's new" mini-tour: one feature, once, for installs that had it arrive in an update. */
export interface WhatsNewFeature {
  /** Stable id, stored per machine once its mini-tour was seen or skipped. */
  readonly id: string;
  /** The decision it implements (`docs/decisions.md`), for the record. */
  readonly decision: string;
  /** The Switchboard version it ships in (`MAJOR.MINOR.PATCH`). */
  readonly version: string;
  /** The feature's name (Settings → Tutorial lists it). */
  readonly title: string;
  /** 2–3 steps. */
  readonly steps: readonly TourStep[];
}

/** The id the main tour is stored under. */
export const MAIN_TOUR_ID = 'main';

/**
 * The last version before the tutorial existed. An install that already had
 * data when migration 0037 ran starts from it, so it is shown every What's-new
 * mini-tour introduced after it (and not the main tour).
 */
export const PRE_TUTORIAL_VERSION = '1.12.0';

/** The version the D76–D84 features ship in. */
const V1_13 = '1.13.0';

const SESSION: TourRoute = { view: 'session' };
const NO_SESSION = 'Start a session with + New session to see this. ';

/** The main tour (~15 steps): shown once on a new install, again from Settings → Tutorial or ⌘K → Tutorial. */
export const MAIN_TOUR: readonly TourStep[] = [
  {
    id: 'sessions',
    title: 'Your sessions',
    what: 'Every Claude Code, Codex or OpenCode session this machine (and any paired machine) runs is listed here, with what it is doing right now.',
    todo: ['Click a session to open its chat.', 'Drag a session onto Pinned or into a folder to arrange the list.', 'Hover a row for its ⋯ menu (rename, close, Undo last turn).'],
    anchors: ['sessions', 'sessions-label'],
    drawer: true,
    missing: "You'll see your sessions here once you start one.",
  },
  {
    id: 'new-session',
    title: 'Start a session',
    what: 'Starts an agent in a folder you saved. Simple asks only for the folder and the prompt; Full adds the CLI, model, worktree per solution, branch and schedule.',
    todo: ['Click + New session.', 'Pick a folder (a workspace or a repo); a git repo gets its own worktree when Worktree per session is on.', 'Type what the agent should do and press Start.'],
    anchors: ['new-session'],
    drawer: true,
    missing: 'Use + New session in the sidebar to start one.',
  },
  {
    id: 'chat',
    title: 'The chat',
    what: "A session's chat: the agent's replies, its tool calls and its questions. The message box sends the next turn.",
    todo: ['Type in the message box and press Enter (Shift+Enter for a new line).', 'Use a quick reply under the box for the usual answers.', 'Attach files or images with the paperclip, or drop them on the box.', 'Stop ends the running turn.'],
    anchors: ['composer'],
    route: SESSION,
    missing: `${NO_SESSION}Its chat has a message box with quick replies, attachments and Stop.`,
  },
  {
    id: 'inbox',
    title: 'The Inbox',
    what: "Everything waiting for you: agents' questions and permission requests, failed scheduled runs, merged worktrees to remove, review cards and updates.",
    todo: ['Open the Inbox when its count shows up.', 'Answer a question or approve a request right in the card.', 'Jump to the session from a card when you need more context.'],
    anchors: ['inbox'],
    route: { view: 'inbox' },
    missing: 'The Inbox sits at the top of the sidebar.',
  },
  {
    id: 'todo-strip',
    title: 'The todo list',
    what: "Each session has a todo list above the message box. You and the agent both add to it; every item carries a priority, an estimate and a plan another agent could pick up.",
    todo: ['Ask the agent to "add that to the todo list", or click + to add one yourself.', 'Press ▶ Start on an item to send it to the agent; it shows as in progress.', 'Tick an item when it is done.'],
    anchors: ['todo-strip'],
    route: SESSION,
    missing: `${NO_SESSION}The todo list sits above its message box.`,
  },
  {
    id: 'run-in-new-session',
    title: 'Run an item in its own session',
    what: 'An item can be handed to a fresh session of its own (its own worktree in a git repo), so the current session keeps going.',
    todo: ["Open an item's ⋯ menu.", 'Choose Run in new session.', 'The item shows its run; review the work and tick it when it is done.'],
    anchors: ['todo-actions', 'todo-strip'],
    route: SESSION,
    missing: `${NO_SESSION}Each todo's ⋯ menu offers Run in new session.`,
  },
  {
    id: 'todos-board',
    title: 'Todos page and board',
    what: "Every session's todo list in one place, as a list or as a board with Open, In progress, Review and Done columns, with estimates against actual time.",
    todo: ['Open Todos in the sidebar.', 'Switch between List and Board.', 'Drag a card between columns, or filter by priority, folder or session.'],
    anchors: ['todos-mode', 'todos-page'],
    route: { view: 'todos' },
    missing: 'Todos sits in the sidebar.',
  },
  {
    id: 'review-cards',
    title: 'Review cards',
    what: 'When a session with changes goes idle, a Review card shows what changed, with Merge, Open PR, Commit, Send back and Dismiss.',
    todo: ['Open the card in the Inbox or on the session header.', 'Look through the files and commits.', 'Merge, open a PR, commit, or send it back to the agent with a comment.'],
    anchors: ['review-card'],
    route: { view: 'inbox' },
    missing: 'No review cards yet: one shows up in the Inbox when a session with changes goes idle.',
  },
  {
    id: 'undo-turn',
    title: 'Undo a turn',
    what: "Before each turn Switchboard saves a checkpoint of the session's working trees, so a turn's changes can be taken back.",
    todo: ['Hover one of your messages in the chat.', 'Click ↶ Revert to before this turn and check the files it lists.', 'Confirm; Redo on the divider takes the revert back.'],
    anchors: ['undo-turn'],
    route: SESSION,
    missing: 'Once a session has a turn, each of your messages gets ↶ Revert to before this turn (also Undo last turn in the session ⋯ menu).',
  },
  {
    id: 'usage',
    title: 'Usage and accounts',
    what: "The usage grid: each account's 5-hour and weekly window, with a marker for the pace you can keep. CPU and RAM sit above it.",
    todo: ['Watch the bars as sessions run.', 'Click a line to open Settings → Accounts.', 'Add a second account there to switch over automatically at the limit.'],
    anchors: ['usage'],
    drawer: true,
    missing: 'The usage grid sits at the bottom of the sidebar.',
  },
  {
    id: 'palette',
    title: '⌘K and quick capture',
    what: 'The palette jumps to any session, view, tool or solution, and captures a todo without leaving what you are doing.',
    todo: ['Press ⌘K (Ctrl+K) anywhere.', 'Type to jump; Enter opens the result.', 'Type "todo " and a title to add it to a session\'s todo list.'],
    anchors: ['palette'],
    drawer: true,
    missing: 'Press ⌘K (Ctrl+K) anywhere to open the palette.',
  },
  {
    id: 'schedules',
    title: 'Schedules and loops',
    what: 'Runs a prompt on a cron schedule or as a loop, each run in its own session, with failed runs raised in the Inbox.',
    todo: ['Open Schedules & loops.', 'Press + New scheduled run and pick the folder, prompt and schedule.', 'Run now, pause or resume it from its row.'],
    anchors: ['schedules'],
    drawer: true,
    missing: 'Schedules & loops sits in the sidebar.',
  },
  {
    id: 'mcp',
    title: 'MCP servers and tools',
    what: 'The MCP servers your CLIs use (check, reconnect, sign in, enable or disable) and the web tools embedded in Switchboard.',
    todo: ['Open MCP to see which servers are connected.', 'Under Tools, press + Add to embed a web tool you use next to your sessions.'],
    anchors: ['mcp'],
    drawer: true,
    missing: 'MCP and Tools sit in the sidebar.',
  },
  {
    id: 'machines',
    title: 'Machines and devices',
    what: 'Pair another computer to see and drive its sessions from here, or pair your phone or tablet over Tailscale for notifications and the chat on the go.',
    todo: ['Open Settings → Machines to pair a computer.', 'Open Settings → Devices and scan the QR code with your phone.'],
    anchors: ['settings-machines', 'settings-content'],
    route: { view: 'settings', section: 'machines' },
    missing: 'Machines and Devices are in Settings.',
  },
  {
    id: 'settings',
    title: 'Settings, and this tour again',
    what: 'Settings holds the CLIs, accounts, folders, sessions, notifications and more. This tour and the What\'s-new tours can be replayed here, or from ⌘K → Tutorial.',
    todo: ['Open Settings → Tutorial.', 'Press Show the tutorial again, or Replay next to a What\'s-new tour.'],
    anchors: ['tutorial-replay', 'settings-content'],
    route: { view: 'settings', section: 'tutorial' },
    missing: 'Settings sits at the bottom of the sidebar.',
  },
];

/** The What's-new registry: every feature with a mini-tour, oldest first. */
export const WHATS_NEW: readonly WhatsNewFeature[] = [
  {
    id: 'run-in-new-session',
    decision: 'D76',
    version: V1_13,
    title: 'Run in new session',
    steps: [
      {
        id: 'menu',
        title: 'Run a todo in its own session',
        what: "A todo item can be handed to a new session of its own, with its own worktree in a git repo, while this one keeps going.",
        todo: ["Open an item's ⋯ menu.", 'Choose Run in new session.'],
        anchors: ['todo-actions', 'todo-strip'],
        route: SESSION,
        missing: `${NO_SESSION}Each todo's ⋯ menu offers Run in new session.`,
      },
      {
        id: 'many',
        title: 'Several at once',
        what: 'On the Todos page, Select picks several items; Run N in new sessions starts one session each.',
        todo: ['Open Todos and press Select.', 'Tick the items, then Run N in new sessions.'],
        anchors: ['todos-select', 'todos-page'],
        route: { view: 'todos' },
        missing: null,
      },
    ],
  },
  {
    id: 'todo-board',
    decision: 'D77',
    version: V1_13,
    title: 'Todos board',
    steps: [
      {
        id: 'mode',
        title: 'The board',
        what: 'The Todos page can show every list as a board: Open, In progress, Review and Done.',
        todo: ['Open Todos and switch to Board.', 'Drag a card to another column (on a phone, swipe between columns).'],
        anchors: ['todos-mode', 'todos-page'],
        route: { view: 'todos' },
        missing: 'Todos sits in the sidebar.',
      },
    ],
  },
  {
    id: 'todo-actuals',
    decision: 'D78',
    version: V1_13,
    title: 'Estimates against actuals',
    steps: [
      {
        id: 'actuals',
        title: 'How long it really took',
        what: 'A finished item shows its estimate next to the time it spent in progress and the tokens its turns used; each session sums them up.',
        todo: ['Finish a few items.', 'Compare "est 30m · took 42m" on the cards and the totals per session.'],
        anchors: ['todos-actuals', 'todos-page'],
        route: { view: 'todos' },
        missing: 'Todos sits in the sidebar.',
      },
    ],
  },
  {
    id: 'review-cards',
    decision: 'D79',
    version: V1_13,
    title: 'Review cards',
    steps: [
      {
        id: 'card',
        title: 'Review when a session goes idle',
        what: 'A session with changes that goes idle raises a Review card: the files, the commits and Merge, Open PR, Commit, Send back or Dismiss.',
        todo: ['Open the card in the Inbox or on the session header.', 'Pick what happens to the changes.'],
        anchors: ['review-card'],
        route: { view: 'inbox' },
        missing: 'No review cards yet: one shows up in the Inbox when a session with changes goes idle.',
      },
      {
        id: 'setting',
        title: 'On or off',
        what: 'Review cards are advisory and never block the agent. Turn them off here if you do not want them.',
        todo: ['Settings → Sessions & worktrees → Raise review cards.'],
        anchors: ['setting-review-cards'],
        route: { view: 'settings', section: 'sessions' },
        missing: null,
      },
    ],
  },
  {
    id: 'undo-turn',
    decision: 'D80',
    version: V1_13,
    title: 'Undo a turn',
    steps: [
      {
        id: 'revert',
        title: 'Revert to before a turn',
        what: "Each of your messages can take the session's files back to how they were before that turn; Redo undoes the revert.",
        todo: ['Hover one of your messages.', 'Click ↶ Revert to before this turn, check the files, confirm.'],
        anchors: ['undo-turn'],
        route: SESSION,
        missing: 'Once a session has a turn, each of your messages gets ↶ Revert to before this turn (also Undo last turn in the session ⋯ menu).',
      },
      {
        id: 'setting',
        title: 'Checkpoints',
        what: 'A checkpoint is saved before each turn (hidden refs; your index and branch are never touched), kept 7 days or 100 turns.',
        todo: ['Turn it off in Settings → Sessions & worktrees if you do not want it.'],
        anchors: ['setting-checkpoints'],
        route: { view: 'settings', section: 'sessions' },
        missing: null,
      },
    ],
  },
  {
    id: 'quick-capture',
    decision: 'D81',
    version: V1_13,
    title: 'Quick capture',
    steps: [
      {
        id: 'palette',
        title: 'Capture a todo from anywhere',
        what: 'Type "todo " and a title in ⌘K to add it to a session; the agent fills in the description, plan, priority and estimate when it is next idle.',
        todo: ['Press ⌘K (Ctrl+K).', 'Type "todo fix the flaky test" and pick the session.'],
        anchors: ['palette'],
        drawer: true,
        missing: 'Press ⌘K (Ctrl+K) anywhere to open the palette.',
      },
      {
        id: 'selection',
        title: 'From the chat or your phone',
        what: 'Select text in a chat to get Add to todo, or share to Switchboard from your phone\'s share sheet.',
        todo: ['Select a sentence in the chat.', 'Press Add to todo.'],
        anchors: ['composer'],
        route: SESSION,
        missing: null,
      },
    ],
  },
  {
    id: 'model-routing',
    decision: 'D82',
    version: V1_13,
    title: 'Model by task',
    steps: [
      {
        id: 'rules',
        title: 'Pick the model per todo',
        what: 'Ordered rules choose the CLI, model, effort and account a todo runs with, by its priority and estimate.',
        todo: ['Open Settings → Sessions & worktrees → Model by task.', 'Add a rule, e.g. low priority and under 15 minutes → a faster model.'],
        anchors: ['setting-model-rules'],
        route: { view: 'settings', section: 'sessions' },
        missing: 'The rules are in Settings → Sessions & worktrees.',
      },
    ],
  },
  {
    id: 'fresh-session',
    decision: 'D83',
    version: V1_13,
    title: 'Fresh session',
    steps: [
      {
        id: 'context',
        title: 'When the context fills',
        what: 'The bar above the message box shows how full the context is; past the threshold Switchboard offers to continue in a fresh session with the agent\'s handover.',
        todo: ['Watch the context bar.', 'Press Continue in a fresh session when it is offered: the new session takes over the place, todos and pin.'],
        anchors: ['context-bar', 'composer'],
        route: SESSION,
        missing: `${NO_SESSION}The context bar sits above its message box.`,
      },
      {
        id: 'setting',
        title: 'The threshold',
        what: 'Choose at what share of the context window the offer shows, or turn it off.',
        todo: ['Settings → Sessions & worktrees → Fresh session when the context fills.'],
        anchors: ['setting-fresh-offer'],
        route: { view: 'settings', section: 'sessions' },
        missing: null,
      },
    ],
  },
  {
    id: 'cleanup',
    decision: 'D84',
    version: V1_13,
    title: 'Clean-up',
    steps: [
      {
        id: 'page',
        title: 'Clean up what Switchboard left',
        what: 'Lists worktrees, branches, closed sessions and old files Switchboard made and no longer needs, with sizes. Nothing goes until you tick it and confirm.',
        todo: ['Open Settings → Clean-up.', 'Look through the dry run, tick what can go, press Clean up.'],
        anchors: ['cleanup', 'settings-content'],
        route: { view: 'settings', section: 'cleanup' },
        missing: 'Clean-up is the last section of Settings (on this computer only).',
      },
    ],
  },
];

/** A tour's id: {@link MAIN_TOUR_ID} or a {@link WhatsNewFeature.id}. */
export function isTourId(id: string, registry: readonly WhatsNewFeature[] = WHATS_NEW): boolean {
  return id === MAIN_TOUR_ID || registry.some((feature) => feature.id === id);
}

/** The steps of a tour (`null` for an unknown id). */
export function tourSteps(id: string, registry: readonly WhatsNewFeature[] = WHATS_NEW): readonly TourStep[] | null {
  if (id === MAIN_TOUR_ID) return MAIN_TOUR;
  return registry.find((feature) => feature.id === id)?.steps ?? null;
}

/** `-1` / `0` / `1`; an unparseable version sorts before every parseable one. */
export function compareVersions(a: string, b: string): number {
  const x = parseSemVer(a);
  const y = parseSemVer(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  return compareSemVer(x, y);
}

/**
 * The version the tutorial system counts as "seen" after it ran on this build:
 * the app's own, or the newest feature's when the registry is ahead of
 * `package.json` (a build before the version bump), so a feature is never
 * offered again as new on the same build.
 */
export function tutorialVersion(appVersion: string, registry: readonly WhatsNewFeature[] = WHATS_NEW): string {
  return registry.reduce((top, feature) => (compareVersions(feature.version, top) > 0 ? feature.version : top), appVersion);
}

/** The features introduced after `lastVersion` (in registry order): an existing install's What's-new mini-tours. */
export function featuresAfter(lastVersion: string, registry: readonly WhatsNewFeature[] = WHATS_NEW): WhatsNewFeature[] {
  return registry.filter((feature) => compareVersions(feature.version, lastVersion) > 0);
}

// ── the API (contracts/local-api.md → Tutorial (D85)) ────────────────────

/** Where a tour stands on this machine. `pending` = it opens by itself; `null` = never queued (a replay still works). */
export type TourStatus = 'pending' | 'completed' | 'skipped';

/** One tour's stored state. */
export interface TourRecord {
  readonly status: TourStatus | null;
  /** When it was queued, finished or skipped; `null` = never. */
  readonly updatedAt: string | null;
}

/** One What's-new feature as `GET /api/tutorial` reports it. */
export interface WhatsNewEntry extends TourRecord {
  readonly id: string;
  readonly title: string;
  readonly version: string;
}

/** `GET /api/tutorial`. */
export interface TutorialState {
  /**
   * Open a tour by itself when the UI loads: the main tour when it is pending,
   * else the pending What's-new mini-tours. `false` in demo mode and with
   * `SWITCHBOARD_TUTORIAL=off` (tests), whatever is pending.
   */
  readonly autoOpen: boolean;
  /** `new`: the database was empty when migration 0037 ran; `existing`: it had data (it gets What's-new, not the main tour). */
  readonly install: 'new' | 'existing';
  /** The version the tutorial system last ran on (after this read: {@link tutorialVersion} of the app). */
  readonly lastVersion: string;
  readonly main: TourRecord;
  /** Every feature of the registry, in its order. */
  readonly whatsNew: readonly WhatsNewEntry[];
}

/** `PUT /api/tutorial/tours/{id}` body. */
export interface TourOutcome {
  readonly status: 'completed' | 'skipped';
}

/** Parses a {@link TourOutcome}; `null` when it is not one. */
export function parseTourOutcome(body: unknown): TourOutcome | null {
  if (!body || typeof body !== 'object') return null;
  const status = (body as Record<string, unknown>)['status'];
  return status === 'completed' || status === 'skipped' ? { status } : null;
}

/** The tours that open by themselves now, in order (the main tour first; it is never mixed with What's-new). */
export function pendingTours(state: TutorialState): string[] {
  if (!state.autoOpen) return [];
  if (state.main.status === 'pending') return [MAIN_TOUR_ID];
  return state.whatsNew.filter((entry) => entry.status === 'pending').map((entry) => entry.id);
}
