import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutOf, isMainCheckout } from '../../../src/server/solutions/checkout.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await removeTempDir(dir);
  dir = undefined;
});

async function temp(): Promise<string> {
  dir = await realpath(await makeTempDir('checkout'));
  return dir;
}

async function repo(at: string): Promise<string> {
  await mkdir(path.join(at, '.git'), { recursive: true });
  return at;
}

describe('checkoutOf (a solution folder → its git main checkout)', () => {
  it('is the folder itself when it is a checkout', async () => {
    const root = await temp();
    const mobile = await repo(path.join(root, 'mobile'));
    expect(await isMainCheckout(mobile)).toBe(true);
    expect(await checkoutOf(mobile)).toBe(mobile);
  });

  it('is the one nested checkout of a folder that is not one (mobile/ → mobile/acme-app-mobile/)', async () => {
    const root = await temp();
    const mobile = path.join(root, 'mobile');
    const nested = await repo(path.join(mobile, 'acme-app-mobile'));
    await writeFile(path.join(mobile, 'AGENTS.md'), 'rules\n');
    await mkdir(path.join(mobile, 'notes'));
    // A worktree next to it (`.git` is a file), a hidden folder and a symlink never count.
    await mkdir(path.join(mobile, 'acme-app-mobile-wt-x'));
    await writeFile(path.join(mobile, 'acme-app-mobile-wt-x', '.git'), 'gitdir: elsewhere\n');
    await repo(path.join(mobile, '.hidden-repo'));
    await symlink(nested, path.join(mobile, 'link-to-repo'));
    expect(await checkoutOf(mobile)).toBe(nested);
  });

  it('is null without a checkout, with several nested ones, or for a missing folder', async () => {
    const root = await temp();
    await mkdir(path.join(root, 'plain', 'sub'), { recursive: true });
    expect(await checkoutOf(path.join(root, 'plain'))).toBeNull();
    await repo(path.join(root, 'two', 'a'));
    await repo(path.join(root, 'two', 'b'));
    expect(await checkoutOf(path.join(root, 'two'))).toBeNull();
    expect(await checkoutOf(path.join(root, 'missing'))).toBeNull();
  });
});
