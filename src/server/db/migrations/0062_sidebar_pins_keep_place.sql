-- 0062 · D186 "A pin is a shortcut, not a place" (docs/sidebar.md → *Pinned*).
-- A pinned session keeps its folder (or loose) place and also shows in Pinned: its pin is now a
-- row of its own in sidebar_places, session_id 'pin~<session id>' (grp 'pinned', or 'none' once
-- unpinned), beside the session's place row. Pinned crews and projects ('crew~…' / 'plan~…') keep
-- their one row, as before.
-- Every existing pinned session row becomes a pin row (same order key and clock) and the session's
-- own row becomes unplaced (its folder before the pin is not known: it shows at the top level).
-- The two D54 triggers take the pin rows with them too (a deleted session record, a forgotten
-- machine).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

INSERT OR REPLACE INTO sidebar_places (session_id, grp, folder_id, sort_key, clock)
  SELECT 'pin~' || session_id, 'pinned', NULL, sort_key, clock FROM sidebar_places
  WHERE grp = 'pinned' AND session_id NOT LIKE 'crew~%' AND session_id NOT LIKE 'plan~%' AND session_id NOT LIKE 'pin~%';

UPDATE sidebar_places SET grp = 'none', folder_id = NULL, sort_key = ''
  WHERE grp = 'pinned' AND session_id NOT LIKE 'crew~%' AND session_id NOT LIKE 'plan~%' AND session_id NOT LIKE 'pin~%';

CREATE TRIGGER sessions_sidebar_pin AFTER DELETE ON sessions
BEGIN
  DELETE FROM sidebar_places WHERE session_id = 'pin~' || OLD.id;
END;

CREATE TRIGGER machines_sidebar_pins AFTER DELETE ON machines
BEGIN
  DELETE FROM sidebar_places WHERE substr(session_id, 1, length(OLD.id) + 7) = 'pin~r~' || OLD.id || '~';
END;
