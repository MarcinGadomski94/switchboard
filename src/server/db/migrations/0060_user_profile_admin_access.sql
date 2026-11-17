-- 0060 · D173 "Admin profiles decide which computers each profile may use"
-- (docs/profiles.md → *Admins and computer access*).
-- user_profiles gains:
--   admin      1 = an admin profile: only an admin (with its password) changes who is an admin and
--              which computers each profile may use. 0 for every existing profile (nothing changes
--              until someone with a password makes their profile the first admin).
--   computers  the computers (machine ids, a JSON array) the profile may use; NULL = every computer
--              (the default: nothing is limited until an admin limits it).
-- Both are profile attributes: they travel with the record over the peer sync (D165 / D172).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE user_profiles ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1));
ALTER TABLE user_profiles ADD COLUMN computers TEXT;
