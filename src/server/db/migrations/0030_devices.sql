-- 0030 · paired devices: phones and tablets reaching Switchboard over Tailscale (D73, docs/devices.md).
-- devices: one row per paired device (a browser profile / installed app on a phone or tablet).
--   id                  random id (12 chars a-z2-7); the first half of the device cookie.
--   name                shown in Settings → Devices; from the user agent at pairing, renamable (1–40).
--   user_agent          the browser's user agent at pairing (shown shortened); NULL when it sent none.
--   credential_hash     sha256 (base64url) of the device credential's secret (the cookie's second half);
--                       compared in constant time, never stored in the clear.
--   tailscale_login     the `Tailscale-User-Login` header `tailscale serve` added at pairing; when set,
--                       later requests must carry the same login. NULL when there was none (tagged nodes).
--   paired_at, last_seen_at (ISO)
-- device_pairing_codes: the one-time codes of "Pair a device" (10 minutes, single use, burned after
-- 5 wrong tries); only a hash is stored. A new code replaces the old ones.
-- device_push_subscriptions: a device's Web Push subscription (one per device) and its toggles.
--   endpoint            the push service URL the browser gave (Apple / Google / Mozilla).
--   p256dh, auth        the subscription's keys (base64url) the payload is encrypted to (RFC 8291).
--   events              JSON object of the per-device toggles (permission, questions, turnFinished, errors, inbox).
--   last_error          the last failed delivery (status and short text), NULL after a success.
-- Revoking a device deletes it; its subscription goes with it (ON DELETE CASCADE).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  user_agent TEXT,
  credential_hash TEXT NOT NULL UNIQUE,
  tailscale_login TEXT,
  paired_at TEXT NOT NULL,
  last_seen_at TEXT
) STRICT;

CREATE TABLE device_pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0)
) STRICT;

CREATE TABLE device_push_subscriptions (
  device_id TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  events TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
) STRICT;
