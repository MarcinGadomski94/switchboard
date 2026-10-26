# Security policy

## Supported versions

Only the latest **2.x** release gets security fixes. Release installs update themselves (Settings → Updates); a git checkout should be on the latest `master`.

| Version | Supported |
|---|---|
| Latest 2.x | Yes |
| Older 2.x, 1.x | No: update to the latest release |

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue, pull request or discussion.

- Use GitHub's private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability** ([open the form](https://github.com/MarcinGadomski94/switchboard/security/advisories/new)). Only the maintainer can see the report.
- If that button is not shown, open an issue that says only that you have a security report, with no details, and the maintainer will set up a private channel with you.

Helpful in a report: the Switchboard version (Settings → Updates, or `package.json`), your OS, what an attacker can do, and the steps to reproduce it. This is a one-person project, so replies may take a few days; you will hear back before anything about the problem is made public, and you will be credited in the advisory and the changelog unless you would rather not be.

## Scope

Switchboard runs on your own machine and binds `127.0.0.1` only; paired computers and phones reach it over your Tailscale network. Its protections (the request guard, the access token and cookie, the peer and device listeners, updates, attachments, accounts and more) are described in [docs/security.md](docs/security.md).

Problems in Claude Code, Codex CLI, OpenCode, Tailscale or other tools Switchboard starts belong to those projects: report them to their maintainers.
