/**
 * D161 · a pinned project (plan) in the shared sidebar layout (D54 / D71), next to D100's
 * pinned crews (`crew-pins.ts`, `docs/sidebar.md` → *Pinned projects (D161)*).
 *
 * A project is pinned by putting `plan~<plan id>` into the layout's `pinned` list, so it is
 * stored, ordered and synced like a pinned agent (no migration). The plan id is the one this
 * machine knows it by: its own plan's id, or a paired machine's `r~<machine>~<id>`. Unlike a
 * team, a plan lives on one machine, so on the D71 wire it travels as
 * `plan~<origin machine>:<id>` (like a session's `<machine>:<id>`) and each machine reads it
 * back as its own id or a remote one ({@link planPinKey}, {@link planPinOfKey}). Every view that
 * looks pinned ids up as sessions finds no session for it (hidden, like an unknown id).
 */
import { isMachineId, parseRemoteId, remoteId } from './peers.ts';

/** The prefix of a project pin id. */
export const PLAN_PIN_PREFIX = 'plan~';

/** A plan's own id as a pin may carry it (a UUID, …): letters, digits, `-` and `_`. */
const PLAN_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The pin id of a plan id as this machine knows it (its own, or `r~<machine>~<id>`). */
export function planPinId(planId: string): string {
  return `${PLAN_PIN_PREFIX}${planId}`;
}

/** The plan id (as this machine knows it) of a project pin id; `null` for anything else (a session, a crew pin, a malformed one). */
export function planOfPin(id: unknown): string | null {
  if (typeof id !== 'string' || !id.startsWith(PLAN_PIN_PREFIX)) return null;
  const planId = id.slice(PLAN_PIN_PREFIX.length);
  if (PLAN_ID.test(planId)) return planId;
  const remote = parseRemoteId(planId);
  return remote && PLAN_ID.test(remote.id) ? planId : null;
}

/** `true` for a well-formed project pin id. */
export function isPlanPinId(id: unknown): boolean {
  return planOfPin(id) !== null;
}

/** D71: the machine-independent key of a project pin as this machine (`selfId`) knows it: `plan~<origin machine>:<id>`; `null` when malformed. */
export function planPinKey(pinId: string, selfId: string): string | null {
  const planId = planOfPin(pinId);
  if (planId === null) return null;
  const remote = parseRemoteId(planId);
  return remote ? `${PLAN_PIN_PREFIX}${remote.machineId}:${remote.id}` : `${PLAN_PIN_PREFIX}${selfId}:${planId}`;
}

/** `true` when a D71 key is a project pin's (`plan~…`). */
export function isPlanPinKey(key: string): boolean {
  return key.startsWith(PLAN_PIN_PREFIX);
}

/** D71: the project pin id this machine (`selfId`) knows a key by; `null` for a malformed key (never a chain of machines). */
export function planPinOfKey(key: string, selfId: string): string | null {
  if (!isPlanPinKey(key)) return null;
  const rest = key.slice(PLAN_PIN_PREFIX.length);
  const at = rest.indexOf(':');
  if (at <= 0 || at === rest.length - 1) return null;
  const machine = rest.slice(0, at);
  const id = rest.slice(at + 1);
  if (!isMachineId(machine) || !PLAN_ID.test(id)) return null;
  return planPinId(machine === selfId ? id : remoteId(machine, id));
}
