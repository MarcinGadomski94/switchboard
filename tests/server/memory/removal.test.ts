import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../helpers/net.ts';

/**
 * D107 · `docs/memory-removal.md` stays true: every file outside Project memory's own folders
 * and files that carries the `Project memory (D107) hook` marker is listed in the removal table,
 * and every file the table names exists and still carries a marker (Team's and Plans' pattern).
 */

const OWN = [/^src\/server\/memory\//, /^src\/web\/memory\//, /^src\/core\/memory\.ts$/, /^src\/hook\/sb-memory-tools\.ts$/];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await files(rel)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe('D107 · the removal procedure', () => {
  it('lists every hook file, and every listed file is a hook', async () => {
    const doc = await readFile(path.join(REPO_ROOT, 'docs', 'memory-removal.md'), 'utf8');
    const hooked: string[] = [];
    for (const file of await files('src')) {
      if (OWN.some((pattern) => pattern.test(file))) continue;
      if ((await readFile(path.join(REPO_ROOT, file), 'utf8')).includes('Project memory (D107) hook')) hooked.push(file);
    }
    expect(hooked.length).toBeGreaterThan(10);
    for (const file of hooked) expect(doc, `${file} is a hook but not in docs/memory-removal.md`).toContain(`\`${file}\``);
    const table = [...doc.matchAll(/^\| `(src\/[^`]+)` \|/gm)].map((match) => match[1] as string);
    expect(table.sort()).toEqual([...hooked].sort());
  });

  it('the main database has no Project memory migration (it lives in memory.db)', async () => {
    const migrations = await readdir(path.join(REPO_ROOT, 'src', 'server', 'db', 'migrations'));
    expect(migrations.filter((file) => /memor/i.test(file))).toEqual([]);
  });

  it('no file outside its own imports its folders except through a listed hook', async () => {
    const doc = await readFile(path.join(REPO_ROOT, 'docs', 'memory-removal.md'), 'utf8');
    for (const file of await files('src')) {
      if (OWN.some((pattern) => pattern.test(file))) continue;
      const text = await readFile(path.join(REPO_ROOT, file), 'utf8');
      if (/from '[^']*(?:\/memory\/|\/core\/memory\.ts|sb-memory-tools\.ts)/.test(text)) expect(doc, `${file} imports Project memory`).toContain(`\`${file}\``);
    }
  });
});
