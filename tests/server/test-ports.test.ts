import { describe, expect, it } from 'vitest';
import { DEFAULT_TEST_PORT_RANGE, TEST_PORTS, WORKER_TEST_PORTS, freeTestPorts, testPortsFrom, testWorkerIndex, workerSlice } from '../helpers/net.ts';

/**
 * The test port allocator (CONTRIBUTING.md → *Ports*): a wide default range, one
 * slice per parallel Vitest worker, so two test files never pick the same port.
 */
describe('test ports', () => {
  it('the default range is 24000–27999, clear of the app (13001–13003) and of the ephemeral ports', () => {
    expect(DEFAULT_TEST_PORT_RANGE).toBe('24000-27999');
    const ports = testPortsFrom(undefined);
    expect(ports[0]).toBe(24000);
    expect(ports.at(-1)).toBe(27999);
    expect(ports).toHaveLength(4000);
    expect(testPortsFrom('  ')).toEqual(ports);
    expect(testPortsFrom('4900-4909')).toEqual([4900, 4901, 4902, 4903, 4904, 4905, 4906, 4907, 4908, 4909]);
    expect(testPortsFrom('4901, 4903')).toEqual([4901, 4903]);
    expect(() => testPortsFrom('13001')).toThrow(/without 13001/);
    expect(() => testPortsFrom('80-90')).toThrow();
  });

  it('each worker gets its own slice; workers beyond the slice count share round-robin; no worker = the whole range', () => {
    const ports = testPortsFrom(undefined);
    const slices = Array.from({ length: 64 }, (_, i) => workerSlice(ports, i + 1));
    expect(new Set(slices.flat()).size).toBe(slices.flat().length);
    for (const slice of slices) expect(slice).toHaveLength(62);
    expect(workerSlice(ports, 1)[0]).toBe(24000);
    expect(workerSlice(ports, 65)).toEqual(workerSlice(ports, 1));
    expect(workerSlice(ports, null)).toBe(ports);
    // A lane's narrow range is one slice every worker shares (as before); 100 ports are four slices of 25.
    const lane = testPortsFrom('4900-4909');
    expect(workerSlice(lane, 3)).toEqual(lane);
    expect(workerSlice(testPortsFrom('4900-4999'), 2)).toEqual(testPortsFrom('4925-4949'));
  });

  it('the worker index comes from VITEST_POOL_ID, else Playwright TEST_PARALLEL_INDEX + 1', () => {
    expect(testWorkerIndex({ VITEST_POOL_ID: '3' })).toBe(3);
    expect(testWorkerIndex({ TEST_PARALLEL_INDEX: '0' })).toBe(1);
    expect(testWorkerIndex({})).toBeNull();
    expect(testWorkerIndex({ VITEST_POOL_ID: 'x' })).toBeNull();
  });

  it("this file's free ports are in its worker's slice, and the next list starts after the port the last one offered first", async () => {
    expect(TEST_PORTS).toEqual(expect.arrayContaining([...WORKER_TEST_PORTS]));
    const first = await freeTestPorts();
    expect(first.length).toBeGreaterThan(0);
    for (const port of first) expect(WORKER_TEST_PORTS).toContain(port);
    const second = await freeTestPorts();
    expect(second[0]).not.toBe(first[0]);
    expect(second.at(-1)).toBe(first[0]);
  });
});
