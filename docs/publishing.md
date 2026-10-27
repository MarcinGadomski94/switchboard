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

<!-- TODO: after the first `npm publish`, add the npx one-liner back to the README's Install section ("Or with npm:" and an `sh` block with `npx @marcingadomski94/switchboard`), and add it back to the expected lines in tests/docs/readme-commands.test.ts. It was taken out while the package is not on npm yet. -->

## Publishing it: the npm-publish workflow

The package is published by `.github/workflows/npm-publish.yml`, with npm **trusted publishing**: npm trusts that workflow through GitHub's OIDC token, so no npm token is stored anywhere, and each version carries a provenance statement linking it to this repository.

- **When it runs:** when a GitHub release is published (`gh release create`, the last step of every release), or by hand from the repository's Actions tab (**npm-publish → Run workflow**) for an existing release tag such as `v2.3.0`.
- **What it does:** checks out the tag, checks that `packages/npx/package.json` has the tag's version (`npm version` in the release keeps them in step), skips a version that is already on npm, then runs `npm publish --access public --provenance` in `packages/npx`.
- **A failure** (a version mismatch, the trust missing) shows in the Actions tab; the GitHub release itself is unaffected, and the installer keeps installing the latest release from GitHub.

### Setting it up (once, by the developer)

The package `@marcingadomski94/switchboard` exists on npm (a first publish attempt on 2026-10-27 created it with npm's staged-publishing placeholder `0.0.0-stage`), so trusted publishing can be configured. Either on npmjs.com (the package → **Settings → Trusted publishing → GitHub Actions**: owner `MarcinGadomski94`, repository `switchboard`, workflow `npm-publish.yml`, no environment), or in a terminal, which asks for the account's second factor (a security key opens the browser):

```sh
npm trust github @marcingadomski94/switchboard --file npm-publish.yml --repo MarcinGadomski94/switchboard --allow-publish
```

Then publish the current release once: Actions → **npm-publish** → **Run workflow** with its tag. From then on every release reaches npm by itself.

Check it from a clean folder. This installs and starts Switchboard for real, so use `--dir` and `SWITCHBOARD_PORT` to keep it away from an existing install:

```sh
npx @marcingadomski94/switchboard --help
```

Why not `npm publish` from a terminal at every release: the account's second factor is a security key, which needs the developer at the browser for every publish, and npm is restricting tokens that bypass two-factor authentication for publishing.

## The MCP Registry entry (optional)

Once the npm package exists, `server.json` is valid for the official registry: `registryType` `npm`, identifier `@marcingadomski94/switchboard`, the same version, and `mcpName` in the package. The `io.github.MarcinGadomski94/…` namespace is proven by signing in with that GitHub account. Install the publisher CLI ([the registry's guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/guides/publishing/publish-server.md) has the other ways), then publish from the repo root:

```sh
brew install mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

After a later release, bump with `npm version` as usual, publish the npm package of that version, then run `mcp-publisher publish` again. The registry refuses a version whose npm package is missing.

## Who runs what

The npm publish runs in GitHub Actions, started by the release (or by the developer from the Actions tab); agents never start or re-run that workflow, and never run `mcp-publisher publish`. The developer authorizes each release (`gh release create`) and sets up the trust once.
