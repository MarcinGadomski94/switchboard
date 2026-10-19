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

/** The version D88, D89, D90 and D91 ship in. */
const V1_14 = '1.14.0';
const V1_15 = '1.15.0';

/** The version D97 (search across everything) ships in. */
const V1_16 = '1.16.0';

/** The version D98 (accounts shared across paired machines), D100 (Team, experimental) and D99 (Plans, experimental) ship in. */
const V1_17 = '1.17.0';

/** The version D101 (the sidebar's navigation as an icon grid, collapsible TOOLS) ships in. */
const V1_18 = '1.18.0';

/** The version D106 (chats) ships in. */
const V1_19 = '1.19.0';

/** The version D107 (project memory, experimental), D108 (Insights) and D109 (the CI / pull-request feedback loop, importing issues as todos) ship in. */
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

/** Team (D100): the steps on the Team page say this when Team is off (they point to the switch). */
const TEAM_OFF = 'Team is experimental and off by default: switch it on in Settings → Experimental → Team, then open Team in the sidebar. ';

/** Team (D100): the steps that need a member. */
const TEAM_NO_MEMBER = 'This shows once Team is on (Settings → Experimental → Team) and has a member: adopt one with ＋ Member. ';

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
  // Plans (D99) hook: its What's-new tour, shown only while Plans is on (the web filters it: src/web/plans/store.ts; docs/plans-removal.md).
  {
    id: 'plans',
    decision: 'D99',
    version: V1_17,
    title: 'Plans (experimental)',
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
        what: "Or start from a Jira epic: Import from Jira… reads the epic's tickets and their links and makes a draft plan from them, each ticket a todo with its key. Nothing runs until you press ▶ Start plan.",
        todo: ['Press Import from Jira… (on the Plans page, or in a session\'s Plan tab).', 'Type the epic key, check the preview, and press Create plan.'],
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
    title: 'Team (experimental)',
    steps: [
      {
        id: 'switch',
        title: 'Team (experimental)',
        what: 'Run a set of role agents ("members") from one page: each member is one of your sessions with a role, a charter, a rhythm, a budget and the things it needs you for. It is off by default; while off nothing changes.',
        todo: ['Turn Team on here.', 'Open Team in the sidebar.'],
        anchors: ['experimental-team'],
        route: { view: 'settings', section: 'experimental' },
        missing: 'Team lives in Settings → Experimental. ',
      },
      {
        id: 'adopt',
        title: 'Adopt a session as a member',
        what: 'Switchboard suggests sessions that look like team members (recurring loops, mostly reading, mostly editing…) and drafts a charter for each. Adopting one moves it from your session list into Team, with its history, worktrees, todos and loops.',
        todo: ['Press ＋ Member (or Review on the banner).', 'Pick a suggestion, check its charter and gates, and press Adopt into the team.', 'Or start a new member from a template.'],
        anchors: ['team-add'],
        route: { view: 'team' },
        missing: TEAM_OFF,
      },
      {
        id: 'needs-you',
        title: 'Needs you, and Return to sessions',
        what: "Needs you lists everything your members wait for: their questions, permission requests and plan items ready to merge, and Team's own approvals (a budget); answer them in place. A member's ⋯ menu gives it a task, pauses it or moves it to your other machine, and ↩ Return to sessions puts its session back in its folder as a plain session. Switching Team off returns every member.",
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
        missing: TEAM_OFF,
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
    title: 'Project memory (experimental)',
    steps: [
      {
        id: 'switch',
        title: 'Project memory (experimental)',
        what: 'Agents can propose durable facts about a project (build commands, gotchas, decisions, where things live). Nothing reaches a session until you approve it; approved entries go to every new or resumed session in that folder. It is off by default.',
        todo: ['Turn Project memory on here.', 'Open Memory in the sidebar.'],
        anchors: ['experimental-memory'],
        route: { view: 'settings', section: 'experimental' },
        missing: 'Project memory lives in Settings → Experimental. ',
      },
      {
        id: 'review',
        title: 'Review what agents propose',
        what: "Proposals wait in the review queue of their folder, each linked to the session that made it, and the Inbox tells you when there are some. Approve one as it is, Edit… it first (your edit is what sessions get) or Reject it. You can add, pin, edit and delete entries yourself too.",
        todo: ['Pick a folder.', 'Approve, Edit… or Reject each proposal.', 'Press + Add entry to write one yourself; ☆ pins it first.'],
        anchors: ['memory-queue', 'memory-folder'],
        route: { view: 'memory' },
        missing: 'Switch Project memory on in Settings → Experimental, then open Memory in the sidebar. ',
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
        what: "Bring GitHub issues (a repository's open issues, by label or assigned to you) or Jira issues (a project key or JQL, through the Jira connection of Settings → Experimental → Plans) into a session's todo list, with a link back. Issues imported before are skipped.",
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
  // Plans (D99) hook: the D99 follow-up's tour, shown only while Plans is on like the Plans tour (src/web/plans/store.ts; docs/plans-removal.md).
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
        missing: 'Plans sits in the sidebar once Settings → Experimental → Plans is on. ＋ New plan takes an optional target branch: empty means no merge step.',
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
        missing: 'Switch Project memory on in Settings → Experimental, then open Memory in the sidebar. ',
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
        missing: TEAM_OFF,
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
