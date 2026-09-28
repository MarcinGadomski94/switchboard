# AGENTS.md (Workspace Router)

This is a multi-solution workspace for the Acme platform. It is **not** a code repository on its own — it contains multiple solutions (Blazor microfrontends and the Acme.Mobile solution) checked out as siblings. Each subfolder is an independent solution with its own rules.

<!-- Test fixture (M6.1): the folder-rule parts of the router AGENTS.md, verbatim, plus a few of its other list items the parser must ignore. -->

---

## Layout

- `mobile/` — the .NET MAUI app + Mobile Gateway BFF cloned repo. Mobile rules live **in-repo** at `mobile/AGENTS.md` (the cloned repo's root). Self-contained: rules travel with the code via PR review
- `microfrontends/` — grouping folder for every Blazor Server microfrontend solution. Each microfrontend gets cloned into its own subfolder using its **git repo name**, which is always `*-front` (e.g. `microfrontends/auth-front/`, `microfrontends/workspace-front/`, `microfrontends/acme-app-front/`, `microfrontends/learning-material-front/`). The **canonical microfrontend rules** live at `microfrontends/AGENTS.md` (one file shared across all microfrontends — workspace-authoritative). Cloned microfrontend repos do NOT ship with their own AGENTS.md; the agent picks up the canonical one via parent-folder traversal
- `nugets/` — top-level grouping folder for Acme NuGet package repos consumed across the platform (web microfrontends and mobile). Each NuGet package gets cloned into its own subfolder using its **git repo name**, which is always `*-nuget` (e.g. `nugets/wrap-up-nuget/`, `nugets/components-library-nuget/`, `nugets/typography-nuget/`, `nugets/auth-nuget/`). The **canonical NuGet rules** live at `nugets/AGENTS.md` (workspace-authoritative). NuGet packages are class libraries, not Blazor microfrontends or MAUI apps; their rules are independent
- `microservices/` — top-level grouping folder for backend ASP.NET microservices that sit behind the Gateway and own domain state + business logic. Each microservice gets cloned into its own subfolder using its **git repo name**, which is always `*-microservice` (e.g. `microservices/auth-microservice/`, `microservices/notifications-microservice/`). The **canonical microservice rules** live at `microservices/AGENTS.md` (workspace-authoritative). Microservices are clean-layered Web APIs (`*.API` / `*.Services` / `*.DataAccessLayer*` / `*.Models` / `*.Mappers` / `*.Extensions` / `*.API.Swagger` + tests), with their own DB, helm chart, terraform, and CI workflows. They are backend-only — no UI, no breakpoints
- `functions/` — top-level grouping folder for backend **Azure Functions apps** — event-driven background processors (Timer / Service Bus / Event Hub / HTTP triggers) that run alongside the microservices. Each function app gets cloned into its own subfolder using its **git repo name**, which is always `*-func` (e.g. `functions/calendar-func/`, `functions/hubspot-func/`). The **canonical function rules** live at `functions/AGENTS.md` (workspace-authoritative). Function apps are clean-layered, .NET isolated-worker solutions (`*.AzureFunc` / `*.Services` / `*.DataAccessLayer*` / `*.Models` / `*.Mappers` / `*.Extensions` + tests), with NSwag-generated outbound clients to other microservices, and may host **multiple** domain `DbContext`s (a function processes cross-cutting work over data the microservices own). They deploy as Azure Function Apps via terraform (no helm chart). They are backend-only — no UI, no breakpoints
- `deprecated/` — top-level **read-only archive** of solutions that are deprecated or being phased out, of **every** type, grouped by type underneath (`deprecated/microfrontends/<repo>-front/`, `deprecated/microservices/<repo>-microservice/`, `deprecated/functions/<repo>-func/`, `deprecated/nugets/<repo>-nuget/`, `deprecated/mobile/`). Agents read it to recover **old contracts / functionality** when migrating integration or features onto a live successor, and **never modify anything under it**. Governed wholly by `deprecated/AGENTS.md`; the live per-type rules do not apply there
- `infrastructure/` — the platform's **infrastructure-as-code** project, **purely Terraform**, describing shared / cross-cutting infra (networking, VPN, DNS, shared Key Vaults, resource groups, service plans) that is **not** owned by any single solution. **Read-only**: agents read it to understand the deployed environment and **never modify it**. Distinct from each solution's own editable `terraform/`. Governed wholly by `infrastructure/AGENTS.md`
- `other/` — solutions developed **for the company but NOT part of the product** (internal tools, experiments, one-offs). Heterogeneous (any stack). **Editable, but only when the developer explicitly directs a task there** — never a default or proactive work target; product per-type rules do not apply. Each such solution follows its **own** conventions / in-repo `AGENTS.md`. Governed by `other/AGENTS.md`

The set of microfrontend folders inside `microfrontends/`, nuget folders inside `nugets/`, microservice folders inside `microservices/`, and function folders inside `functions/` is open-ended — as is the set of archived solutions under `deprecated/` (grouped by type) and the non-product solutions under `other/`. The router does not enumerate them; the agent discovers them by listing the relevant folder.

### Naming convention

All workspace folders are lowercase. Solution-name capitalization (`Acme.<X>`) is reserved for inside cloned repos (csproj names, namespaces, etc.), not for workspace-level folders.

- `mobile/` — the mobile cloned repo (single solution; lives directly under workspace root since there is exactly one)
- `microfrontends/<repo-name>-front/` — each microfrontend cloned repo (uses its git repo name verbatim, always `*-front` suffix)
- `nugets/<repo-name>-nuget/` — each NuGet package cloned repo (uses its git repo name verbatim, always `*-nuget` suffix)
- `microservices/<repo-name>-microservice/` — each microservice cloned repo (uses its git repo name verbatim, always `*-microservice` suffix)
- `functions/<repo-name>-func/` — each Azure Functions app cloned repo (uses its git repo name verbatim, always `*-func` suffix)
- `deprecated/<type-group>/<repo-name>/` — archived (deprecated) solutions, grouped by the same type folders (`microfrontends` / `nugets` / `microservices` / `functions` / `mobile`); read-only reference
- `infrastructure/` — platform infrastructure-as-code (purely Terraform); read-only reference
- `other/<repo-name>/` — non-product company solutions (own repo names, no product suffix); editable only on explicit developer request
- `microfrontends/`, `nugets/`, `microservices/`, `functions/`, `deprecated/`, `infrastructure/`, `other/`, this `AGENTS.md` — workspace metadata / grouping

---

## Behavior (HARD)

When working on a task, the agent MUST:

1. Identify which solution the task belongs to. Cues: project names mentioned in the prompt, mobile vs. web framing, file paths, the user's explicit direction
2. `cd` into that solution's folder:
   - Microfrontend → `microfrontends/<repo-name>-front/` (e.g. `microfrontends/auth-front/`)
   - NuGet package → `nugets/<repo-name>-nuget/` (e.g. `nugets/wrap-up-nuget/`)
   - Mobile → `mobile/`

---

## Cross-cutting rules

- Each solution maintains its own `Directory.Packages.props`. Do **not** introduce a workspace-level package management file — it would silently apply across solutions and break the per-solution NuGet rule defined in each `AGENTS.md`
- **`deprecated/` is read-only.** Solutions under `deprecated/` (any type) are migration **reference only** — never edited, built, wired to, or consumed (no `<ProjectReference>` / NuGet consumption into `deprecated/`). Reuse-first searches live code, not the archive. Governed by `deprecated/AGENTS.md`
- **`infrastructure/` is read-only.** The platform IaC (Terraform) under `infrastructure/` is reference only — read to understand shared infra, never edited / applied. Distinct from each solution's own editable `terraform/`. Governed by `infrastructure/AGENTS.md`
- **`other/` is non-product, edit-on-request.** Solutions under `other/` are editable but only when the developer explicitly directs work there; never a proactive target, never auto-in-scope for a product task, and the product per-type rules / component libraries do not apply. Each follows its own conventions. Governed by `other/AGENTS.md`

---

## Workspace tooling

| Server | Kind | Truth it provides |
|--------|------|-------------------|
| `codebase-memory-mcp` | static / code-intel | symbol & call graph |

- `chrome-devtools` drives a browser → **web only**. It cannot drive native MAUI XAML; mobile visual verification needs Appium + an emulator (see the mobile QA agent).
- `rider-debugger` covers **any .NET process** on both stacks (Gateway, microservices, functions, the Blazor Server circuit; mobile logic where attachable).
