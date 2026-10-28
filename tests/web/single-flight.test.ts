import { describe, expect, it } from 'vitest';
import { SingleFlight } from '../../src/web/api/single-flight.ts';

/** A load the test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void; fail: () => void } {
  let open = (): void => undefined;
  let fail = (): void => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = () => resolve();
    fail = () => reject(new Error('load failed'));
  });
  return { promise, open, fail };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('SingleFlight (D144: a slow load is never dropped for a newer one)', () => {
  it('runs at once; asks while one is on its way fold into one more run after it', async () => {
    const gates: Array<ReturnType<typeof gate>> = [];
    const flight = new SingleFlight(() => {
      const next = gate();
      gates.push(next);
      return next.promise;
    });
    flight.run();
    expect(gates).toHaveLength(1);
    expect(flight.running).toBe(true);
    // Ten reloads while the first is slow: none starts, none cancels it.
    for (let i = 0; i < 10; i++) flight.run();
    expect(gates).toHaveLength(1);
    gates[0]?.open();
    await tick();
    // Exactly one trailing run.
    expect(gates).toHaveLength(2);
    gates[1]?.open();
    await tick();
    expect(gates).toHaveLength(2);
    expect(flight.running).toBe(false);
  });

  it('a failed load still lets the next ask run; close() stops further runs', async () => {
    const gates: Array<ReturnType<typeof gate>> = [];
    const flight = new SingleFlight(() => {
      const next = gate();
      gates.push(next);
      return next.promise;
    });
    flight.run();
    flight.run();
    gates[0]?.fail();
    await tick();
    expect(gates).toHaveLength(2);
    flight.close();
    flight.run();
    gates[1]?.open();
    await tick();
    expect(gates).toHaveLength(2);
  });

  it('a load that throws synchronously does not wedge it', async () => {
    let calls = 0;
    const flight = new SingleFlight(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return Promise.resolve();
    });
    flight.run();
    await tick();
    flight.run();
    await tick();
    expect(calls).toBe(2);
  });
});
