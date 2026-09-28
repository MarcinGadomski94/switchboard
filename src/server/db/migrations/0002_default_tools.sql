-- 0002 · default embedded tools (M8.1)
-- A fresh install lists the two tools the handoff names (ARCHITECTURE → Processes,
-- BACKLOG M8.1): Codebase Memory at its default http://localhost:13000 and Acme Tool
-- without a URL ("isn't configured" until one is set in Settings). This runs once
-- per database, so tools the developer removes or edits later stay that way
-- (gap #14). Ids `cm` / `sw` are the ones the UI and the demo seed use
-- (docs/tools.md). Never edit this file once it is committed.

INSERT INTO tools (id, name, url, description, show_in_sidebar, position, created_at, updated_at)
VALUES
  ('cm', 'Codebase Memory', 'http://localhost:13000', 'code graph for your indexed solutions', 1, 0,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sw', 'Acme Tool', NULL, 'AI chat connected to other tools', 1, 1,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (id) DO NOTHING;
