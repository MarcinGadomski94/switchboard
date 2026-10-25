/**
 * D131 · an avatar's initials and colour (pure; unit-tested).
 */

/** A stable colour for a name (agents without one of their own). */
export function colorFor(name: string): string {
  const palette = ['#4a55d0', '#c9741f', '#1f7f86', '#1d7a45', '#6a3fc8', '#c0739a', '#4f9d84', '#b4609a', '#5f5e59'];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] as string;
}

/** Up to two initials of a name (`Mobile banner` → `MB`). */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] as string;
  if (words.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ''}${(words[1] as string)[0] ?? ''}`.toUpperCase();
}
