/**
 * D190: the `gh` environment of a call Switchboard makes in a folder (PR status, CI, merge, plan PRs):
 * the GitHub binding of the profile working there ({@link GitHubBindings.ghEnvForPath}). The app sets
 * the resolver once ({@link useGhEnv}); the gh runners (worktree manager, CI, plans) read it through
 * {@link ghEnvFor} unless they were given their own. None set, or a failure: no extra environment
 * (the computer's own gh).
 */
let resolver: ((cwd: string) => Promise<Record<string, string>>) | null = null;

/** Sets (or clears, `null`) the resolver; answers the previous one. */
export function useGhEnv(next: ((cwd: string) => Promise<Record<string, string>>) | null): ((cwd: string) => Promise<Record<string, string>>) | null {
  const previous = resolver;
  resolver = next;
  return previous;
}

/** The extra `gh` environment of a call in folder `cwd` (never throws). */
export async function ghEnvFor(cwd: string): Promise<Record<string, string>> {
  if (!resolver) return {};
  try {
    return await resolver(cwd);
  } catch {
    return {};
  }
}
