-- 0061 · D176 "A computer checklist decides only for the computers it was set for"
-- (docs/profiles.md → *Admins and computer access*).
-- user_profiles gains:
--   decided_for  the computers (machine ids, a JSON array) the access list (`computers`) was decided
--                for: the ones the admin's computer could see when the list was set. A computer outside
--                it (for example one paired only with another of the paired computers) stays allowed.
--                NULL = decided for every computer (a D173 list from before, or every computer allowed).
-- A profile attribute: it travels with the record over the peer sync (D165 / D172 / D173).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE user_profiles ADD COLUMN decided_for TEXT;
