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
  // Team (D100) hook: `team` (docs/team-removal.md). Plans (D99) hook: `plans` (docs/plans-removal.md).
  // Project memory (D107) hook: `memory` (docs/memory-removal.md).
  | { readonly view: 'inbox' | 'todos' | 'schedules' | 'mcp' | 'artifacts' | 'search' | 'insights' | 'team' | 'plans' | 'memory' }
  | { readonly view: 'settings'; readonly section: string }
  | { readonly view: 'session'; readonly tab?: 'diff' };

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
   * D131 · a v2 tour's step ({@link WhatsNewFeature.ui} `'v2'`): the v2 address to
   * go to first (`/agents`, `/settings/appearance`, …), or `'agent'` for the
   * newest open agent's view. The classic host ignores it (it never runs v2 tours).
   */
  readonly v2Route?: string;
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
  /** 2–3 steps (a v2 welcome may have more: {@link MAX_V2_TOUR_STEPS}). */
  readonly steps: readonly TourStep[];
  /**
   * D131 · the UI that can highlight it. Unset = the classic UI (its anchors are
   * on classic pages); `'v2'` = the v2 theme's own tour (`src/web/v2/tour/`).
   * Each UI opens, lists and replays only its own tours (`docs/tutorial.md` → *Two themes*).
   */
  readonly ui?: 'v2';
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

/** The version D88, D89, D90 and D91 ship in. */
const V1_14 = '1.14.0';
const V1_15 = '1.15.0';

/** The version D97 (search across everything) ships in. */
const V1_16 = '1.16.0';

/** The version D98 (accounts shared across paired machines), D100 (Team) and D99 (Plans) ship in (both experimental until D132). */
const V1_17 = '1.17.0';

/** The version D101 (the sidebar's navigation as an icon grid, collapsible TOOLS) ships in. */
const V1_18 = '1.18.0';

/** The version D106 (chats) ships in. */
const V1_19 = '1.19.0';

/** The version D107 (project memory, experimental until D132), D108 (Insights) and D109 (the CI / pull-request feedback loop, importing issues as todos) ship in. */
const V1_20 = '1.20.0';

/** The version D110 (choosing the target folders of a move, and their verification) ships in. */
const V1_21 = '1.21.0';

/** The version the D99 follow-up of 2026-10-15 (plans for anything: any target branch, or none) ships in. */
const V1_22 = '1.22.0';

/** The version the D100 follow-up of 2026-10-16 (the sidebar lists each team's members with their status) ships in. */
const V1_23 = '1.23.0';

/** The version the D100 follow-up of 2026-10-16 (the Team page's left column folds to a slim strip) ships in. */
const V1_24 = '1.24.0';

/** The version D111 (deleting artifacts from the lists) ships in. */
const V1_25 = '1.25.0';

/** The version D124 (sessions that wait for you at a turn's end) ships in. */
const V1_31 = '1.31.0';

/** The version D125 (machine power: battery or an estimated draw, shared with paired machines) ships in. */
const V1_32 = '1.32.0';

/** The version D127 (the processes sessions leave running: tracked, listed, stopped when idle or closed) ships in. */
const V1_34 = '1.34.0';

/** The version D128 (multi-select questions take several answers) ships in. */
const V1_35 = '1.35.0';

/** The version D132 (Team, Plans and Project memory graduate from Settings → Experimental: always on) ships in. */
const V2_0 = '2.0.0';

/** The version D134 (Insights → Usage: where each account's usage windows went) ships in. */
const V2_1 = '2.1.0';

/** The version D135 (agents propose edits and removals of approved Project memory entries) ships in. */
const V2_2 = '2.2.0';

/** The version D136 (Project memory checks: duplicates and contradictions of a proposal, a periodic check per folder) ships in. */
const V2_3 = '2.3.0';

/** The version D138 (choose the account overall and per Project) ships in. */
const V2_4 = '2.4.0';

/** The version the redrawn v2 Project graph (Fixes after 2.0 → The Project graph, redrawn) ships in. */
const V2_4_2 = '2.4.2';

/** The version D140 (update Switchboard from a phone or another computer) ships in. */
const V2_4_3 = '2.4.3';

/** Team (D100): the steps on the Team page say this when it is not on screen (D132: Team is always on, so they point to its sidebar icon). */
const TEAM_OPEN = 'Open Team in the sidebar (the ⚑ icon) to see this. ';

/** Team (D100): the steps that need a member. */
const TEAM_NO_MEMBER = 'This shows once a team has a member: adopt one with ＋ Member on the Team page. ';

/** D131 · the v2 welcome tour's id ("Welcome to Switchboard 2"). */
export const V2_WELCOME_ID = 'welcome-v2';

/** The most steps a v2 tour may have (a classic mini-tour has 1–3). */
export const MAX_V2_TOUR_STEPS = 8;

/**
 * D131 · classic What's-new tours the v2 welcome covers: when the welcome opens
 * by itself in v2 and ends, these are recorded with its outcome too (when they
 * are still pending), so a v2 user who later switches to Classic is not shown
 * them again. `graduated` (D132: Team, Plans and Memory always on) is told by the
 * welcome's Projects-and-Crews step; `two-themes` by its Appearance step.
 */
export const V2_COVERS: readonly string[] = ['graduated', 'two-themes'];

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
    todo: ['Type in the message box and press Enter (Shift+Enter for a new line).', 'Attach files or images with the paperclip next to Send, or paste or drop them on the box.', 'Stop ends the running turn.'],
    anchors: ['composer'],
    route: SESSION,
    missing: `${NO_SESSION}Its chat has a message box with attachments and Stop.`,
  },
  {
    id: 'inbox',
    title: 'The Inbox',
    what: "Everything waiting for you: agents' questions and permission requests, failed scheduled runs, merged worktrees to remove, plan items ready to merge and updates.",
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
    anchors: ['todo-strip', 'todo-add'],
    route: SESSION,
    missing: `${NO_SESSION}The todo list sits above its message box.`,
  },
  {
    id: 'run-in-new-session',
    title: 'Run an item in its own session',
    what: 'An item can be handed to a fresh session of its own (its own worktree in a git repo), so the current session keeps going.',
    todo: ["Open an item's ⋯ menu.", 'Choose Run in new session.', 'The item shows its run; it is done when the run marks it done.'],
    anchors: ['todo-actions', 'todo-strip', 'todo-add'],
    route: SESSION,
    missing: `${NO_SESSION}Each todo's ⋯ menu offers Run in new session.`,
  },
  {
    id: 'todos-board',
    title: 'Todos page and board',
    what: "Every session's todo list in one place, as a list or as a board with Open, In progress and Done columns, with estimates against actual time.",
    todo: ['Open Todos in the sidebar.', 'Switch between List and Board.', 'Drag a card between columns, or filter by priority, folder or session.'],
    anchors: ['todos-mode', 'todos-page'],
    route: { view: 'todos' },
    missing: 'Todos sits in the sidebar.',
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
        anchors: ['todo-actions', 'todo-strip', 'todo-add'],
        route: SESSION,
        missing: `${NO_SESSION}Each todo's ⋯ menu offers Run in new session.`,
      },
      {
        id: 'many',
        title: 'Several at once',
        what: 'On the Todos page, Select picks several items; Run N in new sessions starts one session each.',
        todo: ['Open Todos and press Select.', 'Tick the items, then Run N in new sessions.'],
        anchors: ['todos-select'],
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
  {
    id: 'drafts',
    decision: 'D88',
    version: V1_14,
    title: 'Your drafts follow you',
    steps: [
      {
        id: 'composer',
        title: 'Your drafts follow you',
        what: 'What you type and have not sent yet stays with the session: the message box, a question\'s own answer, a Send-back comment or Commit message and the todo forms, and a New session you cancelled. Switch sessions, reload, or pick it up on your phone.',
        todo: ['Type a message and switch to another session.', 'Come back (here or on a paired device): the text is still there.'],
        anchors: ['composer'],
        route: SESSION,
        missing: `${NO_SESSION}Its message box keeps what you type until you send it.`,
      },
    ],
  },
  {
    id: 'saved-artifacts',
    decision: 'D89',
    version: V1_14,
    title: 'Artifacts are saved on purpose',
    steps: [
      {
        id: 'save',
        title: 'Artifacts are saved on purpose',
        what: "Agents save the deliverables you should see (reports, plans, docs, diagrams, mockups) as artifacts, with versions; nothing is collected automatically any more.",
        todo: ['Ask the agent for a report or a plan: it saves it with its artifact_save tool.', "Or open an agent message's ⋯ and choose Save as artifact (code blocks have their own button)."],
        anchors: ['message-menu', 'composer'],
        route: SESSION,
        missing: `${NO_SESSION}Its agent's messages get ⋯ → Save as artifact.`,
      },
      {
        id: 'page',
        title: 'Every artifact in one place',
        what: "The Artifacts page lists every session's artifacts; one opens in its session's Artifacts tab with its versions, Compare, Download and Full screen.",
        todo: ['Open Artifacts in the sidebar.', 'Filter by kind or session, then open one.'],
        anchors: ['artifacts-filters', 'artifacts'],
        route: { view: 'artifacts' },
        missing: 'Artifacts sits in the sidebar.',
      },
    ],
  },
  {
    id: 'diff-since-commit',
    decision: 'D90',
    version: V1_14,
    title: 'Diff shows the work since the last commit',
    steps: [
      {
        id: 'toggle',
        title: 'Diff shows the work since the last commit',
        what: "The Diff tab opens on the uncommitted changes since the last commit; in a repo the session works in place, only the files this session touched. Whole branch shows everything a worktree's branch contains; All uncommitted changes in this repo shows other people's edits too.",
        todo: ["Open a session's Diff tab.", 'Read the line at the top: what is shown, how many files, +/−.', 'Switch to Whole branch or All uncommitted changes; the tab remembers it for the session.'],
        anchors: ['diff-scope', 'diff-scope-bar'],
        route: { view: 'session', tab: 'diff' },
        missing: `${NO_SESSION}Its Diff tab shows the changes since the last commit.`,
      },
    ],
  },
  {
    id: 'apply-instruction',
    decision: 'D91',
    version: V1_14,
    title: 'Apply the standing instruction to open sessions',
    steps: [
      {
        id: 'button',
        title: 'Apply the standing instruction to open sessions',
        what: 'A changed standing instruction used to reach only sessions started or resumed afterwards. Apply to open sessions gives it to the ones already running: an idle session restarts its CLI with the same conversation (no message is sent), a busy one right after its turn.',
        todo: ['Edit the standing instruction in Settings → Sessions & worktrees and Save.', 'Press Apply to open sessions next to it; read the result line.', "Or one session at a time: its ⋯ menu → Reload instruction."],
        anchors: ['standing-apply', 'standing-instruction'],
        route: { view: 'settings', section: 'sessions' },
        missing: 'Apply to open sessions is under the standing instruction in Settings → Sessions & worktrees (on this computer).',
      },
    ],
  },
  {
    id: 'copy-code',
    decision: 'D92',
    version: V1_14,
    title: 'Copy code with one click',
    steps: [
      {
        id: 'copy',
        title: 'Copy code with one click',
        what: 'Every code block an agent writes in the chat has a Copy button at its top right, next to Save as artifact. It copies just the code.',
        todo: ['Hover a code block in a chat (on a touch screen the buttons are always shown).', 'Press Copy; it reads "Copied ✓" for a moment.'],
        anchors: ['code-copy', 'composer'],
        missing: 'Open a session whose agent wrote a code block: Copy sits at the top right of the block.',
      },
    ],
  },
  {
    id: 'unlisted-schedules',
    decision: 'D93',
    version: V1_15,
    title: 'Schedules the CLI keeps to itself',
    steps: [
      {
        id: 'card',
        title: 'Schedules the CLI keeps to itself',
        what: 'When a session\'s CLI keeps starting the same prompt on its own, about every so often, and no job for it is visible (CronList does not list it), Schedules & loops shows it as "Unlisted schedule in the CLI": how many times it ran, about how often, when it last ran, and an estimate of the next time. It goes when the prompts stop or the session\'s process ends.',
        todo: ['Open Schedules & loops.', 'An "Unlisted schedule in the CLI" card shows the prompt in its note; Open session goes to the session.'],
        anchors: ['loop-cards', 'schedules'],
        route: { view: 'schedules' },
        missing: 'Shown on Schedules & loops once a session\'s CLI has started the same prompt by itself at least three times at a regular interval.',
      },
    ],
  },
  {
    id: 'owned-loops',
    decision: 'D94',
    version: V1_15,
    title: 'Loops run by Switchboard',
    steps: [
      {
        id: 'cards',
        title: 'Loops run by Switchboard',
        what: 'Agents now schedule recurring or one-time work with the switchboard loop_create tool instead of the CLI\'s own /loop or CronCreate, and Switchboard sends the prompt into the session at each firing: it waits while the agent is busy, resumes a paused session and survives restarts. Each loop is a card with its schedule, the exact next firing, its expiry (or "no expiry") and its runs; the CLI\'s own schedules still show, marked "Managed by the CLI".',
        todo: ['Open Schedules & loops.', 'Pause / Resume, Run now, Edit or Cancel a loop on its card.'],
        anchors: ['loop-cards', 'schedules'],
        route: { view: 'schedules' },
        missing: 'A card appears here once an agent (or you) creates a loop.',
      },
      {
        id: 'new',
        title: 'Make one yourself',
        what: 'Create a loop for any open session: the prompt, every n minutes, a cron expression or once at a time, and an optional expiry and run limit. A session\'s ⋯ → New loop… does the same for that session.',
        todo: ['Click + New loop.', 'Pick the session, write the prompt and the schedule, then Create loop.'],
        anchors: ['loop-new', 'schedules'],
        route: { view: 'schedules' },
        missing: null,
      },
    ],
  },
  {
    id: 'search',
    decision: 'D97',
    version: V1_16,
    title: 'Search across everything',
    steps: [
      {
        id: 'page',
        title: 'Search across everything',
        what: 'One field searches every conversation (your messages, the agents\' text and progress notes, tool calls, session titles), the saved artifacts, the todos and History, here and on your paired machines. Results come grouped by type and machine, the matching words highlighted.',
        todo: ['Press ⌘⇧F (Ctrl+Shift+F), or the search button in the app bar on a phone or tablet.', 'Type a few words; "quotes" find a phrase, a trailing * a prefix.', 'Click a message: its chat opens scrolled to it, highlighted, even when it is far back.'],
        anchors: ['search-input'],
        route: { view: 'search' },
        missing: 'Open Search with ⌘⇧F (Ctrl+Shift+F).',
      },
      {
        id: 'scopes',
        title: 'Narrow it down, or search from ⌘K',
        what: 'The chips keep one kind of result (Conversations, Artifacts, Todos or History) and page through all of it. In the ⌘K palette, start with ? to search from anywhere: ?invoice lists the best matches.',
        todo: ['Pick a chip to see only that kind of result.', 'Press ⌘K and type ? and a few words.'],
        anchors: ['search-chips'],
        route: { view: 'search' },
        missing: null,
      },
    ],
  },
  {
    id: 'shared-accounts',
    decision: 'D98',
    version: V1_17,
    title: 'Accounts shared across your machines',
    steps: [
      {
        id: 'footer',
        title: 'One usage grid for every machine',
        what: 'With paired machines connected, the usage grid lists their accounts too, each labelled with the machine it is on. The same login on two machines is one line: its newest reading counts on both, because both spend from the same limits.',
        todo: ['Pair a second machine in Settings → Machines.', 'Look at the grid: each line ends with the machines it is on.', 'Hover a line to see whose reading it shows.'],
        anchors: ['usage'],
        drawer: true,
        missing: 'The usage grid sits at the bottom of the sidebar.',
      },
      {
        id: 'settings',
        title: 'Names, order and limits follow the account',
        what: 'An account signed in on several machines shows "Same account on …" in Settings → Accounts. Its name and the account order are shared, and when one machine finds it out of usage the others skip it until the reset. Accounts only another machine has are listed under "On other machines". Each machine still signs in on its own.',
        todo: ['Rename a shared account: the other machine shows the new name.', 'Reorder the accounts: the order follows.', 'Use Manage on a listed account to open its machine\'s accounts.'],
        anchors: ['accounts-shared', 'accounts-others', 'accounts-list'],
        route: { view: 'settings', section: 'accounts' },
        missing: null,
      },
    ],
  },
  // Plans (D99) hook: its What's-new tour, shown only while Plans is available (the web filters it: src/web/plans/store.ts; docs/plans-removal.md).
  {
    id: 'plans',
    decision: 'D99',
    version: V1_17,
    title: 'Plans',
    steps: [
      {
        id: 'nav',
        title: 'Plans: todos that run by themselves',
        what: "A plan groups a session's todos into a dependency graph (\"B after A\"). Switchboard starts each ticket in its own session and worktree when the ones it waits on are done, and merges the work into one epic branch, never into dev or master.",
        todo: ['Open Plans in the sidebar.', 'The number next to it counts the plans running now.'],
        anchors: ['plans'],
        drawer: true,
        missing: 'Plans sits in the sidebar, after Todos. ',
      },
      {
        id: 'new',
        title: 'Make a plan',
        what: 'Pick a session, name the epic branch and tick the todos that belong to it. On the plan page, ✎ Edit dependencies orders them; ▶ Start plan asks how finished tickets should be merged: there is no default.',
        todo: ['Press ＋ New plan.', 'Fill in the title and the target branch, tick the todos, Create plan.', 'Edit the dependencies, then ▶ Start plan and choose the merge mode.'],
        anchors: ['plans-new'],
        route: { view: 'plans' },
        missing: null,
      },
      {
        id: 'jira',
        title: 'Import from Jira',
        what: "Or start from a Jira epic: Import from Jira… reads the epic's tickets and their links and makes a draft plan from them, each ticket a todo with its key. From the Plans page you pick the folder it runs in, and a new session there owns the plan. Nothing runs until you press ▶ Start plan.",
        todo: ['Press Import from Jira… (on the Plans page, or in a session\'s Plan tab).', 'Type the epic key, check the preview, pick where it runs, and press Create plan.'],
        anchors: ['plans-jira-epic', 'plans-import'],
        route: { view: 'plans' },
        missing: null,
      },
    ],
  },
  // Team (D100) hook: its What's-new tour (docs/team-removal.md).
  {
    id: 'team',
    decision: 'D100',
    version: V1_17,
    title: 'Team',
    steps: [
      {
        id: 'switch',
        title: 'Team',
        what: 'Run a set of role agents ("members") from one page: each member is one of your sessions with a role, a charter, a rhythm, a budget and the things it needs you for. Until a session becomes a member, nothing else changes.',
        todo: ['Open Team in the sidebar (the ⚑ icon).'],
        anchors: ['team'],
        drawer: true,
        missing: 'Team sits in the sidebar, next to Plans. ',
      },
      {
        id: 'adopt',
        title: 'Adopt a session as a member',
        what: 'Switchboard suggests sessions that look like team members (recurring loops, mostly reading, mostly editing…) and drafts a charter for each. Adopting one moves it from your session list into Team, with its history, worktrees, todos and loops.',
        todo: ['Press ＋ Member (or Review on the banner).', 'Pick a suggestion, check its charter and gates, and press Adopt into the team.', 'Or start a new member from a template.'],
        anchors: ['team-add'],
        route: { view: 'team' },
        missing: TEAM_OPEN,
      },
      {
        id: 'needs-you',
        title: 'Needs you, and Return to sessions',
        what: "Needs you lists everything your members wait for: their questions, permission requests and plan items ready to merge, and Team's own approvals (a budget); answer them in place. A member's ⋯ menu gives it a task, pauses it or moves it to your other machine, and ↩ Return to sessions puts its session back in its folder as a plain session.",
        todo: ['Tap an option to answer a question, Reply… to open the chat, or Approve / Decline a request.', "Open a member's ⋯ menu and pick ↩ Return to sessions when it is no longer needed."],
        anchors: ['team-needs-you', 'team-member-menu'],
        route: { view: 'team' },
        missing: TEAM_NO_MEMBER,
      },
    ],
  },
  {
    id: 'sidebar-icons',
    decision: 'D101',
    version: V1_18,
    title: 'Navigation as icons',
    steps: [
      {
        id: 'grid',
        title: 'Navigation is now icons: hover for names',
        what: 'Inbox, Solutions, Schedules & loops, MCP, Artifacts, History and Todos (and Team and Plans when they are on) are a grid of icons under + New session, so the sessions get more room. Each icon keeps its count or warning as a badge; hover an icon (or long-press it on a touch screen) for its name. TOOLS folds away from its header too.',
        todo: ['Hover an icon to see its name, click it to open the page.', 'Click the TOOLS header to fold the tools away; it stays folded after a reload.'],
        anchors: ['nav'],
        drawer: true,
        missing: 'The icons sit in the sidebar, under + New session.',
      },
    ],
  },
  // Team (D100) hook: the D100 follow-ups of 2026-10-14 (multiple teams, the members' order, the model dropdown; docs/team-removal.md).
  {
    id: 'team-update',
    decision: 'D100',
    version: V1_18,
    title: 'Team update',
    steps: [
      {
        id: 'teams',
        title: 'More than one team',
        what: 'The tabs above the Team page switch between your teams, each with its own members, hand-offs, activity and Needs you; All teams lists everything that waits for you. Drag a tab to reorder the teams; each team also has its own entry in the sidebar.',
        todo: ['Press ＋ New team and name it.', 'Adopt or create members into it (the form has a Team picker), or move one there from its ⋯ menu → Move to team ▸.'],
        anchors: ['team-new', 'team-switcher'],
        route: { view: 'team' },
        missing: TEAM_OPEN,
      },
      {
        id: 'order',
        title: 'Put the members in your order',
        what: 'The member cards sit in one row that scrolls sideways. Drag a card left or right (long-press it on a touch screen), or use Move left / Move right in its ⋯ menu; the order is saved and shows on your other machine too.',
        todo: ['Drag a card to where you want it.', 'Or focus a card and press Alt+← / Alt+→.'],
        anchors: ['team-cards'],
        route: { view: 'team' },
        missing: TEAM_NO_MEMBER,
      },
      {
        id: 'model',
        title: "Pick a member's model",
        what: "A member's Settings tab (and the Adopt / Create form) chooses its model from the models its CLI offers, with the effort when the model has levels; its session runs on it from its next turn. A change made in the session's own header is kept for the member too.",
        todo: ["Open a member's Settings tab.", 'Open Model · effort, pick a model, and Save.'],
        anchors: ['team-model'],
        route: { view: 'team' },
        missing: "Model · effort sits in a member's Settings tab (open a member, then Settings) and in the Adopt / Create form. ",
      },
    ],
  },
  {
    id: 'credits',
    decision: 'D103',
    version: V1_18,
    title: 'Credits: see them, and save them',
    steps: [
      {
        id: 'footer',
        title: 'An amber badge when an account pays from credits',
        what: 'An account past its 5-hour or weekly limit that keeps answering is paid from credits (extra usage). Its line in the usage grid then gets an amber "on credits" badge with what is left of its credit limit, like "€12.40 left of €50". The Inbox (and your phone, if it gets Inbox pushes) tells you once when it starts, and when less than 20 % is left.',
        todo: ['Look at the usage grid at the bottom of the sidebar.', 'Hover an account\'s line for its credits and when its limit resets.'],
        anchors: ['usage'],
        drawer: true,
        missing: 'The usage grid sits at the bottom of the sidebar.',
      },
      {
        id: 'settings',
        title: 'Allowance first, credits last',
        what: 'New sessions and automatic switches always prefer an account with subscription allowance. When an account resets, sessions running on credits move back to it as soon as their turn ends. If no account has allowance, choose here: keep going on credits, or pause new turns until an account resets.',
        todo: ['Open Settings → Accounts.', 'Pick what happens "When every account is out of allowance".'],
        anchors: ['accounts-credits'],
        route: { view: 'settings', section: 'accounts' },
        missing: null,
      },
    ],
  },
  {
    id: 'chip-fold',
    decision: 'D104',
    version: V1_18,
    title: 'One-line session header',
    steps: [
      {
        id: 'toggle',
        title: 'Long chip rows fold to one line — +N more',
        what: "A session's title stays on one line (hover it for the whole title), and when its chips (work, mode, phase, loops, then one per solution in scope) need more than one line they fold to the chips that fit plus +N more. Your choice is remembered per session.",
        todo: ['Press +N more ▾ to see every chip.', 'Press ▴ less to fold them back to one line.'],
        anchors: ['session-chips-toggle'],
        route: { view: 'session' },
        missing: 'When a session has more chips than fit on one line (many solutions in scope), its header shows them folded with a +N more ▾ button under the title; ▴ less folds them back.',
      },
    ],
  },
  // Team (D100) hook: D105, the members' own agents draft their charters (docs/team-removal.md).
  {
    id: 'better-charters',
    decision: 'D105',
    version: V1_18,
    title: 'Charters your members write themselves',
    steps: [
      {
        id: 'draft',
        title: 'Draft better charters',
        what: "Each member's own agent can now propose a specific charter from its session: the feature it owns, what it delivers, how it works today (its rounds and who gives it feedback) and what it never does. A proposal waits in Needs you with a before → after; nothing changes until you accept it.",
        todo: ['Press Draft better charters to ask every member of the team (or one member: ⋯ → Redraft charter).', 'In Needs you, Accept a proposal, Edit… it in the member\'s Settings, or Dismiss it.'],
        anchors: ['team-draft-charters'],
        route: { view: 'team' },
        missing: `${TEAM_NO_MEMBER}Draft better charters then sits in the Team page's header.`,
      },
    ],
  },
  {
    id: 'chats',
    decision: 'D106',
    version: V1_19,
    title: 'Chats',
    steps: [
      {
        id: 'new-chat',
        title: 'Start a chat instead of a session',
        what: 'A chat is a conversation to think and plan in: its agent reads files, searches, browses the web and looks at what you attach, but never edits or runs commands that change things (its CLI stays in plan mode). It runs in its own empty folder, can look at folders you name, and gets its own CHATS section. When you want it built, ⋯ → Continue as session… carries the conversation into a new session.',
        todo: ['Press + New chat on the CHATS header in the sidebar (or ⌘K → New chat).', 'Write your question; add folders to look at if it needs code.', 'In the chat, ⋯ → Continue as session… to start coding.'],
        anchors: ['new-chat'],
        drawer: true,
        missing: 'Start one from ⌘K → New chat, or + New chat on the CHATS header in the sidebar.',
      },
    ],
  },
  // Project memory (D107) hook: its What's-new tour (docs/memory-removal.md).
  {
    id: 'memory',
    decision: 'D107',
    version: V1_20,
    title: 'Project memory',
    steps: [
      {
        id: 'switch',
        title: 'Project memory',
        what: 'Agents can propose durable facts about a project (build commands, gotchas, decisions, where things live). Nothing reaches a session until you approve it; approved entries go to every new or resumed session in that folder.',
        todo: ['Open Memory in the sidebar.'],
        anchors: ['memory'],
        drawer: true,
        missing: 'Memory sits in the sidebar, next to Plans. ',
      },
      {
        id: 'review',
        title: 'Review what agents propose',
        what: "Proposals wait in the review queue of their folder, each linked to the session that made it, and the Inbox tells you when there are some. Approve one as it is, Edit… it first (your edit is what sessions get) or Reject it. You can add, pin, edit and delete entries yourself too.",
        todo: ['Pick a folder.', 'Approve, Edit… or Reject each proposal.', 'Press + Add entry to write one yourself; ☆ pins it first.'],
        anchors: ['memory-queue', 'memory-folder'],
        route: { view: 'memory' },
        missing: 'Open Memory in the sidebar to see this. ',
      },
    ],
  },
  {
    id: 'insights',
    decision: 'D108',
    version: V1_20,
    title: 'Insights',
    steps: [
      {
        id: 'nav',
        title: 'Insights: where the time and tokens went',
        what: 'A page of numbers about your agents: time and tokens per folder, session and model, how close the todo estimates were, how often work came back (reopened todos, Plans sent back, reverted turns), what the todo runs would cost at the prices you set, when each account\'s usage windows fill at the current pace, and routing rules worth trying.',
        todo: ['Click the bar-chart icon in the sidebar (or ⌘K → Insights).', 'Pick a period and narrow it by folder, CLI, model or account.'],
        anchors: ['insights'],
        drawer: true,
        missing: 'Open it from ⌘K → Insights.',
      },
      {
        id: 'filters',
        title: 'Filter, then read the six sections',
        what: 'The filters scope every section. Costs use example prices until you set your own in Settings → Notifications & usage → Prices; suggested routing rules open Model by task pre-filled and change nothing until you save them.',
        todo: ['Pick Last 7 days, 30 days, 90 days or a custom range.', 'Edit the prices in Settings if the cost matters to you.'],
        anchors: ['insights-filters'],
        route: { view: 'insights' },
        missing: null,
      },
    ],
  },
  {
    id: 'ci-loop',
    decision: 'D109',
    version: V1_20,
    title: 'CI back to the session, Merge PR, issues as todos',
    steps: [
      {
        id: 'chip',
        title: "The session's pull request, at a glance",
        what: "When a session's branch has an open pull request, its header shows a chip: CI running, failed, green (or ready to merge) and merged. A failed check sends the end of the failing job's log to the session, which fixes it and pushes; after a few tries (or the same failure twice) Switchboard stops and asks you in the Inbox. Green and approved, the Inbox offers Merge PR: nothing merges without your click.",
        todo: ['Look at the chip next to the session\'s title; click it to open the pull request.', 'In the Inbox, press Merge PR on a "ready to merge" item, then Remove worktree once it is merged.'],
        anchors: ['session-ci-chip'],
        route: { view: 'session' },
        missing: "The chip shows next to a session's title once its branch has an open pull request (CI running, failed, green, merged). Failed checks go back to the session with their log; green and approved PRs get Merge PR in the Inbox.",
      },
      {
        id: 'settings',
        title: 'Tune the loop',
        what: 'Choose whether failures go to the session, how many fixes per pull request, how much of the log is sent, how often pull requests are read, and how Merge PR merges (the repository\'s default, squash, merge or rebase).',
        todo: ['Open Settings → CI & pull requests.', 'Change what you need; it applies from the next read.'],
        anchors: ['settings-ci'],
        route: { view: 'settings', section: 'ci' },
        missing: null,
      },
      {
        id: 'import',
        title: 'Import issues as todos',
        what: "Bring GitHub issues (a repository's open issues, by label or assigned to you) or Jira issues (a project key or JQL, through the Jira connection of Settings → Jira) into a session's todo list, with a link back. Issues imported before are skipped.",
        todo: ['Press Import issues… on the Todos page (or Import… on a session\'s todo strip).', 'Pick the source, Preview, tick the issues and Import.'],
        anchors: ['todos-import', 'todo-import'],
        route: { view: 'todos' },
        missing: null,
      },
    ],
  },
  {
    id: 'move-target',
    decision: 'D110',
    version: V1_21,
    title: 'Choose where a moved session lands',
    steps: [
      {
        id: 'folders',
        title: 'Choose the folders on the other machine',
        what: "Moving a session (or a Team member) to a paired machine no longer assumes its repos sit at the same paths. Choose folders on that machine (its saved folders, a typed path, or Browse its folders); it looks for each repo by its remote and shows ✓ found, ⚠ on another branch / with changes / to be cloned / several to choose from, ✖ blocked. Move is enabled only when every repo is found or will be cloned, and the next move of that folder remembers your choice.",
        todo: ['Open a session that runs on this machine and press Move to <machine> ▸ (or Take over to this machine on a paired one).', 'Press Choose folders… and pick the workspace or code folder on that machine.', 'Check the table, pick a checkout where there are several, then Move.'],
        anchors: ['session-takeover'],
        route: { view: 'session' },
        missing: 'Move to <machine> ▸ sits in the header of a session once a paired machine is online (Settings → Machines). In its dialog, Choose folders… picks where the repos are on that machine.',
      },
    ],
  },
  // Plans (D99) hook: the D99 follow-up's tour, shown only while Plans is available like the Plans tour (src/web/plans/store.ts; docs/plans-removal.md).
  {
    id: 'plans-any',
    decision: 'D99',
    version: V1_22,
    title: 'Plans for anything',
    steps: [
      {
        id: 'target',
        title: 'Any target branch, or none',
        what: 'A plan no longer needs an epic branch. Target dev or main (agents merging straight into it needs your tick in the Start dialog), or leave the target empty for work that is not merged at all: research, docs elsewhere, ops tasks. Such a plan still runs its items in order within its limits, and an item is done when its agent marks it done; the ones you mark ⚑ wait for your Done.',
        todo: ['Press ＋ New plan and leave the target branch empty.', 'Tick the todos, Create plan, then ▶ Start plan.'],
        anchors: ['plans-new'],
        route: { view: 'plans' },
        missing: 'Open Plans in the sidebar. ＋ New plan takes an optional target branch: empty means no merge step.',
      },
    ],
  },
  // Project memory (D107) hook: the scopes follow-up's tour (docs/memory-removal.md).
  {
    id: 'memory-scopes',
    decision: 'D107',
    version: V1_22,
    title: 'Memory for a member, a repo or the folder',
    steps: [
      {
        id: 'scopes',
        title: 'Who an entry is for',
        what: "Every memory entry now has a scope: one Team member, the sessions working in one repository, or everyone in the folder (Workspace; every entry you had). A member's session gets its own entries first, then its repositories', then the folder's, each with its share of the block, so a member's knowledge is never pushed out by the rest. Agents suggest the narrowest scope; you confirm or change it when you approve.",
        todo: ['Pick a scope in the filter to see only those entries.', 'In the review queue, check the scope each proposal suggests and change it before Approve if it is wrong.'],
        anchors: ['memory-kind', 'memory-queue'],
        route: { view: 'memory' },
        missing: 'Open Memory in the sidebar to see this. ',
      },
      {
        id: 'draft',
        title: 'Draft memory from a session',
        what: "A session's ⋯ menu (and a member's) has Draft memory from this session: its own agent reviews its history and proposes its durable facts. Draft memory for all members asks every Team member at once. Nothing is applied: the proposals wait for you here.",
        todo: ['Press Draft memory for all members (with Team on), or a session\'s ⋯ → Draft memory from this session.', 'Review the proposals here when they arrive.'],
        anchors: ['memory-draft-all', 'memory-queue'],
        route: { view: 'memory' },
        missing: "Use a session's ⋯ menu in the sidebar → Draft memory from this session; with Team on, Draft memory for all members sits on this page and in the Team page's header. ",
      },
    ],
  },
  // Team (D100) hook: the sidebar's member rows (D100 follow-up 2026-10-16; docs/team-removal.md).
  {
    id: 'team-sidebar',
    decision: 'D100',
    version: V1_23,
    title: 'Who is working, in the sidebar',
    steps: [
      {
        id: 'members',
        title: 'Each team lists its members',
        what: "Under each team in the sidebar, its members are listed in the team's order: a blue ● while one works (with its current item, like PROJ-14 · 40m), ? when it needs you, ○ idle (and for how long), ⏸ paused, ⌁ offline. Click a member to open it on the Team page with its chat. The ▾ / ▸ in front of a team folds it to one line (\"2 working · 1 idle\"); each team remembers how you left it.",
        todo: ['Look at the member rows under your team.', 'Click a member to open it; fold the team with ▸ when you need the room.'],
        anchors: ['sidebar-team'],
        route: { view: 'team' },
        missing: TEAM_OPEN,
      },
    ],
  },
  // Team (D100) hook: the left column folds to a slim strip (D100 follow-up 2026-10-16; docs/team-removal.md).
  {
    id: 'team-left-column',
    decision: 'D100',
    version: V1_24,
    title: 'More room for the chat',
    steps: [
      {
        id: 'fold',
        title: 'Fold Needs you and Activity away',
        what: "The ‹ at the top of the Team page's left column (or the [ key) folds Needs you and Activity into a slim strip, so the member's chat gets the full width. The strip keeps the needs-you count as an amber badge and shows a dot when there is new activity; a new item makes the badge pulse but never opens the column. Click the strip, the badge or › (or press [ again) to bring it back; the page remembers how you left it.",
        todo: ['Press ‹ at the top of Needs you, or the [ key.', 'Click the strip or its badge to open the column again.'],
        anchors: ['team-left-column'],
        route: { view: 'team' },
        missing: `${TEAM_NO_MEMBER}On a phone the page is one column, with nothing to fold.`,
      },
    ],
  },
  {
    id: 'artifacts-delete',
    decision: 'D111',
    version: V1_25,
    title: 'Delete artifacts from the list',
    steps: [
      {
        id: 'delete',
        title: 'Delete one or several at once',
        what: "Each artifact row has a ⋯ with Delete…, here and in a session's Artifacts tab, also for artifacts whose session is gone. Tick rows (or Select all) to delete several at once; a row on an unreachable machine can't be picked.",
        todo: ["Open a row's ⋯ and choose Delete…, or tick a few rows.", 'Press Delete N and confirm.'],
        anchors: ['artifacts-select', 'artifacts'],
        route: { view: 'artifacts' },
        missing: 'Artifacts sits in the sidebar; its rows get a ⋯ and a checkbox once an agent has saved one.',
      },
    ],
  },
  {
    id: 'turn-status',
    decision: 'D124',
    version: V1_31,
    title: 'Sessions that wait for you',
    steps: [
      {
        id: 'needs-you',
        title: 'Done, or waiting for you?',
        what: "A session whose agent ended its turn with a question for you, or said it is waiting or blocked, now shows amber \"needs you\" with what it asks, in its row and header, with an Inbox item \"Waiting for you\". When Switchboard only read it from the agent's last message, it says \"detected\". Your reply clears it.",
        todo: ['Look for the amber ask under a session in the sidebar.', 'Open the session and reply, or press Not waiting when it is not waiting for you.'],
        anchors: ['sessions'],
        drawer: true,
        missing: 'Start a session: when its agent ends a turn waiting for you, its row and header say so.',
      },
    ],
  },
  {
    id: 'machine-power',
    decision: 'D125',
    version: V1_32,
    title: 'Battery and power draw',
    steps: [
      {
        id: 'footer',
        title: 'Battery, or the estimated draw',
        what: 'Under CPU and RAM: on a laptop its battery (🔋 discharging with the time left, ⚡ charging with the time to full); on a desktop an estimated total in watts (the GPU where it can be read, the CPU from its use, and a fixed baseline). Hover it for the details. A paired machine shows its own next to its name in Settings → Machines and on its sessions\' machine tags.',
        todo: ['Hover the PWR line for the details.', 'Pair another machine to see its battery or draw too.'],
        anchors: ['power'],
        drawer: true,
        missing: 'The power line sits under RAM at the bottom of the sidebar once this machine has a reading.',
      },
      {
        id: 'estimate',
        title: 'Tune the desktop estimate',
        what: "A desktop's draw is an estimate, never a measurement: CPU idle + CPU use × (max − idle) + the rest of the system, plus the GPU where it can be read. Set this machine's numbers here; an empty field keeps its default.",
        todo: ['Open Settings → Machines → Power estimate.', 'Enter the CPU idle and max watts and the rest of the system, then Save.'],
        anchors: ['power-estimate', 'settings-content'],
        route: { view: 'settings', section: 'machines' },
        missing: 'Power estimate is in Settings → Machines.',
      },
    ],
  },
  {
    id: 'processes',
    decision: 'D127',
    version: V1_34,
    title: 'Processes sessions leave running',
    steps: [
      {
        id: 'footer',
        title: 'What sessions left running',
        what: "Builds, test runs and dev servers an agent starts can outlive its turn (a .NET build server, a test host, a vite or dotnet watch). Switchboard tracks them per session: the line under RAM sums their memory while there are any, and each session's right panel lists its own under Processes, with Stop and Keep.",
        todo: ['Click the procs line at the bottom of the sidebar.', "Open a session's right panel to see its Processes."],
        anchors: ['processes-footer'],
        drawer: true,
        missing: 'The procs line sits under RAM at the bottom of the sidebar while sessions have processes running.',
      },
      {
        id: 'settings',
        title: 'Stopped by themselves',
        what: 'A session\'s leftovers stop when it is closed, and once it has been idle for the delay set here (10 min by default; never while it works or waits on a background task). Keep a process to leave it running; an agent can keep a dev server it leaves for you. Sessions also build .NET without build servers that linger.',
        todo: ['Open Settings → Processes.', 'Pick the idle delay, or Keep a process you still need.'],
        anchors: ['processes-settings', 'settings-content'],
        route: { view: 'settings', section: 'processes' },
        missing: 'Processes is in Settings; its list fills while sessions have processes running.',
      },
    ],
  },
  {
    id: 'multi-select-answers',
    decision: 'D128',
    version: V1_35,
    title: 'Pick several answers',
    steps: [
      {
        id: 'choose-any',
        title: 'Choose any',
        what: 'When an agent asks a multi-select question, its card says "Choose any" and its options are checkboxes: tick as many as apply, and tick Other… to add your own words alongside them. The agent gets every choice.',
        todo: ['Tick the options that apply (Space toggles one).', 'Tick Other… to add your own words, then press Send (or Enter).'],
        anchors: ['question-card'],
        route: { view: 'inbox' },
        missing: 'Shown on a question card in the Inbox or the chat once an agent asks a multi-select question.',
      },
    ],
  },
  // D132: Team, Plans and Project memory left Settings → Experimental: always on, no switch.
  {
    id: 'graduated',
    decision: 'D132',
    version: V2_0,
    title: 'Team, Plans and Project memory are always on',
    steps: [
      {
        id: 'nav',
        title: 'No switches any more',
        what: 'Team, Plans and Project memory are no longer experimental: they are on for everyone and Settings → Experimental is gone. Nothing changes until you use them: no session leaves your list until you make it a team member, nothing runs until you start a plan, and no memory reaches a session until you approve an entry. The Jira connection moved to Settings → Jira.',
        todo: ['Find Plans, Team and Memory in the sidebar.', 'Open one when you need it.'],
        anchors: ['plans', 'team', 'memory'],
        drawer: true,
        missing: 'Plans, Team and Memory sit in the sidebar. ',
      },
    ],
  },
  // D131: Switchboard 2 ships the v2 theme; Classic stays one switch away.
  {
    id: 'two-themes',
    decision: 'D131',
    version: V2_0,
    title: 'Two looks: v2 and Classic',
    steps: [
      {
        id: 'theme',
        title: 'Switch to v2 or back',
        what: 'Switchboard 2 comes with a new design, v2, and keeps this one as Classic. Both show the same agents, folders and settings; the choice is kept in this browser (each phone chooses its own).',
        todo: ['Press v2 to try the new design (Classic stays one switch away, in its Settings › Appearance).', 'Or make your choice the default for new browsers.'],
        anchors: ['theme-switch'],
        route: { view: 'settings', section: 'appearance' },
        missing: 'Settings → Appearance has the Theme switch. ',
      },
    ],
  },
  // D131: the v2 theme's own tour, shown once on the first v2 load (src/web/v2/tour/).
  {
    id: V2_WELCOME_ID,
    decision: 'D131',
    version: V2_0,
    title: 'Welcome to Switchboard 2',
    ui: 'v2',
    steps: [
      {
        id: 'home',
        title: 'Home and Needs you',
        what: 'Home shows what needs you, what is working now and what was done today. Needs you is one queue for every question, approval and stop, from every agent and computer: answer right there, with Undo for a few seconds.',
        todo: ['Answer the cards under Needs you (keys 1–9 work on a focused card).', 'Open Needs you for the full queue with its filters.'],
        anchors: ['v2-home-needs', 'v2-needs'],
        v2Route: '/',
        missing: 'Home lists what needs you; the Needs you button shows its count. ',
      },
      {
        id: 'start',
        title: 'The start box',
        what: 'Write what an agent should do and press Start agent; the folder and the computer next to it can be changed first. The chips under it start something else, such as a task, a project or a routine.',
        todo: ['Describe the work in a sentence.', 'Check the folder and the computer, then press Start agent (⌘↩).'],
        anchors: ['v2-start'],
        v2Route: '/',
        missing: 'The start box sits at the top of Home. ',
      },
      {
        id: 'agents',
        title: 'Agents and folders',
        what: 'Every agent, grouped in your folders. List groups them by folder, Chats shows them like a messenger, Board sorts them by status.',
        todo: ['Switch between List, Chats and Board.', 'Show or hide the folder tree with ⌘\\.'],
        anchors: ['v2-agents-view', 'v2-nav-agents', 'v2-tab-agents'],
        v2Route: '/agents',
        missing: 'Open Agents to see every agent in its folder. ',
      },
      {
        id: 'agent',
        title: 'One agent',
        what: 'An agent is its chat, the changes it made, its results and its helpers. The side panel (⌘.) holds its details: computer, usage, routines and helpers. Each reply has a ⋯ menu: copy it, save it as a result, add it to tasks or undo from there.',
        todo: ['Press ⌘. (or Details) to show or hide the side panel.', 'Hover a reply and open its ⋯ menu.'],
        anchors: ['v2-agent-details'],
        v2Route: 'agent',
        missing: 'Start an agent from Home to see its view. ',
      },
      {
        id: 'projects-crews',
        title: 'Projects and Crews',
        what: 'Projects split a bigger piece of work into steps that agents run in order; Crews are standing teams of agents (teammates) with roles. Both are always on now: Settings › Experimental is gone and the Jira connection is under Settings › Advanced › Jira.',
        todo: ['Open Projects to plan work in steps.', 'Open Crews to give agents roles and a lead.'],
        anchors: ['v2-nav-projects', 'v2-tab-more'],
        v2Route: '/projects',
        missing: 'Projects and Crews are in the rail (on a phone: under More). ',
      },
      {
        id: 'appearance',
        title: 'Prefer the old look?',
        what: 'Settings › Appearance switches this browser back to Classic, the design of Switchboard 1, at once and without a reload. Everything stays where it is; you can come back any time.',
        todo: ['Choose v2 or Classic for this browser.', 'Make your choice the default for new browsers if you like.'],
        anchors: ['v2-theme'],
        v2Route: '/settings/appearance',
        missing: 'Settings › Appearance has the Theme switch. ',
      },
    ],
  },
  // D134: Insights → Usage ("Where your usage went"); in classic (v2 runs only its welcome tour).
  {
    id: 'usage-breakdown',
    decision: 'D134',
    version: V2_1,
    title: 'Where your usage went',
    steps: [
      {
        id: 'section',
        title: 'Which sessions used your limits',
        what: 'Insights now ranks the sessions by the tokens they used in each account’s current 5-hour or weekly window (or today, or the last 7 days), with their share, cache reads, replies, models and cost. Subagents and workflow agents count towards their session. The share is of the tokens Switchboard recorded, not of the limit itself.',
        todo: ['Pick the period and, if you like, one account.', 'Group by folder, model, account or kind to see it another way.'],
        anchors: ['insights-usage'],
        route: { view: 'insights' },
        missing: 'Open Insights (the bar-chart icon) and scroll to Where your usage went. ',
      },
    ],
  },
  // Project memory (D107) hook: D135's tour (docs/memory-removal.md); in classic (v2 runs only its welcome tour).
  {
    id: 'memory-changes',
    decision: 'D135',
    version: V2_2,
    title: 'Agents propose changes to memory',
    steps: [
      {
        id: 'review',
        title: 'Edits and removals, reviewed like proposals',
        what: 'An agent that finds an approved entry wrong or outdated now proposes an edit or its removal, with a reason, instead of adding a contradicting entry. An edit shows the entry now and as proposed side by side; approving replaces it (same entry), approving a removal deletes it, rejecting leaves it as it is. Nothing changes until you approve.',
        todo: ['Open the Memory page when a proposal waits.', 'Compare, then Approve, Edit… or Reject.'],
        anchors: ['memory-queue'],
        route: { view: 'memory' },
        missing: 'Open Memory (the book icon) to see the proposals. ',
      },
    ],
  },
  // Project memory (D107) hook: D136's tour (docs/memory-removal.md); in classic (v2 runs only its welcome tour).
  {
    id: 'memory-checks',
    decision: 'D136',
    version: V2_3,
    title: 'Notes are checked for you',
    steps: [
      {
        id: 'check',
        title: 'Stored notes stay true',
        what: 'Switchboard now checks project memory by itself. A new proposal is compared with the approved notes, and a duplicate or a contradiction shows on its card ("Approve and remove the old note" does both at once). Once a week, a short read-only check per folder verifies the notes against the code: a note that is no longer true is removed (Restore brings it back for 30 days), an edit waits for your review. No session opens; the cost shows in Insights › Usage as "Memory check".',
        todo: ['Open Memory to see when the folder was last checked.', 'Use Check now, or switch it off in Settings › Project memory.'],
        anchors: ['memory-check'],
        route: { view: 'memory' },
        missing: 'Open Memory (the book icon) to see the last check. ',
      },
    ],
  },
  // D137: the archive (docs/cleanup.md → The archive); in classic (v2 runs only its welcome tour).
  {
    id: 'session-archive',
    decision: 'D137',
    version: V2_3,
    title: 'Archived sessions go by themselves',
    steps: [
      {
        id: 'period',
        title: 'Archive instead of delete',
        what: 'Close is now Archive. An archived session stays in History, where Restore brings it back, and is deleted by itself after 14 days, quietly, with its worktree when nothing in it would be lost. Pinned sessions, Team members, plan sessions and sessions with an active loop are kept. Sessions archived before this version count from today, and changing the period never deletes anything at once. Your other paired computers’ archived sessions are listed too, with their own countdown, and Restore works on them.',
        todo: ['Pick the period (or Never) in Settings → Sessions & worktrees.', 'See each archived session’s countdown in History.'],
        anchors: ['setting-archive'],
        route: { view: 'settings', section: 'sessions' },
        missing: 'Settings → Sessions & worktrees has Delete archived sessions after. ',
      },
    ],
  },
  // D138: choosing the account overall and per plan (docs/accounts.md → Choosing the account); in classic (v2 runs only its welcome tour).
  {
    id: 'account-choice',
    decision: 'D138',
    version: V2_4,
    title: 'Choose the account',
    steps: [
      {
        id: 'overall',
        title: 'One account for every session',
        what: 'Pick the account sessions run on, per CLI: new sessions start on it and running ones move to it now (the same conversation; a running turn is interrupted and picked up again). Pinned sessions, and plans with their own account, keep theirs. If it runs out, automatic switching takes over and the chat says why; new sessions prefer it again once it has allowance. It replaces "New sessions start on: a fixed account". In the v2 theme it is in the usage pill.',
        todo: ['Pick an account (or Automatic) under Account for sessions.', 'Give a plan its own account when you start it, or in its limits.'],
        anchors: ['accounts-choice'],
        route: { view: 'settings', section: 'accounts' },
        missing: 'Settings → Accounts has Account for sessions once a CLI has a second account. ',
      },
    ],
  },
  // D131 · the redrawn v2 Project graph (docs/v2.md → Projects: the Graph view): a v2 tour, since the classic plan graph is unchanged.
  {
    id: 'project-graph',
    decision: 'D131',
    version: V2_4_2,
    title: 'The Project graph, redrawn',
    ui: 'v2',
    steps: [
      {
        id: 'graph',
        title: 'A project as a living graph',
        what: 'A project’s Graph now shows its steps by repository, each with a progress ring, arrows that move into the steps being worked on, and the critical path: the longest chain still to do. Hover a step to light up what it waits on and what waits on it. A minimap appears when the project does not fit. On a phone you can choose Graph too: pinch or double-tap to zoom, and long-press a step for its menu.',
        todo: ['Open a project and choose Graph.', 'Turn Critical path on or off; zoom with + / −, ⌘-scroll or a pinch.'],
        anchors: ['v2-project-graph', 'v2-nav-projects', 'v2-tab-more'],
        v2Route: '/projects',
        missing: 'Open a project in Projects and choose Graph to see it. ',
      },
    ],
  },
  // D140: update Switchboard remotely (docs/updates.md → Remote updates): a v2 tour on Settings › Computers.
  {
    id: 'remote-update',
    decision: 'D140',
    version: V2_4_3,
    title: 'Update your other computers from here',
    ui: 'v2',
    steps: [
      {
        id: 'computers',
        title: 'Update a paired computer remotely',
        what: 'Each paired computer’s card in Settings › Computers now shows its Switchboard version and, when a newer release is out, Update. You confirm first, then follow it: downloading, checking, installing, restarting, and the new version once it reconnects. The same works from your phone, and the phone’s Settings › Advanced › Updates updates the computer it is paired with. A computer that runs from a git checkout or is started by hand says it has to be updated there.',
        todo: ['Open Settings › Computers and look at a paired computer’s card.', 'Press Update when a newer version is available, or Check for updates.'],
        anchors: ['v2-computer-update'],
        v2Route: '/settings/computers',
        missing: 'Pair another computer in Settings › Computers to see its version and Update. ',
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

/** `true` for a tour of the v2 theme ({@link WhatsNewFeature.ui} `'v2'`); the main tour and every other tour are classic. */
export function isV2Tour(id: string, registry: readonly WhatsNewFeature[] = WHATS_NEW): boolean {
  return registry.some((feature) => feature.id === id && feature.ui === 'v2');
}

/** The ids among `ids` a UI can run: the v2 tours in v2, every other tour in classic. */
export function toursForUi(ids: readonly string[], ui: 'v2' | 'classic', registry: readonly WhatsNewFeature[] = WHATS_NEW): string[] {
  return ids.filter((id) => isV2Tour(id, registry) === (ui === 'v2'));
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

/**
 * D131 · the tours that open by themselves in the v2 theme: its pending tours,
 * and the welcome tour on any install where it was never shown (a brand-new
 * install queues only the classic main tour, so the welcome stands in for it in
 * v2; the main tour stays pending for a switch to Classic). Once finished or
 * skipped it never opens again (one state per machine, like every tour).
 */
export function v2AutoTours(state: TutorialState, registry: readonly WhatsNewFeature[] = WHATS_NEW): string[] {
  if (!state.autoOpen) return [];
  return state.whatsNew.filter((entry) => isV2Tour(entry.id, registry) && (entry.status === 'pending' || (entry.id === V2_WELCOME_ID && entry.status === null))).map((entry) => entry.id);
}

/** D131 · the classic tours ({@link V2_COVERS}) to record with the v2 welcome's outcome: those still pending. */
export function coveredByWelcome(state: TutorialState): string[] {
  return state.whatsNew.filter((entry) => V2_COVERS.includes(entry.id) && entry.status === 'pending').map((entry) => entry.id);
}

/** The tours that open by themselves now, in order (the main tour first; it is never mixed with What's-new). */
export function pendingTours(state: TutorialState): string[] {
  if (!state.autoOpen) return [];
  if (state.main.status === 'pending') return [MAIN_TOUR_ID];
  return state.whatsNew.filter((entry) => entry.status === 'pending').map((entry) => entry.id);
}
