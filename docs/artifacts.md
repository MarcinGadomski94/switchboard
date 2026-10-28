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
the session's folder, its working folder or one of its worktrees (a chat, D106:
its scratch folder, the folders it looks at or its attachments); anything else
is refused. The helper never reads the file: Switchboard does. An `image` needs a
`path` (a png, jpg, gif or webp, recognised by its bytes); so does a `pdf` (D126:
a file that starts with `%PDF-`). The tool's description tells the agent that a
PDF is saved as it is, so it no longer converts one to an HTML page.

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
| `pdf` (D126) | file | in the browser's own PDF viewer; on phones and touch screens an **Open PDF** card (*PDF*, below) |
| `csv` | text | as a table, the first 500 rows (the header row included) |

- **Title**: one line, at most 120 characters. **Language**: a short name
  (`ts`, `c++`, `f#`), lower-cased.
- **Size**: text up to 2 MB (UTF-8), images up to 10 MB, PDFs up to 25 MB (D126:
  their own limit, `ARTIFACT_PDF_MAX`, not the image one: a report with
  screenshots or scans passes 10 MB easily, and a PDF only ever comes from
  `path`, never in a save's body). A save's body is up to
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
Images and PDFs live in the data folder as `artifacts/<id>/<n>.<ext>` (folder 0700, files
0600; a PDF's media type is `application/pdf`). Migration **0048** (D126) rebuilt
`artifacts_saved` to let its `kind` CHECK accept `pdf` (SQLite cannot change a
CHECK in place); every row, rowid and search entry was kept. Ids are 10 random hex characters. The old derived `artifacts` table (0001)
stays in the schema, unused: nothing writes or reads it any more (conservative:
no migration drops it).

## The session's Artifacts tab
`/sessions/{id}/artifacts`, and `/sessions/{id}/artifacts/{artifactId}` with one
open. A list on the left (kind tag, title, `v3 · 14.2 KB · agent`, age; newest
first) and the viewer beside it (on tablets and phones: one at a time, ‹ goes
back to the list). The header's tab count is the number of artifacts. Live: the
`/hub` event `artifactsChanged` reloads the list; an open artifact follows its
newest version until another version is picked.

D113: while the list loads it shows three placeholder rows (`aria-busy`;
"Loading artifacts…" for screen readers). A paired machine's session is read
there through the proxy, so it says **Loading artifacts from <machine>…** with a
spinner; if that read fails because the machine cannot be reached it says
"<machine> cannot be reached — its artifacts cannot be shown now." with **Try
again** (any other failure: the server's message, and Try again).

The viewer: the title; kind, version, who saved it, when, size; **Version**
(Latest, or any version); **Rendered / Source / Compare** (text kinds; Compare
once there are two versions: a line diff of the version on screen against
another, `+added −removed`; never for an image or a PDF, whose new version is a
new file); **Copy** (the text), **Download** (`?download`,
named after the title with the kind's extension: `.md`, `.html`, `.mmd`,
`.svg`, `.csv`, `.pdf`, the language's for code), **Open in new tab** (a PDF only), **Full screen** (Esc closes),
**Delete** (asks first).

### Mermaid
**Developer ruling (2026-10-09): draw Mermaid**, never in the app's own origin.
- The pinned **`mermaid@12.1.0`** (exact version, a **devDependency**) is copied by the build into `dist/web/vendor/mermaid.min.js` (`vite.config.ts` → `mermaidVendor`). The app's bundle never imports it.
- Rendered, a Mermaid artifact is `<iframe sandbox="allow-scripts">` of the version's raw route with `?render`: a small page that inlines the library and draws the source with `securityLevel: 'strict'`, served under the same sandbox CSP as an HTML artifact (opaque origin, nothing loads or connects). The library is inlined, not linked: the sandboxed page's own requests carry no cookie or device credential, so it could not fetch it from the app. The page is loaded only when a Mermaid artifact is shown rendered (lazily, cached by the browser per version).
- A source Mermaid cannot parse shows as its source with the error's first line, inside the same frame; Source shows the text; Download stays the `.mmd`.
- **Release size:** `dist/web` grows by 5.49 MB (`mermaid.min.js`), about **+1.57 MB** in the `.tar.gz` (gzip -6); nothing is added to the installed `node_modules` (the updater installs with `npm ci --omit=dev`).
- A build without the bundle (tests that run without `dist/web`) shows the source with "this build has no Mermaid renderer".

### PDF (D126)
- **Desktop:** the browser's own PDF viewer, an `<object type="application/pdf">`
  of the version's raw route (not sandboxed: a sandboxed document stops Chrome's
  and Firefox's viewers). No PDF library is bundled (no pdf.js): every desktop
  browser has a viewer, and the phones are handled below.
- **Phones and touch screens** (`(max-width: 767px)` or `(pointer: coarse)`): iOS
  Safari draws only the first page of an embedded PDF, so the viewer shows a
  card with the title and **Open PDF**, which opens the raw route in a new tab,
  where the phone's own viewer shows every page. A first-page preview would need
  pdf.js, so there is none. The same card is the `<object>`'s fallback in a
  browser without a PDF viewer.
- **Served** as `application/pdf`, `inline` (Download: `attachment`, `.pdf`),
  `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: frame-ancestors
  'self'` only (`docs/security.md` → *Artifacts*).
- **Search** (D97) indexes a PDF's title, like an image's; no text is extracted
  from the file (that would need a PDF parser).

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
Code · HTML · Diagrams · Images · PDFs · Tables** (D126: PDFs have their own chip;
grouping them with Images would hide them under a word that does not say PDF) (`kind=`, kinds separated by commas)
and a session picker (`session=`); search (`q`) matches the title, kind,
language, session name and title, and machine. `n of m` counts what is shown of
everything. A row opens its session's Artifacts tab on that artifact. Live on
`artifactsChanged` (and `sessionUpdated`, for renamed sessions).

### Loading and syncing (D113)
- **First load:** six placeholder rows (the session view's skeleton shapes,
  `.sb-skel`) and `Loading…` in place of the count; the page is `aria-busy` and
  says "Loading artifacts…" once for screen readers. A failed first load says
  so with **Try again** instead of keeping the placeholders.
- **A re-query** (a kind, a session, a search) keeps the rows on screen; a small
  spinner by the count shows until the answer replaces them.
- **Paired machines:** the merged list is this machine's rows plus each paired
  machine's copy as last known, so a machine whose copy has not arrived yet (or
  is being fetched again for more than a moment) gets a chip under the filters,
  **Syncing with <machine>…** with a spinner. Nothing waits for it: the local
  rows (and the machine's last known ones) are already listed. When its copy
  arrives the chip goes and the list reads again, so its rows merge in. A
  machine that cannot be reached gets a static chip, "<machine> is offline — its
  artifacts may be out of date" (or why: refused the pairing, no address). A
  polite live region says "Syncing with <machine>…" and then "Synced with
  <machine>.". How the page learns this: `docs/peers.md` → *List sync (D113)*.

### Deleting from the lists (D111)
- **A row's ⋯ → Delete…** on the Artifacts page and in a session's Artifacts
  tab, with the viewer's confirmation ("Delete “Title” and all its versions?
  This cannot be undone.", Cancel focused; one shared component,
  `src/web/views/session/ArtifactDelete.tsx`). The ⋯ never opens the row; its
  menu opens in the window (↑ ↓, Esc back to the ⋯, a click outside or a scroll
  closes it).
- **Several at once** (the page only): a checkbox per row, **Select all** (the
  rows shown, in the column header; in words on tablets and phones), then
  **Delete N** ("Delete N artifacts and all their versions? …") or **Clear
  selection**. Each artifact goes through its own route; a partial failure keeps
  the failed rows selected and says "k of N could not be deleted: <why>". The
  selection keeps only rows still shown after a reload or a filter change.
- **Unreachable machines (D48):** a paired machine's row whose machine cannot be
  reached cannot be selected, and its ⋯ shows Delete… off with the reason, as
  the viewer's Delete does. The session tab follows its session's machine.
- **Without a session:** a row whose session is gone is deleted with
  `DELETE /api/artifacts/{artifactId}` (files removed exactly as the session
  route does; `artifactsChanged` with `sessionId: null`); 409 `has-session` while
  its session exists. A paired machine's goes to that machine through the proxy
  (`/api/machines/{id}/api/artifacts/{artifactId}`); a machine before 1.25.0
  refuses it (the error says so).
- **The open artifact** deleted anywhere (its row, the page, another window)
  takes the session tab back to the list.

## Paired machines and devices
- **Peers (D48):** a paired machine's session's artifacts go through the proxy
  like every session route: the list, one artifact, a version's bytes (passed on
  as bytes with their serving headers, the CSP included: a PDF arrives as
`application/pdf`, inline, `nosniff`, so it shows in the viewer there too), Save as artifact,
  Delete; D111: Delete of one whose session is gone there
  (`DELETE /api/artifacts/{artifactId}` on `PEER_API_ALLOW`). Their ids come back namespaced (`r~<machine>~<id>` session ids; the
  artifact ids stay). The Artifacts page lists the paired machines' artifacts as
  last known (`GET /api/artifacts` there, refreshed on its `artifactsChanged` and
  after a save or delete through the proxy). A machine before D89 sends derived
  rows: they are left out.
- **Devices (D73):** a paired device may read (the page, a session's list, an
  artifact, a version's bytes), Save as artifact and Delete (D111: also one
  without a session): normal use.

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
