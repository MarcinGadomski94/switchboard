/**
 * D62 (`docs/providers.md`): the agent CLIs a session can run on, their labels
 * and the capability matrix. Pure, shared by the server (what a provider can do,
 * the reasons it refuses) and the UI (which controls are disabled, and why).
 *
 * Every Switchboard feature that depends on the CLI is a {@link CliFeature}; each
 * provider declares it `available` or not, with an exact reason. The UI never
 * hides a control because of the provider: it disables it with
 * {@link unavailableText} ("Not available in Codex CLI: …").
 */

/** The CLIs Switchboard can supervise, in the order the pickers show them. */
export const CLI_PROVIDERS = ['claude', 'codex', 'opencode'] as const;

/** One supervised CLI. `claude` is every session from before D62 (migration 0023). */
export type CliProviderId = (typeof CLI_PROVIDERS)[number];

/** The default for a new install and every session from before D62. */
export const DEFAULT_CLI_PROVIDER: CliProviderId = 'claude';

/** Display names. */
export const CLI_LABELS: Readonly<Record<CliProviderId, string>> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
};

/** Short names for badges (sidebar rows, the header chip). */
export const CLI_SHORT_LABELS: Readonly<Record<CliProviderId, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** `true` for a known provider id. */
export function isCliProviderId(value: unknown): value is CliProviderId {
  return typeof value === 'string' && (CLI_PROVIDERS as readonly string[]).includes(value);
}

/** A stored provider value read defensively: anything unknown is Claude Code (every session before D62). */
export function readCliProvider(value: unknown): CliProviderId {
  return isCliProviderId(value) ? value : DEFAULT_CLI_PROVIDER;
}

/** The binary's environment variable of each provider (argv prefix: a bare command or a JSON array). */
export const CLI_BIN_ENV: Readonly<Record<CliProviderId, string>> = {
  claude: 'SWITCHBOARD_CLAUDE_BIN',
  codex: 'SWITCHBOARD_CODEX_BIN',
  opencode: 'SWITCHBOARD_OPENCODE_BIN',
};

/** The bare command each provider is looked up as when nothing is configured. */
export const CLI_DEFAULT_COMMAND: Readonly<Record<CliProviderId, string>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/** Where to get each CLI (Settings → CLIs, "Not installed"). Links only: Switchboard never installs a CLI. */
export const CLI_INSTALL: Readonly<Record<CliProviderId, { readonly docs: string; readonly commands: readonly string[]; readonly signIn: string }>> = {
  claude: {
    docs: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    commands: ['npm install -g @anthropic-ai/claude-code'],
    signIn: 'Run `claude` once in a terminal and sign in.',
  },
  codex: {
    docs: 'https://github.com/openai/codex#installing-and-running-codex-cli',
    commands: ['npm install -g @openai/codex', 'brew install --cask codex'],
    signIn: 'Run `codex login` in a terminal (ChatGPT account or an API key).',
  },
  opencode: {
    docs: 'https://opencode.ai/docs/',
    commands: ['npm install -g opencode-ai', 'brew install sst/tap/opencode', 'curl -fsSL https://opencode.ai/install | bash'],
    signIn: 'Run `opencode auth login` in a terminal and pick a provider.',
  },
};

/**
 * Every CLI-dependent feature of a session, named after the decision that added
 * it. `docs/providers.md` → *Capability matrix* is this table in prose.
 */
export type CliFeature =
  | 'chat'
  | 'images'
  | 'pdfs'
  | 'files'
  | 'permissions'
  | 'permission-always'
  | 'questions'
  | 'stop'
  | 'pause-resume'
  | 'model'
  | 'effort'
  | 'context-meter'
  | 'usage-footer'
  | 'background-tasks'
  | 'stop-background'
  | 'subagents'
  | 'workflow-agents'
  | 'remote-control'
  | 'teleport'
  | 'terminal-handoff'
  | 'history-import'
  | 'mcp'
  | 'hooks'
  | 'worktrees'
  | 'schedules'
  | 'peers'
  | 'handover';

/** A provider's answer for one feature. */
export interface CliCapability {
  readonly available: boolean;
  /** Why it is not available (shown verbatim after "Not available in <CLI>: "). */
  readonly reason?: string;
  /** How the feature works on this CLI when it differs from Claude Code (the matrix's note). */
  readonly note?: string;
}

const yes = (note?: string): CliCapability => (note ? { available: true, note } : { available: true });
const no = (reason: string): CliCapability => ({ available: false, reason });

/**
 * The capability matrix (D62 "equivalent or marked"). Claude Code is the
 * reference: every feature is available there. The other two are filled from
 * their documented protocols (`docs/providers.md` → *Evidence*); a row marked
 * unavailable says exactly why.
 */
export const CLI_CAPABILITIES: Readonly<Record<CliProviderId, Readonly<Record<CliFeature, CliCapability>>>> = {
  claude: {
    chat: yes(),
    images: yes(),
    pdfs: yes(),
    files: yes(),
    permissions: yes(),
    'permission-always': no('supervised Claude Code sessions run with Allow once / Deny (D6); "Always allow" is for hooked terminal sessions'),
    questions: yes(),
    stop: yes(),
    'pause-resume': yes(),
    model: yes(),
    effort: yes(),
    'context-meter': yes(),
    'usage-footer': yes(),
    'background-tasks': yes(),
    'stop-background': yes(),
    subagents: yes(),
    'workflow-agents': yes(),
    'remote-control': yes(),
    teleport: yes(),
    'terminal-handoff': yes(),
    'history-import': yes(),
    mcp: yes(),
    hooks: yes(),
    worktrees: yes(),
    schedules: yes(),
    peers: yes(),
    handover: yes(),
  },
  codex: {
    chat: yes('codex app-server (JSON-RPC over stdio): thread/start, turn/start'),
    images: yes('localImage input items (the attachment file path)'),
    pdfs: no('Codex takes images only; a PDF is attached as a file path the agent reads'),
    files: yes('as file paths in the message, like Claude Code'),
    permissions: yes('command and file-change approvals → Inbox (Allow once / Deny)'),
    'permission-always': yes('"Always for this session" = Codex\'s acceptForSession'),
    questions: yes('item/tool/requestUserInput (an experimental app-server request) → question cards'),
    stop: yes('turn/interrupt'),
    'pause-resume': yes('thread/resume with the stored thread id'),
    model: yes('model/list; the choice applies from the next turn'),
    effort: yes('reasoning effort per turn (the model\'s supportedReasoningEfforts)'),
    'context-meter': yes('thread/tokenUsage/updated (tokens in context, model window)'),
    'usage-footer': yes('account rate limits (primary / secondary windows)'),
    'background-tasks': no('Codex runs no background tasks a turn can leave behind'),
    'stop-background': no('Codex runs no background tasks a turn can leave behind'),
    subagents: yes('collab agent tool calls (spawnAgent) show as subagent cards'),
    'workflow-agents': no('Workflow agents are a Claude Code feature'),
    'remote-control': no('Remote Control (claude.ai on the phone) is a Claude Code feature'),
    teleport: no('teleport continues a claude.ai/code session; Codex has none'),
    'terminal-handoff': yes('`codex resume <thread id>` continues it in a terminal'),
    'history-import': yes('rollout files under $CODEX_HOME/sessions (read only)'),
    mcp: yes('`codex mcp` and config.toml [mcp_servers]'),
    hooks: no('hooking into a hand-started terminal session (D48 P4) speaks Claude Code\'s hook protocol; Codex\'s hooks.json / notify program are not bridged'),
    worktrees: yes('git-level, the same for every CLI'),
    schedules: yes('a schedule template has a CLI'),
    peers: yes('through the peer proxy like any session'),
    handover: yes(),
  },
  opencode: {
    chat: yes('opencode serve (HTTP + SSE /event) on a loopback port'),
    images: yes('file parts with a data: URL'),
    pdfs: yes('file parts with a data: URL'),
    files: yes('as file paths in the message, like Claude Code'),
    permissions: yes('permission requests → Inbox (Allow once / Deny)'),
    'permission-always': yes('"Always for this session" = OpenCode\'s "always" reply'),
    questions: yes('question.asked → question cards (POST /question/:id/reply)'),
    stop: yes('POST /session/:id/abort'),
    'pause-resume': yes('the server process ends; the stored session id is reopened'),
    model: yes('GET /config/providers; provider/model per message'),
    effort: yes('the model\'s variants (e.g. high / max) as the effort, sent as `variant` per message'),
    'context-meter': yes('message tokens and the model\'s context limit'),
    'usage-footer': no('OpenCode reports a cost per message, not plan limits'),
    'background-tasks': no('OpenCode runs no background tasks a turn can leave behind'),
    'stop-background': no('OpenCode runs no background tasks a turn can leave behind'),
    subagents: yes('task tool calls run child sessions; shown as subagents'),
    'workflow-agents': no('Workflow agents are a Claude Code feature'),
    'remote-control': no('Remote Control (claude.ai on the phone) is a Claude Code feature'),
    teleport: no('teleport continues a claude.ai/code session; OpenCode has none'),
    'terminal-handoff': yes('`opencode --session <id>` continues it in a terminal'),
    'history-import': yes('`opencode session list --format json` / `opencode export <id>` (read only; its SQLite store is never read directly)'),
    mcp: yes('the `mcp` block of OpenCode\'s config (`opencode mcp`)'),
    hooks: no('hooking into a hand-started terminal session (D48 P4) speaks Claude Code\'s hook protocol; OpenCode\'s plugins run inside its own process and are not bridged'),
    worktrees: yes('git-level, the same for every CLI'),
    schedules: yes('a schedule template has a CLI'),
    peers: yes('through the peer proxy like any session'),
    handover: yes(),
  },
};

/** The provider's answer for `feature`. */
export function cliCapability(provider: CliProviderId, feature: CliFeature): CliCapability {
  return CLI_CAPABILITIES[provider][feature];
}

/** `true` when `provider` supports `feature`. */
export function supports(provider: CliProviderId, feature: CliFeature): boolean {
  return cliCapability(provider, feature).available;
}

/** "Not available in Codex CLI: <reason>" for a feature the provider lacks; `null` when it has it. */
export function unavailableText(provider: CliProviderId, feature: CliFeature): string | null {
  const capability = cliCapability(provider, feature);
  if (capability.available) return null;
  return `Not available in ${CLI_LABELS[provider]}: ${capability.reason ?? 'not supported'}`;
}

/** The command a developer runs to continue the session in a terminal, per provider; `null` without a native id yet. */
export function terminalResumeCommand(provider: CliProviderId, nativeId: string | null): string | null {
  if (!nativeId) return null;
  switch (provider) {
    case 'claude':
      return `claude --resume ${nativeId}`;
    case 'codex':
      return `codex resume ${nativeId}`;
    case 'opencode':
      return `opencode --session ${nativeId}`;
  }
}

/** Who wrote a handover (D62 switch): the outgoing agent, or the incoming one from the exported history. */
export type HandoverSource = 'outgoing' | 'history';

/** The chat divider's text: "Switched from Claude Code to Codex CLI · handover by the outgoing agent". */
export function switchDividerLabel(from: CliProviderId, to: CliProviderId, source: HandoverSource): string {
  const by = source === 'outgoing' ? `${CLI_LABELS[from]} (outgoing agent)` : `${CLI_LABELS[to]} from the history`;
  return `Switched from ${CLI_LABELS[from]} to ${CLI_LABELS[to]} · handover by ${by}`;
}

/** Short names of the features a CLI lacks (the CLI pickers' tooltip: "not here: …"). */
export const CLI_FEATURE_NAMES: Readonly<Record<CliFeature, string>> = {
  chat: 'chat',
  images: 'images',
  pdfs: 'PDFs inline',
  files: 'files',
  permissions: 'permission requests',
  'permission-always': '"always allow"',
  questions: 'question cards',
  stop: 'Stop',
  'pause-resume': 'pause / resume',
  model: 'model choice',
  effort: 'effort',
  'context-meter': 'context meter',
  'usage-footer': 'usage limits',
  'background-tasks': 'background tasks',
  'stop-background': 'stopping background tasks',
  subagents: 'subagents',
  'workflow-agents': 'Workflow agents',
  'remote-control': 'Remote Control',
  teleport: 'teleport',
  'terminal-handoff': 'terminal handoff',
  'history-import': 'History moves',
  mcp: 'MCP page',
  hooks: 'hooked terminal sessions',
  worktrees: 'worktrees',
  schedules: 'schedules',
  peers: 'peers',
  handover: 'handover',
};

/** "Not here: Remote Control, teleport, …" for a CLI's missing features; `null` when it has them all. */
export function missingFeaturesText(provider: CliProviderId): string | null {
  const missing = (Object.keys(CLI_CAPABILITIES[provider]) as CliFeature[]).filter((feature) => feature !== 'permission-always' && !CLI_CAPABILITIES[provider][feature].available);
  return missing.length > 0 ? `Not in ${CLI_LABELS[provider]}: ${missing.map((feature) => CLI_FEATURE_NAMES[feature]).join(', ')}` : null;
}

