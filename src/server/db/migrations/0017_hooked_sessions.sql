-- 0017 · hand-started terminal sessions a Switchboard hooked into (D48 P4,
-- docs/peers.md → Hooked terminal sessions).
-- sessions:
--   hooked            1 = the session is a terminal `claude` session the developer
--                     started by hand, followed through Switchboard's hooks (its
--                     chat from the transcript, its prompts and replies through
--                     the hook endpoints); Switchboard never runs a process for
--                     it. 0 for every other session and every session before 0017.
--   transcript_path   the transcript the hooks reported (`transcript_path`);
--                     NULL when unknown (then looked up by the claude session id).
-- permission_requests:
--   hook_suggestions  the PermissionRequest hook's `permission_suggestions`
--                     (JSON array, `[]` when it had none) for a hooked session's
--                     request: "Always allow" sends them as `updatedPermissions`;
--                     NULL for every request of a supervised process (D6: Allow
--                     once / Deny only).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN hooked INTEGER NOT NULL DEFAULT 0 CHECK (hooked IN (0, 1));
ALTER TABLE sessions ADD COLUMN transcript_path TEXT;
ALTER TABLE permission_requests ADD COLUMN hook_suggestions TEXT;
