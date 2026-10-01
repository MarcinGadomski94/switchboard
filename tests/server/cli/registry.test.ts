import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliRegistry, MissingAdapterError, cliCommandKey, readCommandOverride } from '../../../src/server/cli/registry.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await makeTempDir('cli-registry');
  store = await openTempStore(dir);
});
afterEach(async () => {
  await store.close();
  await removeTempDir(dir);
});

describe('D62 CliRegistry', () => {
  it('uses the configured commands, the bare names by default, and the settings override for Codex / OpenCode only', async () => {
    const registry = new CliRegistry({ commands: { claude: ['/opt/claude'], codex: ['/env/codex'] }, settings: store.settings });
    expect(await registry.command('claude')).toEqual(['/opt/claude']);
    expect(await registry.command('codex')).toEqual(['/env/codex']);
    expect(await registry.command('opencode')).toEqual(['opencode']);
    await store.settings.set(cliCommandKey('codex'), ['node', '/x/codex.js']);
    await store.settings.set(cliCommandKey('claude'), ['ignored']);
    expect(await registry.command('codex')).toEqual(['node', '/x/codex.js']);
    expect(await registry.command('claude')).toEqual(['/opt/claude']);
    expect(registry.configuredCommand('codex')).toEqual(['/env/codex']);
  });

  it('reads overrides defensively and has Claude Code built in', () => {
    expect(readCommandOverride(['a', 'b'])).toEqual(['a', 'b']);
    expect(readCommandOverride([])).toBeNull();
    expect(readCommandOverride(['a', ''])).toBeNull();
    expect(readCommandOverride('codex')).toBeNull();
    const registry = new CliRegistry({ commands: {} });
    expect(registry.adapter('claude').id).toBe('claude');
    expect(registry.hasAdapter('codex')).toBe(false);
    expect(() => registry.adapter('codex')).toThrow(MissingAdapterError);
  });
});
