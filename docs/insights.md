# Insights (D108)

The Insights page (`/insights`; the bar-chart icon in the sidebar's navigation grid, ⌘K → Insights) answers: where did the agents' time and tokens go (and, D134, which sessions used each account's usage windows: *Usage breakdown* below), how good were the todo estimates, how often did work come back, what would the todo runs cost at the prices you set, when will each account's usage windows fill, and which routing rules are worth trying. Decision: `docs/decisions.md` → D108. Contract: `docs/handoff/contracts/local-api.md` → *Insights (D108)*. Code: `src/core/insights.ts` (every metric, pure), `src/server/db/repos/insights.ts` (rollup and reads), `src/server/insights/` (backfill, service), `src/server/api/insights.ts` (route), `src/web/views/insights/` (page).

Nothing is invented: every number comes from something Switchboard recorded. Unknown stays unknown (`—`), and the page says what each number means.

## Filters

One row above the sections; they scope every section and live in the address (`?period=&from=&to=&folder=&cli=&model=&account=&machine=`), so a reload or a shared link keeps them.

- **Period**: Last 7 / 30 / 90 days (whole **UTC** days, today included) or a custom range (`from`–`to`, both included, at most 366 days). A turn belongs to the UTC day its `result` event was written; a todo to the UTC day it was completed; a Plans outcome / Merge-step decision to the day it ended.
- **Folder**: the session's root (`sessions.root`), or "No folder". **CLI**: the session's CLI. **Model**: the model key (below). **Account**: the account profile the session ran on (a session without one: its CLI's built-in Default).
- **Machine** (shown only with paired machines): **All machines** (the default: merged, *Merged machines* below), **This machine**, or one paired machine (its own Insights through the peer proxy, `/api/machines/{id}/api/insights`).
- The filter lists offer what the period contains.

**Chats (D106)** are never mixed in: their turns are counted apart (a line under *Time and tokens*). Todos and plan items are not chats by construction.

### The model key

Every section groups by the same key: the model the CLI **reported** for the turn (Claude Code's `result.modelUsage`: of its entries, the one with the most output tokens, named by its `canonicalModel`, else its key without a date suffix; recorded from 1.20 on), else the session's **chosen** model (`sessions.model`, e.g. `opus`), else `''`, shown as "default model" (the CLI's default; which model that was is not recorded). A todo's model is the one its working session (its run session, else its own) reported last when it completed. A D80 revert belongs to the model of the session's newest turn before it.

## 1 · Time and tokens

From the daily rollup (below). Sessions only (chats apart).

- **Turns** = the number of `result` events (one per turn that ended, also stopped and failed turns).
- **Tokens** = D78's tokens: `input + cache creation + output` of each turn's `usage`; **cache reads are left out** (the context re-read on every call would dwarf the rest).
- **Agent time** = the sum of the turns' `duration_ms` (the CLI's own measure of the turn), not wall time.
- **Tokens / turn** = tokens ÷ turns of the same rows (`—` with no turns).
- **Sessions** = distinct sessions with at least one turn.
- **By folder / by model / by session**: the same sums per group, sorted by tokens (the session table: the top 20).
- **Tokens per turn, by day**: per UTC day, that day's tokens ÷ its turns; a day without turns has no point (the line breaks). Hover or the arrow keys for a day's numbers; *Table* lists them all.

## 2 · Estimate accuracy

From `todo_actuals` (D78): completed todos **with an estimate**, completed in the period.

- **Ratio** = actual ÷ estimate = `actual_ms ÷ (estimate_minutes × 60,000)`. D78's actual time is the time the item spent in progress (every span from in progress to done; time back in open does not count).
- **Buckets**: `< 0.5×` = [0, 0.5), `0.5–1×` = [0.5, 1), `1–2×` = [1, 2), `> 2×` = [2, ∞). 1× exactly is in `1–2×` ("took as long or longer").
- **Median**: of the ratios; with an even count the mean of the two middle values.
- Per model and per folder: the same, per group.

## 3 · Outcomes and rework

Review cards (D79) were removed in D102: there are no review outcomes. These are the signals that are recorded now, per model; each rate is labelled on the page.

1. **Reopened todos** (`todo_reopens`, recorded from 1.20): a reopen is a todo going from **done** back to **open or in progress** (the developer's untick, ⋯ → Mark in progress / ▶ Start on a done item, the agent's `todo_update`, and a Plans **Send back**, which puts the item's todo back in progress). **Reopen rate** = completed todos (in the period) that were reopened at least once ÷ completed todos. Items completed before 1.20 count as never reopened (nothing was recorded).
2. **Plans (D99), only while Plans is on** (read from `plans.db` through a Plans hook; `null` while off):
   - **Merged** = items whose stored state is `done` (their work is in the target branch), at their merge time;
   - **Failed** = stored `failed` (discarded, could not start);
   - **Blocked** = any other item whose view state is `blocked` (a dependency failed, its session stopped with an error, a repeated conflict), at its last change;
   - **Merge rate** = merged ÷ (merged + failed + blocked).
   - **Merge-step decisions (D102)**: the Inbox's "Ready to merge" items closed by **Merge** (`merged`), **Send back** (`sent-back`) or a failed merge (`failed`), from the main database's system items (developer mode and held items only: agents' own merges have no decision). **Sent back rate** = sent back ÷ (merged + sent back + failed).
   - Attributed to the model of the item's run session (its chosen model).
3. **Reverts (D80)**: the rollup counts each "Revert to before this turn" / Undo last turn (`lifecycle` `reverted`) and each Redo (`revert-undone`) on its day. **Reverts / 100 turns** = max(0, reverts − Redos) ÷ turns × 100.

Not used: D76's "discarded" runs (gone with review cards), tool errors, error results (rolled up as `error_turns` but not shown as rework: an error turn is not undone work).

## 4 · Cost per todo run

**Every turn of the period** (ruling 2026-10-14): each rollup row (sessions; chats priced apart, a tile) × its model's price row: `usageCost` of its split (input, output, cache writes, cache reads; tokens without a split, turns before 1.20, at the input rate, the group marked `≥`). Summed **per folder**, **per model** and in **total**; the D78 tokens of models without a price row are counted apart ("n tokens of models without a price row are not in these totals"). It follows the merged view and every filter.

**Per todo:** each completed todo's tokens (in the period, filtered) priced with **Settings → Notifications & usage → Prices (Insights)** (`insights.prices`, `docs/settings.md`).

- **A todo's tokens by kind** = the `usage` of the turns D78 counts for it (the working session's turns that ended during its in-progress spans), accumulated per span like `actual_tokens` (`session_todos.actual_usage`, copied to `todo_actuals.usage` at completion).
- **Price row** = the first row whose `match` text the model key contains (case-insensitive). No row → the todo is *not priced* (counted, shown as `—`).
- **Cost** = (input × input price + output × output price + cache writes × cache-write price + cache reads × cache-read price) ÷ 1,000,000, in the table's currency. Cache reads **are** priced here.
- **Lower bound**: todos completed before 1.20 have only D78's total (no split): it is priced at the input rate and the cost is marked `≥` (a lower bound; output costs more).
- **Total** = sum of the priced todos; **average** = total ÷ priced; **median** of the priced costs; **by model**; **most expensive runs** = the 10 highest.
- **Example prices**: until you save the table it is Switchboard's example (USD, the Anthropic API list prices of October 2026: Fable 10 / 50, Opus 4 / 20, Sonnet 2 / 10, Haiku 0.10 / 0.50 per 1M input / output; cache writes 1.25× input, cache reads as listed), and both the page and Settings say "Example prices — edit in Settings". They are **not authoritative**: prices change, and a subscription is not billed per token.

## 5 · Usage-limit forecast

Per Claude Code account (the account / CLI filters apply; the period does not: it is about now), from the usage readings (`usage_readings`, D17 / D63) of the last 24 hours.

- **Current window**: the newest reading's window (its `resets_at`, which must be ahead of now). Readings belong to it when their reset is within 15 minutes of it (the two sources report it with small differences).
- **Pace** = the least-squares slope of % over time (% per hour) of the window's readings received in the lookback: **the last hour** for the 5-hour window, **the last 24 hours** for the weekly one (never before the window started). It needs two readings spanning at least 10 minutes (5-hour) / 1 hour (week), else **unknown**.
- **Verdicts**: already ≥ 100 % → *full*; pace ≤ 0 → *flat* ("not rising"); `full at = newest reading's time + (100 − its %) ÷ pace` before the reset → *fills* ("at this pace the weekly window is full Thu 14:00"); else *holds*, with the projected % at the reset (`newest % + pace × time to the reset`, at most 100).
- **Credits (D103)**: the account's credit line ("€12.40 left of €50") and an "on credits" mark, from the same state the footer shows.
- A straight line: bursts and pauses are not modelled. Codex and OpenCode have no stored readings (Codex's windows live in memory only) and are not forecast.

## 6 · Suggested routing rules

Rules for D82's *Model by task* worth trying. Completed todos (all filters but the model) are grouped by **priority × estimate class** (≤ 30 min, > 30 min, no estimate) × model. Model A is suggested over model B in the same group when:

- each has at least **3** completed todos, every one of them priced;
- A's reopen rate is **not higher** than B's;
- A's median cost is **at most half** of B's.

Per group, the cheapest such A against the most expensive B. The text names the evidence ("claude-haiku-4-5 finished 3 low-priority todos estimated ≤ 30 min with 0 reopened, at 1/36 the cost of claude-opus-5-5 (3 todos, 1 reopened)"). **Open in Model by task…** opens Settings → Sessions with the rule (priority, estimate, CLI, model) added to the editor **unsaved**; the reported model is offered as the CLI's own value when one matches (`claude-haiku-4-5` → `haiku`). Nothing is ever applied by itself.

## 7 · Usage breakdown (D134)

"Where your usage went": which sessions used the tokens of each account's usage windows. v2: **Insights › Usage** (`/insights?view=usage`; the status pill's popover has **See what used it →** per account, which opens it for that account's current 5-hour window; Settings › Usage & accounts links it). Classic: the section *Where your usage went* at the bottom of Insights (`?view=usage` scrolls to it). Decision: `docs/decisions.md` → D134. Code: `src/core/usage-breakdown.ts` (pure), `src/server/insights/usage.ts` (service), `src/server/insights/turns-backfill.ts`, `src/server/db/repos/insights.ts` (`insight_turns`), `src/server/api/insights.ts` (routes), `src/web/v2/insights/UsageView.tsx` + `usage-model.ts`, `src/web/views/insights/UsageSection.tsx`.

### What is recorded per turn

One row per `result` event in `insight_turns` (migration 0050), written by the same events-repository hook as the daily rollup:

| | |
|---|---|
| time | the result event's time (to the millisecond) |
| session, CLI, folder, kind (session / chat) | the session's, when the turn ended |
| model | the model key (*The model key* above) |
| account | the account profile the session ran on when the turn ended (not as it is now) |
| own tokens | the result's `usage`: input, output, cache writes, cache reads (results before 1.20: D78's total as *unsplit*) |
| agents' tokens | per model: the turn's **subagents, workflow agents and the CLI's background calls** (below) |
| duration | the result's `duration_ms` |
| computer | not stored: a row belongs to the machine that recorded it; the merged view tags it |

**Why a new table:** the windows need the minute a turn ended and the account it ran on; the daily rollup has days, and `events` has neither a time index nor the account. Indexes: `ts`, `(profile_id, ts)`, `(session_id, event_id)`. A weekly window reads one indexed range.

**Backfill:** turns written before 0050 are added in the background (the D108 backfill's pattern: bounded steps, waiting while events are written, the progress in each batch's transaction), **the last 8 days only** (its start found by a binary search over the event ids). The view says *Counting the last week's replies… n%* meanwhile. Older history is not needed: the longest period is a week.

### Subagents and workflow agents

Claude Code's `result.usage` is the turn's **own** replies (the main thread). Its `modelUsage` is **cumulative for the session** (it survives a resume) and includes the subagents', workflow agents' and background calls' tokens; a background subagent's tokens may appear only in a later turn. So from 2.1 on every result also stores `modelTotals` (the `modelUsage` token counts per model), and a turn's agents' tokens are, per model, *the growth of the totals since the session's previous turn, minus the turn's own usage* (`agentTokensOfTurn`). Rules, so it never over-counts:

- every part is clamped at 0; a total that went down (the CLI counted afresh) counts from zero;
- without a previous turn's totals nothing is attributed, unless this is the session's first turn ever (a Switchboard session, no earlier result), when the CLI started at zero;
- turns recorded before 2.1 have no totals: their agents' tokens are unknown (shown as none);
- Codex and OpenCode report no `modelUsage` counts: nothing extra.

The agents' tokens count towards their session everywhere (tokens, share, cost, chart, log); **Show the agents' tokens** on a session row splits *its own replies* from *subagents and workflow agents*, per model. Per individual subagent the CLI streams only a single total (`task_notification.usage.total_tokens`, cache reads included), which is not recorded. The D108 sections above (*Time and tokens*, cost) still count `usage` only.

### Periods and windows

- **Current 5-hour window** / **This week**: per account, its own window from its newest usage reading: `[resetsAt − 5 h (7 d), now]`. A turn counts when it ended inside **its own account's** window. When the newest reading's reset has passed (no newer reading yet), the span runs from the later of the reset and `now − 5 h (7 d)`, marked ("the window reset and no newer reading came"), without a %. An account with no reading has no window: it is named ("No window known yet for …"), never guessed. Accounts are Claude Code's (D63 readings) and Codex's (its own windows, while known).
- **Today**: from the browser's midnight (the page sends it). **Last 7 days**: the last 7 × 24 h. The same for every account.
- **Account**: all accounts (each in its own window) or one.

### Numbers

- **Tokens** = input + output + cache writes (+ unsplit), own and agents' (D78's measure). **Cache reads** are a separate column and never in the share: they are the context read again on every call, often 10–50× the rest, and the providers bill them at about a tenth of the input rate.
- **Share** = the row's tokens ÷ the answer's tokens: with one account, of that account's recorded tokens in its window; with all accounts, of every recorded token in the period.
- **The limit is not computed from tokens.** The providers' usage % weighs tokens in ways they do not publish (Anthropic does not publish the token cap) and also counts use outside Switchboard (claude.ai, other machines not paired, the CLI in a terminal). So the page shows shares of **what Switchboard recorded** and says so in its info note.
- **≈ % of the limit** (decision: shown, as an estimate): only with **one account** picked, in its **own 5-hour or weekly window**, while its usage % is known: *the row's share × the window's usage %*, written "≈ 12% of the 5-hour limit (estimate)". It assumes every token weighs the same and that all of the window's use came through Switchboard, which the note says. Never across accounts (their limits differ), never for Today / 7 days (not a window), never after the reset passed.
- **Turns** = results; by model, the turns whose own replies used it.
- **Models**: the own replies' model first, then the agents'.
- **Cost**: each model's part × its Insights price row (section 4); a part without a price row, or tokens without a split, mark it `≥`.
- **Group by**: Session (default) / Folder / Model (own and agents' parts each to their model) / Account / Kind: *teammate* (a Team member's session), *plan step* (a plan item's run session), *conversation* (a chat), *routine* (a session with a Switchboard loop that has not ended, or a schedule's run), else *agent*. The kind is the session's now.
- Rows: the top 100 (the rest summed in "n more with … tokens").

### Chart and log

- **Tokens over time**: stacked columns (inline SVG, ≤ 24 buckets of 15 min … 1 day, chosen by the span), the top 5 groups plus "Everything else" (neutral). Colours: the dataviz reference palette's first five categorical slots, validated light and dark (`validate_palette.js`: CVD worst adjacent ΔE 9.1 light / 8.4 dark; three light slots are under 3:1 against the surface, so the legend, the hover titles and the ranked list carry every value). Each column's hover title lists its numbers.
- **Usage log**: every turn of the period, newest first: time, session (opens it), model(s), tokens and cache reads, account (and computer). Filtered by the same period and account, and to one group with a row's **Log** button; 50 per page (`page`, `pageSize` ≤ 200). **Export CSV** downloads the whole log (every page, at most 20,000 turns): `time, session, kind, models, input, output, cache_write, cache_read, unsplit, tokens, agent_tokens, account, computer, folder`.

### API

`GET /api/insights/usage?period=5h|week|today|7d&account=&groupBy=session|folder|model|account|kind&from=&group=&page=&pageSize=&machine=all|local&peers=cached|wait[&format=csv]` → `UsageAnswer` (`src/core/usage-breakdown.ts`): `spans` (each account's window), `unknownWindows`, `totals`, `rows`, `more`, `chart`, `log`, `shareOf`, `estimate`, prices' currency, `accounts`, `machines`, `backfill`. `from` (Today only) is the browser's midnight (ISO, within 26 h). 422 for a bad parameter. Cached 15 s per query while no turn was recorded.

`GET /api/insights/usage/rows?from=&to=` (ISO, ≤ 8 days apart) → this machine's turns, accounts (windows, D98 identity), session titles and kinds, account names: what a paired machine merges. Both routes are on the peer and device allow-lists like the other Insights routes.

**Merged machines**: as D108's (*Merged machines* below): `machine=all` (default) pulls each paired machine's rows of the period's range (cached 60 s; `peers=cached` never waits, `wait` up to 2.5 s each), namespaces its sessions and folders, merges accounts by identity (the **newest** reading of the windows wins) and tags every row with its computer. A paired machine's own request answers only itself.

### Tests

`tests/core/usage-breakdown.test.ts` (windows, ranking and grouping, the subagent roll-up on a real turn's figures, shares, the estimate, the query, merging), `tests/web/v2-usage.test.ts` (the address, the pill's link, words, the stacked geometry), `tests/server/api/insights-usage.test.ts` (the routes on seeded turns across two accounts and windows, the CSV, the backfill, a paired machine), `tests/e2e/v2-usage.spec.ts` (the view, period and group-by, the pill, opening an agent, the log's pages, a phone), route classification in `tests/server/devices/units.test.ts` and `tests/server/peers/units.test.ts`.

## Merged machines

Ruling 2026-10-14: the default view is **All machines**, one view over this machine and every paired machine (D48).

- **What travels: rows, not numbers.** Each machine answers `GET /api/insights/rows?from=&to=` (peer API) with its rows of those days: rollup rows, completed todos with their reopen counts, Plans outcomes (or `null`), Merge-step decisions, the last 24 h of usage readings, its Claude Code accounts with their D98 identity and D103 credit line, session titles and account names. The merged answer is computed from all rows together, so medians, buckets, suggestions and the forecast are exact.
- **Pulled when the page asks** (not a D98-style background exchange): nothing travels unless the page is open, and an older or away machine simply answers nothing. Each machine's rows are cached **60 s** per period.
- **Never blocking:** the page's first request (`peers=cached`) answers at once with this machine's rows and any paired machine's fresh copy; a machine without one is listed as *pending* ("Adding Studio…") and fetched behind. The page then asks again with `peers=wait` (each machine bounded by 2.5 s) and fills it in.
- **Not reachable:** an offline machine, one that does not answer in time or an older Switchboard (no rows route) is left out, with the notice **"This machine only — Studio not reachable"** (or "Studio not reachable (not included)" with other machines in). An offline machine is left out even when a recent copy is cached.
- **Namespaces:** a paired machine's sessions, todos and plan items are `r~<machine>~<id>` (as D48's proxy names them), its session titles get "(Studio)". **Folders are per machine** (`<path>@@<machine>`): where two folders of the view share a name, each is labelled with its machine ("acme · This machine", "acme · Studio"). **Accounts merge by identity** (D98: the same Claude Code email is one account; its readings from both machines feed one forecast); an account only one machine has is "<name> (<machine>)". Models and CLIs are the same everywhere.
- A paired machine's own request (`GET /api/insights` over the peer API) always answers that machine alone (never fans out).

## Rollup and backfill

So the page never scans events, migration 0045 adds `insight_turns_daily`: one row per UTC day × session × CLI × model × account (folder and kind alongside) with turns, error turns, tokens, the split (input, output, cache write, cache read, unsplit), duration, reverts and Redos.

- **As turns end**: every event write goes through the events repository, which adds a `result` (or a `reverted` / `revert-undone` lifecycle line) to its day's row in the same call (one session lookup, one upsert); the dimensions are the session's at that moment (a later model / account switch does not rewrite history).
- **Backfill**: 0045 records the newest event id (`insight_state.events.upto`); events up to it are added in the background after startup, like D97's search backfill: steps of 500 candidate events (`kind` ok / error / text) and at most 15 ms, waiting while events are written (at most 1 s), starting 2 s after start; the progress is stored **in each batch's transaction**, so a restart resumes and never counts a batch twice. Their dimensions are the session's as it is now. The page says *Counting older history… n%* meanwhile.
- **Results recorded before 1.20** have no split and no reported model: their tokens are `unsplit` and their model the session's choice.
- **Other reads** (all indexed): `todo_actuals` by `completed_at` (new index), `todo_reopens` by todo, the "Ready to merge" system items, `usage_readings` by account and time (new index), the account list, and Plans' items (a few rows).
- **Cache**: an answer is reused for 30 s per query while nothing changed (the rollup's write counter, the completed todos and reopens, the backfill's progress and the prices).
- Deleting a session leaves its rollup rows (they hold numbers, no text) labelled "deleted session".

## Performance

`node tools/bench/insights.ts [--browser] [--runs 30] [--todos 400]` on the D95 bench world (31,819 events in 5 sessions, 2,000 usage readings) plus 400 completed todos over 90 days, seeded as an **upgrade** (every event older than the rollup), 2026-10-14 on the developer's Mac:

| | p50 | p95 | max |
|---|---|---|---|
| backfill: done after the server answered (2 s start delay included) | 2.1 s | | |
| `GET /api/insights?period=30d` while the backfill runs | 1.3 ms | 15.7 ms | 23.8 ms |
| first answer per query (7d / 30d / 90d / one model / custom 60d) | 2.7 ms | 3.9 ms | 3.9 ms |
| recomputed (the cache's stamp changed) | 2.7 ms | 3.5 ms | 3.8 ms |
| cached | 0.4 ms | 0.6 ms | 1.4 ms |
| the page in Chromium (1366 × 900): load until every section shows | 68 ms | 118 ms | 118 ms |
| a period change until its numbers show | 17 ms | 35 ms | 35 ms |

Answers are 10–15 KB. The acceptance bar (the page in < 500 ms on the bench world) holds with a wide margin.

Merged machines (`node tools/bench/insights-peers.ts`: two paired Switchboard processes on loopback, each with ≈5,400 rollup rows over 90 days and 400 completed todos; `period=90d&machine=all`):

| | time |
|---|---|
| peer reachable · the page's first request (this machine, the peer pending) | 53 ms |
| peer reachable · the fill-in (the peer's rows pulled, 54,000 turns merged) | 84 ms |
| peer reachable · recomputed with the peer's cached rows | p50 35 ms · p95 39 ms |
| this machine only · recomputed | p50 26 ms · p95 27 ms |
| peer slow (its process stopped with SIGSTOP) · first request | p50 9 ms · p95 9.5 ms (30d) |
| peer slow · fill-in | 2.4 s, then "did not answer in time" (the page already shows this machine) |
| peer offline · `peers=wait` | p50 26 ms · p95 31 ms, "reconnecting" |

## The page

`src/web/views/insights/`: one row of filters, then six sections. No chart library: the trend is an inline SVG line (one series, 2 px, crosshair and tooltip, keyboard ← →, a *Table* with every value), the accuracy buckets four HTML bars each labelled with its count, the per-group tables carry a thin bar, the forecast a meter (now solid, the projection hatched). One series colour (`--ins-series`, the dataviz reference palette's dark slot 1, validated against the page's surface); everything else is the app's tokens; status amber only with words ("at this pace … is full …", "€ on credits"). The app is dark only. Responsive (D74): cards 2 → 1 columns below 1024 px, the filters a two-column grid on phones, wide tables scroll inside their card; checked at 360 / 768 / 1366 / 1920 (`tests/e2e/insights.spec.ts`; screenshots `docs/visual/insights-*.png`).

Devices (D73) may read it; the Machine filter appears only with paired machines.

## Tests

- `tests/core/insights.test.ts`: a hand-computed fixture world (tokens, times, estimate buckets and medians, outcomes, costs, the forecast, the suggestion, filters).
- `tests/server/insights/rollup.test.ts`: the rollup as turns end, the backfill (bounded, resumable, never twice), what a completed todo records (split, model, priority, reopens), migration 0045.
- `tests/server/api/insights.test.ts`: the route, its 422s, prices from Settings.
- `tests/core/insights.test.ts` → *merged machines*, *period cost*: two fixture machines (sums, same-named folders, identity-merged accounts, the forecast over both) and exact period totals.
- `tests/server/insights/peers.test.ts`: a scripted paired machine (pending then filled in, the 60 s cache, offline, older, too slow); `tests/server/peers/insights.test.ts`: two real paired processes.
- `tests/web/insights.test.ts`: the page's helpers, the suggested rule into Model by task.
- `tests/e2e/insights.spec.ts`: the page with filters, a suggestion, prices, at 360 / 768 / 1366 / 1920.
- Route classification: `tests/server/devices/units.test.ts`, `tests/server/peers/units.test.ts`.
