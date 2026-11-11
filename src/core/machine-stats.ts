/**
 * D162 (`docs/peers.md` → *A paired computer's CPU and RAM*): a computer's CPU and
 * memory as it reports them to the computers it is paired with, so the status
 * popover shows them for every computer, not only this one.
 */

/** A computer's CPU and memory reading, as it sends it on its peer stream (`machineStats`). */
export interface MachineStats {
  /** Machine-wide CPU use, 0–100 (%), over the last ~10 s. */
  readonly cpu: number;
  /** Memory in use (bytes; the same reading as its own footer, D17). */
  readonly ramUsed: number;
  /** Total memory (bytes). */
  readonly ramTotal: number;
  /** When it was read (ISO). */
  readonly at: string;
}

/**
 * A received {@link MachineStats} (a paired computer's), checked field by field:
 * finite numbers, `cpu` 0–100, memory not negative and `ramUsed` at most 5 % over
 * `ramTotal` (rounding on the sender), `at` a parseable time; `null` when it is not one.
 */
export function readMachineStats(value: unknown): MachineStats | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const num = (key: string): number | null => (typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : null);
  const cpu = num('cpu');
  const ramUsed = num('ramUsed');
  const ramTotal = num('ramTotal');
  const at = record['at'];
  if (cpu === null || ramUsed === null || ramTotal === null || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  if (cpu < 0 || cpu > 100 || ramUsed < 0 || ramTotal <= 0 || ramUsed > ramTotal * 1.05) return null;
  return { cpu, ramUsed: Math.min(ramUsed, ramTotal), ramTotal, at };
}

/** How long one CPU reading for the peer streams is reused (several paired computers share it). */
export const MACHINE_STATS_REUSE_MS = 5_000;
