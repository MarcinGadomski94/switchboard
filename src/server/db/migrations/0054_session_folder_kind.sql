-- 0054 · 2026-11-05: a session linked to a saved folder after it started (a terminal session
-- followed from its cwd, then the folder saved: FolderRepository.linkSessions) kept root_kind
-- NULL, read as a plain folder (D59), so a workspace session moved as "not in a git repository".
-- A session whose root is its saved folder's path takes that folder's kind (NULL stays for a
-- plain folder). Chats have no folder and are left alone.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

UPDATE sessions
SET root_kind = (SELECT NULLIF(f.kind, 'plain') FROM folders f WHERE f.id = sessions.folder_id)
WHERE root_kind IS NULL
  AND root IS NOT NULL
  AND folder_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM folders f
    WHERE f.id = sessions.folder_id AND f.kind IN ('workspace', 'repo') AND (f.canonical_path = sessions.root OR f.path = sessions.root)
  );
