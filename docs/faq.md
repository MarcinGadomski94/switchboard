# FAQ

Short, honest answers to the questions people ask first. The longer docs are linked from each answer.

## How is this different from Claude Code's own agent view and Remote Control?

Claude Code already has two features that overlap with parts of Switchboard, and for some people they are enough:

- **[Agent view](https://code.claude.com/docs/en/agent-view)** (`claude agents`, a research preview at the time of writing) is one terminal screen for your Claude Code background sessions on one machine: what is working, what needs your input and what is done. The sessions keep running without a terminal open.
- **[Remote Control](https://code.claude.com/docs/en/remote-control)** lets you continue a Claude Code session that runs on your machine from claude.ai/code or the Claude app on your phone, with push notifications. It needs a Pro, Max, Team or Enterprise plan (no API keys).

If you use only Claude Code, on one computer, these may cover what you need, and they come from Anthropic.

Switchboard is a separate, local web app that starts the unmodified CLIs and adds:

- **one queue** for every question, approval and alert from every agent, across **several engines** (Claude Code, Codex CLI, OpenCode) and switching an agent to another engine mid-way ([providers](providers.md));
- **several computers** paired over Tailscale, and **phones and tablets** paired with a QR code, all seeing the same agents ([computers](peers.md), [phones](devices.md));
- **projects**: multi-step work, for example from a Jira epic, whose steps start when the steps before them are done ([projects](plans.md));
- **crews** of long-lived agents with job descriptions ([crews](team.md));
- **several logins per engine**, switched when one hits its usage limit ([accounts](accounts.md));
- a **browser UI** on `127.0.0.1` with tasks, saved results, routines, search and insights.

Switchboard can also turn on Claude Code's own Remote Control for the sessions it runs ([remote control](remote-control.md)), so the two work together.

## Multiple accounts and switching at usage limits: is that allowed?

This is not legal advice. What Switchboard does: you sign each CLI in to **your own** logins (account profiles) on the Accounts page, through the CLI's own sign-in. When an agent hits a 5-hour or weekly limit, Switchboard restarts it on the next of your profiles that still has allowance. It never reads, stores or shares a token, and it does not share logins between people ([accounts](accounts.md), [security](security.md#accounts-d63)).

Whether having and switching between several subscriptions is allowed is up to each provider's terms and your plan. Check them before you turn it on:

- Anthropic: [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (Free, Pro, Max), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (Team, Enterprise, API), and Claude Code's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) (authentication and credential use).
- OpenAI: [Terms of Use](https://openai.com/policies/terms-of-use/) and, for Codex on a ChatGPT plan, [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).
- OpenCode talks to whichever model provider you configure; that provider's terms apply.

Nothing switches until you add a second profile for a CLI, and Settings → Accounts has a switch to turn automatic switching off (for all CLIs or one).

## Is `curl | sh` safe?

Piping a script into a shell runs it without showing it to you first, so read it if you prefer: [install.sh](../install.sh) and [install.ps1](../install.ps1) are short. The script:

1. checks for Node.js 24 or newer and stops with install hints if it is missing;
2. downloads the latest release (or `--version`) from GitHub with its `.sha256` file, and **verifies the checksum** before unpacking anything;
3. unpacks it into a folder in your home directory and runs `npm ci --omit=dev` there;
4. asks whether to start Switchboard at sign-in, then starts it.

It **never uses sudo** or administrator rights, never edits your shell profile and sends no telemetry. The only downloads are the release from GitHub and the dependencies from the npm registry. You can also download it, read it and run it as a file, or skip it and install by hand: [manual install](setup.md#manual-install).

## Was this built with AI?

Yes. Almost all of it was written by Claude Code agents, with the developer deciding what to build, directing the work and reviewing it. The commits say so: at the time of writing, 871 of the 872 non-merge commits carry a `Co-Authored-By: Claude …` trailer. You can count them yourself in a clone:

```sh
git rev-list --count --no-merges --grep="Co-Authored-By: Claude" HEAD
git rev-list --count --no-merges HEAD
```

The developer's rulings are recorded in [decisions.md](decisions.md), and the rules the agents work by are in [AGENTS.md](../AGENTS.md). The test suite runs against fake CLIs, so it never calls a real model.

## Does it send data anywhere?

Switchboard itself has no servers, no accounts and no telemetry. It listens on `127.0.0.1` only (paired computers and phones reach it over your Tailscale network). What does leave your machine: the update check against GitHub (can be turned off), the coding agents talking to their own providers under your logins, and, only if you pair a phone and turn them on, end-to-end encrypted push notifications. The full list: [PRIVACY.md](../PRIVACY.md).

## Which platforms?

macOS, Linux and Windows 10 / 11, with Node.js 24 or newer ([setup](setup.md#requirements)). Phones and tablets (iPhone, iPad, Android) are not a separate install: you pair them with a running Switchboard and use it in the browser or as an installed web app, with push notifications ([phones](devices.md), [install as an app](install-app.md)).
