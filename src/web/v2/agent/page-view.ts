/**
 * SPIKE · side panel Files: the words for an HTML file shown as a page
 * (`src/core/agent-files.ts` → "A page").
 */
import { AGENT_PAGE_BYTES, type AgentPageInfo, type AgentPageLeftWhy } from '../../../core/agent-files.ts';

/** Why something a page points at was not loaded. */
export const PAGE_LEFT_WORDS: Readonly<Record<AgentPageLeftWhy, string>> = {
  remote: 'another address, nothing is fetched',
  'site-root': 'starts at the site’s root, which one file does not tell',
  missing: 'no such file, or it cannot be read',
  outside: 'not in the page’s own folders',
  kind: 'not a stylesheet, a script or a picture',
  secret: 'looks like it holds secrets',
  'too-large': 'too much to put into the page',
};

/**
 * What the button that runs a page's scripts tells before it is pressed. With
 * scripts the page stays closed off from this app and still fetches nothing, but no
 * browser rule keeps a script from opening a connection of its own (WebRTC).
 */
export const PAGE_SCRIPTS_HINT =
  'A page’s scripts are off until you run them. With them on, the page still cannot reach this app or load anything from another address, but a script could send what the page holds (its text and the files loaded with it) to another computer: a browser cannot stop that.';

/** How an HTML file opens: as its page, unless it was opened at a line (the source is what a line number means) or it is too big to show as a page. */
export function pageOpensAs(line: number | null, size: number): 'rendered' | 'source' {
  return line === null && size <= AGENT_PAGE_BYTES ? 'rendered' : 'source';
}

/** The last part of an address, short enough for one line. */
export function refName(ref: string): string {
  const bare = ref.replace(/[?#][\s\S]*$/, '');
  const name = bare.split(/[\\/]/).filter(Boolean).pop() ?? ref;
  return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

/** What to say above a page that is shown without something it points at. */
export interface PageLeftNote {
  /** One line: the first thing left out with why, and how many more. */
  readonly text: string;
  /** Everything left out that is known, one line each. */
  readonly lines: readonly string[];
}

/** The note for a page; `null` when nothing it points at was left out. */
export function pageLeftNote(info: AgentPageInfo): PageLeftNote | null {
  const total = info.left.length + info.leftMore;
  const first = info.left[0];
  if (total === 0 || !first) return null;
  const lines = info.left.map((item) => `${item.ref}: ${PAGE_LEFT_WORDS[item.why]}`);
  if (info.leftMore > 0) lines.push(`… and ${info.leftMore} more`);
  return { text: `Not loaded: ${refName(first.ref)} (${PAGE_LEFT_WORDS[first.why]})${total > 1 ? ` and ${total - 1} more` : ''}`, lines };
}

/** The line under a page: how many of its own files came with it, whether its scripts run (when it has any), and its size. */
export function pageFootText(info: AgentPageInfo, scripts: boolean, size: string): string {
  const loaded = info.loaded === 0 ? '' : `${info.loaded} file${info.loaded === 1 ? '' : 's'} loaded with it`;
  const running = info.scripted ? (scripts ? 'its scripts run' : 'its scripts are off') : '';
  return [loaded, running, size].filter((part) => part !== '').join(' · ');
}

/** What the button that turns a page's scripts on or off says. */
export function pageScriptsAction(running: boolean): string {
  return running ? 'Stop its scripts' : 'Run its scripts';
}
