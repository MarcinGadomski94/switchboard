# Configuration and scripts (M1.1)

## Environment variables
Read once at startup by `src/server/config.ts`. An invalid value makes `npm start` exit 1 with a message.

| Variable | Default | Notes |
|---|---|---|
| `SWITCHBOARD_PORT` | `4870` | Integer 1–65535. Tests use 4871–4879. The bind address is fixed to 127.0.0.1 and has no variable (`docs/security.md`). |
| `SWITCHBOARD_DATA_DIR` | per-user app-data folder | macOS `~/Library/Application Support/Switchboard`, Windows `%LOCALAPPDATA%\Switchboard` (else `~\AppData\Local\Switchboard`), Linux `$XDG_DATA_HOME/switchboard` when XDG_DATA_HOME is absolute, else `~/.local/share/switchboard` (gap #18). Holds the token (`sb_token`) and the database `switchboard.db` (`docs/database.md`), which is created and migrated at startup. A relative value resolves against the working directory. Tests always pass a temp folder. |
| `SWITCHBOARD_WORKSPACE_ROOT` | none (`null`) | The workspace Switchboard manages. There is no default: `null` means not configured. A relative value resolves against the working directory. |
| `SWITCHBOARD_CLAUDE_BIN` | `claude` | The Claude Code CLI. A value that starts with `[` is a JSON array used as an argv prefix, e.g. `["/path/to/node","/repo/tools/fake-claude/main.ts"]`, which is how tests point the supervisor at `tools/fake-claude` on every OS (`fakeClaudeBinEnv()` in `tools/fake-claude/command.ts`; surface in `docs/fake-claude.md`). Always spawned with `shell: false`. |
| `SWITCHBOARD_CLAUDE_EXTRA_ARGS` | none | **Dev-only.** A JSON array of flags appended to every supervised `claude` spawn, after the baseline (`docs/supervisor.md`), e.g. `["--model","haiku","--max-turns","3"]` for the D13 real-CLI smoke. Never shell-parsed; anything but an array of non-empty strings makes `npm start` exit 1. Leave unset in normal runs. |
| `SWITCHBOARD_GH_BIN` | `gh` | The GitHub CLI, same format as `SWITCHBOARD_CLAUDE_BIN`. The worktree manager runs `gh pr view <branch> --json number,state,url,headRefOid` for each registered worktree 15 s after start and then every 5 minutes (`docs/worktrees.md`); tests point it at `tools/fake-gh` (`fakeGhBinEnv()`). git itself is taken from `PATH`. |
| `SWITCHBOARD_DEMO` | off | Exactly `1` loads the demo seed (gap #21, visual oracle only; `docs/demo.md`). Any other value means off. Needs `SWITCHBOARD_DATA_DIR` set to a throwaway folder: demo mode refuses the per-user app-data folder. |

Test-only variables (read by the test helpers, never by the server):

| Variable | Default | Notes |
|---|---|---|
| `SWITCHBOARD_TEST_PORTS` | `4871-4879` | The test port pool (`tests/helpers/net.ts` → `TEST_PORTS`) as `<first>-<last>`, 2–20 ports, never including 4870. Parallel lane worktrees set their own range (e.g. `SWITCHBOARD_TEST_PORTS=4930-4939 npm test`) so their suites never share ports. Every test server, stub server and socket test binds only inside the pool. |
| `SWITCHBOARD_E2E_PORT` | none | Pins the port test servers use (`tests/helpers/server-process.ts`); must be one of the test ports (`SWITCHBOARD_TEST_PORTS`). Unset: the first free port in the pool. |
| `SWITCHBOARD_VISUAL_REPORT` | off | `1` makes the visual-oracle specs also write their reports into `docs/visual/` (`docs/visual/README.md`); they always write to `test-results/visual/`. |

## npm scripts
| Script | What it does |
|---|---|
| `npm run build` | `vite build`: `src/web` → `dist/web`. |
| `npm start` | `node src/server/main.ts`: Fastify on 127.0.0.1, serving `dist/web` and the API. Node ≥ 24 runs the TypeScript directly (type stripping, erasable syntax only). |
| `npm run dev` | `tools/dev.ts`: `vite build` in watch mode into `dist/web` plus `node --watch src/server/main.ts`. There is no Vite dev server or HMR. The UI is served by the real server on the real port, so the Host/Origin guard and the `sb_token` cookie behave as in production. Reload the browser after a rebuild. |
| `npm run typecheck` | `tsc` over three configs: `tsconfig.json` (server, core, tools, tests, tool configs; Node types, no DOM), `tsconfig.web.json` (React UI, DOM, bundler resolution), `tsconfig.e2e.json` (Playwright specs: adds DOM for `page.evaluate`). |
| `npm test` | Vitest: `tests/**/*.test.ts` (unit + integration). |
| `npm run e2e` | Playwright: `tests/e2e/**/*.spec.ts`, Chromium at 1440×900. It first builds `dist/web` (`tests/e2e/global-setup.ts`). Specs start their own server on a test port (`SWITCHBOARD_TEST_PORTS`, default 4871–4879) with a temp data dir. |

## Ignored folders
Every tool config excludes `.worktrees/` (parallel lane worktrees), `.spike/`, `dist/` and `node_modules/`: the tsconfigs (`exclude`), `vite.config.ts` (`server.watch.ignored`, `build.watch.exclude` in dev), `vitest.config.ts` (`test.exclude`, `server.watch.ignored`) and `playwright.config.ts` (`testIgnore`, a pattern anchored inside `tests/e2e/`, because Playwright matches absolute paths and a lane worktree itself lives under `.worktrees/`).

## Pinned tool versions
Exact versions live in `package.json` + `package-lock.json`. The fonts are `@fontsource/geist` and `@fontsource/geist-mono` 5.3.0 (OFL, the Google Fonts files; gap #19). The prototype's runtime for the offline visual harness is pinned as devDependencies at the versions the prototype requests: `prototype-react` = `npm:react@18.3.1`, `prototype-react-dom` = `npm:react-dom@18.3.1` and `@babel/standalone` 7.29.0; an `overrides` entry points the aliased react-dom's React peer at the app's React (`$react`), because only its UMD file is used, never its module. `@playwright/test` is pinned to **1.62.1** because its Chromium (revision 1234) is the one already in `~/Library/Caches/ms-playwright`, so no browser download is needed. Moving to a newer Playwright means running `npx playwright install chromium` (allowed by D12).
