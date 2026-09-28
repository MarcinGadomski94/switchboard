import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryInUseReader, parseMeminfo, parseVmStat } from '../../../src/server/system/memory.ts';
import { REPO_ROOT } from '../../helpers/net.ts';

/**
 * D17: memory actually in use (src/server/system/memory.ts, docs/setup.md →
 * *System*) from fixture `vm_stat` / `/proc/meminfo` text: Activity Monitor's
 * *Memory Used* on macOS, `MemTotal − MemAvailable` on Linux, `null` (→ total −
 * free) on Windows and whenever a read fails.
 */

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'memory');

async function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), 'utf8');
}

/** The developer's Mac sample (page size 16384): (4206892 anonymous − 136138 purgeable + 292409 wired + 184332 compressor) × 16384. */
const VM_STAT_IN_USE = (4_206_892 - 136_138 + 292_409 + 184_332) * 16_384;
/** (32617072 MemTotal − 20482148 MemAvailable) kB. */
const MEMINFO_IN_USE = (32_617_072 - 20_482_148) * 1024;

describe('parseVmStat (macOS)', () => {
  it('app memory + wired + compressed × the header page size, like Activity Monitor’s Memory Used', async () => {
    expect(parseVmStat(await fixture('vm_stat-darwin.txt'))).toBe(VM_STAT_IN_USE);
    // About 74.5 GB (decimal), 69.4 GiB: well below the 88–93 GiB that total − free reads there.
    expect(VM_STAT_IN_USE).toBe(74_506_158_080);
  });

  it('reads the page size from the header (4 KiB pages on Intel Macs)', async () => {
    const intel = (await fixture('vm_stat-darwin.txt')).replace('page size of 16384 bytes', 'page size of 4096 bytes');
    expect(parseVmStat(intel)).toBe(VM_STAT_IN_USE / 4);
  });

  it('CRLF line ends are fine; purgeable above anonymous counts as no app memory', async () => {
    expect(parseVmStat((await fixture('vm_stat-darwin.txt')).replaceAll('\n', '\r\n'))).toBe(VM_STAT_IN_USE);
    const text = (await fixture('vm_stat-darwin.txt')).replace(/Pages purgeable:\s+\d+\./, 'Pages purgeable: 9999999.');
    expect(parseVmStat(text)).toBe((292_409 + 184_332) * 16_384);
  });

  it('null when the page size or a counter is missing or not a number', async () => {
    const text = await fixture('vm_stat-darwin.txt');
    expect(parseVmStat(text.replace(/\(page size of \d+ bytes\)/, ''))).toBeNull();
    for (const counter of ['Anonymous pages', 'Pages purgeable', 'Pages wired down', 'Pages occupied by compressor']) {
      const missing = text
        .split('\n')
        .filter((line) => !line.startsWith(`${counter}:`))
        .join('\n');
      expect(parseVmStat(missing), counter).toBeNull();
    }
    expect(parseVmStat(text.replace(/Pages wired down:\s+\d+\./, 'Pages wired down: many.'))).toBeNull();
    expect(parseVmStat('')).toBeNull();
  });
});

describe('parseMeminfo (Linux)', () => {
  it('MemTotal − MemAvailable, kB → bytes', async () => {
    expect(parseMeminfo(await fixture('meminfo-linux.txt'))).toBe(MEMINFO_IN_USE);
  });

  it('null without MemAvailable (kernels before 3.14), without MemTotal, or when available exceeds total', async () => {
    const text = await fixture('meminfo-linux.txt');
    expect(parseMeminfo(text.replace(/^MemAvailable:.*$/m, ''))).toBeNull();
    expect(parseMeminfo(text.replace(/^MemTotal:.*$/m, ''))).toBeNull();
    expect(parseMeminfo('MemTotal: 100 kB\nMemAvailable: 200 kB\n')).toBeNull();
    expect(parseMeminfo('')).toBeNull();
  });
});

describe('createMemoryInUseReader', () => {
  it('macOS parses vm_stat; Linux parses /proc/meminfo; Windows is null (total − free)', async () => {
    const vmStat = await fixture('vm_stat-darwin.txt');
    const meminfo = await fixture('meminfo-linux.txt');
    const sources = { vmStat: async () => vmStat, meminfo: async () => meminfo };
    expect(await createMemoryInUseReader({ platform: 'darwin', ...sources })()).toBe(VM_STAT_IN_USE);
    expect(await createMemoryInUseReader({ platform: 'linux', ...sources })()).toBe(MEMINFO_IN_USE);
    expect(await createMemoryInUseReader({ platform: 'win32', ...sources })()).toBeNull();
  });

  it('a failed read is null, never a rejection: vm_stat missing, /proc unreadable, unexpected output', async () => {
    const fail = async (): Promise<string> => {
      throw new Error('ENOENT');
    };
    expect(await createMemoryInUseReader({ platform: 'darwin', vmStat: fail })()).toBeNull();
    expect(await createMemoryInUseReader({ platform: 'linux', meminfo: fail })()).toBeNull();
    expect(await createMemoryInUseReader({ platform: 'darwin', vmStat: async () => 'vm_stat: unexpected' })()).toBeNull();
  });

  it.runIf(process.platform === 'darwin')('on this Mac: runs /usr/bin/vm_stat (argv, no shell) and reads a value within the machine', async () => {
    const used = await createMemoryInUseReader()();
    expect(used).not.toBeNull();
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(os.totalmem());
  });

  it.runIf(process.platform === 'linux')('on this Linux machine: reads /proc/meminfo within the machine', async () => {
    const used = await createMemoryInUseReader()();
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(os.totalmem());
  });
});
