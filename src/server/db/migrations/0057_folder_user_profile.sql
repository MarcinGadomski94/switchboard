-- 0057 · D169 "A folder bound to a profile" (docs/profiles.md → *A folder bound to a profile*):
-- a saved folder (D14) may belong to one profile (D165); the other profiles do not see it and can
-- start nothing in it. Per computer: each computer's folders are bound on their own.
-- folders gains:
--   user_profile_id  NULL = shared by every profile (every folder before 0057, as before);
--                    else the owning profile's id (no foreign key: profiles sync between paired
--                    computers and a deleted profile's folders are unbound by the service).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE folders ADD COLUMN user_profile_id TEXT;
