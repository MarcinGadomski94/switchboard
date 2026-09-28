#!/usr/bin/env node
/**
 * `npm run service:uninstall -- [--dry-run] [--platform …]` (M9.1,
 * `docs/service.md`): stops and removes this user's background service.
 */
import { main } from './cli.ts';

await main('uninstall');
