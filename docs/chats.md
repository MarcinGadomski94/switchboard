# Chats (D106)

A **chat** is a conversation to think and plan in, started instead of a development session. Its agent may read files, search, browse the web and look at what the developer pastes or attaches, and it keeps Switchboard's MCP tools (todos, artifacts, plans when they are on). It never edits files, writes code or runs commands that change things: coding happens in a session. When the plan is ready, **Continue as session…** carries the conversation into a new development session.

Developer request (2026-10-14): "can we add a mode that I can just start a chat instead of development session?" Rulings: full tools but only planning; a CHATS section of its own; Continue as session. `docs/decisions.md` → D106.

## Where a chat runs

- **Its own empty scratch folder:** `<dataDir>/chats/<id>/` (0700), created at the start and removed when the chat is deleted (`src/server/chats/start.ts`). No workspace, no `AGENTS.md`, no git repository, no worktrees, no branch. So no router start-up questions: the first message is the developer's text alone (no session-start answers block, no worktree note). Claude Code still reads the developer's user-level `CLAUDE.md`, as any session does.
- **Look at folders (optional):** folders the chat may read for planning, at the start (the New-chat form) or later (the chat's ⋯ → **Look at folders…**). Absolute paths of existing folders, canonicalized, at most 10 (`LOOK_AT_MAX`); none by default. They go to the CLI as extra read-only directories (Claude Code: `--add-dir` per folder, still in plan mode) and are named in the chat's instruction. A change restarts an idle chat's process with `--resume` (the divider **Folders to look at updated**); a busy one restarts after its turn (D91's reload, since the folders are part of the chat's instruction).
- **Record:** a row of `sessions` with `kind = 'chat'` and `look_at` (migration **0044**); `folder_id`, `root`, `root_kind` are `NULL`, `solutions` empty, `worktrees` off.

## Read-only per CLI

Every CLI Switchboard runs has a read-only mode, so chats are offered for all three (`chatSupport` in `src/core/chats.ts` is the one place a CLI without one would be refused with its reason, shown in the New-chat form's error line).

| CLI | How it is held read-only | Status |
|---|---|---|
| Claude Code | `--permission-mode plan` on every spawn (resumes included) and never changed; `--disallowedTools Edit,MultiEdit,Write,NotebookEdit,ExitPlanMode,Bash,BashOutput,KillShell,KillBash,PowerShell,REPL` (the editors, the tool that would leave plan mode and, ruling 2026-10-14, **every shell / code-running tool**: no Bash at all; a name the CLI does not have is ignored by it); `WebFetch,WebSearch` added to `--allowedTools` next to `mcp__switchboard` (reading the web is planning); `--add-dir` per folder to look at. Every permission request (`can_use_tool` other than AskUserQuestion) is **refused at once by Switchboard** with the chat's reason, before the recorder or the Inbox see it (the chat's line "Refused in a chat: <tool> (chats can plan but not edit)"). A turn whose `system/init` reports any mode but `plan` gets `set_permission_mode plan` straight away (the line "The chat left plan mode (…): set back to plan"); D6's auto → acceptEdits fallback never applies. | Flags VERIFIED in `claude --help` (2.1.296: `plan` among the `--permission-mode` choices, `--disallowedTools`, `--add-dir`, `--allowedTools`); Switchboard's refusals and re-assertion VERIFIED with fake-claude (which honours `--disallowedTools`: a disallowed `Write` or `Bash` call is never made). The shell tools' names: `Bash`, `PowerShell`, `REPL` are the code-running tools `claude --help` names (VERIFIED); `BashOutput` / `KillShell` / `KillBash` (the background-shell companions) are ASSUMED names. ASSUMED: what the real CLI does in plan mode with each remaining tool — Switchboard's own refusal covers anything that asks. |
| Codex CLI | ruling 2026-10-14, no shell: the chat's `codex app-server` starts with `-c features.shell_tool=false -c features.unified_exec=false` (`CODEX_CHAT_CONFIG`, the same as `--disable shell_tool --disable unified_exec`), which removes its shell / exec tools; and `thread/start` / `thread/resume` with `sandbox: 'read-only'` and `approvalPolicy: 'never'` (should a command still run it cannot write; nothing asks); any exec or patch approval that still arrives is refused like Claude Code's permission requests. | The features `shell_tool` and `unified_exec` (both stable, on by default) and `--disable` / `-c features.<name>=false` VERIFIED with `codex features list` / `codex --help` (0.160.0); `read-only` / `never` VERIFIED there as the sandbox / approval values. The argv and parameters VERIFIED with fake-codex. ASSUMED: that the app-server leaves the model no other way to run a command with both features off (not run with a real Codex). |
| OpenCode | the server's `OPENCODE_CONFIG_CONTENT` permission rules `{ edit: deny, bash: deny, webfetch: allow, external_directory: allow }` (ruling 2026-10-14: the shell is denied, confirmed) (`OPENCODE_CHAT_PERMISSIONS`; reads outside the scratch folder are what "look at folders" needs), and every prompt names the built-in `plan` agent (`agent: "plan"`). Any permission that still asks is refused. | VERIFIED with fake-opencode (the config and the prompt body). ASSUMED (no OpenCode installed here): OpenCode's built-in `plan` agent and `prompt_async`'s `agent` field. |

**No permission-mode picker.** Switchboard has none for sessions either (D6: every session runs in `auto`, falling back to `acceptEdits`). Where one would be, a chat's header shows a locked **🔒 Plan mode** chip whose tooltip / accessible name is the hint *Chats can plan but not edit. Continue as session to code.* (`CHAT_LOCKED_HINT`). The New-chat form shows the same hint under its title.

**Refused for chats** (409 `chat`): Continue in terminal (`POST …/detach`: a terminal's CLI could leave plan mode), Remote Control (`PUT …/remote` `{enabled: true}`: claude.ai could switch the mode), and a take-over to another machine (a blocker in its preview). Adopting a chat as a Team member (409 `chat`) and naming it a plan's source (409 `chat`) are refused too.

## The chat's instruction

The developer's standing instruction (Settings → Sessions, D64) does **not** apply to chats: it is often written for a workspace. A chat gets its own fixed instruction instead (`chatInstruction`), built from:

- what a chat is: plan mode that stays, read with the read tools and search with Grep / Glob, **no shell** (never run commands), never edit / write, describe the plan and let the developer continue as a session;
- the folders it may read (or that it has none and can ask for some);
- **Switchboard's own parts that apply:** "write out the proposal / table / plan before asking about it" (D64), the todo tools (D68–D75) and `artifact_save` (D89). **Not** `loop_create` (D94): a chat does no recurring work.

D100's team charter never applies (a chat is never a member). The switchboard MCP server is injected as for any session (`--mcp-config`, `--allowedTools mcp__switchboard`). `Session.instructionOutdated` compares a chat's process with this instruction, so changing the standing-instruction setting never marks a chat outdated.

## Starting a chat

- **Sidebar:** **+ New chat** on the CHATS header (`data-tour="new-chat"`), shown also with no chats.
- **⌘K:** **New chat** (after the prototype's entries, so its first ten results stay), **Chats** (only with open chats: shows and focuses the CHATS section, opening the drawer on a tablet or phone), and every open chat (kind `chat`).
- **The New-chat form** (`src/web/modals/NewChatModal.tsx`): the message with its attachments (📎, paste, drop), the CLI and account (the New-session pickers), the model and effort (the New-session picker; the next form starts on the last choice), and **Look at folders** (a path field with Add, the saved folders as one-click chips). ⌘↩ / Ctrl+↩ starts. The title comes from the first line of the message with text (Markdown marks and links reduced, cut at a word to 60 characters with "…"; "New chat" when it has no words) and is shown under the message; the chat can be renamed like a session.

`POST /api/chats` starts it (contract → *Chats (D106)*).

## Sidebar

The **CHATS** section sits above SESSIONS (after the Team entry) and **always shows** (ruling 2026-10-14), also with no chats: its header with a ▾ / ▸ toggle, the count and **+ New chat**, then one row per open chat (newest first): dot, title, age, and *plan mode* (· *N folders*) or *continued as <session>*; the row's × closes it and its **⋯** has **Rename…** (on a touch screen also Close, as the × needs a hover); a double-click on the title renames it too (see *Rename*). SESSIONS never lists chats, nor does any folder or pin of the sidebar layout. The list is at most a third of the window high and scrolls.

**Folding:** the CHATS and SESSIONS headers each fold their list (▾ / ▸, the count stays), kept per install as `ui.chatsCollapsed` / `ui.sessionsCollapsed` like D101's TOOLS, default expanded (`docs/sidebar.md` → *SESSIONS and CHATS (D106)*). The visual oracle changes by design: `docs/visual/README.md` → *D106*.

## The chat's header

- The title (a click renames it, see *Rename*), then a **chat** badge.
- Actions: the account and model pickers, the locked **🔒 Plan mode** chip, Close / Reopen, Pause / Resume, and a **⋯** with **Rename…**, **Continue as session…**, **Look at folders…** (disabled while closed) and **Delete chat…** (asks first).
- Not shown for a chat: the CLI switcher, Remote, take-over, Undo last turn, Continue in terminal, the Diff tab (the tabs are Chat · Timeline · Artifacts), the right panel's Terminal handoff card and Plans tab.
- The root line reads `<scratch folder> · chat scratch folder`.

## Rename

Developer request 2026-10-22: "also add a possibility to rename the chats". A chat is a session of kind `chat`, so it is renamed **exactly like a session (D22)**: the same `InlineTitle` editor and the same route, nothing new on the server.

- **Where:** the sidebar row's ⋯ → **Rename…** (`sidebar-chat-menu-rename`) or a double-click on the row's title; the chat header's title (a click) or its ⋯ → **Rename…** (`chat-rename`). The ⋯ items make it reachable from the keyboard and on a phone (the drawer's row ⋯ shows without a hover there).
- **Editing:** the title turns into a field with the text selected (accessible name *Chat title*). Enter or leaving the field saves, Esc cancels; the text is trimmed; an emptied field clears the title so the chat shows its own name again (the session rule); over 80 characters is refused by the server and shown under the field (`TITLE_RULE`).
- **Saved:** `PUT /api/sessions/{id}/title`, which publishes `sessionUpdated` (other tabs, phones and paired machines update). A paired machine's chat is renamed on its own machine: the route is on `PEER_API_ALLOW` and forwarded like a session's.
- **It sticks:** the first-message title is written once when the chat starts (`chatTitleFromMessage`); nothing writes `title` afterwards (the CLI's own `ai-title` is never copied into it), so a rename is kept over later turns, restarts and look-at changes. No "set by the developer" flag is needed.
- **Continue as session:** the new session has its own title (the form's field, as before); the links read the chat's current title: the form's *Continues the chat “<title>”*, the new session's **Continued from the chat <title>** divider and `continuedFrom.title`.
- **Search (D97):** the title is in the index through the sessions trigger (0042, `UPDATE OF title`), so the new title is found at once.

## Continue as session

The chat's ⋯ → **Continue as session…** opens the **New-session form**, pre-filled with the chat's CLI, model and effort and, when the first folder it looks at is a saved folder, that folder; the developer picks the folder / workspace, writes the session's message and starts it. The form opens in the remembered mode (Simple or Full, like New session) and says *Continues the chat “<title>”: its conversation is carried into the session's first message, before yours.* (`data-testid="ns-from-chat"`). For a paired machine's chat the form starts on that machine.

**Mechanism: the D62 P5 history export, carried into the first message.** `POST /api/sessions` takes an additive `fromChat` (the chat's id on that machine). Switchboard exports the chat as it recorded it (`chatMarkdown`: the developer's messages, the agent's replies, one line per tool step) to `<dataDir>/handovers/<chat id>/<stamp>-continued-as-session.md` and starts the new session's first message with it (the newest 60,000 characters inline; the export path for the rest), then the developer's message (and, for a Full start, the usual answers block). Chosen over the alternatives the ruling named because it needs no turn of the chat's agent (it is immediate and works the same for Claude Code, Codex and OpenCode), and over resuming the CLI's own conversation in the new cwd because a chat's conversation was held in plan mode with the chat's instruction, which the new session must not inherit (and two Switchboard sessions cannot share one conversation id). The fallback the ruling named (an agent-written handover) is not needed.

Both are linked like D83's continuation (`continuedFrom` on the session, `continuedTo` on the chat; the dividers **Continued from the chat <title>** and **Continued as <session>**, each a link). The chat is **not closed**: it stays in CHATS, its row reads *continued as <session>* and its header *Continued as <session>* with **Open the session**. It can be continued again (the link follows the newest). The new session is an ordinary development session (D6's permission mode, its folder, worktrees, router questions as usual).

## Lifecycle

- **Close** and **Reopen** as for a session (D33); History lists closed chats.
- **Delete:** the chat's ⋯ → **Delete chat…** (`DELETE /api/chats/{id}`): closes it (its process stops) and removes its record (events, todos… cascade), its scratch folder, its attachments and its exports. Clean-up (D84) deletes closed chats like closed sessions, scratch folder included.
- **Continue in a fresh session** (D83) keeps a chat a chat (kind, folders and scratch folder are carried over).

## Excluded

Chats are left out of: Team suggestions and the Team page's session pickers; Plans sources (the New-plan and Jira dialogs, the session's Plan tab; the server refuses one); review / Diff / checkpoints (no Diff tab; no checkpoint before a turn); solution rows and conflicts (Solutions view and badge).

## Search, phones and peers

- **Search (D97)** finds chats like sessions; a chat's title result is labelled **Chat**, any other result in a chat gets ` · chat` (additive `SearchResult.chat: true`).
- **Phones (D73) and peers (D48)** work with chats like sessions: their list carries `kind: 'chat'`, every session route works for them, and the chat routes are classified: `POST /api/chats`, `PUT /api/chats/{id}/look-at`, `DELETE /api/chats/{id}` are on `DEVICE_ALLOWED` and `PEER_API_ALLOW` (a peer's chat's look-at answers are mapped as a `session`). The New-chat form itself starts chats on this machine.

## What's new

A one-step mini-tour **Chats** (`chats`, D106) under version **1.19.0** (`V1_19`), pointing at **+ New chat** on the CHATS header (`new-chat`; the drawer on a phone).

## Tests

- `tests/server/chats/chats.test.ts` (fake-claude, fake-codex, fake-opencode, the real routes): no shell on any CLI (Claude Code's `--disallowedTools` names Bash and the other shell tools, and a `Bash` call is never made; Codex's app-server starts with its shell features off; OpenCode's bash denied); plan mode in the scratch folder with the chat instruction and no AGENTS.md / router questions; edits not offered (fake-claude honours `--disallowedTools Write`) and permission requests refused; plan mode set back; terminal and Remote refused; look-at folders (`--add-dir`, restart); the MCP flags; the title; excluded from Team suggestions, Plans and Solutions; delete removes the scratch folder; Continue as session; rename (the title route, `sessionUpdated`, kept over later turns and a restart, found by search, the continued session's link); route classification; Codex's read-only sandbox; OpenCode's rules and plan agent.
- `tests/server/peers/proxy.test.ts`: a paired machine's chat renamed from the other machine.
- `tests/server/db/migrate.test.ts` (0044), `tests/server/db/repos.test.ts` (the defaults).
- `tests/e2e/chats.spec.ts`: New chat from the sidebar and from ⌘K, the CHATS section (also with no chats), the badge and the locked hint, no Diff tab, Continue as session, folding SESSIONS and CHATS (kept across a reload; ⌘K → Chats unfolds), rename from the row ⋯ (keyboard), a double-click and the header (click and ⋯), Esc, an emptied field, after a reload, and at 360 px on a touch screen (`CHATS_SHOTS=<dir>` writes screenshots).
- `tests/web/nav-grid.test.ts`: the three section states' store (`ui.sessionsCollapsed`, `ui.chatsCollapsed`).
- The shell / full-pass visual specs: `docs/visual/README.md` → *D106*.
