-- 0064 · D190 "A profile's GitHub account" (docs/profiles.md → *A profile's GitHub account*).
-- user_profiles gains:
--   github  the GitHub account the profile is bound to, as JSON { login, name, id, email }
--           (`email` = the commit email the developer chose, null = the account's noreply address);
--           NULL = not bound. A profile attribute: it travels with the record over the peer sync
--           (D165). The sign-in itself is gh's own, per computer, in <dataDir>/github/<profile id>/
--           (never in the database, never synced).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE user_profiles ADD COLUMN github TEXT;
