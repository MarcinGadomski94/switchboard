# Artifacts (D89)

Artifacts work like Claude's artifacts on claude.ai: a deliverable the developer
should see (a report, a plan, a doc, a diagram, a mockup, a table) is **saved on
purpose**, by the session's agent or by the developer, and shown in the session's
**Artifacts** tab and on the **Artifacts** page. Nothing is collected
automatically: until 1.13.0 the recorder derived rows from every written `.md`,
every diff, branch and PR (`docs/derivations.md` → *Artifacts (gap #9): replaced
by D89*), which showed far too much.

Code: `src/core/artifacts.ts` (the shared rules), `src/server/artifacts/service.ts`
(saving, reading, deleting), `src/server/api/artifacts.ts` (routes, serving
headers), `src/hook/sb-mcp.ts` (the agent's tools), `src/web/views/session/`
`ArtifactsTab.tsx` / `ArtifactViewer.tsx` / `SaveArtifact.tsx` and
`src/web/views/ArtifactsView.tsx` (the UI).

## Saving

### The agent: `artifact_save`
Every session Switchboard starts or resumes gets the built-in `switchboard` MCP
server (D68, `docs/todos.md` → *The agent's tools*); D89 adds three tools to it,
through the same injection (Claude Code `--mcp-config`; Codex CLI and OpenCode
through their own config, still unverified on the real CLIs):

| Tool | Input | Does |
|---|---|---|
| `artifact_save` | `title`, `kind`, `content?`, `path?`, `language?`, `id?` | Saves a new artifact, or with `id` (one of this session's) a **new version** of it. Answers the id and the version. |
| `artifact_list` | — | This session's artifacts, newest first: `[id] Title · kind · v3 · 14.2 KB`. |
| `artifact_get` | `id`, `version?` | One artifact's latest (or named) version with its text. |

Annotations (all four declared): `artifact_save` is not read-only, not
destructive, not idempotent, not open-world; the other two are read-only. The
descriptions say what to save (deliverables the developer should see, not every
file edit) and to update the same artifact instead of creating near-duplicates;
the server's `instructions` and the standing instruction (below) say the same.

`content` is the text; `path` instead copies a file **at save time**: absolute or
relative to the session's working folder, and (symbolic links resolved) inside
the session's folder, its working folder or one of its worktrees; anything else
is refused. The helper never reads the file: Switchboard does. An `image` needs a
`path` (a png, jpg, gif or webp, recognised by its bytes).

The agent routes are `GET /agent/v1/artifacts`, `POST /agent/v1/artifacts` and
`GET /agent/v1/artifacts/{id}[?version=n]`, behind the session's agent token
(`docs/security.md` → *Agent todo tools*): the session is always the token's.

### The developer: Save as artifact
- An agent's chat message has a **⋯** (on hover or focus; always on touch
  screens) → **Save as artifact**: a dialog with the title prefilled from the
  message's first heading (else its first line, without Markdown), kind
  Markdown and the message's text, all editable, then **Save**. Afterwards it
  says so, with **Open** (the Artifacts tab on it).
- Each fenced code block in an agent's message has its own **Save as artifact**
  (on hover; always on touch screens): kind Code with the block's language.
- Both go to `POST /api/sessions/{id}/artifacts` (saved by the developer; `path`
  is the agent's only). The ⋯ and the code button's labels are drawn by CSS, so
  copying or selecting the message never picks them up. Not offered for an
  unreachable paired machine's session.

### The standing instruction
The default standing instruction (D64, `docs/settings.md`) gained one sentence:
"Save deliverables the developer should see (reports, plans, docs, diagrams,
mockups) with the switchboard artifact_save tool; update the same artifact
instead of creating new ones." 1.13.0's default counts as an earlier default (D68's
convention): a stored text equal to it reads as the new default; an edited text
stays the developer's. The "short" bound of the tests moved from 560 to 740
characters (the new default is 731).

## Kinds, versions and limits

| Kind | Stored as | Rendered |
|---|---|---|
| `markdown` | text | with the chat's Markdown renderer (D20: GFM, no raw HTML, no images loaded) |
| `code` (+ `language`) | text | one highlighted code block (the chat's highlighter) |
| `html` | text | in a sandboxed frame (below) |
| `mermaid` | text | drawn by Mermaid inside a sandboxed frame; source if it cannot be parsed (*Mermaid*, below) |
| `svg` | text | as an `<img>` of the served file, never inline in the page |
| `image` | file | as an `<img>` of the served file |
| `csv` | text | as a table, the first 500 rows (the header row included) |

- **Title**: one line, at most 120 characters. **Language**: a short name
  (`ts`, `c++`, `f#`), lower-cased.
- **Size**: text up to 2 MB (UTF-8), images up to 10 MB. A save's body is up to
  about 6 MB of JSON (escapes included).
- **Versions** are numbered from 1; a save with `id` adds the next one (its title
  and language may change, its kind may not). At most **100 versions** per
  artifact and **200 artifacts** per session (409 `too-many` past either).
- **Who**: `createdBy` (the first version's) and each version's `createdBy`:
  `agent` or `developer` (the UI says "agent" / "you").
- An artifact outlives its session (its session id becomes `null`); deleting it
  (developer only, with a confirmation) removes every version and its files.
  Clean-up offers the ones whose session is gone (below).

## Storage
Migration **0039** (`docs/database.md`): `artifacts_saved` (id, session id, title,
kind, language, created by, created / updated) and `artifact_versions` (n, the
text **or** a file, the image's media type, size, created by, created at).
Images live in the data folder as `artifacts/<id>/<n>.<ext>` (folder 0700, files
0600). Ids are 10 random hex characters. The old derived `artifacts` table (0001)
stays in the schema, unused: nothing writes or reads it any more (conservative:
no migration drops it).

## The session's Artifacts tab
`/sessions/{id}/artifacts`, and `/sessions/{id}/artifacts/{artifactId}` with one
open. A list on the left (kind tag, title, `v3 · 14.2 KB · agent`, age; newest
first) and the viewer beside it (on tablets and phones: one at a time, ‹ goes
back to the list). The header's tab count is the number of artifacts. Live: the
`/hub` event `artifactsChanged` reloads the list; an open artifact follows its
newest version until another version is picked.

The viewer: the title; kind, version, who saved it, when, size; **Version**
(Latest, or any version); **Rendered / Source / Compare** (text kinds; Compare
once there are two versions: a line diff of the version on screen against
another, `+added −removed`); **Copy** (the text), **Download** (`?download`,
named after the title with the kind's extension: `.md`, `.html`, `.mmd`,
`.svg`, `.csv`, the language's for code), **Full screen** (Esc closes),
**Delete** (asks first).

### Mermaid
**Developer ruling (2026-10-09): draw Mermaid**, never in the app's own origin.
- The pinned **`mermaid@12.1.0`** (exact version, a **devDependency**) is copied by the build into `dist/web/vendor/mermaid.min.js` (`vite.config.ts` → `mermaidVendor`). The app's bundle never imports it.
- Rendered, a Mermaid artifact is `<iframe sandbox="allow-scripts">` of the version's raw route with `?render`: a small page that inlines the library and draws the source with `securityLevel: 'strict'`, served under the same sandbox CSP as an HTML artifact (opaque origin, nothing loads or connects). The library is inlined, not linked: the sandboxed page's own requests carry no cookie or device credential, so it could not fetch it from the app. The page is loaded only when a Mermaid artifact is shown rendered (lazily, cached by the browser per version).
- A source Mermaid cannot parse shows as its source with the error's first line, inside the same frame; Source shows the text; Download stays the `.mmd`.
- **Release size:** `dist/web` grows by 5.49 MB (`mermaid.min.js`), about **+1.57 MB** in the `.tar.gz` (gzip -6); nothing is added to the installed `node_modules` (the updater installs with `npm ci --omit=dev`).
- A build without the bundle (tests that run without `dist/web`) shows the source with "this build has no Mermaid renderer".

### HTML
An `html` version runs in `<iframe sandbox="allow-scripts">` (never
`allow-same-origin`) whose `src` is the version's raw route, served with a CSP
that sandboxes it again and lets nothing load or connect. Its scripts run, in an
opaque origin: no cookie, no storage, no API, no navigation of the app, no popups.
Details: `docs/security.md` → *Artifacts*.

## Artifacts page
`/artifacts` (sidebar → Artifacts; the badge counts every saved artifact). Every
session's artifacts, this machine's and the paired machines', newest first:
**Kind · Title · Session · Versions · Saved by · Age**; a paired machine's carry
its machine tag, another folder's the folder tag (D14). Filters: **All · Docs ·
Code · HTML · Diagrams · Images · Tables** (`kind=`, kinds separated by commas)
and a session picker (`session=`); search (`q`) matches the title, kind,
language, session name and title, and machine. `n of m` counts what is shown of
everything. A row opens its session's Artifacts tab on that artifact. Live on
`artifactsChanged` (and `sessionUpdated`, for renamed sessions).

## Paired machines and devices
- **Peers (D48):** a paired machine's session's artifacts go through the proxy
  like every session route: the list, one artifact, a version's bytes (passed on
  as bytes with their serving headers, the CSP included), Save as artifact,
  Delete. Their ids come back namespaced (`r~<machine>~<id>` session ids; the
  artifact ids stay). The Artifacts page lists the paired machines' artifacts as
  last known (`GET /api/artifacts` there, refreshed on its `artifactsChanged` and
  after a save or delete through the proxy). A machine before D89 sends derived
  rows: they are left out.
- **Devices (D73):** a paired device may read (the page, a session's list, an
  artifact, a version's bytes), Save as artifact and Delete: normal use.

## What D89 removed
- The recorder's artifact derivation (file / DIFF / PR / BRANCH rows) and its
  helpers (`fileArtifactType`, `findPullRequests`, `runsGh`, `createdBranches`,
  `diffArtifactName`, `locateSessionFile`), the worktree manager's PR-state
  update of PR rows, `src/core/artifacts-view.ts` (the type filters), the old tab
  model (DIFF rows from the session's diff).
- The Solutions detail's *Artifacts & follow-ups* lists, instead of the sessions'
  derived rows, the saved artifacts of the sessions working on the solution
  (D89 ruling 2026-10-09; a row opens the session's tab on it), then its
  `mobile-followups/*.md` files.

## Clean-up
Clean-up (D84) lists saved artifacts whose session was deleted (one item each,
with its versions' size and an image's folder), never ticked for you; the run
removes exactly what the preview listed (`docs/cleanup.md`). Desktop only, like
the rest of Clean-up.
- The visual oracle of the session's Artifacts tab (`docs/visual/README.md` →
  *Deliberate deviations*, D89).
