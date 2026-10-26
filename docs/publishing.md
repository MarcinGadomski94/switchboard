# Publishing the npm installer and the MCP Registry entry

Switchboard ships as a GitHub release (`docs/updates.md` → *Release packages*). Two more channels sit on top of the release. Both are prepared in the repo but not yet published:

- **npm:** `@marcingadomski94/switchboard`, the package in `packages/npx/`. `npx @marcingadomski94/switchboard` installs Switchboard.
- **The official MCP Registry** (`registry.modelcontextprotocol.io`): `server.json` at the repo root, whose package entry is that npm package.

## The npm package

**What it is: an installer, not Switchboard itself.** `packages/npx` is a small Node launcher with no dependencies (`bin/switchboard.mjs` → `lib/installer.mjs`, plain JavaScript checked through JSDoc by `tsconfig.npx.json`). It does what `install.sh` / `install.ps1` do (`docs/setup.md` → *One-line install*), the same way on every OS:

1. finds the latest GitHub release, or takes `--version`;
2. downloads the tarball and its `.sha256` and verifies the checksum;
3. unpacks the tarball into `<dir>/switchboard-<version>` and runs `npm ci --omit=dev`;
4. optionally registers the login service, then starts Switchboard.

It takes the same options: `--dir`, `--version`, `--service`, `--no-service`, `--no-start`, `--uninstall`, `--purge` and `--help`.

Why not publish Switchboard itself as the package (a `files` whitelist, a `bin` that starts the server):
- **npx runs packages from its cache** (`~/.npm/_npx/<hash>`), which npm may clean at any time. The login service and the in-app updater both need a stable install folder. A package run in place would leave the login service pointing into a folder that can vanish.
- **Updates already come from GitHub releases.** The updater recognises a release install and moves it to `<data folder>/versions/<v>` (`docs/updates.md`). The launcher produces exactly that release-install layout, so npm, `install.sh`, `install.ps1` and the manual install all lead to the same place.
- **The package stays tiny** (about 10 kB, no dependencies). The real package's tarball, with the built UI and the runtime dependencies, is installed by `npm ci` from the release's lock file, as in every other install.

The package's version follows Switchboard's: `npm version <x.y.z>` in the repo root runs `tools/release/server-json.ts`, which writes the version into `packages/npx/package.json`, `server.json` and `docs/setup.md`. `tests/docs/server-json.test.ts` checks that they agree. The launcher always installs the **latest** release unless `--version` says otherwise. Publishing the package for every release is therefore optional: it is needed only when the launcher itself changed, or to keep npm's version in step with the release.

`package.json` carries `"mcpName": "io.github.MarcinGadomski94/switchboard"`. The MCP Registry reads that field to check that the npm package belongs to the server named in `server.json`.

## Publishing it (once, by the developer)

The GitHub release of the version must exist first, because the launcher downloads it. In the repo root, on the release commit, with Node 24:

```sh
npm login
cd packages/npx
npm pack --dry-run
npm publish --access public
```

`npm pack --dry-run` lists the four files that go out (`bin/switchboard.mjs`, `lib/installer.mjs`, `README.md`, `package.json`). `--access public` is needed because a scoped package is private by default. With two-factor authentication on, npm asks for a one-time code.

Check it from a clean folder. This installs and starts Switchboard for real, so use `--dir` and `SWITCHBOARD_PORT` to keep it away from an existing install:

```sh
npx @marcingadomski94/switchboard --help
```

## The MCP Registry entry (optional)

Once the npm package exists, `server.json` is valid for the official registry: `registryType` `npm`, identifier `@marcingadomski94/switchboard`, the same version, and `mcpName` in the package. The `io.github.MarcinGadomski94/…` namespace is proven by signing in with that GitHub account. Install the publisher CLI ([the registry's guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/guides/publishing/publish-server.md) has the other ways), then publish from the repo root:

```sh
brew install mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

After a later release, bump with `npm version` as usual, publish the npm package of that version, then run `mcp-publisher publish` again. The registry refuses a version whose npm package is missing.

## Never from an agent

Agents in this repo never run `npm publish`, `mcp-publisher publish`, `gh release create` or a push; these steps belong to the developer.
