#!/usr/bin/env node
/**
 * `npm run service:install -- [--dry-run] [--start] [--platform …]` (M9.1,
 * `docs/service.md`): registers Switchboard as this user's background service.
 */
import { main } from './cli.ts';

await main('install');
