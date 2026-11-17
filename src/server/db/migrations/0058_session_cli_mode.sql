-- 0058 · D171 "The agent's CLI tab" (docs/terminals.md → *CLI mode*): an agent switched into CLI mode
-- runs its conversation as the interactive `claude` in a Switchboard terminal (D170), followed through
-- its hooks (D48) like a hooked terminal session, until Back to chat mode (D72's continue).
-- sessions gains:
--   cli_terminal_id  the D170 terminal running the agent's interactive claude while it is in CLI mode;
--                    NULL = chat mode (headless, as before). A terminal does not survive a restart, so a
--                    session still marked at start goes back to chat mode (idle, no process).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN cli_terminal_id TEXT;
