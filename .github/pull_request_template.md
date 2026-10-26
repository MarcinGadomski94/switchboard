## What and why

<!-- What this pull request changes and why. Link the issue it fixes, if any. -->

## How it was tested

<!-- The commands you ran, e.g. `npm run typecheck`, `npx vitest run tests/…`, `npx playwright test tests/e2e/….spec.ts`, and anything you checked by hand. -->

## Checklist

- [ ] `npm run typecheck`, `npm test` and the affected `npm run e2e` specs pass
- [ ] Tests use the fake CLIs (`tools/fake-*`), never a real `claude`, `codex`, `opencode`, `gh` or the network
- [ ] Docs in `docs/` and, where a ruling changed, `docs/decisions.md` are updated
- [ ] A user-facing feature has a What's-new tour entry (`docs/tutorial.md`)
- [ ] Only placeholders (`Acme`, `PROJ-123`, `example.com`): no real company names, tickets, emails, tokens or local paths
