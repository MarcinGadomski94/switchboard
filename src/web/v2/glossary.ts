import type { SessionStatus } from '../../core/model.ts';
import { type ArchiveKeptReason, archiveCountdownText, archivePolicyText } from '../../core/session-archive.ts';
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
  recent: 'Recent',
  recentActions: 'Recent: more',
  clearRecent: 'Clear recent',
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
  // Lane X
  /** The phone top bar's ⌘K button (the palette). */
  quickOpen: 'Go to or do anything',
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
export const NEEDS_KINDS = ['question', 'multi', 'approval', 'ready', 'pick', 'note', 'note-edit', 'note-removal', 'access', 'jd', 'routine', 'ask', 'stopped', 'alert'] as const;
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
  // D135: an agent proposes to change or remove an approved note.
  'note-edit': { label: 'Note edit', icon: 'edit', status: 'ready' },
  'note-removal': { label: 'Note removal', icon: 'trash', status: 'ready' },
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
  'note-edit': 'setup',
  'note-removal': 'setup',
  access: 'setup',
  jd: 'setup',
};

// ── Lane H · Home + Needs you ───────────────────────────────────────────
// Lane H's words, in their own block (so the lanes' parallel branches merge
// without touching each other's lines).

/** Lane H · Home (`/`): the greeting, the start box, Working now, Done today. */
export const HOME_WORDS = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
  nothingNeedsYou: 'Nothing needs you',
  oneNeedsYou: '1 thing needs you',
  manyNeedYou: (n: number): string => `${n} things need you`,
  working: 'working',
  doneToday: 'done today',
  startLabel: 'What should an agent do?',
  startPlaceholder: 'What should an agent do? For example: “Fix the login timeout on the checkout page”',
  startPhonePlaceholder: 'What should an agent do?',
  folder: 'Project folder',
  noFolder: 'No folder saved',
  computer: 'Computer',
  speed: 'Speed',
  moreOptions: 'More options',
  startAgent: 'Start agent',
  starting: 'Starting…',
  justAsk: 'Just ask (conversation)',
  addTask: 'Add a task',
  newProject: 'New project',
  newRoutine: 'New routine',
  startSomethingElse: 'Start something else',
  started: (folder: string): string => `Agent started in ${folder}. We’ll tell you if it needs you.`,
  startedHere: 'Agent started. We’ll tell you if it needs you.',
  open: 'Open',
  needsHint: 'Answer here, in the agent’s chat, or on your phone',
  seeAll: (n: number): string => `See all ${n}`,
  seeAllWaiting: (n: number): string => `See all ${n} waiting`,
  workingNow: 'Working now',
  workingHint: 'Click to open an agent',
  allAgents: 'All agents',
  nothingRunning: 'Nothing running. Start an agent above.',
  nothingRunningPhone: 'Nothing running.',
  startedAt: (time: string): string => `started ${time}`,
  justNow: 'just now',
  helpers: (n: number): string => (n === 1 ? '1 helper' : `${n} helpers`),
  approvalWaiting: 'approval waiting',
  offlineCard: (computer: string): string => `${computer} is offline. Stop and Send wait until it reconnects.`,
  reconnectingCard: (computer: string): string => `Reconnecting to ${computer}…`,
  doneTodayTitle: 'Done today',
  allResults: 'All results',
  nothingDone: 'Nothing finished yet today.',
  showMore: (n: number): string => `Show ${n} more`,
  showLess: 'Show less',
  doneAgo: (ago: string): string => `Done ${ago}`,
  activeAgo: (ago: string): string => `Last active ${ago}`,
  resultFrom: (agent: string, time: string): string => `Result from ${agent} · ${time}`,
  resultAt: (time: string): string => `Result · ${time}`,
  version: (n: number): string => `v${n}`,
  changeRequest: (n: number): string => `Change request #${n}`,
  testsPassed: 'automatic tests passed',
  testsFailed: 'automatic tests failed',
  testsRunning: 'automatic tests running',
  combined: 'combined',
  download: 'Download',
  // Lane X · P1: why Start agent is disabled (its tooltip).
  startNeedsText: 'Type what the agent should do first',
  startComputerOffline: 'The chosen computer is not online',
  startLoadingFolders: 'Loading the folders…',
} as const;

/** Lane H · the Needs-you page (`/needs-you`). */
export const NEEDS_PAGE_WORDS = {
  sub: 'One queue for every agent, project step, teammate and computer. The same cards sit in each agent’s chat; answer either one and both update.',
  phoneSub: 'Every ask, answerable right here. Answers sync to your computers.',
  filterLabel: 'Filter',
  keyHintTab: 'to a card, then',
  keyHintAnswer: 'to answer',
  nothingOfKind: 'Nothing of this kind',
  tryAll: 'Try “All”.',
  showAll: 'Show all',
  loadError: 'Needs you could not be loaded',
} as const;

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
  /** Lane H: the Needs-you page's link to the item's agent. */
  openAgent: 'Open agent',
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
  // D135: a proposed change of an approved note.
  approveRemoval: 'Approve removal',
  // D136: a proposal the memory check flagged (a duplicate or a conflict with an approved note).
  approveReplace: 'Approve and remove the old note',
  youApprovedNoteEdit: 'You approved the edit',
  youRejectedNoteEdit: 'You kept the note as it was',
  youApprovedNoteRemoval: 'You removed the note',
  youRejectedNoteRemoval: 'You kept the note',
  youAccepted: 'You accepted the job description',
  youRetried: 'You asked it to try again',
  youPicked: (items: readonly string[]): string => `You picked ${items.join(', ')}`,
  gotIt: 'Got it',
  done: 'Done',
  // Lane X · P1: why Send answer is disabled (its tooltip).
  answerEveryQuestion: 'Answer every question first',
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

/** The rail's seven destinations, in order. */
export const RAIL_LABELS = {
  home: 'Home',
  agents: 'Agents',
  projects: 'Projects',
  crews: 'Crews',
  results: 'Results',
  tasks: TERMS.task.many,
  settings: 'Settings',
} as const;

/** The rail's Tasks item read aloud with its count of tasks not done yet. */
export const railTasksLabel = (count: number): string => `${RAIL_LABELS.tasks}, ${count} not done`;

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
  sub: 'Files your agents made. Every version is kept.',
  layout: 'Layout',
  grid: 'Grid',
  list: 'List',
  typeFilter: 'Type',
  filters: {
    all: 'All',
    documents: 'Documents',
    pdfs: 'PDFs',
    diagrams: 'Diagrams',
    images: 'Images',
    tables: 'Tables',
    web: 'Web pages',
    code: 'Code',
  },
  kinds: {
    markdown: 'Markdown',
    code: 'Code',
    html: 'Web page',
    mermaid: 'Diagram',
    svg: 'Diagram',
    image: 'Image',
    pdf: 'PDF',
    csv: 'Table',
  },
  searchWithin: 'Search within results…',
  searchLabel: 'Search within results',
  loading: 'Loading results…',
  loadFailed: 'The results could not be loaded.',
  tryAgain: 'Try again',
  emptyTitle: 'No results yet',
  emptyText: 'Reports, diagrams, tables and files your agents save show up here, with every version.',
  emptyFilterTitle: (filter: string): string => `No ${filter.toLowerCase()} yet`,
  emptyFilterText: 'Try another type, or clear the search.',
  noMatchTitle: 'Nothing matches',
  noMatchText: 'Try fewer words, or another type.',
  select: (title: string): string => `Select ${title}`,
  selected: (n: number): string => `${n} selected`,
  selectAll: 'Select all shown',
  delete: 'Delete',
  clear: 'Clear',
  deleted: (n: number): string => (n === 1 ? 'Deleted 1 result' : `Deleted ${n} results`),
  deleteFailed: (n: number, why: string): string => `${n} could not be deleted: ${why}`,
  from: (agent: string): string => `From ${agent}`,
  agentGone: 'Its agent is gone',
  version: (n: number): string => `v${n}`,
  versions: 'Versions',
  compare: 'Compare',
  compareOne: 'Only one version so far.',
  newer: 'newer',
  source: 'Source',
  rendered: 'Rendered',
  copy: 'Copy',
  copied: (title: string): string => `Copied ${title}.`,
  download: 'Download',
  fullScreen: 'Full screen',
  exitFullScreen: 'Leave full screen',
  openAgent: 'Open agent',
  openPdf: 'Open PDF',
  csvCap: (shown: number, total: number): string => `Showing the first ${shown} of ${total} rows. Download for all of them.`,
  noPreview: 'This result’s agent is gone, so it can’t be previewed here. You can still delete it.',
  notFound: 'That result is gone.',
  preview: 'Result preview',
  savedByAgent: 'saved by the agent',
  savedByYou: 'saved by you',
} as const;

// ── (lane R · Search) ──

/** Lane R · Search (`/search?q=`). */
export const SEARCH_WORDS = {
  title: 'Search',
  sub: 'Every message, result, task and archived agent, on every computer.',
  input: 'Search',
  placeholder: 'Search messages, results, tasks and archived agents…',
  types: { all: 'Everything', messages: 'Messages', results: 'Results', tasks: 'Tasks', closed: 'Archived agents' },
  computerAny: 'Any computer',
  folderAny: 'Any folder',
  dates: { any: 'Any time', today: 'Today', week: 'This week' },
  computer: 'Computer',
  folder: 'Folder',
  date: 'Date',
  you: 'You',
  agent: 'Agent',
  exactMessage: 'Exact message',
  searched: 'Searched',
  notSearched: 'not searched',
  backSoon: 'its agents and results show up again when it’s back.',
  backSoonMany: 'their agents and results show up again when they’re back.',
  nothingTitle: 'Nothing found',
  nothingText: 'Try fewer words, or clear a filter.',
  hintTitle: 'Search everything',
  hintText: 'Words match anywhere, in any order. Use "quotes" for a phrase and a trailing * for a prefix (deploy*).',
  failed: 'Search failed. Try again.',
  indexing: 'Indexing older history…',
  showAll: 'Show all',
  showMore: 'Show more',
  thisComputer: 'This computer',
} as const;

// ── (lane R · Insights) ──

/** Lane R · Insights (`/insights`). */
export const INSIGHTS_WORDS = {
  title: 'Insights',
  back: 'Settings · Usage',
  subAll: 'across every computer',
  subOne: 'on',
  subCost: 'Costs are what the same work would cost on paid usage.',
  ranges: { today: 'Today', week: 'This week', month: 'This month' },
  rangeLabel: 'Range',
  folderAll: 'All folders',
  engineAll: 'All engines',
  modelAll: 'All models',
  accountAll: 'All accounts',
  computerAll: 'All computers',
  thisComputer: 'This computer',
  noFolder: 'No folder',
  defaultModel: 'Default model',
  folder: 'Folder',
  engine: 'AI engine',
  model: 'Model',
  account: 'Account',
  computer: 'Computer',
  suggestion: 'Suggestion:',
  switchRule: 'Switch',
  tiles: {
    time: 'Agent time',
    tokens: 'Tokens',
    cost: 'Cost',
    estimates: 'Estimates',
    rework: 'Rework',
    prices: 'Prices used',
  },
  tokensPerDay: 'Tokens per day',
  last7: 'Last 7 days',
  costWent: 'Where the cost went',
  estimateVsActual: 'Estimate vs. actual',
  estimateSub: 'Finished tasks by how long they took against their estimate',
  forecast: 'Forecast',
  noForecast: 'No usage readings yet.',
  everythingElse: 'Everything else',
  examplePrices: 'Example prices',
  yourPrices: 'Your prices',
  editPrices: 'edit them in Settings › Advanced',
  emptyTitle: 'Nothing in this range yet',
  emptyText: 'Agent time, tokens and cost show up here once agents have worked in it.',
  failed: 'Insights could not be loaded.',
  retry: 'Try again',
  backfill: 'Counting older work…',
} as const;

/** D134 · Insights → Usage ("Where your usage went", `/insights?view=usage`). */
export const USAGE_WORDS = {
  tabOverview: 'Overview',
  tabUsage: 'Usage',
  tabsLabel: 'Insights views',
  title: 'Where your usage went',
  periodLabel: 'Period',
  periods: { '5h': 'Current 5-hour window', week: 'This week', today: 'Today', '7d': 'Last 7 days' },
  periodsShort: { '5h': '5 hours', week: 'Week', today: 'Today', '7d': '7 days' },
  groupLabel: 'Group by',
  groups: { session: 'Agent', folder: 'Folder', model: 'Model', account: 'Account', kind: 'Kind' },
  accountAll: 'All accounts',
  computerAll: 'All computers',
  thisComputer: 'This computer',
  kinds: { agent: 'Agent', conversation: 'Conversation', crew: 'Teammate', plan: 'Plan step', routine: 'Routine', memory: 'Memory check' },
  tokens: 'Tokens',
  input: 'input',
  output: 'output',
  cacheWrite: 'cache writes',
  cacheRead: 'cache reads',
  share: 'Share',
  turns: 'Replies',
  models: 'Models',
  cost: 'Cost',
  open: 'Open',
  agentsLine: 'Subagents and workflow agents',
  ownLine: 'Its own replies',
  agentsNone: 'No subagent or workflow tokens recorded.',
  showAgents: 'Show the agents’ tokens',
  hideAgents: 'Hide the agents’ tokens',
  chartTitle: 'Tokens over time',
  chartOther: 'Everything else',
  logTitle: 'Usage log',
  logSub: 'Every reply in this period, newest first.',
  logFiltered: (label: string): string => `Only “${label}”.`,
  logAll: 'Show all',
  logFilter: 'Log',
  logFilterHint: (label: string): string => `Show only ${label} in the usage log`,
  logEmpty: 'No replies in this period.',
  prev: 'Newer',
  next: 'Older',
  page: (page: number, pages: number): string => `Page ${page} of ${pages}`,
  csv: 'Export CSV',
  empty: 'No tokens recorded in this period yet.',
  emptyHint: 'Agents’ replies show up here as soon as they finish.',
  noWindow: (names: string): string => `No window known yet for ${names}: no usage reading.`,
  sinceReset: (name: string): string => `${name}: the window reset and no newer reading came, so this counts from the reset.`,
  windowLine: (name: string, start: string, end: string, pct: string): string => `${name}: ${start} – ${end}${pct}`,
  pctUsed: (pct: number): string => ` · ${Math.round(pct)}% used`,
  shareOfAccount: 'share of this account’s recorded tokens in its window',
  shareOfAll: 'share of every recorded token in the period (each account in its own window)',
  estimate: (pct: string, window: string): string => `≈ ${pct} of the ${window} limit`,
  estimateTag: 'estimate',
  windowWords: { '5h': '5-hour', week: 'weekly' },
  infoTitle: 'How these numbers are counted',
  info: [
    'Shares are of the tokens Switchboard recorded: input, output and cache writes, the subagents’ and workflow agents’ included. They are not the limit itself: the provider’s usage % is not computed from tokens (Anthropic doesn’t publish the token cap), and it also counts use outside Switchboard.',
    'Cache reads are listed apart and left out of the share: they are the context read again on every call, far more numerous, and billed at about a tenth of the input rate.',
  ],
  infoEstimate: 'With one account picked, “≈ % of the limit” is an estimate: the share × the window’s usage %, as if every token weighed the same and all of the window’s use came through Switchboard.',
  costNote: 'Cost at the Insights prices (what the same work would cost on paid usage).',
  seeWhat: 'See what used it',
  more: (count: number, tokens: string): string => `${count} more with ${tokens} tokens`,
  failed: 'The usage breakdown could not be loaded.',
  retry: 'Try again',
  backfill: 'Counting the last week’s replies…',
  totalsLine: (tokens: string, turns: number, sessions: number): string => `${tokens} tokens · ${turns} ${turns === 1 ? 'reply' : 'replies'} · ${sessions} ${sessions === 1 ? 'agent' : 'agents'}`,
} as const;

// ── (lane R · Settings) ──

/** Lane R · Settings (`/settings/*`). */
export const SETTINGS_WORDS = {
  title: 'Settings',
  sub: 'The few things most people need. Everything else is under Advanced.',
  back: 'Settings',
  sectionsLabel: 'Settings sections',
  loading: 'Loading…',
  loadError: 'Settings could not be loaded.',
  saveError: 'The setting could not be saved.',
  // Usage & accounts
  usageSub: 'How much each account has left, and how agents move between them.',
  fiveHours: '5 hours',
  week: 'Week',
  paidExtra: 'Paid extra usage',
  outOfUsage: 'Out of usage',
  signIn: 'Sign in',
  signOut: 'Sign out',
  switchingTitle: 'Switching between accounts',
  switchingOn: 'Switch accounts automatically',
  switchingSub: 'Agents use the first account with usage left. Drag to change the order, or use the arrows.',
  switchAt: 'Switch when an account reaches',
  switchAtLimit: '100% (at the limit)',
  whenAllOut: 'When all are out',
  usePaidExtra: 'Use paid extra',
  pauseNewWork: 'Pause new work',
  switchBack: 'Switch back to the first account after it resets',
  warnTitle: 'Usage warnings',
  warnSub: 'A warning appears once per window, as a toast and in Needs you, when the 5-hour window or the weekly limit reaches this. Nothing is paused.',
  warnAt: 'Warn at Max usage',
  warnSaved: (pct: number): string => `You’ll be warned at ${pct}%.`,
  pinnedTitle: 'Pinned accounts',
  pinnedSub: 'A pinned agent always uses its account and never switches. You can also pin from the agent’s side panel (How it works › Account).',
  pinnedNone: 'No agent is pinned to an account.',
  pinButton: 'Pin account to agent',
  unpin: 'Unpin',
  insightsTitle: 'Insights',
  openInsights: 'Open Insights',
  /** D134: Settings › Usage & accounts → the Usage breakdown. */
  seeUsage: 'Where your usage went',
  noAccounts: 'No accounts yet.',
  // Computers
  computersSub: 'This computer and the ones paired with it. Agents, results and questions from all of them show up everywhere.',
  thisComputer: 'This computer',
  reconnectNow: 'Reconnect now',
  retryIn: 'retry in',
  backgroundApps: 'Background apps',
  noBackgroundApps: 'Nothing is running in the background.',
  stop: 'Stop',
  keep: 'Keep',
  kept: 'Kept',
  stopAll: 'Stop all',
  sharedLayout: 'Shared layout',
  sharedLayoutSub: 'Folders, pins and the List / Board choice are the same on both computers and your phone.',
  sharedAccounts: 'Shared accounts',
  sharedAccountsSub: 'Signed in once, used by every paired computer. Their names, order and usage are shared automatically.',
  sharedAccountsNone: 'No account is on more than one computer yet.',
  addComputer: 'Add a computer',
  forget: 'Forget',
  forgetConfirm: 'Forget this computer? Its agents stop showing here. Pair it again any time.',
  noComputers: 'No other computer is paired yet.',
  // Phones
  phonesSub: 'Answer questions and approvals from your phone, over your private network.',
  pairPhone: 'Pair a phone',
  pairSteps: ['Open the camera on your phone.', 'Point it at this code.', 'Tap “Add to Home Screen” to install.'],
  pairNote: 'The code works for 10 minutes and only on your private network. Nothing goes through the internet.',
  revoke: 'Revoke',
  revokeConfirm: 'It can’t see or answer anything until you pair it again.',
  noPhones: 'No phone is paired yet.',
  phoneAccessOff: 'Phone access is off. Turn it on under Advanced › Phones: every option.',
  notificationsOnPhone: 'Notifications are set on the phone itself: open Settings › Phones there.',
  installApp: 'Install as an app',
  // Rules
  rulesSub: 'Every agent reads these before it starts. Write them like you’d brief a new colleague.',
  rulesOn: 'Give these rules to every agent',
  saveRules: 'Save rules',
  resetRules: 'Reset to default',
  applyOpen: 'Apply to open agents',
  rulesApplies: 'Applies to new agents and the next step of running ones.',
  // Appearance
  density: 'Text density',
  densitySub: 'How chats are shown by default on this browser. Each agent’s View menu can change it.',
  comfortable: 'Comfortable',
  compact: 'Compact',
  motionTitle: 'Reduced motion',
  motionNote: 'Switchboard follows your computer’s “Reduce motion” setting: animations are turned off when it is on.',
  // Advanced
  advancedSub: 'For power users and setup. Most people never need these.',
  advancedBack: 'Advanced',
  advancedMissing: 'There is no such Advanced page.',
  runSetup: 'Run setup again',
  runSetupSub: 'Accounts, computers, phone, code projects. Your agents and folders stay.',
  // Tool / share
  toolTitle: 'Tool',
  shareTitle: 'Add to which agent?',
  // Lane X · P3 polish: why a rules button is disabled
  rulesNoChanges: 'No changes to save.',
  rulesTooLong: 'Too long: at most 4,000 characters.',
  rulesAtDefault: 'These are already the default rules.',
  rulesAllCurrent: 'Every open agent already uses these rules.',
  // Fix after 2.0 · search in Settings and the grouped Advanced list
  searchLabel: 'Search settings',
  searchPlaceholder: 'Search settings: archive, port, sound…',
  searchResults: 'Matching settings',
  searchClear: 'Clear search',
  searchNone: (q: string): string => `No setting matches “${q}”`,
  searchNoneSub: 'Try another word, or look under Advanced.',
  searchCount: (n: number): string => `${n} setting${n === 1 ? '' : 's'}`,
  searchHint: '↑↓ move · ↩ open · Esc clear',
  crumbSep: ' › ',
  advancedGroups: {
    agents: 'Agents',
    code: 'Projects & code',
    accounts: 'Accounts & devices',
    notifications: 'Notifications',
    app: 'App',
  },
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
    settings: 'Settings',
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
    closed: 'Archived agents',
    pairPhone: 'Pair a phone',
    addComputer: 'Add a computer',
    // Lane X · P1: the prototype's direct replay of the v2 welcome tour.
    replayTour: 'Replay tour: what’s new in Switchboard 2',
  },
} as const;

// ── Lane A · Agents, Notes, Routines, Tasks ─────────────────────────────
// Lane A's words, one block per page (each page's own file edits only its block).

/** D137: why an archived agent is kept past the archive period, in v2 words (classic: `ARCHIVE_KEPT_LABELS`). */
export const ARCHIVE_KEPT_WORDS: Readonly<Record<ArchiveKeptReason, string>> = {
  running: 'still running',
  crew: 'a teammate in a crew',
  plan: 'its project is not finished',
  'plan-step': 'a step of a running project',
  routine: 'it has an active routine',
  'cli-schedule': 'it has a scheduled job',
  pinned: 'pinned',
};

/** D137: Settings › Advanced › Sessions → the archive's row (`ArchiveRow`) in v2 words. */
export const ARCHIVE_WORDS = {
  label: 'Delete archived agents after',
  description: 'An archived agent is deleted by itself after this long, with its separate copy of the code when nothing in it would be lost. Pinned agents, teammates, project agents and agents with an active routine are kept. Never keeps them until you delete them in Clean-up.',
  select: 'Delete archived agents after',
  noun: 'agent',
} as const;

/** Lane A · the Agents page: List / Chats / Board, the folder tree, Drafts, Archived (D137; was Closed). */
export const AGENTS_WORDS = {
  title: 'Agents',
  sub: 'Every agent on every computer: conversations, teammates, routines and project steps too.',
  closedTitle: 'Archived',
  closedSub: 'Archived agents keep their full chat until they are deleted. Restore one to carry on.',
  views: { list: 'List', chats: 'Chats', board: 'Board', folders: 'Folders' },
  viewLabel: 'View',
  foldersButton: 'Folders',
  foldersToggle: 'Hide or show folders',
  newButton: 'New',
  allAgents: 'All agents',
  needsYou: 'Needs you',
  pinned: 'Pinned',
  folders: 'Folders',
  crews: 'Crews',
  notInFolder: 'Not in a folder',
  drafts: 'Drafts',
  closed: 'Archived',
  also: 'Also',
  notes: 'Notes · what agents know',
  tasks: 'Tasks',
  routines: 'Routines',
  newFolder: 'New folder',
  newSubfolder: 'New subfolder',
  newCrew: 'New crew',
  folderActions: (name: string): string => `Folder actions for ${name}`,
  crewActions: (name: string): string => `Crew actions for ${name}`,
  agentActions: (name: string): string => `Actions for ${name}`,
  expand: (name: string): string => `Expand ${name}`,
  collapse: (name: string): string => `Collapse ${name}`,
  needCount: (n: number): string => `${n} need${n === 1 ? 's' : ''} you`,
  agentsCount: (n: number): string => `${n} agent${n === 1 ? '' : 's'}`,
  foldersCount: (n: number): string => `${n} folder${n === 1 ? '' : 's'}`,
  dragHint: 'Drag onto a folder, or ⋯ › Move to folder…',
  openProject: 'Open project',
  openCrew: 'Open crew',
  emptyFolderTitle: 'This folder is empty',
  emptyFolderText: 'Drag agents here, or start one with + New.',
  emptyTitle: 'No agents yet',
  emptyText: 'Start one with + New. Agents on your paired computers show here too.',
  shareOn: (names: readonly string[]): string => `Folders and pins are shared with ${names.join(', ')}. Your List / Chats / Board choice stays on this browser.`,
  shareOff: 'Folders and pins are on this computer. Share them with paired computers in Settings › Computers.',
  sameAsClassic: 'The classic sidebar shows the same folders and pins.',
  // Rows and menus.
  open: 'Open',
  pin: 'Pin',
  unpin: 'Unpin',
  pinToSidebar: 'Pin to sidebar',
  moveToFolder: 'Move to folder…',
  moveToCrew: 'Move to crew…',
  rename: 'Rename…',
  delete: 'Delete folder…',
  closeAgent: 'Archive agent',
  closeRunning: (name: string): string => `“${name}” is still running or waiting. Archiving stops it; its chat is kept in Archived.`,
  draftNotes: 'Draft notes from this agent',
  managedPlan: 'Managed by its project. Rename or delete the project instead.',
  managedCrew: 'Managed by its crew. Rename the crew on the Crew page.',
  stepsStay: 'Project steps stay in their project’s folder.',
  tooDeep: 'Folders nest up to 5 levels.',
  offlineWhy: (computer: string): string => `${computer} is offline. It can move once it reconnects.`,
  offlineLine: (computer: string, why: string | null): string => `${computer} is offline${why ? ` · ${why}` : ''} · can’t send or stop until it reconnects`,
  draft: 'Draft',
  draftLine: 'Draft:',
  unread: 'Unread',
  peek: 'Peek',
  kind: { conv: 'Conversation', routine: 'Routine', mate: 'Teammate', step: 'Step', agent: 'Agent' },
  advanced: 'Advanced',
  showEngine: 'Show the AI engine on each row',
  // Toasts.
  moved: (name: string, where: string, share: string): string => `Moved “${name}” to ${where}.${share ? ` ${share}` : ''}`,
  movedToCrew: (name: string, crew: string): string => `Moved “${name}” to ${crew}.`,
  pinnedToast: (name: string): string => `Pinned “${name}”. It’s in the sidebar.`,
  unpinnedToast: (name: string): string => `Unpinned “${name}”.`,
  folderCreated: (name: string, parent: string | null): string => `Folder “${name}” created${parent ? ` in ${parent}` : ''}. Drag agents into it.`,
  renamed: (name: string): string => `Renamed to “${name}”.`,
  folderDeleted: (name: string): string => `Deleted “${name}”. Its agents moved up a level.`,
  closedToast: (name: string): string => `Archived “${name}”. Find it in Archived.`,
  reopened: (name: string): string => `Restored “${name}”. It’s back in Agents with its full chat.`,
  syncedTo: (names: readonly string[]): string => (names.length ? `Synced to ${names.join(', ')}.` : ''),
  // Dialogs.
  moveTitle: 'Move to folder',
  moveHint: 'The keyboard way to drag: ↑ ↓ to pick, ↩ to move.',
  moveHere: 'Move here',
  cancel: 'Cancel',
  name: 'Name',
  inside: 'Inside',
  topLevel: 'Top level',
  nestHint: 'Folders can nest up to 5 levels. They sync to paired computers that share the layout.',
  createFolder: 'Create folder',
  renameFolderTitle: 'Rename folder',
  renameAgentTitle: 'Rename agent',
  renameButton: 'Rename',
  deleteTitle: (name: string): string => `Delete “${name}”?`,
  deleteButton: 'Delete folder',
  projectStepsOnly: 'project steps only',
  // Board.
  groupRowsBy: 'Group rows by',
  groupBy: { project: 'Project', crew: 'Crew', folder: 'Folder' },
  columns: { needs: 'Needs you', working: 'Working', ready: 'Ready for approval', done: 'Done' },
  answer: 'Answer',
  decide: 'Decide',
  review: 'Review & combine',
  quickAnswer: 'Quick answer · it also updates the chat and Needs you',
  approvalWaiting: '1 approval waiting',
  waitingForAnswer: 'Waiting for your answer',
  notOnBoard: (names: readonly string[]): string => `Not on the board: ${names.join(', ')} (idle, paused or offline). They’re in the List.`,
  allOnBoard: 'Every agent here is on the board.',
  cardsMove: 'Cards move on their own as agents progress.',
  stepsDone: (done: number, total: number): string => `${done}/${total} done`,
  noneInCell: '—',
  // Drafts.
  draftsTitle: (n: number): string => `Drafts · ${n}`,
  draftsNote: 'Drafts follow you to your phone',
  continue: 'Continue',
  deleteDraft: 'Delete draft',
  newAgentDraft: (when: string): string => `New agent · saved ${when}`,
  draftDeleted: 'Draft deleted.',
  // Archived (D137: the classic "Closed"; the API keeps close / reopen).
  searchClosed: 'Search archived agents',
  reopen: 'Restore',
  closedAgo: (when: string): string => `Archived ${when}`,
  closedEmpty: 'No archived agents',
  closedEmptyText: 'Agents you archive show here with their full chat until they are deleted.',
  closedNoMatch: 'No archived agent matches',
  /** D137: the line at the top of Archived ("… Change in Settings."). */
  archivePolicy: (days: number): string => archivePolicyText(days, 'agents'),
  archiveSettings: 'Change in Settings',
  /** D137: a row's countdown ("Deletes in 12 days", "Deletes today"). */
  deletesIn: (deletesAt: string): string => archiveCountdownText(deletesAt),
  /** D137: why an archived agent is kept past the period ("Kept: pinned"). */
  kept: (reason: ArchiveKeptReason): string => `Kept: ${ARCHIVE_KEPT_WORDS[reason]}`,
  backToAgents: 'Back to Agents',
  // Phone.
  phoneNote: 'Same folders and pins as on your computers. Rearrange them on a computer; the phone follows.',
  folderPath: 'Folder path',
  everythingElse: 'Everything else',
  agentsAndConversations: 'Agents & conversations',
  nothingHere: 'Nothing here.',
} as const;

/** Lane A · the Tasks page (`/tasks`). */
export const TASKS_WORDS = {
  title: 'Tasks',
  sub: 'Every agent’s tasks, with estimate vs actual.',
  crumb: 'estimate vs actual',
  colOpen: 'Open',
  colProgress: 'In progress',
  colReview: 'Review',
  colDone: 'Done',
  colReviewHint: 'In progress, but its agent has stopped: check the work and mark it done.',
  columns: 'Columns',
  quickAdd: 'Quick add a task and press Enter',
  quickAddLabel: 'Quick add a task',
  addTo: 'Add to',
  addToLabel: 'Add new tasks to',
  noAgentToAdd: 'Start an agent first: a task belongs to an agent.',
  withDetails: 'Task with details',
  import: 'Import from Jira or GitHub',
  startHere: 'Start here',
  runOwn: 'Run in its own agent',
  startHereTitle: (agent: string) => `Hand it to ${agent}, in the same chat`,
  runOwnTitle: 'A new agent works on it',
  more: 'More for this task',
  details: 'Details',
  description: 'Description',
  plan: 'Handover plan',
  planSub: 'what an agent needs to pick it up later',
  noPlan: 'No handover plan.',
  noDescription: 'No description.',
  waitingFill: 'Waiting for its agent to fill it in',
  agent: 'Agent',
  priority: 'Priority',
  estimate: 'Estimate',
  moveTo: (column: string) => `Move to ${column}`,
  delete: 'Delete',
  close: 'Close',
  emptyTitle: 'No tasks yet',
  emptyText: 'Quick add one above, write one with details, or import issues from Jira or GitHub.',
  emptyColumn: 'Nothing here.',
  loadError: 'Tasks could not be loaded',
  added: (title: string, agent: string) => `Task added to ${agent}: “${title}”.`,
  started: (title: string, agent: string) => `Handed “${title}” to ${agent}. It starts after the current reply.`,
  startedNow: (title: string, agent: string) => `Sent “${title}” to ${agent}.`,
  ran: (title: string) => `Started a new agent for “${title}”.`,
  open: 'Open',
  moved: (title: string, column: string) => `Moved “${title}” to ${column}.`,
  deleted: (title: string) => `Deleted “${title}”.`,
  offline: (computer: string) => `${computer} is offline`,
  reconnecting: (computer: string) => `Reconnecting to ${computer}…`,
  alreadyRunning: 'An agent of its own already works on it',
  accuracy: (percent: number, count: number) => `Estimates were ${percent}% accurate on ${count} completed ${count === 1 ? 'task' : 'tasks'}.`,
  importTitle: 'Import tasks',
  importInto: 'Into the tasks of',
  importSource: 'Source',
  importRepo: 'Repository',
  importLabel: 'Label',
  importMine: 'Assigned to me',
  importJira: 'Project key or JQL',
  importPreview: 'Preview',
  importNone: 'No open issues match.',
  importTruncated: 'Showing the first 100: narrow the filter to see the rest.',
  importImported: 'imported',
  importFull: 'with its full description',
  importButton: (count: number) => (count === 1 ? 'Import 1 task' : `Import ${count} tasks`),
  importDone: (count: number, source: string, agent: string) => `Imported ${count} ${count === 1 ? 'task' : 'tasks'} from ${source} into ${agent}.`,
  importNoAgent: 'Start an agent that works in a code project first.',
  cancel: 'Cancel',
  // Fix after 2.0 · the task card (classic's todo card in v2's look, `shared/TodoCard.tsx`).
  startShort: 'Start',
  runShort: 'Run',
  startTitle: 'Send this task to this agent and mark it in progress',
  startAgainTitle: 'Send this task to this agent again',
  markDone: (title: string) => `Mark “${title}” done`,
  reopen: (title: string) => `Reopen “${title}”`,
  edit: 'Edit',
  editTitle: 'Edit task',
  save: 'Save',
  markInProgress: 'Mark in progress',
  markNotStarted: 'Mark not started',
  planMark: 'Plan',
  planMarkTitle: 'Has a handover plan: open the task to read it',
  showDetails: 'Show details',
  hideDetails: 'Hide details',
  fieldTitle: 'Title',
  fieldTitleHint: 'One line',
  fieldDescription: 'Description',
  fieldDescriptionHint: 'For you · Markdown · optional',
  fieldPlan: 'Handover plan',
  fieldPlanHint: 'For an agent · Markdown · “No plan” when there is none',
  fieldPriority: 'Priority',
  fieldEstimate: 'Estimate',
  fieldEstimateHint: 'AI agent time · optional (45m, 2h)',
  saved: (title: string) => `Saved “${title}”.`,
  doneToast: (title: string) => `Marked “${title}” done.`,
  reopened: (title: string) => `Reopened “${title}”.`,
  projectStep: (project: string, step: string) => `Project ${project} · step ${step}`,
  ownAgent: 'Its own agent',
  addedByAgent: 'added by the agent',
  addedByYou: 'added by you',
  stripLabel: 'Tasks of this agent',
  stripToggle: (open: boolean) => (open ? 'Hide the task cards' : 'Show the task cards'),
} as const;

/** Lane A · the Notes page (`/notes`, "What agents know"). */
export const NOTES_WORDS = {
  title: 'Notes',
  sub: 'What agents know: facts agents proposed and you approved.',
  crumb: 'Notes · what agents know',
  scopedHint: 'Scoped to a folder, a code project or a teammate',
  scopeFolder: 'Folder',
  scopeCodeProject: 'Code project',
  scopeTeammate: 'Teammate',
  all: 'All notes',
  filterLabel: 'Show notes for',
  proposedHeading: 'Proposed · waiting for you',
  approvedHeading: 'Approved',
  rejectedHeading: 'Rejected',
  showRejected: 'Show rejected',
  hideRejected: 'Hide rejected',
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  approve: 'Approve',
  reject: 'Reject',
  edit: 'Edit',
  editFirst: 'Edit first',
  delete: 'Delete note',
  by: 'by',
  you: 'You',
  editedByYou: 'edited by you',
  anAgent: 'An agent',
  tip: 'Agents propose notes; you approve them in Needs you. From any agent’s ⋯, choose “Draft notes from this agent”.',
  draft: 'Draft notes from this agent',
  draftButton: 'Draft notes from an agent…',
  draftTitle: 'Draft notes from an agent',
  draftText: 'The agent looks back over its own work and proposes the facts a future agent would need. Nothing is used until you approve it.',
  draftPick: 'Which agent?',
  draftGo: 'Draft notes',
  draftNone: 'No agent can draft notes right now: only open agents on this computer that work in a folder can.',
  editTitle: 'Edit note',
  editFirstTitle: 'Edit the note before approving',
  approveEdited: 'Approve edited note',
  save: 'Save',
  cancel: 'Cancel',
  fieldTitle: 'Short title',
  fieldText: 'Note',
  approvedToast: 'Approved. Agents in {scope} now know it.',
  editedApprovedToast: 'Edited and approved.',
  rejectedToast: 'Rejected. Agents won’t use it.',
  savedToast: 'Note saved.',
  deletedToast: 'Note deleted.',
  emptyTitle: 'No notes yet',
  emptyText: 'When an agent learns something worth keeping, it proposes a note. You approve it, and every agent in that folder, code project or teammate knows it from then on.',
  emptyFilteredTitle: 'No notes here',
  emptyFilteredText: 'Nothing is stored for this scope yet.',
  unavailable: 'Notes are unavailable: their database (memory.db) could not be opened. Restart Switchboard; the log says why.',
  offlineNote: '{name} is offline: its notes show when it is back.',
  // D135: an agent proposes to change or remove an approved note.
  changeEdit: 'Edit',
  changeRemoval: 'Removal',
  changeEditTitle: (title: string): string => `Change “${title}”`,
  changeRemovalTitle: (title: string): string => `Remove “${title}”`,
  now: 'Now',
  proposedSide: 'Proposed',
  wouldBeRemoved: 'Would be removed',
  why: 'Why',
  noReason: 'No reason given.',
  targetGone: 'That note no longer exists: reject this proposal.',
  approveRemoval: 'Approve removal',
  editFirstChangeTitle: 'Edit the change before approving',
  approveEditedChange: 'Approve edited change',
  editApprovedToast: 'Approved. The note now reads as proposed.',
  removalApprovedToast: 'Approved. The note was removed.',
  changeRejectedToast: 'Rejected. The note stays as it was.',
  // D136: memory checks.
  approveReplace: 'Approve and remove the old note',
  replacedToast: 'Approved. The old note moved to “Removed by memory check”.',
  removedHeading: 'Removed by memory check',
  removedSub: 'Kept 30 days and never given to agents. Restore puts a note back as it was.',
  restore: 'Restore',
  restoredToast: 'Restored. Agents know the note again.',
  checkNow: 'Check now',
  checkStartedToast: 'Checking the notes in the background. The result shows here.',
} as const;

/** Lane A · the Routines page (`/routines`). */
export const ROUTINES_WORDS = {
  title: 'Routines',
  sub: 'Work that runs on a schedule. Routines skip a run while they wait for you.',
  newRoutine: 'New routine',
  count: '{n} routines',
  countOne: '1 routine',
  onSchedule: 'On schedule',
  paused: 'Paused',
  runningNow: 'Running now',
  lastFailed: 'Last run failed',
  waitingForYou: 'Waiting for you',
  ended: 'Ended',
  pause: 'Pause',
  resume: 'Resume',
  runNow: 'Run now',
  edit: 'Edit',
  cancel: 'Cancel routine',
  historyHeading: 'Run history · skips a run while it’s waiting for you',
  noRuns: 'No runs yet.',
  cliManaged: 'Managed by the AI engine: Switchboard can only watch it.',
  cliTag: 'Watched',
  belongsTo: 'Agent',
  lastRunAgent: 'Last run',
  terminal: 'Terminal',
  agentClosed: 'Its agent is archived.',
  running: 'A run is in progress.',
  waitForRun: 'Wait for the current run to finish.',
  cancelTitle: 'Cancel “{name}”?',
  cancelLoopText: 'It stops running and is removed. Its agent keeps its chat and everything the runs did.',
  cancelScheduleText: 'It stops running and is removed, with its run history. The agents its runs started stay in Agents.',
  keep: 'Keep it',
  pausedToast: 'Routine paused. No runs until you resume.',
  resumedToast: 'Routine resumed.',
  ranLoopToast: 'Sent it to “{agent}” now.',
  ranScheduleToast: 'Started a run now.',
  cancelledToast: 'Routine cancelled.',
  savedToast: 'Routine saved.',
  editTitle: 'Edit routine',
  fieldName: 'Name',
  fieldNameHint: 'Leave it empty to name it after what it does.',
  fieldWhat: 'What should it do each time?',
  fieldHow: 'How often',
  howEvery: 'Every …',
  howCron: 'On a schedule',
  howAt: 'Once',
  fieldEvery: 'Every (minutes)',
  fieldCron: 'Schedule (cron: minute hour day month weekday)',
  fieldAt: 'At',
  save: 'Save',
  close: 'Cancel',
  formNote: 'Routines skip a run while they’re waiting for you, and tell you if a run fails.',
  emptyTitle: 'No routines yet',
  emptyText: 'A routine runs work for you on a schedule: a nightly check, a morning report. Agents can make them too.',
  endedHeading: 'Ended',
  showEnded: 'Show ended',
  hideEnded: 'Hide ended',
} as const;

// ── Lane P · Projects and Crews (D131) ───────────────────────────────────
// Lane P's words, kept in one block at the end of the file so the lanes' merges stay trivial.

/** A project step's state in v2 words (the step list, the board, the graph, the timeline). */
export const STEP_LABELS = {
  waiting: 'Waiting',
  pick: 'Waiting for the project agent to pick code projects',
  ready: 'Ready to start',
  running: 'Working',
  runningTests: 'Working · automatic tests',
  question: 'Needs your answer',
  needs: 'Needs you',
  stopped: 'Stopped — needs you',
  approval: 'Ready for approval',
  confirm: 'Ready for approval',
  done: 'Done',
  blocked: 'Blocked',
} as const;

/** The approval modes (who combines a finished step), in plain words. */
export const MODE_LABELS = {
  agents: 'Agents combine on their own',
  'agents-with-holds': 'Agents combine, I approve marked steps',
  developer: 'I approve each',
  none: 'No combining (finish when done)',
  unset: 'Not chosen yet',
} as const;

/** The Projects pages' words. */
export const PROJECT_WORDS = {
  pageSub: 'Multi-step work. Steps start on their own when the steps before them are done.',
  newProject: 'New project',
  importJira: 'Import from Jira',
  cards: 'Cards',
  timeline: 'Timeline',
  steps: 'Steps',
  board: 'Board',
  graph: 'Graph',
  whoApproves: 'Who approves combining',
  protectedAck: (branch: string): string => `Agents will combine straight into ${branch}`,
  protectedAckNote: 'Needed before agents may combine into a protected branch.',
  start: 'Start project',
  pause: 'Hold project',
  resume: 'Resume project',
  cancel: 'Cancel project…',
  heldNote: 'On hold. Running steps finish; no new steps start until you resume.',
  hold: 'Hold this step',
  release: 'Release hold',
  onHold: 'On hold',
  reopen: 'Reopen',
  retry: 'Try again',
  // D139: a step whose agent failed (its account needed you, or an error) starts again, the same agent.
  restart: 'Restart',
  restartStopped: (n: number): string => `Restart stopped steps (${n})`,
  stoppedAccount: 'Stopped (account needs you)',
  markDone: 'Mark done',
  openChange: 'Open change request',
  remove: 'Remove from project',
  edit: 'Edit title and estimate…',
  combine: 'Combine',
  confirmDone: 'Confirm done',
  sendBack: 'Send back',
  rereadDeps: 'Re-read dependencies from Jira…',
  jiraSync: 'Jira sync…',
  proposeOrder: 'Propose order',
  deleteProject: 'Delete project…',
  fromJira: 'From Jira',
  jiraActivity: 'Jira activity',
  earlyStart: 'Early start',
  reopened: 'Reopened',
  sidebarSubfolder: 'Folder in Agents for its steps',
  sidebarSubfolderHint: 'The steps’ agents go into this folder, next to the project’s own agent (an existing one with this name is reused). Clear it to keep them next to it.',
  noProjects: 'No projects yet',
  noProjectsText: 'A project runs several steps in order, each in its own agent. Start one from your tasks, or import a Jira epic.',
  stepsDone: (done: number, total: number): string => `${done} of ${total} steps done`,
  timeLeft: (text: string): string => `about ${text} left`,
  needYou: (n: number): string => `${n} need${n === 1 ? 's' : ''} you`,
  stoppedCount: (n: number): string => `${n} stopped`,
  earlierDone: (n: number): string => `${n} earlier step${n === 1 ? '' : 's'} done`,
  // Lane X · boards
  whatAgentsKnow: 'What agents know',
  whatAgentsKnowText: 'Notes are scoped to a folder, a code project or a teammate, so every project there shares them.',
  openNotes: 'Open notes',
} as const;

/** The v2 Project graph's words (`projects/GraphView.tsx`, Fixes after 2.0 → *The Project graph, redrawn*). */
export const GRAPH_WORDS = {
  summary: (done: number, total: number, working: number, needs: number): string => `${done} of ${total} done · ${working} working · ${needs} need${needs === 1 ? 's' : ''} you`,
  percentDone: (percent: number): string => `${percent}% done`,
  criticalPath: 'Critical path',
  criticalPathHint: 'Highlight the longest chain of steps still to do',
  onCriticalPath: 'on the critical path',
  severalRepos: 'Several repositories',
  repos: (n: number): string => `${n} repos`,
  laneDone: (done: number, total: number): string => `${done} of ${total} steps done`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit',
  fitHint: 'Fit the whole project',
  minimap: 'Overview: click or drag to move the view',
  map: 'Map',
  mapHint: 'Show or hide the overview map',
  openToRestart: 'open to restart',
  estimate: (text: string): string => `estimate ${text}`,
  after: (names: string): string => `after ${names}`,
  graphOf: (title: string): string => `Dependency graph of ${title}`,
  legend: 'Arrows point to the steps that wait for it. Lanes group steps by repository.',
  legendMotion: 'Dots travel into steps being worked on; the glowing line is the critical path (the longest chain still to do).',
  segments: {
    done: 'done',
    working: 'working',
    needs: 'need you',
    approval: 'for approval',
    failed: 'failed',
    ready: 'ready',
    waiting: 'waiting',
  },
} as const;

/** The Crews pages' words. */
export const CREW_WORDS = {
  pageSub: 'Long-lived teammates, grouped into crews. Drag to reorder; the order is shared across your computers and phone.',
  newCrew: 'New crew',
  newTeammate: 'New teammate',
  addTeammate: 'Add teammate',
  allCrews: 'All crews',
  reorderNote: 'Drag a crew to reorder it, or use ⋯ › Move up / Move down. Teammates move between crews from their ⋯ menu.',
  phoneNote: 'Reorder crews and move teammates on a computer; the phone follows.',
  moveUp: 'Move up',
  moveDown: 'Move down',
  openCrew: 'Open crew',
  renameCrew: 'Rename crew…',
  deleteCrew: 'Delete crew…',
  moveToCrew: 'Move to crew…',
  moveToComputer: 'Move to computer…',
  pause: 'Pause',
  resume: 'Resume',
  draftJd: 'Draft job description',
  redraftJd: 'Redraft job description',
  returnToAgents: 'Return to agents',
  model: 'Model…',
  budget: 'Budget',
  budgetEdit: 'Edit budget…',
  access: 'Access',
  overview: 'Overview',
  addKey: 'Add key',
  crewActivity: 'Crew activity',
  handoffs: 'Hand-offs',
  handoffsSub: 'Who passes work to whom',
  noTeammates: 'No teammates yet. Add one, or move one here from another crew.',
  noActivity: 'Nothing yet.',
  noHandoffs: 'No hand-offs yet.',
  working: 'working',
  needYou: 'need you',
  teammates: (n: number): string => `${n} teammate${n === 1 ? '' : 's'}`,
  inOrder: (index: number): string => `${ordinal(index + 1)} in your order`,
  movedTo: (who: string, crew: string): string => `Moved ${who} to ${crew}. Synced everywhere.`,
  jdProposed: 'Proposed a new job description',
  jdAsked: 'Asked for a job description — waiting for its agent',
  /** 2026-10-27 (D137 follow-up, the developer chose B): archived teammates are hidden from the crew, never removed. */
  archivedTeammates: (n: number): string => `${n} archived teammate${n === 1 ? '' : 's'}`,
  showInArchived: 'Show in Archived',
  allArchived: 'Every teammate of this crew is archived. Restore one to bring it back here.',
} as const;

/** 1st, 2nd, 3rd, 4th … (the crews' order). */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// ── Lane S · the agent view (`agent/`) ─────────────────────────────────

/** The agent view's words (header, chat, composer, side panel, menus, peek). Lane S's block. */
export const AGENT_WORDS = {
  agent: 'Agent',
  conversation: 'Conversation',
  you: 'You',
  reply: (n: number): string => `reply ${n}`,
  back: 'Agents',
  details: 'Details',
  hideDetails: 'Hide',
  view: 'View',
  more: 'More actions',
  rename: 'Rename…',
  notInFolder: 'Not in a folder',
  separateCopy: 'Separate copy',
  separateCopyHint: 'Works on a separate copy, so your main code is untouched until you Combine',
  // Automatic tests (CI) chip.
  testsPassing: 'Automatic tests: passing',
  testsFailing: 'Automatic tests: failing',
  testsRunning: 'Automatic tests: running',
  testsMerged: 'Change request combined',
  sentBack: (attempt: number, max: number): string => `sent back, try ${attempt} of ${max}`,
  testsGaveUp: 'gave up',
  openChangeRequest: (n: number): string => `Open change request #${n}`,
  // Needs-you line.
  needsYou: 'Needs you',
  blocked: 'Blocked',
  detected: 'detected',
  detectedHint: 'Read from the agent’s last message (it did not say so itself). Not waiting clears it for this turn.',
  notWaitingHint: 'The agent is not waiting for you: clear “needs you” for this turn.',
  // View menu.
  comfortable: 'Comfortable text',
  compact: 'Compact text',
  fullWidth: 'Full width (when details are hidden)',
  showDetails: 'Show details',
  hideDetailsLong: 'Hide details',
  densityRemembered: (which: string): string => `${which}. Remembered.`,
  detailsHidden: 'Details hidden. The chat takes the full width. ⌘. brings them back.',
  detailsShown: 'Details shown.',
  // Chat.
  earlier: 'Show earlier messages',
  earlierLoading: 'Loading earlier messages…',
  earlierFailed: 'Could not load earlier messages · Retry',
  later: 'Show later messages',
  laterLoading: 'Loading later messages…',
  laterFailed: 'Could not load later messages · Retry',
  jumpLatest: 'Jump to latest',
  emptyChat: 'No messages yet',
  emptyChatText: 'Write the first message below. The agent picks it up at once.',
  helpersFinished: (n: number): string => `${n} helper${n === 1 ? '' : 's'} finished`,
  helpersWorking: (n: number, working: number): string => `${n} helper${n === 1 ? '' : 's'} · ${working} still working`,
  openHelperChat: 'Open its chat',
  helperOf: (name: string): string => `Helper of ${name}`,
  mainChat: 'Main chat',
  helperBrief: 'Brief from the agent',
  helperResult: 'Result',
  helperNoMessages: 'Helpers take no messages · reply in the main chat',
  helperFinished: 'Finished · its result is in the main chat',
  helperMissing: 'This helper has no chat here.',
  answered: 'Answered',
  answeredClosed: 'Closed before it was answered',
  showFull: 'Show the whole message',
  copy: 'Copy',
  copied: 'Copied.',
  copyCode: 'Copy code',
  copyCodeNone: 'This reply has no code.',
  saveResult: 'Save as result',
  addToTasks: 'Add to tasks',
  addSelectionToTasks: (text: string): string => `Add “${text}” to tasks`,
  addedToTasks: (text: string): string => `Added to tasks: “${text}”.`,
  undoFromHere: 'Undo from here',
  replyActions: (n: number): string => `Actions for reply ${n}`,
  redo: 'Redo',
  notSent: 'Not sent',
  resend: 'Resend',
  queued: 'Queued',
  queuedNote: 'sends when this reply finishes',
  queuedResume: 'sends when the agent starts again',
  sendNow: 'Send now',
  edit: 'Edit',
  remove: 'Remove',
  takeBackHint: 'A queued message is already with the agent. Edit takes every queued message back into the box and stops the current reply (nothing is undone).',
  removeQueuedHint: 'Messages already with the agent cannot be removed one by one: Edit takes them back.',
  paused: (reset: string | null): string => `Paused — waiting for usage${reset ? ` (resets ${reset})` : ''}`,
  sendWithPaid: 'Send with paid extra',
  sendWithPaidHint: 'Sending one message with paid extra usage is not available yet. Change “When every account is out” in Settings › Usage & accounts.',
  // Live line.
  stop: 'Stop',
  resume: 'Resume',
  stopping: 'Stopping…',
  stoppedByYou: 'Stopped by you',
  waitingForYou: 'Waiting for you · answer the card above',
  offlineLine: (computer: string): string => `${computer} is offline. Stop and Send wait until it reconnects.`,
  reconnectingLine: (computer: string): string => `Reconnecting to ${computer}…`,
  allOut: 'Every account is out of usage. New messages wait here.',
  idleLine: 'Idle · waiting for your next message',
  doneLine: 'Done',
  pausedLine: 'Paused · nothing new starts until you resume',
  stopTimeout: 'It did not stop in time.',
  pauseInstead: 'Pause it',
  // Composer.
  placeholder: 'Send a message',
  placeholderWorking: 'Send a follow-up. It waits until this reply finishes.',
  placeholderConversation: 'Ask a follow-up. Conversations never change files.',
  attach: 'Attach a file or image',
  attachHint: 'Attach a file or image (or paste / drop it here)',
  send: 'Send',
  draftSaved: 'Draft saved · drafts follow you to your phone',
  draftSavedShort: 'Draft saved',
  backToCrew: (crew: string): string => `Back to ${crew}`,
  aboutAgent: 'About this agent',
  teammateIn: (crew: string, own: string): string => `Teammate in ${crew} · its agent is “${own}”`,
  renameTeammate: (crew: string): string => `Rename this teammate (in ${crew})`,
  showMore: 'Show more',
  showLess: 'Show less',
  continueAsAgent: 'Continue as agent',
  readOnly: 'Read-only: this conversation was continued as an agent.',
  // Working memory and tasks above the composer.
  workingMemory: 'Working memory',
  memoryUsed: (pct: number): string => `${pct}% used`,
  memoryUnknown: 'not measured yet',
  plentyLeft: 'Plenty left',
  almostFull: 'Almost full',
  memoryFullBanner: (pct: number): string => `Working memory is ${pct}% full. It may start forgetting early details.`,
  memoryWarn: 'Start fresh with a short summary of the work so far. Nothing is lost.',
  compacted: (time: string): string => `tidied up at ${time}`,
  cleanSlate: 'Continue with a clean slate',
  cleanSlateShort: 'Clean slate',
  cleanSlateRunning: 'Writing a summary for the clean slate…',
  tasksStrip: (open: number, done: number): string => `Tasks · ${done} of ${open + done} done`,
  // Side panel.
  howItWorks: 'How it works',
  speed: 'Speed',
  engine: 'AI engine',
  account: 'Account',
  pinAccount: 'Pin this account to this agent',
  thinkingDepth: 'Thinking depth',
  modelUnknown: 'The choices show once the agent has run.',
  switchEngineConfirm: 'Switch',
  switchAccountConfirm: 'Switch account',
  cancel: 'Cancel',
  helpers: 'Helpers',
  noHelpers: 'No helpers right now.',
  // 2026-10-27 · the helpers fold (helpers that ended over 10 minutes ago fold under one row).
  showEarlierHelpers: (n: number): string => `Show ${n} ${n === 1 ? TERMS.helper.one.toLowerCase() : TERMS.helper.many.toLowerCase()} finished earlier`,
  showEarlierOverview: (n: number): string => `Show ${n} finished earlier`,
  hideEarlierHelpers: 'Hide the ones finished earlier',
  showMoreHelpers: (next: number, left: number): string => `Show ${next} more (${left} left)`,
  earlierLanes: (n: number): string => `${n} earlier ${n === 1 ? TERMS.helper.one.toLowerCase() : TERMS.helper.many.toLowerCase()}`,
  activeHelpers: (n: number): string => `${n} active`,
  noActiveHelpers: 'none active',
  backgroundApps: 'Background apps',
  noBackgroundApps: 'Nothing left running.',
  keep: 'Keep',
  stopApp: 'Stop',
  tasks: 'Tasks for this agent',
  noTasks: 'No tasks yet. Add one with + New › Task.',
  run: 'Run',
  handoff: 'Handoff note & terminal',
  noTerminal: 'Nothing ran yet.',
  advanced: 'Advanced',
  branch: 'Branch',
  folderPath: 'Path',
  remoteControl: 'Remote control',
  hooked: 'Started in a terminal',
  // Tabs.
  changesWhich: 'Which changes',
  sinceSavePoint: 'Since last save point',
  wholeCopy: 'Whole separate copy',
  allUnsaved: 'All unsaved',
  noChanges: 'No changes yet',
  noChangesText: 'Changes appear here as soon as the agent edits a file.',
  noResults: 'No results yet',
  noResultsText: 'Files this agent makes show up here, with every version.',
  noHelpersTitle: 'No helpers',
  noHelpersText: 'When the agent splits work, each helper gets its own chat here.',
  timelineNote: 'One lane per helper.',
  noTimeline: 'Nothing happened yet',
  // Agent ⋯ menu.
  openFull: 'Open full view',
  peek: 'Peek',
  pause: 'Pause',
  stopBackground: 'Stop background tasks',
  noBackground: 'Nothing is running in the background.',
  moveToComputer: 'Move to computer…',
  continueInTerminal: 'Continue in a terminal',
  attachHere: 'Bring it back here',
  remoteLink: 'Remote control link / QR',
  openInClaude: 'Open in the Claude app',
  addRoutine: 'Add a routine to this agent…',
  draftNotes: 'Draft notes from this agent',
  makeTeammate: 'Make a teammate…',
  returnToAgents: 'Return to agents',
  close: 'Archive agent',
  reopen: 'Restore',
  deleteConversation: 'Delete conversation…',
  offlineReason: (computer: string): string => `${computer} is offline; it can move once it reconnects.`,
  // Peek.
  peekClose: 'Close peek',
  // Lane X · agent
  move: 'Move',
  moveHere: 'Move here',
  moveTo: 'Move to',
  closeDialog: 'Close',
  openMovedAgent: 'Open the agent',
  continueHooked: 'Continue in Switchboard',
  continueHookedHint: 'Switchboard runs it from now on; its terminal’s claude is stopped first (it asks).',
  continuedHere: (title: string): string => `“${title}” now runs in Switchboard.`,
  overview: 'Agents overview',
  overviewColumns: ['Agent', 'What it does', 'Code project', 'Status'] as const,
  overviewReported: 'As reported by the agent',
  overviewUnreadable: 'The agent printed a table Switchboard can’t read.',
  overviewAsPrinted: 'Show as printed',
  resumeRun: 'Resume run',
  resumeRunHint: 'Ask the agent to resume this run (its finished helpers replay from the cache).',
  resumeRunSent: 'Asked the agent to resume it.',
  resumeRunFailed: 'Could not send the message.',
  project: 'Project',
  projectStep: (step: string): string => `Step: ${step}`,
  projectSource: 'Project agent',
  openProject: 'Open project',
  whatAgentsKnow: 'What agents know',
  notesCount: (n: number): string => (n === 1 ? '1 note for this folder' : `${n} notes for this folder`),
  notesToReview: (n: number): string => `${n} to review`,
  openNotes: 'Open notes',
  playback: 'Playback',
  play: 'Play',
  pausePlayback: 'Pause',
  previousEvent: 'Previous event',
  nextEvent: 'Next event',
  playReducedHint: 'Reduced motion is on: each press moves to the next event.',
  toNow: 'Now',
  timelinePosition: 'Timeline position',
  eventLog: 'Event log',
  eventsUpTo: (time: string): string => `Events up to ${time}`,
  noEventsYet: 'Nothing happened before this moment.',
} as const;

// Lane X · tour
// The v2 tour host (`tour/TourHost.tsx`) and the replay page (Settings › Advanced › What’s new tours).

/** Lane X · the v2 tours' card and their Settings page. */
export const TOUR_WORDS = {
  next: 'Next',
  nextTour: 'Next tour',
  back: 'Back',
  done: 'Done',
  skip: 'Skip tour',
  skipAll: 'Skip all',
  whatToDo: 'What to do',
  step: (n: number, count: number): string => `${n} of ${count}`,
  live: (kicker: string, n: number, count: number, title: string): string => `${kicker}, step ${n} of ${count}: ${title}`,
  // Settings › Advanced › What’s new tours
  pageTitle: 'What’s new tours',
  pageSub: 'Replay a tour. Each one shows by itself once on this computer; a replay changes nothing.',
  replay: 'Replay',
  replayAll: 'Replay all',
  seen: 'seen',
  skipped: 'skipped',
  notSeen: 'not seen yet',
  notShown: 'not shown on this computer',
  classicNote: 'The other What’s new tours point at the Classic theme. Switch to Classic in Settings › Appearance to replay them under Settings › Tutorial.',
  loadError: 'The tours’ state could not be loaded.',
} as const;

/**
 * D138 · choosing the account (`docs/accounts.md` → *Choosing the account*): the status pill's
 * picker, Settings › Usage & accounts, a Project's account, the agent's "Account: B (from project)".
 */
export const ACCOUNT_CHOICE_WORDS = {
  title: 'Account for agents',
  sub: 'New agents start on it, and running agents move to it now. Pinned agents, and projects with their own account, keep theirs. If it runs out, agents switch automatically.',
  automatic: 'Automatic',
  automaticHint: 'Automatic: the first account with usage left',
  picker: (engine: string): string => `${engine} account`,
  out: 'out of usage',
  confirmTitle: 'Move agents?',
  move: 'Move',
  cancel: 'Cancel',
  saved: (name: string): string => `New agents start on ${name}.`,
  savedAuto: 'New agents use the first account with usage left.',
  moving: (count: number, name: string): string => `Moving ${count} ${count === 1 ? 'agent' : 'agents'} to ${name}.`,
  sources: { pinned: 'pinned', project: 'from project', overall: 'overall choice', automatic: 'automatic' },
  line: (name: string, source: string): string => `Account: ${name} (${source})`,
  // A Project's account.
  projectAccount: 'Account',
  projectAccountMenu: 'Account…',
  projectAccountTitle: (title: string): string => `Account for “${title}”`,
  projectAccountHint: 'Every step’s agent, and the project’s own agent, use it. Automatic follows your choice in the usage pill. If it runs out, agents switch automatically.',
  projectAuto: 'Automatic (your overall choice)',
  projectSaved: (title: string): string => `“${title}” uses the new account.`,
} as const;
