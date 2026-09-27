# Handoff: Switchboard

A local web app for running and supervising many Claude Code sessions on one PC: an inbox of agent questions, session chat, timeline and diffs, a solutions/branches overview, schedules and loops, artifacts, history, embedded local tools, and settings.

This package is written so **Claude Code can build the entire product in a bounded loop** (Ralph outer loop, plan-act-verify per item). The loop instructions live in `LOOP.md`.

## About the design files
The files in `prototype/` are **design references built in HTML**. They show the intended look and behavior; they are not production code. Open `prototype/Switchboard App.dc.html` in a browser (keep `support.js` next to it). All data in the prototype is mock data, except the embedded-tool URL checks, which are live.

Build the real app in the stack described in `ARCHITECTURE.md` (ASP.NET Core + Blazor, matching the team's existing stack), following that stack's usual patterns.

## Fidelity
**High fidelity.** Colors, type, spacing, layout and copy are final. Match them exactly (see `SPEC.md → Design tokens`). Interactions in the prototype define the expected behavior.

## What's in the package
| File | Purpose |
|---|---|
| `README.md` | This index |
| `LOOP.md` | The loop prompt, the gates, caps/circuit breaker, and the progress-file format |
| `BACKLOG.md` | Ordered checklist of items (M0–M9). Each item has acceptance criteria and an **oracle** that makes it verifiable |
| `ARCHITECTURE.md` | Processes, Claude Code integration, data model, security, OS service |
| `contracts/local-api.md` | Locked REST + SignalR contract between the local service and the UI |
| `SPEC.md` | Screen-by-screen UI spec, interactions, state, design tokens |
| `AGENTS.md` | Rules for the agent working in the new `switchboard` repo |
| `prototype/Switchboard App.dc.html` | **Primary reference**: the full clickable prototype |
| `prototype/Switchboard.dc.html` | Design explorations (turns 1–4). Background only; the App file wins on any conflict |
| `prototype/support.js` | Runtime the prototypes need to open |
| `screenshots/01–14-*.png` | Reference captures of every view (inbox, session chat/timeline/diff, solutions, schedules & loops, artifacts, history, Codebase Memory tool, settings, new session, setup wizard, ⌘K palette). Captured at 60% zoom; use the prototype for exact sizes |

## Where the code lives
New repo `switchboard`, cloned at `<workspace>/other/switchboard/`. Under the workspace router this is a **non-product solution** (`other/`): edited only on explicit instruction, product per-type rules don't apply, and it follows its own `AGENTS.md` (included here).

## How to start
1. Create the repo and copy this folder into it as `docs/handoff/`.
2. Copy `AGENTS.md` to the repo root.
3. Start a Claude Code session in the repo and paste the **Kickoff prompt** from `LOOP.md`.
4. Approve the M0 spike results (gate) before the loop continues into M1+.

## Open decisions (resolved in M0, confirm with the developer)
- The exact Claude Code CLI surface available on the installed version: streaming input/output, how `AskUserQuestion` and permission prompts appear in headless mode, hooks in `-p` mode, background sessions and attach. The spike records what's real; the backlog adapts.
- Where Max usage % comes from. There is no documented usage API; candidates are listed in `ARCHITECTURE.md`. If none is reliable, the meter shows "unknown" rather than a guess.
- Whether driving Claude Code from a local tool fits the terms of your Max subscription. Check this before relying on it daily.
