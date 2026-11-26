import { withoutGhTokens } from '../../core/github-binding.ts';

/**
 * D190: the `gh` environment of a call Switchboard makes for an agent (PR status, CI, merge, plan
 * PRs, Import issues): the GitHub binding of **that agent's** profile, named explicitly by the
 * caller (`owner`: the agent's session id). No owner (a call for no agent, e.g. a branching
 * preflight before the agent exists) or an unbound profile: the computer's own gh. Never guessed
 * from a folder. The app sets the resolver once ({@link useGhEnv}); the gh runners read it through
 * {@link ghEnvFor} unless they were given their own.
 */
let resolver: ((sessionId: string) => Promise<Record<string, string>>) | null = null;

/** The agent a gh call is made for: its session id; `null` / absent = none (the computer's gh). */
export type GhOwner = string | null | undefined;

/** Sets (or clears, `null`) the resolver; answers the previous one. */
export function useGhEnv(next: ((sessionId: string) => Promise<Record<string, string>>) | null): ((sessionId: string) => Promise<Record<string, string>>) | null {
  const previous = resolver;
  resolver = next;
  return previous;
}

/** The extra `gh` environment of a call made for agent `owner` (never throws; `{}` without one). */
export async function ghEnvFor(owner: GhOwner, own?: ((sessionId: string) => Promise<Record<string, string>>) | null): Promise<Record<string, string>> {
  if (!owner) return {};
  const resolve = own ?? resolver;
  if (!resolve) return {};
  try {
    return await resolve(owner);
  } catch {
    return {};
  }
}

/**
 * The environment of a gh call: `base`, then the binding (`bound`), then `extra`. With a binding
 * (`GH_CONFIG_DIR`), gh's token / host variables are removed, so the profile's folder decides
 * (a `GH_TOKEN` in Switchboard's own environment would win over it).
 */
export function ghCallEnv(base: NodeJS.ProcessEnv, bound: Record<string, string>, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...bound, ...extra };
  return bound['GH_CONFIG_DIR'] ? withoutGhTokens(env) : env;
}
