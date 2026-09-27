# Configuration and scripts (M1.1)

## Environment variables
Read once at startup by `src/server/config.ts`. An invalid value makes `npm start` exit 1 with a message.

| Variable | Default | Notes |
|---|---|---|
| `SWITCHBOARD_PORT` | `4870` | Integer 1–65535. Tests use 4871–4879. The bind address is fixed to 127.0.0.1 and has no variable (`docs/security.md`). |
| `SWITCHBOARD_DATA_DIR` | per-user app-data folder | macOS `~/Library/Application Support/Switchboard`, Windows `%LOCALAPPDATA%\Switchboard` (else `~\AppData\Local\Switchboard`), Linux `$XDG_DATA_HOME/switchboard` when XDG_DATA_HOME is absolute, else `~/.local/share/switchboard` (gap #18). Holds the token (`sb_token`) and the database `switchboard.db` (`docs/database.md`), which is created and migrated at startup. A relative value resolves against the working directory. Tests always pass a temp folder. |
| `SWITCHBOARD_WORKSPACE_ROOT` | none (`null`) | The workspace Switchboard manages. There is no default: `null` means not configured. A relative value resolves against the working directory. |
| `SWITCHBOARD_CLAUDE_BIN` | `claude` | The Claude Code CLI. A value that starts with `[` is a JSON array used as an argv prefix, e.g. `["/path/to/node","/repo/tools/fake-claude/main.ts"]`, which is how tests point the supervisor at `tools/fake-claude` on every OS (`fakeClaudeBinEnv()` in `tools/fake-claude/command.ts`; surface in `docs/fake-claude.md`). Always spawned with `shell: false`. |
| `SWITCHBOARD_GH_BIN` | `gh` | The GitHub CLI, same format as `SWITCHBOARD_CLAUDE_BIN`. |
| `SWITCHBOARD_DEMO` | off | Exactly `1` loads the demo seed (gap #21, visual oracle only). Any other value means off. |

## npm scripts
| Script | What it does |
|---|---|
| `npm run build` | `vite build`: `src/web` → `dist/web`. |
| `npm start` | `node src/server/main.ts`: Fastify on 127.0.0.1, serving `dist/web` and the API. Node ≥ 24 runs the TypeScript directly (type stripping, erasable syntax only). |
| `npm run dev` | `tools/dev.ts`: `vite build` in watch mode into `dist/web` plus `node --watch src/server/main.ts`. There is no Vite dev server or HMR. The UI is served by the real server on the real port, so the Host/Origin guard and the `sb_token` cookie behave as in production. Reload the browser after a rebuild. |
| `npm run typecheck` | `tsc` over three configs: `tsconfig.json` (server, core, tools, tests, tool configs; Node types, no DOM), `tsconfig.web.json` (React UI, DOM, bundler resolution), `tsconfig.e2e.json` (Playwright specs: adds DOM for `page.evaluate`). |
| `npm test` | Vitest: `tests/**/*.test.ts` (unit + integration). |
| `npm run e2e` | Playwright: `tests/e2e/**/*.spec.ts`, Chromium at 1440×900. Specs start their own server on a 4871–4879 port with a temp data dir. |

## Ignored folders
Every tool config excludes `.worktrees/` (parallel lane worktrees), `.spike/`, `dist/` and `node_modules/`: the tsconfigs (`exclude`), `vite.config.ts` (`server.watch.ignored`, `build.watch.exclude` in dev), `vitest.config.ts` (`test.exclude`, `server.watch.ignored`) and `playwright.config.ts` (`testIgnore`).

## Pinned tool versions
Exact versions live in `package.json` + `package-lock.json`. `@playwright/test` is pinned to **1.62.1** because its Chromium (revision 1234) is the one already in `~/Library/Caches/ms-playwright`, so no browser download is needed. Moving to a newer Playwright means running `npx playwright install chromium` (allowed by D12).
