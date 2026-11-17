# Backup and restore (D168)

Developer request (2026-11-17): "make it possible to create a backup of all of the settings, agents, folders, artifacts, basically everything, around switchboard, so i can move the setup from one pc to another". Rulings: the secrets are included, encrypted with a passphrase; every agent's conversation is included (each agent can continue on the new computer); a restore goes into a fresh install, with the folders whose paths do not exist there mapped by the developer; automatic daily backups; Settings and the command line. Decisions: `docs/decisions.md` → D168.

Code: `src/core/backup.ts` (format, preview, version rule, entry names, path mapping), `src/server/backup/` (`crypto.ts`, `container.ts`, `archive.ts`, `restore.ts`, `service.ts`), `src/server/api/backup.ts`, `tools/backup/cli.ts`, `src/web/v2/settings/BackupSection.tsx`.

## What is in a backup

| In the archive | From | Notes |
|---|---|---|
| `db/switchboard.db`, `db/plans.db`, `db/team.db`, `db/memory.db` | the data folder | Consistent snapshots (`VACUUM INTO`), never the live file next to its WAL, so a running Switchboard can be backed up. |
| `data/attachments/`, `data/artifacts/`, `data/chats/`, `data/handovers/` | the data folder | Attachments' and artifacts' files are stored relative to the data folder, so they need no rewriting. |
| `data/profiles/` | the data folder | D63's account folders (each CLI account's own config folder): their conversations and their own logins. Symbolic links in them (an account's settings shared with the Default, `docs/accounts.md`) are not followed and are left out; Settings → Accounts links them again. |
| `data/sb_token`, `data/hook-token`, `data/vapid.json` | the data folder | The UI token, the terminal hooks' token, the push keys: restored only with *take over the old computer's identity*. |
| `cli/claude/<session>/…`, `cli/codex/<session>/…` | the CLIs' Default folders (`~/.claude`, `~/.codex`, or `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) | Only Switchboard's sessions' conversations: a Claude Code transcript `<id>.jsonl` with its `<id>/` folder (subagents, workflow runs), a Codex rollout. An account's conversations are already inside `data/profiles/`. OpenCode keeps its own storage: its sessions continue from the D62 handover, as after a move. |
| `secrets.json` | the OS keychain | The values Switchboard put there: the Team accesses' fields (D100-T2, their references in `team.db`) and the Jira token. Inside the encrypted archive only. |

**Not included** (machine-specific or rebuilt): `logs/`, `versions/`, `updates/`, `takeover/` (staging), `service/` (the login service's files), `agent-mcp/`, caches. The CLIs' own Default logins (`~/.claude` credentials, the macOS keychain item Claude Code writes) are the CLI's, not Switchboard's: sign in once on the new computer. The code itself is never in a backup: repositories travel through git (and a move, `docs/peers.md`).

## The file

`switchboard-backup-<date>-<time>[-auto].sbbackup`, encrypted as a whole (ASSUMED D168: not only the secrets):

- **Key:** scrypt of the passphrase (N = 2^17, r = 8, p = 1, a random 16-byte salt; the cost is in the header, bounded when read), 32 bytes.
- **Encryption:** AES-256-GCM in records of 1 MiB of plaintext (the STREAM construction): the nonce is a random per-file prefix, the record's counter and a last-record flag; the header is every record's additional data. A changed byte, a record moved, dropped or added, a cut-off end and bytes after the last record are all refused. A key check value in the header (an HMAC of the key) tells a wrong passphrase apart from a damaged file before anything is read.
- **Inside:** gzip of a container: entries `header length | header JSON | data | sha256`. The first entry is the **preview** (the old computer's version, OS, name and id, its data folder, home and CLI folders, the saved folders, each conversation's place, the counts), the last the **checksums** of every file entry. The reader checks each entry's sha256 and the list.
- A file is read up to the size it had when the backup started (a transcript growing meanwhile is cut there, never torn). Memory stays bounded whatever the size.

## Backing up

- **Settings → Backup → Back up now:** a passphrase (at least 8 characters, typed twice); the file goes into the backup folder (default `<home>/SwitchboardBackups`) and can be downloaded from the list (`GET /api/backup/files/{name}`). One backup or restore at a time (409 `busy`).
- **Automatic backups** (off by default): every day (checked every 30 minutes, a day after the last automatic one), into the folder, the newest *N* kept (default 7; only `-auto` files are pruned). Turning them on needs a passphrase: its **derived key** (with its salt and cost) is kept in this computer's keychain (`Switchboard Backup` / `automatic`), never the passphrase; the files open with the passphrase as any backup. ASSUMED D168.
- **Terminal:** `switchboard backup [--out <file or folder>] [--passphrase-env <VAR>]` (the installer's `npx @marcingadomski94/switchboard backup` runs the installed app's `tools/backup/cli.ts`; or `npm run backup` in the app folder). The passphrase is never an argument: the named variable, else a hidden prompt (twice).

## Restoring

Meant for a **fresh install** on the new computer. Steps (`src/server/backup/restore.ts`):

1. **Check** (Settings: *Check the backup*; `POST /api/backup/inspect`): the passphrase, the preview, a backup from a **newer** Switchboard refused (update this one first; an older backup restores and the migrations run at the next start), and the saved folders that do not exist here after the automatic mappings.
2. **Stage:** the whole file is decrypted into a folder inside the data folder (`restore-pending/` from Settings, `.restore-staging-…` from the terminal) and every checksum verified. A wrong passphrase or a damaged file stops here; nothing else was touched.
3. **Map the paths** in the staged databases: the old data folder → this one, the old CLI Default folders → this computer's, and the developer's folder mappings (Settings: a field per missing folder; terminal: `--map "<old>=<new>"`, repeatable). A path matches when it is the mapped folder or lies under it (Windows paths compare without case and slash), the longest mapping first, and the rest takes the target's separator (`D:\code\app` with `D:\code` → `/Users/me/code` gives `/Users/me/code/app`). Columns rewritten: every path column (`cwd`, `root`, `path`, `canonical_path`, `repo_path`, `dir`, `progress_path`, `export_path`, `folder`, `scope`, `scope_key`) and every JSON document (`extra_dirs`, `template`, `data`, `repos`, `solutions`, `entry`, `value`, `look_at`, `answers`, `context`) of the four databases, only strings under a mapped folder; the agents' own chat (`events`) is never rewritten. Folders still missing: refused, unless *keep the ones I did not map as missing* (`--allow-missing`).
4. **Place the conversations:** a Claude Code transcript belongs under `<config folder>/projects/<slug of its working folder>/`, so each one moves to the new working folder's slug (an account's inside the staged `profiles/`, the Default's copied after the swap into this computer's Default folder); `sessions.transcript_path` points there. Codex rollouts go to `CODEX_HOME/sessions/…` as they were. Caches (`history_cache`, `peer_snapshots`) are emptied; the automatic backups are switched off (their key is the old computer's keychain's).
5. **Identity** (ASSUMED D168): *take over the old computer's identity* keeps its machine id, pairings, phones, tokens and push keys (only when the old computer is retired: two computers with one identity confuse their peers); *start as a new computer* (the default) gives this install a new machine id (the old id is replaced in `team.db` and the other records that name it), removes the pairings and phones, and keeps this install's own tokens. Re-pair afterwards.
6. **Swap** (Switchboard stopped): the data folder's databases (with their WAL files) and folders, and with *keep* the tokens, move to `.pre-restore-<time>/` and the staged ones move in; any failure puts everything back. An install that already has agents is refused unless the developer confirms *replace everything here* (`--force`); its data is then that `.pre-restore-<time>/` folder (the safety copy). Then the conversations outside the data folder are written and the keychain values set; the report goes to `restore-report.json`.
7. **Where it runs:** from Settings the restore is prepared, then Switchboard restarts through the login service (D140's one start) and applies it at start (`applyPendingRestore` in `main.ts`, before anything opens the data folder); a Switchboard started by hand says to restart it. From the terminal (`switchboard restore <file> …`) it refuses while Switchboard answers on its port, then applies at once.
8. **Report** (Settings → Backup → *Last restore*; the terminal prints it): agents and folders restored, paths mapped, conversations placed / missing, keychain values written, where the old data is kept, and what needs the developer (sign in to the CLIs, re-pair, fix missing folders).

## Routes

Local only: refused to paired phones (`DEVICE_REFUSED`, `src/server/devices/local-only.ts`) and not on the peer API. `docs/handoff/contracts/local-api.md` → *Backup (D168)*.

## Tests

| Test | Covers |
|---|---|
| `tests/core/backup.test.ts` | path mapping (both directions, case, longest first, no partial names), JSON, `--map`, the version rule, entry names, file names and pruning, settings |
| `tests/server/backup/crypto.test.ts` | round trip at the chunk boundaries, fresh nonces, a wrong passphrase, any changed byte, a cut-off file, extra bytes, not a backup |
| `tests/server/backup/roundtrip.test.ts` | a setup backed up and restored into a fresh install with a folder map: the agents at the new paths (the restored server's `GET /api/sessions`), both conversations at the new slug, an account folder, an attachment, the keychain value, a new identity; a wrong passphrase, a changed byte, missing folders and an install with agents restore nothing; replace keeps the old data aside; automatic backups keep N |
| `tests/tools/backup-cli.test.ts` | the terminal's arguments (no passphrase on the command line) |
