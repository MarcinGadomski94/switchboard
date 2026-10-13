import path from 'node:path';
import type { InboxItem } from '../../core/api.ts';
import type { SearchAnswer } from '../../core/search.ts';
import { ACCESS_MCP_MARKER } from '../../core/team-access.ts';
import { AGENT_MCP_MARKER } from '../../core/todos.ts';
import type { AgentMcpExtraServer, AgentMcpLaunch } from '../todos/agent-mcp.ts';
import type { AccessEnv, AccessServerSpec } from './access/service.ts';

/**
 * D100 · the seams Team plugs into the rest of Switchboard (`docs/team-removal.md`
 * lists every call site). Each is a no-op until a {@link TeamService} registers
 * itself for the store (`registerTeamHooks`), and answers "nothing" while Team is
 * off or `team.db` is unavailable, so the rest of Switchboard behaves exactly as
 * without Team. Keyed by the main `Store` object (one app, one store).
 */
export interface TeamHooks {
  /** The member's charter instruction for a session of this machine (`null` = not a member, or Team off). */
  charterFor(sessionId: string): Promise<string | null>;
  /** The role name of a session (this machine's id or `r~<machine>~<id>`), `null` when it is not a member's. */
  roleOf(sessionId: string): string | null;
  /** Settings → Experimental → Team was switched (`PUT /api/settings`). */
  switchChanged(): Promise<void>;
  /** D100 follow-up 2026-10-14: the developer chose a model / effort for a session (its header's picker): a member's saved choice follows. */
  sessionModelChanged?(sessionId: string, model: string | null, effort: string | null): Promise<void>;
  /** D100-T2: the MCP servers of a member's ready access (no value in them). */
  accessServers?(sessionId: string): readonly AccessServerSpec[];
  /** D100-T2: the environment a member's spawn gets (its API keys) and the values to mask. */
  accessEnv?(sessionId: string): Promise<AccessEnv>;
  /** D100-T2: the masking pass of a session's recorded output (identity for a non-member). */
  mask?(sessionId: string): (text: string) => string;
}

/** The access launcher (`src/hook/sb-access-mcp.ts`), next to the `switchboard` helper. */
export const ACCESS_MCP_SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'hook', 'sb-access-mcp.ts');

const registry = new WeakMap<object, TeamHooks>();

/** Registers Team's hooks for `store`; returns the unregister function. */
export function registerTeamHooks(store: object, hooks: TeamHooks): () => void {
  registry.set(store, hooks);
  return () => {
    if (registry.get(store) === hooks) registry.delete(store);
  };
}

/** D64 seam: the standing instruction `base` with the session's charter appended (unchanged for a non-member or with Team off). */
export async function withTeamCharter(store: object, sessionId: string, base: string | null): Promise<string | null> {
  const charter = await registry.get(store)?.charterFor(sessionId).catch(() => null);
  if (!charter) return base;
  return base ? `${base}\n\n${charter}` : charter;
}

/** Inbox seam: member sessions' items are labelled with the role name (`teamRole`, and the role as `sourceTitle`). */
export function labelInboxItems(store: object, items: InboxItem[]): InboxItem[] {
  const hooks = registry.get(store);
  if (!hooks) return items;
  return items.map((item) => {
    const role = item.sessionId ? hooks.roleOf(item.sessionId) : null;
    return role ? { ...item, sourceTitle: role, teamRole: role } : item;
  });
}

/** Search seam (D97): a member session's results are labelled with the role name. */
export function labelSearchAnswer(store: object, answer: SearchAnswer): SearchAnswer {
  const hooks = registry.get(store);
  if (!hooks) return answer;
  return {
    ...answer,
    groups: answer.groups.map((group) => ({
      ...group,
      results: group.results.map((result) => {
        const sessionId = 'sessionId' in result.target ? result.target.sessionId : null;
        const role = sessionId ? hooks.roleOf(sessionId) : null;
        return role ? { ...result, sessionTitle: role, teamRole: role } : result;
      }),
    })),
  };
}

/**
 * D31 seam (D100 follow-up 2026-10-14): `PUT /api/sessions/{id}/model` changed a
 * session's model / effort by the developer's choice; a member's saved model follows
 * (and syncs). Never throws: a failure here does not undo the change.
 */
export async function teamSessionModelChanged(store: object, sessionId: string, model: string | null, effort: string | null): Promise<void> {
  await registry.get(store)?.sessionModelChanged?.(sessionId, model, effort).catch(() => undefined);
}

/** Settings seam: the Team switch changed. */
export async function teamSwitchChanged(store: object): Promise<void> {
  await registry.get(store)?.switchChanged();
}

/**
 * D68 seam (D100-T2): a member's access MCP servers are added to its `switchboard`
 * launch (the same Node, port and agent token: the launcher fetches the server and
 * its values from Switchboard when it starts). Unchanged for every other session.
 */
export function withTeamAccessServers(store: object, launch: AgentMcpLaunch, sessionId: string): AgentMcpLaunch {
  const specs = registry.get(store)?.accessServers?.(sessionId) ?? [];
  if (specs.length === 0) return launch;
  const at = launch.args.indexOf(AGENT_MCP_MARKER);
  const port = at >= 0 ? launch.args[at + 1] : undefined;
  const extra: AgentMcpExtraServer[] = [];
  for (const spec of specs) {
    if (spec.kind === 'http') extra.push({ name: spec.name, transport: 'http', url: spec.url, headers: spec.headers });
    else if (port) extra.push({ name: spec.name, transport: 'stdio', command: launch.command, args: [ACCESS_MCP_SCRIPT, ACCESS_MCP_MARKER, port, sessionId, spec.accessId], env: { ...launch.env } });
  }
  return { ...launch, extraServers: extra };
}

/** Supervisor seam (D100-T2): a member's API keys for its spawn's environment and the masking pass of its output (nothing / identity otherwise). */
export async function teamAccessEnv(store: object, sessionId: string): Promise<{ readonly env: Readonly<Record<string, string>>; readonly mask: (text: string) => string }> {
  const hooks = registry.get(store);
  const identity = (text: string): string => text;
  if (!hooks?.accessEnv) return { env: {}, mask: identity };
  const access = await hooks.accessEnv(sessionId).catch(() => ({ env: {}, secrets: [] }));
  return { env: access.env, mask: hooks.mask?.(sessionId) ?? identity };
}
