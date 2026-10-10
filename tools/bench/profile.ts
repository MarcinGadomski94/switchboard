/**
 * `node tools/bench/profile.ts <file.cpuprofile> [--top 25] [--filter <text>]`:
 * summarizes a V8 CPU profile (`--cpu-prof`, or CDP `Profiler.stop`) by function:
 * self time and total (inclusive) time, the hottest first. Part of the
 * performance harness (`docs/performance.md`).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
  readonly children?: readonly number[];
}

interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
  readonly startTime: number;
  readonly endTime: number;
}

/** One function's times in ms. */
export interface FunctionTime {
  readonly name: string;
  readonly self: number;
  readonly total: number;
}

function frameName(node: ProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame;
  const file = url === '' ? '' : ` ${path.basename(url.replace(/^file:\/\//, ''))}:${lineNumber + 1}`;
  return `${functionName || '(anonymous)'}${file}`;
}

/** Self and total time per function (a recursive function counts once per sample). */
export function summarize(profile: CpuProfile): { readonly totalMs: number; readonly functions: FunctionTime[] } {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  let totalMs = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const ms = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    const leaf = profile.samples[i];
    if (leaf === undefined) continue;
    totalMs += ms;
    const leafNode = byId.get(leaf);
    if (!leafNode) continue;
    const leafName = frameName(leafNode);
    self.set(leafName, (self.get(leafName) ?? 0) + ms);
    const seen = new Set<string>();
    for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) {
      const node = byId.get(id);
      if (!node) break;
      const name = frameName(node);
      if (seen.has(name)) continue;
      seen.add(name);
      total.set(name, (total.get(name) ?? 0) + ms);
    }
  }
  const functions = [...total.entries()].map(([name, t]) => ({ name, self: self.get(name) ?? 0, total: t }));
  return { totalMs, functions };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { top: { type: 'string', default: '25' }, filter: { type: 'string' } } });
  const top = Number(values.top);
  for (const file of positionals) {
    const { totalMs, functions } = summarize(JSON.parse(await readFile(file, 'utf8')) as CpuProfile);
    const shown = values.filter ? functions.filter((f) => f.name.includes(values.filter ?? '')) : functions;
    const idle = functions.find((f) => f.name.startsWith('(idle)'))?.self ?? 0;
    console.log(`${file}: ${totalMs.toFixed(0)} ms sampled, ${(totalMs - idle).toFixed(0)} ms busy`);
    console.log('  by self time:');
    for (const f of [...shown].sort((a, b) => b.self - a.self).slice(0, top)) console.log(`    ${f.self.toFixed(1).padStart(9)} ms self  ${f.total.toFixed(1).padStart(9)} ms total  ${f.name}`);
    console.log('  by total time (Switchboard code):');
    for (const f of [...shown].filter((f) => f.name.includes('.ts:')).sort((a, b) => b.total - a.total).slice(0, top)) console.log(`    ${f.total.toFixed(1).padStart(9)} ms total  ${f.self.toFixed(1).padStart(9)} ms self  ${f.name}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
