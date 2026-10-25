import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../helpers/net.ts';

/**
 * D99 · `docs/plans-removal.md` stays true: every file outside Plans' own folders and
 * files that carries the `Plans (D99) hook` marker is listed in the removal table, and
 * every file the table names exists and still carries a marker (Team's pattern, D100).
 */

const OWN = [/^src\/server\/plans\//, /^src\/web\/plans\//, /^src\/core\/plans\.ts$/, /^src\/hook\/sb-plan-tools\.ts$/];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await files(rel)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe('D99 · the wiring map (D132: graduated, the hooks stay listed)', () => {
  it('lists every hook file, and every listed file is a hook', async () => {
    const doc = await readFile(path.join(REPO_ROOT, 'docs', 'plans-removal.md'), 'utf8');
    const hooked: string[] = [];
    for (const file of await files('src')) {
      if (OWN.some((pattern) => pattern.test(file))) continue;
      if ((await readFile(path.join(REPO_ROOT, file), 'utf8')).includes('Plans (D99) hook')) hooked.push(file);
    }
    expect(hooked.length).toBeGreaterThan(10);
    for (const file of hooked) expect(doc, `${file} is a hook but not in docs/plans-removal.md`).toContain(`\`${file}\``);
    const table = [...doc.matchAll(/^\| `(src\/[^`]+)` \|/gm)].map((match) => match[1] as string);
    expect(table.sort()).toEqual([...hooked].sort());
  });

  it('the main database has no Plans migration (Plans lives in plans.db)', async () => {
    const migrations = await readdir(path.join(REPO_ROOT, 'src', 'server', 'db', 'migrations'));
    // D102: 0043 is the review cards' removal (drop_session_reviews), not Plans'.
    expect(migrations.filter((file) => /plan/i.test(file))).toEqual([]);
  });
});
