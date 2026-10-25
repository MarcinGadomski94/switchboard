/**
 * D131 · lane X · **Smart / Fast**: the one mapping from the v2 speed words to a
 * model, used by Home's start box, the + New sheet and the agent's side panel
 * (`docs/v2.md` → *Shared modules*). Pure (no DOM).
 *
 * Smart = an Opus model, Fast = a Sonnet model (else a Haiku one, else any model
 * that names itself fast). With no list of the computer's models, Claude Code's
 * aliases (`opus` / `sonnet`) are sent: the server takes any model name then.
 * Another engine without a matching model gets `null` (its own default), so a
 * start is never refused for a name its CLI does not offer.
 */

/** The speed choice. */
export type Speed = 'smart' | 'fast';

/** Claude Code's alias for each speed (`--model opus` / `--model sonnet`). */
export const SPEED_ALIAS: Readonly<Record<Speed, string>> = { smart: 'opus', fast: 'sonnet' };

/** A model a computer offers (`GET /api/models`, an agent's `model.available`). */
export interface SpeedOption {
  readonly value: string;
  readonly label?: string;
}

const PATTERNS: Readonly<Record<Speed, readonly RegExp[]>> = {
  smart: [/opus/i],
  fast: [/sonnet/i, /haiku/i, /(^|[-_. ])mini\b|fast|flash/i],
};

function named(options: readonly SpeedOption[], pattern: RegExp): SpeedOption | null {
  return options.find((option) => option.value !== 'default' && (pattern.test(option.value) || pattern.test(option.label ?? ''))) ?? null;
}

/**
 * The model a speed means (`null` = the engine's default): the alias itself when
 * offered, else the first offered model named after it. `provider` is the agent's
 * engine (`null` = Claude Code).
 */
export function speedModel(speed: Speed, options: readonly SpeedOption[] | null, provider: string | null = null): string | null {
  const claude = (provider ?? 'claude') === 'claude';
  if (!options || options.length === 0) return claude ? SPEED_ALIAS[speed] : null;
  const alias = SPEED_ALIAS[speed];
  if (options.some((option) => option.value === alias)) return alias;
  for (const pattern of PATTERNS[speed]) {
    const found = named(options, pattern);
    if (found) return found.value;
  }
  return null;
}

/** Both speeds' models; Fast is `null` when it would be the same model as Smart. */
export function speedModels(options: readonly SpeedOption[] | null, provider: string | null = null): { readonly smart: string | null; readonly fast: string | null } {
  const smart = speedModel('smart', options, provider);
  const fast = speedModel('fast', options, provider);
  return { smart, fast: fast !== null && fast !== smart ? fast : null };
}

/** Which speed a model is (`smart` for anything that is not a Fast model). */
export function speedOfModel(current: string | null | undefined, options: readonly SpeedOption[] | null): Speed {
  const value = current ?? 'default';
  const { fast } = speedModels(options);
  if (fast !== null && value === fast) return 'fast';
  return PATTERNS.fast.some((pattern) => pattern.test(value)) ? 'fast' : 'smart';
}
