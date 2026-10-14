# Insights (D108)

The Insights page (`/insights`; the bar-chart icon in the sidebar's navigation grid, ⌘K → Insights) answers: where did the agents' time and tokens go, how good were the todo estimates, how often did work come back, what would the todo runs cost at the prices you set, when will each account's usage windows fill, and which routing rules are worth trying. Decision: `docs/decisions.md` → D108. Contract: `docs/handoff/contracts/local-api.md` → *Insights (D108)*. Code: `src/core/insights.ts` (every metric, pure), `src/server/db/repos/insights.ts` (rollup and reads), `src/server/insights/` (backfill, service), `src/server/api/insights.ts` (route), `src/web/views/insights/` (page).

Nothing is invented: every number comes from something Switchboard recorded. Unknown stays unknown (`—`), and the page says what each number means.

## Filters

One row above the sections; they scope every section and live in the address (`?period=&from=&to=&folder=&cli=&model=&account=&machine=`), so a reload or a shared link keeps them.

- **Period**: Last 7 / 30 / 90 days (whole **UTC** days, today included) or a custom range (`from`–`to`, both included, at most 366 days). A turn belongs to the UTC day its `result` event was written; a todo to the UTC day it was completed; a Plans outcome / Merge-step decision to the day it ended.
- **Folder**: the session's root (`sessions.root`), or "No folder". **CLI**: the session's CLI. **Model**: the model key (below). **Account**: the account profile the session ran on (a session without one: its CLI's built-in Default).
- **Machine** (shown only with paired machines): which machine's Insights to read. Each machine computes its own; the page shows one machine at a time through the peer proxy (`/api/machines/{id}/api/insights`). There is no merged "both machines" view (medians and distributions cannot be merged from two answers; see *Open questions*).
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

Each completed todo's tokens (in the period, filtered) priced with **Settings → Notifications & usage → Prices (Insights)** (`insights.prices`, `docs/settings.md`).

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

## The page

`src/web/views/insights/`: one row of filters, then six sections. No chart library: the trend is an inline SVG line (one series, 2 px, crosshair and tooltip, keyboard ← →, a *Table* with every value), the accuracy buckets four HTML bars each labelled with its count, the per-group tables carry a thin bar, the forecast a meter (now solid, the projection hatched). One series colour (`--ins-series`, the dataviz reference palette's dark slot 1, validated against the page's surface); everything else is the app's tokens; status amber only with words ("at this pace … is full …", "€ on credits"). The app is dark only. Responsive (D74): cards 2 → 1 columns below 1024 px, the filters a two-column grid on phones, wide tables scroll inside their card; checked at 360 / 768 / 1366 / 1920 (`tests/e2e/insights.spec.ts`; screenshots `docs/visual/insights-*.png`).

Devices (D73) may read it; the Machine filter appears only with paired machines.

## Tests

- `tests/core/insights.test.ts`: a hand-computed fixture world (tokens, times, estimate buckets and medians, outcomes, costs, the forecast, the suggestion, filters).
- `tests/server/insights/rollup.test.ts`: the rollup as turns end, the backfill (bounded, resumable, never twice), what a completed todo records (split, model, priority, reopens), migration 0045.
- `tests/server/api/insights.test.ts`: the route, its 422s, prices from Settings.
- `tests/web/insights.test.ts`: the page's helpers, the suggested rule into Model by task.
- `tests/e2e/insights.spec.ts`: the page with filters, a suggestion, prices, at 360 / 768 / 1366 / 1920.
- Route classification: `tests/server/devices/units.test.ts`, `tests/server/peers/units.test.ts`.
