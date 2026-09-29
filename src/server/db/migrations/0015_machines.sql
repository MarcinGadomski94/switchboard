-- 0015 · paired Switchboard machines (D48, "Switchboard peers", docs/peers.md).
-- machines: one row per paired peer. One pairing creates both directions
-- (ASSUMED D48-both-directions): each side stores the token it presents to the
-- other and only a hash of the token the other presents to it.
--   id                   the peer's own machine id (12 chars a-z2-7): the
--                        namespace of its remote ids (`r~<id>~<peer id>`).
--   name                 shown in tags; the peer's host name at pairing, renamable.
--   address              the peer listener's `host:port` (a Tailscale IPv4); NULL
--                        while the peer has not told one (its listener is off).
--   outbound_token       the bearer token this service presents to the peer
--                        (random 32 bytes, base64url). It has to be sent, so it is
--                        stored as is (the database file is the user's own, 0600
--                        folder); NULL never (kept NOT NULL).
--   inbound_token_hash   sha256 (base64url) of the token the peer presents here;
--                        compared in constant time, never stored in the clear.
--   paired_at, last_seen_at (ISO)
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  outbound_token TEXT NOT NULL,
  inbound_token_hash TEXT NOT NULL UNIQUE,
  paired_at TEXT NOT NULL,
  last_seen_at TEXT
) STRICT;
