# Contributing to Switchboard

Thanks for your interest. Bug reports, small fixes and docs improvements are welcome. For a bigger change, open an issue first so we can agree on the shape before you build it.

If you work with an AI coding agent, point it at [AGENTS.md](AGENTS.md): it holds the same rules in the stricter form agents need.

## Set up from source

You need Node.js 24 or newer and git ([requirements](docs/setup.md#requirements)). You do **not** need Claude Code, Codex or OpenCode to run the tests: they use fake CLIs.

```sh
git clone https://github.com/MarcinGadomski94/switchboard.git
cd switchboard
npm ci
npm run build
npm start
```

`npm run dev` rebuilds the UI on change and restarts the server (no hot reload: reload the browser). The layout of `src/`, `tests/`, `tools/` and `docs/` is described in [docs/setup.md → Developing](docs/setup.md#developing). To run a checkout next to an installed Switchboard, give it another port with `SWITCHBOARD_PORT` and its own data folder with `SWITCHBOARD_DATA_DIR` ([configuration](docs/configuration.md)).

## Work in a worktree

Make each change on its own branch in a git worktree under `.worktrees/` (git ignores that folder), so the main checkout stays clean and several changes can run side by side:

```sh
git worktree add .worktrees/my-change -b fix/my-change master
cd .worktrees/my-change
npm ci
```

Remove it with `git worktree remove .worktrees/my-change` once the branch is merged. Playwright ignores other worktrees' specs, so tests in one worktree never pick up another's.

## Run the tests that matter

The full suites are large. While you work, run the tests your change can affect; run the full set before you open a pull request.

```sh
npx vitest run tests/server/setup
npx vitest run tests/docs/readme-commands.test.ts
npx playwright test tests/e2e/setup-wizard.spec.ts
```

The full checks:

```sh
npm run typecheck
npm test
npm run e2e
```

- **Fakes, never the real thing.** Tests never call the real `claude`, `codex`, `opencode`, `gh`, `tailscale`, push services or network beyond loopback. They use `tools/fake-*` ([fake-claude](docs/fake-claude.md)), temporary git repos and temporary data folders.
- **Ports.** Test servers use ports 24000–27999 (or the range in `SWITCHBOARD_TEST_PORTS`), never 13001, so they do not clash with a Switchboard you have running; the range sits below the ports the OS hands out to outgoing connections. Each parallel Vitest worker gets its own slice of the range (`VITEST_POOL_ID`; 64 slices of 62 ports by default), so two test files running at once never pick the same port, and within a file `freeTestPorts()` offers the ports in rotating order, so a port a test just left is not handed out again at once. Always pick ports through `freeTestPorts()` in `tests/helpers/net.ts` (take them from the front), and give a nested run your slice (`workerTestPortsEnv()`). A lane or a second checkout running tests at the same time sets its own range, 100 ports or more.
- **Test servers never outlive a run.** Every `node src/server/main.ts` a test starts (`tests/helpers/server-process.ts`, used by `pairedNodes` in `tests/helpers/peers.ts` and the E2E worlds) is registered the moment it is spawned, before its start is awaited, and runs in its own process group on macOS and Linux. Four nets stop it, from the narrowest: `removeTempDir` / `removeWorld` stop the servers inside the folder they remove (also one a timed-out test was still starting), and refuse new ones there; an `afterAll` in every Vitest file (`tests/helpers/vitest-setup.ts`) stops anything still alive; the test process's `exit`, SIGINT, SIGTERM and SIGHUP kill the groups; and the Vitest and Playwright global setups give each run a pid-file folder (`$TMPDIR/switchboard-test-run-*`) whose leftovers the global teardown kills. A stop is SIGTERM, then SIGKILL to the whole group after 5 s, so a hung shutdown cannot block it. The nets only ever touch servers this run started, never another run's or a Switchboard you have running. Details: `tests/helpers/server-registry.ts`; the proof: `tests/server/test-servers-no-leak.test.ts`. After a run, `pgrep -fl "node src/server/main.ts"` should list none started from your checkout.
- **Browser tests** (`tests/e2e/`) run with Playwright in headless Chromium by default and build their own copy of the UI first. Install the browser once with `npx playwright install chromium`. Add `--headed` to watch a run, or `--debug` to step through it.
- **Visual checks** compare screens with the design; see [docs/visual/](docs/visual/).
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml), the badge in the README) runs on every push to `master` and every pull request: the typecheck and the core, web, docs and tools tests on Linux and macOS must pass. The server tests (`npx vitest run tests/server`) run in a separate job that must pass too (one port slice per worker, waits for what a fake CLI writes a moment late). Reproduce CI locally with `CI=true GIT_CONFIG_GLOBAL=<a file with user.name, user.email, init.defaultBranch=main> SWITCHBOARD_TEST_SECRET_STORE=memory npx vitest run tests/server`. Browser tests do not run in CI yet.

## Commit style

- A short subject in the imperative or a plain summary, optionally with the area first: `v2: render Markdown in the answer card`, `Docs: …`, `One-line installer: …`.
- A body when the why is not obvious; cite the decision number (`D133`) when a change follows one.
- One logical change per commit. Keep generated files and unrelated edits out.
- Commits made with an AI agent keep its `Co-Authored-By:` trailer.

## Decisions are recorded

[docs/decisions.md](docs/decisions.md) is the log of the maintainer's rulings, numbered `D1`, `D2`, …. Where it differs from the original spec in `docs/handoff/`, the decisions log wins. A change that alters behaviour a decision describes updates that entry (or adds a new one) in the same pull request, and a feature's own doc in `docs/` explains anything non-obvious. A user-facing feature also adds an entry to the What's-new tour ([tutorial](docs/tutorial.md)).

## Keep the public repo clean

This repo is public. In code, tests, docs, screenshots and commit messages:

- use **placeholders**: the company is `Acme`, tickets are like `PROJ-123`, sites are `acme.atlassian.net` or `example.com`, people are generic names;
- never include real company or client names, real ticket keys, personal email addresses, tokens, private hostnames or paths from your own machine;
- screenshots come from the demo data (`SWITCHBOARD_DEMO=1`, [demo](docs/demo.md)), never from a real workspace.

## Pull requests

Fill in the pull request template: what changed and why, how you tested it, and the docs you updated. Keep pull requests small enough to review. Security problems are reported privately, not in an issue or pull request: see [SECURITY.md](SECURITY.md).

By contributing you agree that your work is released under the [MIT License](LICENSE), and that you follow the [code of conduct](CODE_OF_CONDUCT.md).
