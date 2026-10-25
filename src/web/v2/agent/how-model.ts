/**
 * D131 · lane S · "How it works" in plain words: **Smart** / **Fast** for the
 * model (the exact names stay under Advanced) and **Thinking depth** for the
 * effort. Pure; the side panel sends the choice through the classic model route
 * (`PUT /api/sessions/{id}/model`, D31).
 *
 * ASSUMED (lane S): Smart = an Opus model (else the CLI's default), Fast = a
 * Sonnet model (else Haiku). A model that is neither shows as Smart with its exact
 * name in Advanced.
 */
import type { SessionModel, SessionModelOption } from '../../../core/api.ts';
import { THINKING_DEPTH } from '../glossary.ts';

/** The speed choice. */
export type Speed = 'smart' | 'fast';

function find(options: readonly SessionModelOption[], pattern: RegExp): SessionModelOption | null {
  return options.find((option) => pattern.test(option.value) || pattern.test(option.label)) ?? null;
}

/** The model values behind Smart and Fast (`null` when the agent offers no such model). */
export function speedModels(available: readonly SessionModelOption[] | null): { readonly smart: string | null; readonly fast: string | null } {
  if (!available || available.length === 0) return { smart: null, fast: null };
  const smart = find(available, /opus/i) ?? find(available, /^default$/i) ?? available[0] ?? null;
  const fast = find(available, /sonnet/i) ?? find(available, /haiku/i);
  return { smart: smart?.value ?? null, fast: fast && fast.value !== smart?.value ? fast.value : null };
}

/** Which speed the agent's model is (`smart` for anything that is not the Fast one). */
export function speedOf(model: SessionModel | null | undefined): Speed {
  if (!model) return 'smart';
  const current = model.current ?? 'default';
  const { fast } = speedModels(model.available);
  if (fast !== null && current === fast) return 'fast';
  if (fast === null && /sonnet|haiku/i.test(current)) return 'fast';
  return 'smart';
}

/** The exact model's name (Advanced): its label, else its value, else "Default". */
export function exactModel(model: SessionModel | null | undefined): string {
  if (!model) return 'Default';
  const current = model.current;
  if (current === null) return 'Default';
  return model.available?.find((option) => option.value === current)?.label ?? current;
}

/** The thinking-depth choices of the agent's model, in plain words (`null` = the CLI's default). */
export function depthOptions(model: SessionModel | null | undefined): Array<{ readonly value: string | null; readonly label: string }> {
  if (!model?.available) return [];
  const current = model.current ?? 'default';
  const option = model.available.find((o) => o.value === current) ?? null;
  const levels = option?.efforts ?? [];
  if (levels.length === 0) return [];
  return [{ value: null, label: 'Default' }, ...levels.map((level) => ({ value: level, label: THINKING_DEPTH[level] ?? level }))];
}

/** "Smart · Deep" (the header's engine tag and the group's summary). */
export function howSummary(model: SessionModel | null | undefined): string {
  const speed = speedOf(model) === 'fast' ? 'Fast' : 'Smart';
  const effort = model?.effort ? THINKING_DEPTH[model.effort] ?? model.effort : null;
  return effort ? `${speed} · ${effort}` : speed;
}
