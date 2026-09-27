# UI spec

The source of truth for visuals is `prototype/Switchboard App.dc.html`. This file names every view and records the exact values used.

## Design tokens
**Colors**
| Token | Value | Use |
|---|---|---|
| bg-app | #0b0c0d | page background |
| bg-sidebar | #111214 | sidebar, modal side panels |
| bg-main | #141518 | main area |
| bg-list | #121315 | inbox list, settings nav |
| bg-card | #17181b / #16171a | cards, rows |
| bg-code | #0c0d0f | terminal, diff, code blocks |
| bg-selected | #212227 (nav) · #1c1d21 (cards) · #1f2024 (rows) | selection |
| border | #232428 (dividers) · #2c2d32 (controls) · #26272c (cards) · #1f2024 (row lines) | |
| text | #e8e7e3 · strong #f0efeb | |
| text-2 | #c9c8c3 · #d9d8d3 | secondary |
| muted | #a9a8a3 · #8d8c87 · #76756f · #6d6c67 | descending emphasis |
| primary button | bg #e8e7e3, text #111214 | |
| status need | oklch(0.8 0.14 70) | needs you |
| status run | oklch(0.72 0.12 250) | running |
| status done | oklch(0.74 0.13 150) | done / ok |
| status fail | oklch(0.68 0.17 25) | failed |
| status idle | #5a5955 | idle / paused |
| branch chip | text oklch(0.78 0.1 250), bg oklch(0.24 0.03 250) | ⎇ branch |
| question card | border oklch(0.5 0.09 70), bg oklch(0.2 0.025 70), label oklch(0.82 0.13 70) | |
| selected option | border oklch(0.7 0.12 70), bg oklch(0.3 0.06 70) | |
| diff + / − | text oklch(0.82 0.1 150) on oklch(0.22 0.04 150) / oklch(0.76 0.13 25) on oklch(0.22 0.04 25) | |

**Type:** Geist (UI) and Geist Mono (paths, branches, labels, terminal).
- Page title 18px/600; modal/settings title 20px/600; inbox focus title 24px/500, letter-spacing −0.01em
- Body 13–13.5px; chat 13.5px/1.55
- Section label: Geist Mono 10.5px/500, uppercase, letter-spacing .06em, #8d8c87
- Mono meta 11–12px

**Radius:** 4–5px chips · 6–7px buttons · 8–10px cards · 12px question card/toast · 14px modals.
**Shadows:** toast 0 16px 40px rgba(0,0,0,.6); modal 0 30px 80px rgba(0,0,0,.6).
**Spacing:** 2/4/6/8/10/12/14/16/18/22/26/28px. Main padding 22–28px.

## Shell
Grid `256px | 1fr`, full height. The sidebar scrolls as a whole.
Sidebar, top to bottom: logo + ⌘K badge · "+ New session" (primary, full width) · nav (Inbox with count badge, Solutions with conflict badge, Schedules & loops with failed badge, Artifacts, History) · TOOLS (dot + name + host) · SESSIONS (dot, name, age, mode line; min-height 160px) · Settings · machine footer (service dot + address, CPU/RAM/Max bars at 4px, process count).

## Inbox
Two columns, `340px | 1fr`. List cards show a status dot, source, age, title and a kind label. The detail shows a meta line, the 24px title, branch chips, the detail text, then either:
- **Question batch card:** each question has its source in mono blue, the verbatim quote in “…”, and option pills. Footer: "n of m answered" + Send (45% opacity until everything is answered).
- **System actions:** the first is primary, the rest outlined.

Empty state: "Inbox zero".

## Session
Grid `1fr | 380px`. The header has a status dot, the name, the root path, Pause/Resume and "⇄ Continue in terminal" / "⇄ Attach here". Chips (k v, mono); loop/workflow chips are blue. Tabs: Chat · Timeline · Diff · n · Artifacts · n.
- **Chat:** user bubbles right (#212227, 12px radius), agent text left with mono tool lines. An inline question card when questions are open; once answered, a bubble lists the answers plus "● Answers written into the briefs…". Quick replies (pills) and a composer (Enter sends).
- **Timeline:** 150px label column; lanes 34px high; blocks colored by kind (plan/impl/loop/ask/ok); a white playhead; a range scrubber with ▶/❚❚; event log + terminal below.
- **Diff:** 300px file list (file, +/−, solution · path) | unified diff; header note "Not committed. Commit only when you approve."
- **Artifacts:** type tag + name + meta rows.
- **Right panel:** agent cards (dot, name, desc, status; path + ⎇ branch), terminal tail, handoff card (state, explanation, `claude --resume <id>` + copy).

## Solutions
`1fr | minmax(280px,340px)`. Filter pills: All, Web, Mobile, NuGet, Backend, Read-only. Groups by folder; the read-only group is at 60% opacity. Row grid: `minmax(130px,190px) minmax(240px,1fr) 80px 54px` → name (flag on a second line), branch chips (⎇ branch · worktree · dot · session, ellipsized), phase, changes. Detail: path, name, conflict warning card with a "Move … to worktree" action, branch cards (branch, worktree path, owner), phase ledger, artifacts & follow-ups, codebase-memory freshness + link.

## Schedules & loops
Table `10px 220px 150px 1fr 150px 180px`: dot, name + description, cron, a 14-run strip (14px bars) + last result, next run, Run now / Pause. Two loop cards: iteration strip, 3 facts, note, Open session.

## Artifacts
Search input + type filters. Table `80px 1fr 320px 180px 90px 50px`. A click opens the source session.

## History
Search. Rows `110px 220px 1fr 200px`: date, name + mode, summary + solutions/branches, outcome in status color.

## Tools
Toolbar: dot, name, description, URL field with status, Reload, New tab, Edit. The iframe fills the area. Overlays: "isn't configured" (→ Set URL in Settings) and "is not reachable" (→ Retry). The Codebase Memory tool adds a strip of `.codebase-memory-dirty` projects + "Reindex n now".

## Settings
`230px nav | content (max 860px)`. Sections: Claude Code (+ Run setup again), Workspace & solutions (scan table), Sessions & worktrees, Notifications & usage (Send test, Allow OS notifications, 90%, just warn), Schedules, Embedded tools (URL input, Test, Open), GitHub. Rows: label + description left, value/control right, 1px #1f2024 divider.

## Modals
- **New session:** 1080px, `1fr | 360px`. Numbered sections 1–6; pills (selected: #26272c bg, #8d8c87 border); solution chips (selected: blue); read-only chips at 40% opacity with a not-allowed cursor. The right panel has the Worktree/Ultracode toggles (32×18) and a live mono summary with the worktree paths. "Start session" is disabled when there are no solutions or the name is a duplicate.
- **Setup wizard:** 960×620, a steps rail with ✓/number dots; Back / Skip / Continue → Finish.
- **Palette:** 620px, input 15px, results show a kind label + label + hint; ↑↓ Enter; Esc closes.
- **Toast:** top-right, 360px; dot, title, sub, branch line, text; Jump to session / Later. It plays a two-tone chime (784 Hz → 1046 Hz, about 0.25s) and sends an OS notification if allowed.

## Copy rules
Plain, factual, sentence case. Agent questions are always shown **verbatim** with attribution. Nothing is committed, pushed or deleted without an explicit click.
