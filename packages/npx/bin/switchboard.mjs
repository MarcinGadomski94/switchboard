#!/usr/bin/env node
// @ts-check
// `npx @marcingadomski94/switchboard [--help]`: installs, upgrades or removes Switchboard
// (lib/installer.mjs; the same steps as the repo's install.sh / install.ps1).
import { main } from '../lib/installer.mjs';

process.exitCode = await main(process.argv.slice(2));
