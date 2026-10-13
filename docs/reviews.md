# Review queue (D79) — removed

Review cards were **removed** in D102 (developer decision 2026-10-14: "it's not working as it's supposed to"). See `docs/decisions.md` → D102 for the reasons and what replaced them:

- a todo run marked done goes straight to **done** (no `review` state; `docs/todos.md`);
- Plans have their own **Merge step** (`ready-to-merge`: Merge / Open PR / Send back / Open diff, and an Inbox "Ready to merge" item; `docs/plans.md` → *Merge step*);
- the repositories a session works in (still read by turn checkpoints and the Diff tab) are documented in `docs/worktrees.md` → *Which repositories*.

Migration `0043_drop_session_reviews.sql` dropped the `session_reviews` table (`docs/database.md`).
