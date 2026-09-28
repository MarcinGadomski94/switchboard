# Visual oracle (D10)

The gate compares the real app (demo seed) with `docs/handoff/prototype/Switchboard App.dc.html` at 1440×900: computed-style checks on the SPEC tokens, key box sizes and positions within ±2 px, exact copy, and an agent's side-by-side review. The pixel-diff % is recorded here but does not gate.

## Harness (`tests/e2e/visual/`)
- `offline.ts`: opens the prototype from `file://` without network. Its unpkg requests (React / ReactDOM 18.3.1 UMD, @babel/standalone 7.29.0, loaded with SRI) are answered from the pinned devDependencies `prototype-react`, `prototype-react-dom` (npm aliases, so they do not clash with the app's React 19) and `@babel/standalone`; the bytes are identical, so the SRI checks pass. The Google Fonts stylesheet is answered with the `@fontsource/geist` / `@fontsource/geist-mono` sheets the app bundles, so both pages render with the same font files. Every other request (including the prototype's live probe of `http://localhost:13000`) is aborted. Props are set before the runtime boots: `simulateIncoming` off unless a view needs the toast.
- `harness.ts`: `startDemoApp()` (the app with `SWITCHBOARD_DEMO=1` in a temp data folder, on `SWITCHBOARD_E2E_PORT` when set, else the first free port in 4871–4879), `openApp()`, `measure()` (boxes, text, computed styles of parts addressed by child-index paths from the shell grid, which both pages share), `compareBoxes()` (±2 px; geometry `box` / `size` / `bottom` / `none`), `rootTokens()` + `canonicalColors()` + `specColorTokens()` (SPEC colors defined as CSS variables, compared as computed colors), `pixelDiff()` and `sideBySide()` (in-browser canvas, no image library), `writeReport()`.
- One spec per view, e.g. `shell.spec.ts`. `npx playwright test` builds `dist/web` first (`tests/e2e/global-setup.ts`).

Reports go to `test-results/visual/` on every run. Only `SWITCHBOARD_VISUAL_REPORT=1 npx playwright test` writes them here (`docs/visual/<view>.md` + side-by-side PNGs, prototype left, app right), so ordinary runs leave the working tree clean.

## Reviews
### Shell (M1.4, 2026-09-28)
`shell.md`, `shell-side-by-side.png`, `shell-sidebar-side-by-side.png`. Gate green: every chrome box within ±2 px (all measured equal), copy exact, SPEC tokens defined, computed styles as specified, Geist and Geist Mono loaded. Pixel diff 5.32% (page) / 5.42% (sidebar), advisory.

Agent review of the sidebar pair: logo row, ⌘K badge, "+ New session", the five nav rows, TOOLS / SESSIONS labels, Settings and the footer layout render identically. Every difference is data the app does not have yet because its routes answer 501: the Inbox / conflict / failed / artifact badges, the two tool rows, the six session rows and their count, the footer's process count and meter values ("—" instead of 38% / 11.2/32 GB / 62% · 1h48). Without the process count, the footer's first row no longer wraps "claude code" onto two lines, so the footer is 14 px shorter and Settings sits 14 px lower; both follow once `/api/system` lands. The main area is empty (the Inbox view is M3.2).

### Codebase Memory tool (M8.1, 2026-09-28)
`tools.md`, `tools-side-by-side.png`, `tools-main-side-by-side.png`. Prototype: sidebar → Codebase Memory, its probe of localhost:13000 aborted offline; app: `/tools/cm` with the demo seed, whose probe provider answers `down`. Gate green: 32 parts (toolbar, URL field, actions, overlay card, the `.codebase-memory-dirty` strip with its three chips, note and button, the sidebar TOOLS rows and their dots) within ±2 px (all measured equal), copy exact, computed styles equal, SPEC token checks ok. Pixel diff 0.00% (main area) / 0.45% (page), advisory.

Agent review of the pair: the main area is identical (toolbar, "offline" in the status color, the "localhost:13000 is not reachable" card with Retry, the strip with mobile 10:31 · acme-app-front 10:22 · components-library-nuget 09:58, "16 projects indexed · full mode", "Reindex 3 now"). Sidebar TOOLS rows match (Codebase Memory red, Acme Tool grey "set URL"). The remaining page differences are other lanes' data: nav badges, session mode lines, footer meters. The real path shows no times on the chips and no indexed note, because the dirty file keeps no times and only codebase-memory itself knows its project count (`docs/tools.md`).

