/**
 * `node tools/bench/heap-diff.ts <before.heapsnapshot> <after.heapsnapshot> [--top 30]`: what grew
 * between two V8 heap snapshots (`docs/performance.md` → *Long runs (1.24)*), by constructor /
 * node name: count and self size of each, sorted by the growth of the self size.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

interface Snapshot {
  readonly snapshot: { readonly meta: { readonly node_fields: string[]; readonly node_types: [string[], ...unknown[]] } };
  readonly nodes: number[];
  readonly strings: string[];
}

/** Count and self size per `type:name` of a snapshot file. */
export async function heapSummary(file: string): Promise<Map<string, { count: number; size: number }>> {
  const data = JSON.parse(await readFile(file, 'utf8')) as Snapshot;
  const fields = data.snapshot.meta.node_fields;
  const width = fields.length;
  const typeAt = fields.indexOf('type');
  const nameAt = fields.indexOf('name');
  const sizeAt = fields.indexOf('self_size');
  const types = data.snapshot.meta.node_types[0];
  const out = new Map<string, { count: number; size: number }>();
  for (let i = 0; i < data.nodes.length; i += width) {
    const type = types[data.nodes[i + typeAt] as number] ?? '?';
    let name = type === 'object' || type === 'closure' || type === 'native' ? (data.strings[data.nodes[i + nameAt] as number] ?? '?') : type;
    if (name.length > 60) name = `${name.slice(0, 57)}…`;
    const key = `${type}:${name}`;
    const entry = out.get(key) ?? { count: 0, size: 0 };
    entry.count += 1;
    entry.size += data.nodes[i + sizeAt] as number;
    out.set(key, entry);
  }
  return out;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { top: { type: 'string', default: '30' } } });
  const [beforeFile, afterFile] = positionals;
  if (!beforeFile || !afterFile) throw new Error('usage: heap-diff.ts <before> <after>');
  const before = await heapSummary(beforeFile);
  const after = await heapSummary(afterFile);
  const total = (m: Map<string, { size: number }>) => [...m.values()].reduce((s, e) => s + e.size, 0);
  console.log(`total self size: ${(total(before) / 1e6).toFixed(2)} MB → ${(total(after) / 1e6).toFixed(2)} MB`);
  const rows = [...new Set([...before.keys(), ...after.keys()])].map((key) => {
    const b = before.get(key) ?? { count: 0, size: 0 };
    const a = after.get(key) ?? { count: 0, size: 0 };
    return { key, dCount: a.count - b.count, dSize: a.size - b.size, count: a.count, size: a.size };
  });
  rows.sort((x, y) => y.dSize - x.dSize);
  for (const row of rows.slice(0, Number(values.top))) {
    console.log(`${(row.dSize / 1024).toFixed(1).padStart(9)} KB ${String(row.dCount).padStart(7)} ×  (now ${String(row.count).padStart(7)}, ${(row.size / 1024).toFixed(0).padStart(7)} KB)  ${row.key}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
