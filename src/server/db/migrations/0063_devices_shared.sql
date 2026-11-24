-- 0063 · D189 "A phone paired on one computer works on every paired computer"
-- (docs/devices.md → One pairing for all your computers; docs/security.md → Device handover).
-- devices gains:
--   clock        the hybrid clock of the device's shared record (name, profile): last write wins
--                between the paired computers; '' = before D189 (older than any clock).
--   paired_on    the machine id of the computer the phone was paired on; NULL = this computer.
--   set_up_here  1 when the phone holds a credential of THIS computer (credential_hash is real);
--                0 for a phone known only through a paired computer, until it is handed over here
--                (credential_hash then holds an unusable placeholder, never a real hash).
-- device_tombstones: revoked phones (id, the revoke's clock, when), so a revoke reaches every paired
-- computer and a revoked phone never comes back through a sync.
-- Credentials are never shared: each computer keeps the hash of the credential it gave the phone.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE devices ADD COLUMN clock TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN paired_on TEXT;
ALTER TABLE devices ADD COLUMN set_up_here INTEGER NOT NULL DEFAULT 1 CHECK (set_up_here IN (0, 1));

CREATE TABLE device_tombstones (
  id TEXT PRIMARY KEY,
  clock TEXT NOT NULL,
  revoked_at TEXT NOT NULL
) STRICT;
