/**
 * A computer's name for a compact badge (`ComputerTag short`): the name as the developer knows it,
 * without a network domain ("Marcins-PC.local" → "Marcins-PC"). Hyphens and spaces stay: cutting
 * at the first one turned "Marcins-PC" and "Marcins-MacBook-Pro" into the same "Marcins". The
 * badge's CSS ellipsis and its title (the full name) handle a name that is still too long.
 */
export function computerShortName(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.indexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return base === '' ? trimmed : base;
}
