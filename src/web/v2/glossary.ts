import type { SessionStatus } from '../../core/model.ts';
import type { PlanItemState } from '../../core/plans.ts';
import type { TeamMemberStatus } from '../../core/team.ts';
import type { MachineState } from '../../core/peers.ts';

/**
 * D131 · the single source of the v2 UI's words (`docs/v2.md` → *Glossary*;
 * `docs/design/v2-prototype.html` and the brief's plain-language table). Every v2
 * screen takes its nouns, status words and button labels from here, so the same
 * thing is called the same everywhere. The classic UI keeps its own wording.
 *
 * Rule of thumb: the plain word on screen, the exact technical term only under
 * Advanced (and in tooltips where it helps a power user).
 */

/** A noun in its singular and plural. */
export interface Noun {
  readonly one: string;
  readonly many: string;
}

/** Today's concept → the v2 word (the brief's table, as Direction D chose). */
export const TERMS = {
  /** A session. */
  agent: { one: 'Agent', many: 'Agents' },
  /** A chat (read-only thinking partner). */
  conversation: { one: 'Conversation', many: 'Conversations' },
  /** A subagent (Task tool call / workflow agent). */
  helper: { one: 'Helper', many: 'Helpers' },
  /** A turn / an assistant message. */
  reply: { one: 'reply', many: 'replies' },
  /** A todo. */
  task: { one: 'Task', many: 'Tasks' },
  /** A plan. */
  project: { one: 'Project', many: 'Projects' },
  /** A plan item. */
  step: { one: 'step', many: 'steps' },
  /** A team. */
  crew: { one: 'Crew', many: 'Crews' },
  /** A team member. */
  teammate: { one: 'Teammate', many: 'Teammates' },
  /** A member's charter. */
  jobDescription: { one: 'Job description', many: 'Job descriptions' },
  /** An artifact. */
  result: { one: 'Result', many: 'Results' },
  /** Project memory entries ("What agents know"). */
  notes: { one: 'Note', many: 'Notes' },
  /** A loop / schedule. */
  routine: { one: 'Routine', many: 'Routines' },
  /** A repo / solution. */
  codeProject: { one: 'Code project', many: 'Code projects' },
  /** A worktree / branch (Advanced). */
  separateCopy: { one: 'Separate copy', many: 'Separate copies' },
  /** A pull request. */
  changeRequest: { one: 'Change request', many: 'Change requests' },
  /** CI checks. */
  automaticTests: { one: 'Automatic tests', many: 'Automatic tests' },
  /** A paired machine (or this one). */
  computer: { one: 'Computer', many: 'Computers' },
  /** A paired device. */
  phone: { one: 'Phone', many: 'Phones' },
  /** A tracked process a session left running. */
  backgroundApp: { one: 'Background app', many: 'Background apps' },
  /** The CLI (Claude Code, Codex, OpenCode), under Advanced. */
  aiEngine: { one: 'AI engine', many: 'AI engines' },
  /** MCP servers. */
  connections: { one: 'Connection', many: 'Connections' },
  /** A Claude / Codex login. */
  account: { one: 'Account', many: 'Accounts' },
  /** A sidebar folder. */
  folder: { one: 'Folder', many: 'Folders' },
} as const satisfies Readonly<Record<string, Noun>>;

/** Single words and phrases used across the UI. */
export const WORDS = {
  combine: 'Combine',
  combined: 'Combined',
  sendBack: 'Send back',
  credits: 'Paid extra usage',
  creditsShort: 'Paid extra',
  standingInstruction: 'Rules for every agent',
  contextMeter: 'Working memory',
  contextFull: 'Agent memory full',
  cleanSlate: 'Continue with a clean slate',
  modelSmart: 'Smart',
  modelFast: 'Fast',
  effort: 'Thinking depth',
  needsYou: 'Needs you',
  pinned: 'Pinned',
  thisComputer: 'this one',
  newThing: 'New',
  search: 'Search',
  searchEverything: 'Search everything',
  searchPlaceholder: 'Search agents, messages, results',
  shortcuts: 'Keyboard shortcuts',
  more: 'More',
  insights: 'Insights',
  home: 'Home',
  settings: 'Settings',
  undo: 'Undo',
  waitingForYou: 'Waiting for you…',
  notWaiting: 'Not waiting',
  allClear: 'All clear',
  allClearText: 'Nothing needs you right now. We’ll tell you here, in the chat and on your phone.',
} as const;

/** Thinking depth (effort) in plain words, by the CLI's effort id. */
export const THINKING_DEPTH: Readonly<Record<string, string>> = { low: 'Light', medium: 'Normal', high: 'Deep', xhigh: 'Deeper', max: 'Deepest' };

// ── Status ───────────────────────────────────────────────────────────

/**
 * The statuses a v2 badge shows (always icon + word + colour, never colour alone).
 * `working` pulses; the others use the icon named in {@link STATUS}.
 */
export const V2_STATUSES = ['working', 'waiting', 'queued', 'needs', 'stopped', 'ready', 'done', 'idle', 'paused', 'userstop', 'offline', 'reconnecting', 'online'] as const;
/** A v2 status. */
export type V2Status = (typeof V2_STATUSES)[number];

/** A colour family of the tokens (`--v2-<tone>` / `--v2-<tone>-bg`). */
export type Tone = 'blue' | 'amber' | 'red' | 'green' | 'violet' | 'grey';

/** How a status is shown. `icon` names a v2 icon (`components/Icon.tsx`); `pulse` = the live dot. */
export interface StatusLook {
  readonly label: string;
  readonly icon: string;
  readonly tone: Tone;
}

/** The prototype's `ST` table (plus the computer states). */
export const STATUS: Readonly<Record<V2Status, StatusLook>> = {
  working: { label: 'Working', icon: 'pulse', tone: 'blue' },
  waiting: { label: 'Waiting on tests', icon: 'hourglass', tone: 'grey' },
  queued: { label: 'Waiting', icon: 'hourglass', tone: 'grey' },
  needs: { label: 'Needs you', icon: 'hand', tone: 'amber' },
  stopped: { label: 'Stopped', icon: 'octagon', tone: 'red' },
  ready: { label: 'Ready for approval', icon: 'half', tone: 'violet' },
  done: { label: 'Done', icon: 'check', tone: 'green' },
  idle: { label: 'Idle', icon: 'moon', tone: 'grey' },
  paused: { label: 'Paused', icon: 'pause', tone: 'grey' },
  userstop: { label: 'Stopped by you', icon: 'stop', tone: 'red' },
  offline: { label: 'Offline', icon: 'offline', tone: 'grey' },
  reconnecting: { label: 'Reconnecting', icon: 'refresh', tone: 'amber' },
  online: { label: 'Online', icon: 'check-circle', tone: 'green' },
};

/** A session's status (`need · run · done · fail · idle · paused`) in v2 words. */
export function sessionStatusToV2(status: SessionStatus): V2Status {
  switch (status) {
    case 'need':
      return 'needs';
    case 'run':
      return 'working';
    case 'done':
      return 'done';
    case 'fail':
      return 'stopped';
    case 'paused':
      return 'paused';
    default:
      return 'idle';
  }
}

/** A plan item's state in v2 words (a step of a Project). */
export function planItemStateToV2(state: PlanItemState): V2Status {
  switch (state) {
    case 'running':
      return 'working';
    case 'question':
    case 'needs-you':
      return 'needs';
    case 'stopped':
    case 'blocked':
      return 'stopped';
    case 'ready-to-merge':
    case 'to-confirm':
      return 'ready';
    case 'done':
      return 'done';
    default:
      // `waiting` (on its dependencies) and `ready` (about to start).
      return 'queued';
  }
}

/** A team member's status in v2 words (a Teammate). */
export function teammateStatusToV2(status: TeamMemberStatus): V2Status {
  switch (status) {
    case 'needs-you':
      return 'needs';
    case 'working':
      return 'working';
    case 'paused':
      return 'paused';
    case 'offline':
      return 'offline';
    default:
      return 'idle';
  }
}

/** A paired machine's connection in v2 words (a Computer). */
export function computerStateToV2(state: MachineState | null | undefined): 'online' | 'reconnecting' | 'offline' {
  if (state === 'online' || state === undefined || state === null) return 'online';
  return state === 'reconnecting' ? 'reconnecting' : 'offline';
}

/** Why a paired machine is not reachable, in plain words (shown under "Offline"). */
export function computerProblem(state: MachineState | null | undefined): string | null {
  switch (state) {
    case 'auth-failed':
      return 'It no longer accepts this computer. Pair it again.';
    case 'no-address':
      return 'It is not sharing an address. Turn on sharing there.';
    case 'offline':
      return 'Reconnects automatically.';
    default:
      return null;
  }
}

// ── Needs you ───────────────────────────────────────────────────────

/**
 * The kinds of a "needs you" item (the prototype's `KIND`): what the card asks.
 * `alert` covers usage / paid-extra alerts and anything only to acknowledge.
 */
export const NEEDS_KINDS = ['question', 'multi', 'approval', 'ready', 'pick', 'note', 'access', 'jd', 'routine', 'ask', 'stopped', 'alert'] as const;
/** A needs-you kind. */
export type NeedsKind = (typeof NEEDS_KINDS)[number];

/** How each kind is labelled (chip word, icon, status tone). */
export const NEEDS_KIND_LOOK: Readonly<Record<NeedsKind, { readonly label: string; readonly icon: string; readonly status: V2Status }>> = {
  question: { label: 'Question', icon: 'question', status: 'needs' },
  multi: { label: 'Question · choose any', icon: 'question', status: 'needs' },
  approval: { label: 'Approval', icon: 'shield', status: 'ready' },
  ready: { label: 'Ready for approval', icon: 'half', status: 'ready' },
  pick: { label: 'Pick code projects', icon: 'folder', status: 'needs' },
  note: { label: 'Note to approve', icon: 'book', status: 'ready' },
  access: { label: 'Access request', icon: 'shield', status: 'needs' },
  jd: { label: 'Job description', icon: 'crew', status: 'needs' },
  routine: { label: 'Routine failed', icon: 'routine', status: 'stopped' },
  ask: { label: 'Ask', icon: 'chat', status: 'needs' },
  stopped: { label: 'Stopped', icon: 'octagon', status: 'stopped' },
  alert: { label: 'Alert', icon: 'alert', status: 'needs' },
};

/** The Needs-you page's filter groups (the prototype's `FGROUP`). */
export const NEEDS_FILTERS = ['all', 'question', 'approval', 'ready', 'setup', 'ask', 'stopped'] as const;
/** A filter group. */
export type NeedsFilter = (typeof NEEDS_FILTERS)[number];

/** The filter chips' words. */
export const NEEDS_FILTER_LABELS: Readonly<Record<NeedsFilter, string>> = {
  all: 'All',
  question: 'Questions',
  approval: 'Approvals',
  ready: 'Ready for approval',
  setup: 'Notes & setup',
  ask: 'Asks',
  stopped: 'Stopped & alerts',
};

/** Which filter group each kind is in. */
export const NEEDS_FILTER_OF: Readonly<Record<NeedsKind, Exclude<NeedsFilter, 'all'>>> = {
  question: 'question',
  multi: 'question',
  approval: 'approval',
  ready: 'ready',
  ask: 'ask',
  stopped: 'stopped',
  alert: 'stopped',
  routine: 'stopped',
  pick: 'setup',
  note: 'setup',
  access: 'setup',
  jd: 'setup',
};

/** Where an item was answered, shown on its compact card ("· on Home"). */
export const ANSWERED_WHERE = {
  home: 'on Home',
  needs: 'in Needs you',
  chat: 'in the chat',
  board: 'on the Board',
  crew: 'on Crew',
  phone: 'on your phone',
} as const;
/** A place an answer was given. */
export type AnsweredWhere = keyof typeof ANSWERED_WHERE;

/** The answer cards' buttons and lines (the prototype's `cardHTML`). */
export const ANSWER = {
  tapToSend: 'Tap an answer to send it.',
  other: 'Other…',
  otherPlaceholder: 'Type your answer',
  send: 'Send',
  sendAnswer: 'Send answer',
  chooseAny: 'Choose any, then send.',
  choicesKept: 'Your choices so far are kept.',
  nothingChosen: 'Nothing chosen yet',
  chosen: (n: number): string => `${n} chosen · kept as a draft`,
  allowOnce: 'Allow once',
  alwaysAllow: 'Always allow',
  deny: 'Deny',
  combine: 'Combine',
  sendBack: 'Send back',
  sendBackPlaceholder: 'What should change?',
  viewChanges: 'View changes',
  replyTo: (name: string): string => `Reply to ${name}`,
  goAhead: 'Go ahead',
  notWaiting: 'Not waiting',
  tryAgain: 'Try again',
  openChat: 'Open chat',
  open: 'Open',
  dismiss: 'Dismiss',
  approve: 'Approve',
  editFirst: 'Edit first',
  reject: 'Reject',
  addKey: 'Add key',
  notNow: 'Not now',
  accept: 'Accept',
  edit: 'Edit',
  runNow: 'Run now',
  openRoutine: 'Open routine',
  ok: 'OK',
  manageUsage: 'Manage usage',
  pickHint: 'The project agent needs to know where this step’s code lives. Choose any.',
  offline: (computer: string): string => `${computer} is offline. You can answer when it reconnects.`,
  keys: (n: number): string => `keys 1–${n}`,
  // The compact (answered) card.
  youAnswered: (text: string): string => `You answered “${text}”`,
  youChose: (items: readonly string[]): string => `You chose ${items.join(', ')}`,
  youReplied: (text: string): string => `You replied “${text}”`,
  youAllowed: 'You allowed it once',
  youAlwaysAllowed: 'You always allow this here',
  youDenied: 'You denied it',
  youCombined: 'You combined it',
  youSentBack: 'You sent it back with a note',
  youMarkedNotWaiting: 'You marked it “not waiting”',
  youDismissed: 'You dismissed it',
  youApprovedNote: 'You approved the note',
  youRejectedNote: 'You rejected the note',
  youAccepted: 'You accepted the job description',
  youRetried: 'You asked it to try again',
  youPicked: (items: readonly string[]): string => `You picked ${items.join(', ')}`,
  gotIt: 'Got it',
  done: 'Done',
} as const;

/**
 * The server's Inbox action ids (`InboxItem.actions[].id`) in v2 words. An id not
 * listed keeps the server's label.
 */
export const SERVER_ACTION_LABELS: Readonly<Record<string, string>> = {
  'allow-once': 'Allow once',
  'always-allow': 'Always allow',
  deny: 'Deny',
  dismiss: 'Dismiss',
  keep: 'Keep',
  'plan-merge': 'Combine',
  'merge-pr': 'Combine',
  'open-plan': 'Open project',
  'open-session': 'Open chat',
  'open-pr': 'Open change request',
  'try-again': 'Try again',
  'retry-run': 'Try again',
  'open-fix-session': 'Fix it in a new agent',
  'remove-worktree': 'Remove the separate copy',
  'whats-new': 'What’s new',
  'plan-ask-repos': 'Ask again',
  'open-memory': 'Review notes',
  'memory-copy-retry': 'Try again',
  'memory-copy-keep': 'Keep on this computer',
};

/** The server's system-item labels (`SYSTEM_ITEM_LABELS`, src/server/inbox/wire.ts) in v2 words. */
export const SYSTEM_LABELS: Readonly<Record<string, string>> = {
  'Scheduled run failed': 'Routine failed',
  'PR merged': 'Change request combined',
  'Parent merged': 'Earlier change combined',
  'Parent closed': 'Earlier change closed',
  'Update available': 'Update available',
  'Ready to merge': 'Ready for approval',
  'Confirm done': 'Confirm it’s done',
  'Pick repositories': 'Pick code projects',
  Stopped: 'Stopped',
  'Waiting for you': 'Waiting for you',
  Reopened: 'Reopened',
  Memory: 'Notes',
  'CI keeps failing': 'Automatic tests keep failing',
};

/** A server action's v2 label (falls back to the server's own). */
export function actionLabel(id: string, serverLabel: string): string {
  return SERVER_ACTION_LABELS[id] ?? serverLabel;
}

// ── Rail, tabs, shortcuts ──────────────────────────────────────────────

/** The rail's six destinations, in order. */
export const RAIL_LABELS = {
  home: 'Home',
  agents: 'Agents',
  projects: 'Projects',
  crews: 'Crews',
  results: 'Results',
  settings: 'Settings',
} as const;

/** The phone's bottom tabs, in order. */
export const PHONE_TABS = {
  home: 'Home',
  needs: 'Needs you',
  agents: 'Agents',
  results: 'Results',
  more: 'More',
} as const;

/** The agent view's tabs. */
export const AGENT_TAB_LABELS = {
  chat: 'Chat',
  changes: 'Changes',
  results: 'Results',
  timeline: 'Timeline',
  helpers: 'Helpers',
} as const;

/** The v2 Settings sections. */
export const SETTINGS_LABELS = {
  usage: 'Usage & accounts',
  computers: 'Computers',
  phones: 'Phones',
  rules: 'Rules for every agent',
  appearance: 'Appearance',
  advanced: 'Advanced',
} as const;

/** The theme switch's words (both UIs show them). */
export const THEME_LABELS = {
  row: 'Theme',
  v2: 'v2',
  classic: 'Classic',
  description: 'The look of Switchboard on this browser. v2 is the new design; Classic is the design of Switchboard 1.',
  followDefault: 'Use the default',
  makeDefault: 'Make it the default for new browsers',
  isDefault: 'Default for new browsers',
} as const;

// ── Lane R · Results, Search, Insights, Settings, + New, ⌘K ─────────────
// Each area keeps its words in its own object below (one block per area, so the
// lane's parallel branches merge without touching each other's lines).

/** Lane R · Results (`/results`) and the result drawer. */
export const RESULTS_WORDS = {
  title: 'Results',
} as const;

// ── (lane R · Search) ──

/** Lane R · Search (`/search?q=`). */
export const SEARCH_WORDS = {
  title: 'Search',
} as const;

// ── (lane R · Insights) ──

/** Lane R · Insights (`/insights`). */
export const INSIGHTS_WORDS = {
  title: 'Insights',
} as const;

// ── (lane R · Settings) ──

/** Lane R · Settings (`/settings/*`). */
export const SETTINGS_WORDS = {
  title: 'Settings',
} as const;

// ── (lane R · + New) ──

/** Lane R · the + New sheet. */
export const NEW_WORDS = {
  title: 'Start something new',
  sub: 'Pick what you need. You can change it later.',
  whatToStart: 'What to start',
  kinds: {
    agent: { label: 'Agent', sub: 'Does work in a code project', go: 'Start agent', icon: 'sparkle' },
    conversation: { label: 'Conversation', sub: 'Think it through; read-only', go: 'Start conversation', icon: 'chat' },
    task: { label: 'Task', sub: 'Add to your list, run it later', go: 'Add task', icon: 'task' },
    project: { label: 'Project', sub: 'Several steps that run in order', go: 'Create project', icon: 'projects' },
    routine: { label: 'Routine', sub: 'Repeats on a schedule', go: 'Create routine', icon: 'routine' },
    teammate: { label: 'Teammate', sub: 'A long-lived role in a crew', go: 'Add teammate', icon: 'crew' },
    crew: { label: 'Crew', sub: 'A team of teammates', go: 'Create crew', icon: 'crew' },
  },
  whichFolder: 'Which project folder?',
  noFolders: 'No project folder yet. Add one in Settings › Advanced › Code projects.',
  usedAgo: (ago: string) => `Used ${ago}`,
  neverUsed: 'Not used yet',
  whatToDo: 'What should it do?',
  whatToDoPlaceholder: 'Describe the outcome you want, like you’d ask a colleague. Paste or drop images and files.',
  attach: 'Attach a file or image',
  speed: 'Speed',
  smart: 'Smart · best results',
  fast: 'Fast · cheaper',
  depth: 'Thinking depth',
  depthNormal: 'Normal',
  depthDeep: 'Deep',
  computer: 'Computer',
  thisComputer: (name: string) => `${name} · this one`,
  offlineSuffix: 'offline',
  offlineWhy: (name: string) => `${name} is offline. Agents can start there once it reconnects.`,
  separateCopy: 'Work on a separate copy',
  separateCopyNote: 'your files stay untouched until you click Combine',
  separateCopyPlain: 'A plain folder has no git repository, so the agent works in the folder itself.',
  putItIn: 'Put it in',
  notInFolder: 'Not in a folder',
  advanced: 'Advanced',
  advancedNote: 'engine, account, model names, workspace questions, code projects, branch, Ultracode',
  askQuestions: 'Answer the workspace questions now',
  askQuestionsNote: 'Off: the agent asks what the workspace needs. On: you answer here (work type, mode, phase, coordination).',
  workType: 'Work type',
  mode: 'Mode',
  phase: 'Phase',
  coordination: 'Coordination',
  codeProjects: 'Code projects',
  codeProjectsNote: 'Leave empty to let the agent choose.',
  branch: 'Branch',
  branchPlaceholder: 'PROJ-123-short-name (follows the title)',
  engine: 'AI engine',
  account: 'Account',
  accountAuto: 'Automatic (the first with usage left)',
  model: 'Model',
  modelBySpeed: 'By speed (Smart / Fast)',
  ultracode: 'Ultracode',
  ultracodeNote: 'Runs larger work as tracked workflows.',
  titleField: 'Title',
  titlePlaceholder: 'Optional · named after the message',
  convNote: 'A conversation reads your project but never changes files. Click “Continue as agent” any time to turn it into one.',
  task: 'Task',
  taskDescription: 'Description',
  taskPlan: 'Handover plan',
  taskPlanNote: '· what an agent needs to pick it up later',
  priority: 'Priority',
  estimate: 'Estimate',
  estimateNone: 'Not estimated',
  forAgent: 'Whose list?',
  forAgentNote: 'A task lives in one agent’s list. Run it later from there or from Tasks.',
  noAgents: 'No open agent yet. Start an agent first.',
  projectName: 'Project name',
  projectOwner: 'Which agent plans it?',
  projectOwnerNote: 'The project runs that agent’s task list, each step in its own agent. Its folder decides where steps work.',
  projectSteps: 'Steps',
  projectStepsNote: 'One per line. Add “(after <step>)” to make a step wait.',
  importJira: 'Import steps from a Jira epic',
  orWriteSteps: 'or write the steps below, one per line',
  routineWhat: 'What should it do each time?',
  routineAgent: 'Which agent runs it?',
  routineHow: 'How often',
  routineCron: 'Cron (minute hour day month weekday)',
  routineOn: (name: string) => `Runs on ${name}, where the agent is.`,
  routineNote: 'Routines skip a run while they’re waiting for you, and tell you if a run fails.',
  roleFrom: 'Start from a role:',
  adopt: 'Make an existing agent a teammate instead',
  adoptAgent: 'Agent to adopt',
  role: 'Role',
  joinsCrew: 'Joins which crew?',
  jobDescription: 'Job description',
  owns: 'What it owns',
  produces: 'What it produces',
  neverDoes: 'What it never does',
  teammateFolder: 'Project folder',
  crewName: 'Crew name',
  crewJob: 'What does this crew do?',
  crewNote: 'The crew gets its own folder in Agents and goes last in your crew order. Add teammates next.',
  saveDraft: 'Save as draft',
  draftSaved: 'Draft saved. It opens here next time, on this computer and your phone.',
  draftRestored: 'Your draft is back.',
  clearDraft: 'Clear draft',
  cancel: 'Cancel',
  working: 'Working…',
  started: (name: string) => `Started “${name}”.`,
  taskAdded: (title: string, agent: string) => `Task added to ${agent}: “${title}”.`,
  routineMade: (agent: string) => `Routine added to ${agent}.`,
  projectMade: (title: string) => `Project “${title}” created as a draft. Start it from the project.`,
  teammateMade: (name: string) => `${name} joined the crew.`,
  crewMade: (name: string) => `Crew “${name}” created.`,
  show: 'Show',
  errors: {
    folder: 'Pick a project folder.',
    message: 'Say what it should do.',
    title: 'Give it a title.',
    titleLong: (max: number) => `At most ${max} characters.`,
    agent: 'Pick an agent.',
    steps: 'Write at least one step.',
    cron: 'Not a schedule: use five fields, like 0 8 * * 1-5.',
    role: 'Name the role.',
    crew: 'Pick a crew.',
    crewName: 'Name the crew.',
    computerOffline: 'That computer is offline.',
    branch: 'Name the branch after its ticket, like PROJ-123-short-name.',
    attachments: 'Wait for the attachments to finish.',
  },
} as const;

// ── (lane R · ⌘K) ──

/** Lane R · the ⌘K palette. */
export const PALETTE_WORDS = {
  placeholder: 'Search agents, messages, results, settings…',
  label: 'Search agents, messages, results, settings',
  commands: 'Results',
  groups: {
    quick: 'Quick capture',
    messages: 'Messages',
    agents: 'Agents & projects',
    results: 'Results',
    pages: 'Pages',
    actions: 'Actions',
    search: 'Search',
  },
  hintMove: 'move',
  hintOpen: 'open',
  hintSearch: 'search on every computer',
  hintClose: 'close',
  nothing: 'Nothing found on any computer. Try fewer words.',
  searchFor: (q: string) => `Search everything for “${q}”`,
  addTask: (title: string) => `Add task: ${title}`,
  addTaskTo: (agent: string) => `↩ adds it to ${agent}’s tasks`,
  noAgentForTask: 'Start an agent first: a task lives in an agent’s list.',
  taskAdded: (title: string, agent: string) => `Task added to ${agent}: “${title}”.`,
  project: 'Project',
  crew: 'Crew',
  result: 'Result',
  conversation: 'Conversation',
  page: 'Page',
  settingsPrefix: 'Settings ›',
  advancedPrefix: 'Settings › Advanced ›',
  actions: {
    newAgent: 'New agent',
    newConversation: 'New conversation',
    newTask: 'New task',
    newProject: 'New project',
    newRoutine: 'New routine',
    newTeammate: 'New teammate',
    newCrew: 'New crew',
    quickTask: 'task … quick capture',
    searchEverything: 'Search everything',
    classic: 'Switch to the classic theme',
    light: 'Use the light look',
    dark: 'Use the dark look',
    system: 'Follow the computer’s light or dark',
    shortcuts: 'Keyboard shortcuts',
    tours: 'Replay a What’s new tour',
    routines: 'Routines',
    closed: 'Closed agents (history)',
    pairPhone: 'Pair a phone',
    addComputer: 'Add a computer',
  },
} as const;
