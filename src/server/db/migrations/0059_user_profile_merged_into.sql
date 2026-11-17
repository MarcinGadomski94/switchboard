-- 0059 · D172 "Profiles keep their own identity across paired computers; merge on purpose"
-- (docs/profiles.md → *Identity across computers*, *Merging profiles*).
-- Every computer keeps its own Default under the local id 'default'; on the peer link it travels as
-- that computer's own id (`default-<machine id>`, or the merged one), so two computers' Defaults never
-- meet as one record again (the D165 bug: both were 'default', the newer rename won on both).
-- user_profiles gains:
--   merged_into  on a tombstone: the profile (as the peer link names it) it was merged into, so every
--                computer that holds data of the merged-away profile re-keys it to the survivor.
--                NULL for live profiles and ordinary deletes.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE user_profiles ADD COLUMN merged_into TEXT;
