import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVICE_LOG_MAX_BYTES, ServiceLogRotation, rotateLog, rotatedLogFile, serviceLogFile, writesTo } from '../../src/server/service-log.ts';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sb-service-log-'));
  file = path.join(dir, 'service.log');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** `count` numbered lines of 20 bytes each: `line 000000 ......\n`. */
function lines(from: number, count: number): string {
  let text = '';
  for (let i = from; i < from + count; i += 1) text += `line ${String(i).padStart(6, '0')} .......\n`;
  return text;
}

describe('service log paths', () => {
  it('is <dataDir>/logs/service.log, rotated to service.log.1; the cap is 50 MiB', () => {
    expect(serviceLogFile('/data')).toBe(path.join('/data', 'logs', 'service.log'));
    expect(rotatedLogFile('/data/logs/service.log')).toBe('/data/logs/service.log.1');
    expect(SERVICE_LOG_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('rotateLog', () => {
  it('leaves a file at or under the limit alone, and a missing file too', async () => {
    await writeFile(file, lines(0, 10)); // 200 bytes
    expect(await rotateLog(file, 200)).toEqual({ rotated: false, sizeBefore: 200, kept: 0 });
    expect(await readFile(file, 'utf8')).toBe(lines(0, 10));
    await expect(stat(rotatedLogFile(file))).rejects.toThrow();
    expect(await rotateLog(path.join(dir, 'missing.log'), 200)).toEqual({ rotated: false, sizeBefore: 0, kept: 0 });
  });

  it('over the limit: the whole file goes to .1 (replacing the old one) and the file is emptied', async () => {
    await writeFile(rotatedLogFile(file), 'older copy\n');
    await writeFile(file, lines(0, 12)); // 240 bytes
    const result = await rotateLog(file, 239);
    expect(result.rotated).toBe(true);
    expect(result.sizeBefore).toBe(240);
    // The newest 239 bytes start mid-line, so the copy starts at the next full line.
    expect(await readFile(rotatedLogFile(file), 'utf8')).toBe(lines(1, 11));
    expect(result.kept).toBe(220);
    expect((await stat(file)).size).toBe(0);
    await expect(stat(`${rotatedLogFile(file)}.tmp`)).rejects.toThrow();
  });

  it('an oversized file (start-up trim) keeps only its newest part, from a full line', async () => {
    await writeFile(file, lines(0, 5000)); // 100 000 bytes
    const result = await rotateLog(file, 1000);
    expect(result).toEqual({ rotated: true, sizeBefore: 100_000, kept: 1000 });
    expect(await readFile(rotatedLogFile(file), 'utf8')).toBe(lines(4950, 50));
    expect((await stat(file)).size).toBe(0);
  });

  it('never loses the writer: an O_APPEND writer keeps writing to the start of the emptied file', async () => {
    const fd = openSync(file, 'a'); // launchd opens StandardOutPath with O_APPEND the same way
    try {
      writeSync(fd, lines(0, 100));
      await rotateLog(file, 1000);
      writeSync(fd, lines(100, 3));
      // No hole of NULs where the old content was: the next line is the file's first byte.
      expect(await readFile(file, 'utf8')).toBe(lines(100, 3));
      expect(await readFile(rotatedLogFile(file), 'utf8')).toBe(lines(50, 50));
      // And it rotates again on the next check.
      writeSync(fd, lines(103, 100));
      await rotateLog(file, 1000);
      writeSync(fd, lines(203, 1));
      expect(await readFile(file, 'utf8')).toBe(lines(203, 1));
      expect(await readFile(rotatedLogFile(file), 'utf8')).toBe(lines(153, 50));
    } finally {
      closeSync(fd);
    }
  });
});

describe('writesTo', () => {
  it('is true only for a file this process writes its output to', async () => {
    await writeFile(file, '');
    const fd = openSync(file, 'a');
    const other = path.join(dir, 'other.log');
    await writeFile(other, '');
    try {
      expect(await writesTo(file, [fd])).toBe(true);
      expect(await writesTo(other, [fd])).toBe(false);
      expect(await writesTo(path.join(dir, 'missing.log'), [fd])).toBe(false);
      expect(await writesTo(dir, [fd])).toBe(false);
    } finally {
      closeSync(fd);
    }
  });
});

describe('ServiceLogRotation', () => {
  it('trims an oversized log at start, keeping the newest half of the cap', async () => {
    await writeFile(file, lines(0, 5000)); // 100 000 bytes
    const rotated: number[] = [];
    const rotation = new ServiceLogRotation({ file, maxBytes: 2000, isOwnOutput: async () => true, onRotate: (result) => rotated.push(result.sizeBefore) });
    await rotation.start();
    await rotation.stop();
    expect(rotated).toEqual([100_000]);
    expect(await readFile(rotatedLogFile(file), 'utf8')).toBe(lines(4950, 50));
    expect((await stat(file)).size).toBe(0);
  });

  it('checks again every interval while it runs', async () => {
    const fd = openSync(file, 'a');
    const rotation = new ServiceLogRotation({ file, maxBytes: 2000, intervalMs: 20, isOwnOutput: async () => true });
    try {
      await rotation.start();
      writeSync(fd, lines(0, 100)); // 2000 bytes > 1000
      const deadline = Date.now() + 5000;
      while ((await stat(file)).size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await stat(file)).size).toBe(0);
      expect(await readFile(rotatedLogFile(file), 'utf8')).toBe(lines(50, 50));
    } finally {
      await rotation.stop();
      closeSync(fd);
    }
  });

  it('leaves a log alone that this process does not write (npm start in a terminal, Linux, Windows)', async () => {
    await writeFile(file, lines(0, 5000));
    const rotation = new ServiceLogRotation({ file, maxBytes: 2000, isOwnOutput: async () => false });
    await rotation.start();
    await rotation.stop();
    expect((await stat(file)).size).toBe(100_000);
    // The default check: this test process's stdout / stderr are not that file.
    const real = new ServiceLogRotation({ file, maxBytes: 2000 });
    await real.start();
    await real.stop();
    expect((await stat(file)).size).toBe(100_000);
  });
});
