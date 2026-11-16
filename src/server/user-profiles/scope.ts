import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ProfileScope, scopeSees } from '../../core/user-profiles.ts';
import type { SidebarLayout } from '../../core/sidebar-layout.ts';
import type { HubMessage } from '../hub/bus.ts';
import { bearerOf, isAgentPath, isHookPath } from '../security.ts';
import { runInProfileScope } from './context.ts';
import type { UserProfileService } from './service.ts';

/**
 * D165 · the server side of "strictly only mine" (`docs/profiles.md` → *Scope*):
 *
 * 1. **The request's scope**, right after the security guard: a paired phone's profile; the agent's
 *    own session's profile on `/agent/*`; everything (`'*'`) for the hook script and for the peer API's
 *    own requests (marked with a per-process secret, never the bare peer header a browser could add);
 *    else the browser's signed profile cookie (Default while it has no password; none otherwise).
 *    It is kept for the request's async work ({@link runInProfileScope}), so a new agent the request
 *    creates takes it.
 * 2. **The id guard** (a preHandler): every route keyed by a session, chat, plan, crew member, crew,
 *    Inbox item, question batch, artifact, schedule or move answers 404 when that belongs to another
 *    profile, as if it did not exist.
 * 3. **The list filter** (`onSend`): the scoped `GET` lists keep only what the scope sees.
 * 4. **The hub filter** ({@link hubTransform}): each `/hub` client gets only its profile's events.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** D165: what this request may see (`'*'` all, a profile id, `null` none chosen yet). */
    userProfileScope: ProfileScope;
  }
}

/** The header the peer API's own injected requests carry (its value: {@link INTERNAL_SECRET}). */
export const INTERNAL_SCOPE_HEADER = 'x-switchboard-internal';
/** D165: the header a paired computer's request carries naming the profile it works in (honoured only with {@link INTERNAL_SECRET}). */
export const USER_PROFILE_HEADER = 'x-switchboard-user-profile';
/** A per-process secret: only Switchboard's own `app.inject` calls know it. */
export const INTERNAL_SECRET = randomBytes(24).toString('base64url');

function internal(request: FastifyRequest): boolean {
  const value = request.headers[INTERNAL_SCOPE_HEADER];
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(INTERNAL_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Lookups the guard and the filters need (each may say `null`: unknown, the route answers for itself). */
export interface ProfileScopeResolvers {
  /** A plan's source session. */
  readonly planSession?: (planId: string) => Promise<string | null> | string | null;
  /** A crew member's session. */
  readonly memberSession?: (memberId: string) => Promise<string | null> | string | null;
  /** The crew a crew route without an id means (the first one), or the one named; `null`: none. */
  readonly teamIdFor?: (teamId: string | null) => string | null;
  /** A crew's profile. */
  readonly teamProfile?: (teamId: string) => Promise<string | null> | string | null;
  /** An Inbox item's session (`undefined`: unknown item; `null`: an item of no session). */
  readonly inboxSession?: (itemId: string) => Promise<string | null | undefined>;
  /** A question batch's session. */
  readonly batchSession?: (batchId: string) => Promise<string | null> | string | null;
  /** An artifact's session. */
  readonly artifactSession?: (artifactId: string) => Promise<string | null> | string | null;
  /** A schedule's profile (a paired computer's: `null`). */
  readonly scheduleProfile?: (scheduleId: string) => string | null;
  /** A move's agent session. */
  readonly moveSession?: (moveId: string) => Promise<string | null> | string | null;
  /** The Switchboard session that holds a CLI conversation (`null`: none, it is not in Switchboard yet). */
  readonly sessionByClaudeId?: (claudeSessionId: string) => Promise<string | null>;
  /** A sidebar folder's profile. */
  readonly folderProfile?: (folderId: string) => string | null;
}

/** Writes that name a session in their JSON body: [route, method, field]. */
const BODY_KEYED: ReadonlyArray<readonly [string, string, string]> = [
  ['/api/sidebar/place', 'POST', 'sessionId'],
  ['/api/team/members', 'POST', 'sessionId'],
];

type Kind = 'session' | 'plan' | 'member' | 'team' | 'inbox' | 'batch' | 'artifact' | 'schedule' | 'move' | 'folder';

/** The id-keyed routes: a route prefix, the param that names the thing, and what it is. */
const KEYED: ReadonlyArray<readonly [string, string, Kind]> = [
  ['/api/sessions/:id', 'id', 'session'],
  ['/api/chats/:id', 'id', 'session'],
  ['/api/memory/sessions/:id', 'id', 'session'],
  ['/api/takeover/cleanup/:sessionId', 'sessionId', 'session'],
  ['/api/plans/:id', 'id', 'plan'],
  // D159: an agent's plan tools name any plan of this computer: only its own profile's.
  ['/agent/v1/plans/:planId', 'planId', 'plan'],
  ['/api/team/members/:memberId', 'memberId', 'member'],
  ['/api/team/teams/:teamId', 'teamId', 'team'],
  ['/api/inbox/:id', 'id', 'inbox'],
  ['/api/questions/batch/:batchId', 'batchId', 'batch'],
  ['/api/artifacts/:artifactId', 'artifactId', 'artifact'],
  ['/api/schedules/:id', 'id', 'schedule'],
  ['/api/moves/:moveId', 'moveId', 'move'],
  ['/api/sidebar/folders/:folderId', 'folderId', 'folder'],
];

/** Installs the scope hook, the id guard and the list filter on `app`. */
export function registerProfileScope(app: FastifyInstance, profiles: UserProfileService, resolvers: () => ProfileScopeResolvers): void {
  if (!app.hasRequestDecorator('userProfileScope')) app.decorateRequest('userProfileScope', null);

  app.addHook('onRequest', (request, _reply, done) => {
    scopeOf(request, profiles).then(
      (scope) => {
        request.userProfileScope = scope;
        runInProfileScope(scope, done);
      },
      (error: unknown) => done(error as Error),
    );
  });

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = request.userProfileScope;
    if (scope === '*') return undefined;
    const url = request.routeOptions.url ?? '';
    const params = (request.params ?? {}) as Record<string, string>;
    // Writes that name a session in their body: placing an agent in the sidebar, adding it to a crew.
    const bodyKey = BODY_KEYED.find(([route, method]) => route === url && method === request.method);
    if (bodyKey) {
      const value = (request.body as Record<string, unknown> | null)?.[bodyKey[2]];
      if (typeof value === 'string' && !profiles.sees(scope, value)) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not-found', message: `no session ${value}` });
    }
    // A crew's page and activity name the crew in the query (none = the first crew).
    // Bringing a terminal conversation in, or continuing one from History: one another profile already holds is not found.
    if ((url === '/api/terminal-sessions/:id/hook' || url === '/api/history/:claudeSessionId/continue') && request.method === 'POST') {
      const claudeId = params['id'] ?? params['claudeSessionId'];
      const held = claudeId ? await resolvers().sessionByClaudeId?.(claudeId) : null;
      if (held && !profiles.sees(scope, held)) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not-found', message: 'no such conversation in this profile' });
    }
    if ((url === '/api/team' || url === '/api/team/activity' || url === '/api/team/needs-you') && request.method === 'GET') {
      const asked = (request.query as { teamId?: unknown } | null)?.teamId;
      const teamId = resolvers().teamIdFor?.(typeof asked === 'string' && asked !== '' ? asked : null) ?? null;
      const profile = teamId ? await resolvers().teamProfile?.(teamId) : null;
      if (typeof profile === 'string' && !scopeSees(scope, profile)) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not-found', message: 'no such crew in this profile' });
    }
    for (const [prefix, param, kind] of KEYED) {
      if (url !== prefix && !url.startsWith(`${prefix}/`)) continue;
      const id = params[param];
      if (typeof id !== 'string' || id === '') return undefined;
      const allowed = await seesKey(profiles, resolvers(), scope, kind, id);
      if (!allowed) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not-found', message: `no ${kind} ${id}` });
      return undefined;
    }
    return undefined;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const scope = request.userProfileScope;
    if (scope === '*' || reply.statusCode < 200 || reply.statusCode >= 300 || typeof payload !== 'string') return payload;
    const url = request.routeOptions.url ?? '';
    // Every sidebar answer is a layout (writes too): cut to the profile's.
    const sidebar = url === '/api/sidebar' || url.startsWith('/api/sidebar/');
    if (!sidebar && request.method !== 'GET') return payload;
    const filter = sidebar ? SIDEBAR_FILTER : LIST_FILTERS[url];
    if (!filter) return payload;
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return payload;
    }
    return JSON.stringify(await filter(body, (sessionId) => sessionId === null || profiles.sees(scope, sessionId), { scope, profiles, resolvers: resolvers() }));
  });
}

async function seesKey(profiles: UserProfileService, r: ProfileScopeResolvers, scope: ProfileScope, kind: Kind, id: string): Promise<boolean> {
  switch (kind) {
    case 'session':
      return profiles.sees(scope, id);
    case 'plan': {
      const session = await r.planSession?.(id);
      return session == null || profiles.sees(scope, session);
    }
    case 'member': {
      const session = await r.memberSession?.(id);
      return session == null || profiles.sees(scope, session);
    }
    case 'team': {
      const profile = await r.teamProfile?.(id);
      return profile == null || scopeSees(scope, profile);
    }
    case 'inbox': {
      const session = await r.inboxSession?.(id);
      return session == null || profiles.sees(scope, session);
    }
    case 'batch': {
      const session = await r.batchSession?.(id);
      return session == null || profiles.sees(scope, session);
    }
    case 'artifact': {
      const session = await r.artifactSession?.(id);
      return session == null || profiles.sees(scope, session);
    }
    case 'schedule': {
      const profile = r.scheduleProfile?.(id) ?? null;
      return profile === null || scopeSees(scope, profile);
    }
    case 'move': {
      const session = await r.moveSession?.(id);
      return session == null || profiles.sees(scope, session);
    }
    case 'folder': {
      const profile = r.folderProfile?.(id) ?? null;
      return profile === null || scopeSees(scope, profile);
    }
  }
}

/** The request's scope (see the module comment). */
async function scopeOf(request: FastifyRequest, profiles: UserProfileService): Promise<ProfileScope> {
  if (request.device) return request.device.userProfileId ?? 'default';
  if (isHookPath(request.url)) return '*';
  if (isAgentPath(request.url)) {
    const sessionId = request.headers['x-switchboard-session'];
    return typeof sessionId === 'string' && bearerOf(request.headers.authorization) !== null ? profiles.profileOfSession(sessionId) : null;
  }
  if (internal(request)) {
    // The peer API: the calling computer's profile when it named one (its agents are created in it), else everything.
    const named = request.headers[USER_PROFILE_HEADER];
    return typeof named === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(named) ? named : '*';
  }
  return profiles.scopeOfCookies(request.headers.cookie);
}

interface FilterContext {
  readonly scope: ProfileScope;
  readonly profiles: UserProfileService;
  readonly resolvers: ProfileScopeResolvers;
}

type Sees = (sessionId: string | null) => boolean;
type ListFilter = (body: unknown, sees: Sees, context: FilterContext) => unknown | Promise<unknown>;

function arr(body: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(body) ? (body as Array<Record<string, unknown>>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The scoped `GET` lists, by route URL (exported for the tests). */
export const LIST_FILTERS: Readonly<Record<string, ListFilter>> = {
  '/api/sessions': (body, sees) => arr(body)?.filter((session) => sees(str(session['id']))) ?? body,
  '/api/inbox': (body, sees) => arr(body)?.filter((item) => sees(str(item['sessionId']))) ?? body,
  '/api/todos': (body, sees) => arr(body)?.filter((group) => sees(str(group['sessionId']))) ?? body,
  '/api/artifacts': (body, sees) => arr(body)?.filter((artifact) => sees(str(artifact['sessionId']))) ?? body,
  '/api/moves': (body, sees) => arr(body)?.filter((move) => sees(str(move['agentSessionId']))) ?? body,
  '/api/plans': (body, sees) => arr(body)?.filter((plan) => sees(str(plan['sourceSessionId']))) ?? body,
  // D159's plan_list: the plans of the agent's own profile.
  '/agent/v1/plans': async (body, sees, { resolvers }) => {
    const list = arr(body);
    if (!list) return body;
    const out: Array<Record<string, unknown>> = [];
    for (const plan of list) {
      const id = str(plan['id']);
      const session = id ? await resolvers.planSession?.(id) : null;
      if (session == null || sees(session)) out.push(plan);
    }
    return out;
  },
  // History: the profile's own sessions; a conversation not in Switchboard yet is the machine's (every profile).
  '/api/history': (body, sees) => arr(body)?.filter((item) => sees(str(item['sessionId']))) ?? body,
  // Terminal conversations: one not followed yet is the machine's (every profile); a followed one is a session (its profile).
  '/api/terminal-sessions': (body, sees) => arr(body)?.filter((terminal) => sees(str(terminal['sessionId']))) ?? body,
  // Crews' Needs you, the members' sessions the sidebar hides, the adoption suggestions: the profile's own.
  '/api/team/needs-you': (body, sees) => arr(body)?.filter((item) => sees(str(item['sessionRef']))) ?? body,
  '/api/team/suggestions': (body, sees) => arr(body)?.filter((suggestion) => sees(str(suggestion['sessionId']))) ?? body,
  '/api/team/state': (body, sees) => {
    if (typeof body !== 'object' || body === null) return body;
    const state = body as { hiddenSessionIds?: unknown; roles?: unknown };
    const hidden = Array.isArray(state.hiddenSessionIds) ? (state.hiddenSessionIds as string[]).filter((id) => sees(id)) : state.hiddenSessionIds;
    const roles = state.roles && typeof state.roles === 'object' ? Object.fromEntries(Object.entries(state.roles as Record<string, string>).filter(([id]) => sees(id))) : state.roles;
    return { ...state, hiddenSessionIds: hidden, roles };
  },
  // Crews: the profile's own.
  '/api/team/teams': (body, _sees, { scope, resolvers }) => arr(body)?.filter((team) => {
    const id = str(team['id']);
    const profile = id ? resolvers.teamProfile?.(id) : null;
    return typeof profile !== 'string' || scopeSees(scope, profile);
  }) ?? body,
  '/api/processes': (body, sees) => {
    if (typeof body !== 'object' || body === null) return body;
    const overview = body as { sessions?: Array<Record<string, unknown>> };
    return { ...overview, sessions: (overview.sessions ?? []).filter((session) => sees(str(session['sessionId']))) };
  },
  '/api/schedules': (body, _sees, { scope, resolvers }) => arr(body)?.filter((schedule) => {
    const id = str(schedule['id']);
    const profile = id ? (resolvers.scheduleProfile?.(id) ?? 'default') : 'default';
    return scopeSees(scope, profile);
  }) ?? body,
  '/api/search': (body, sees) => {
    if (typeof body !== 'object' || body === null) return body;
    const answer = body as { groups?: Array<{ results?: Array<{ target?: { sessionId?: unknown } }> }> };
    return {
      ...answer,
      groups: (answer.groups ?? []).map((group) => ({ ...group, results: (group.results ?? []).filter((result) => sees(str(result.target?.sessionId) ?? null)) })),
    };
  },
  '/api/sidebar': (body, sees, { scope, resolvers }) => filterLayout(body as SidebarLayout, sees, (folderId) => scopeSees(scope, resolvers.folderProfile?.(folderId) ?? 'default')),
};

/** Any sidebar answer: a layout, or `{ layout, … }` (D141's delete with archiving). */
const SIDEBAR_FILTER: ListFilter = (body, sees, { scope, resolvers }) => {
  const seen = (folderId: string): boolean => scopeSees(scope, resolvers.folderProfile?.(folderId) ?? 'default');
  if (body && typeof body === 'object' && Array.isArray((body as SidebarLayout).folders)) return filterLayout(body as SidebarLayout, sees, seen);
  const wrapped = body as { layout?: SidebarLayout } | null;
  if (wrapped && typeof wrapped === 'object' && wrapped.layout && Array.isArray(wrapped.layout.folders)) return { ...wrapped, layout: filterLayout(wrapped.layout, sees, seen) };
  return body;
};

/**
 * A sidebar layout as profile `scope` sees it: its own folders (with only its sessions in them),
 * its pins and loose order without other profiles' sessions. Crew and project pins stay (the rail
 * shows them only when the crew / project is in the profile's lists).
 */
export function filterLayout(layout: SidebarLayout, sees: Sees, folderSeen: (folderId: string) => boolean): SidebarLayout {
  if (!layout || !Array.isArray(layout.pinned) || !Array.isArray(layout.folders)) return layout;
  const keep = (id: string): boolean => (id.startsWith('crew~') || id.startsWith('plan~') ? true : sees(id));
  return {
    ...layout,
    pinned: layout.pinned.filter(keep),
    folders: layout.folders.filter((folder) => folderSeen(folder.id)).map((folder) => ({ ...folder, sessionIds: folder.sessionIds.filter(keep) })),
    ...(Array.isArray(layout.loose) ? { loose: layout.loose.filter(keep) } : {}),
  };
}

/**
 * The `/hub` filter of one client in scope `scope`: an event about a session of another profile is
 * dropped; the sidebar layout is cut to the profile's. Events about no session (the system tick,
 * machines, updates) pass. Plan and crew events pass as ids only: the pages read the scoped lists.
 */
export function hubTransform(profiles: UserProfileService, scope: ProfileScope): (message: HubMessage) => HubMessage | null {
  if (scope === '*') return (message) => message;
  const lookups = profiles.hubLookups;
  const sees = (sessionId: string | null): boolean => sessionId === null || profiles.sees(scope, sessionId);
  return (message) => {
    const payload = message.payload as unknown as Record<string, unknown> | null;
    if (message.name === 'sessionUpdated') return sees(str(payload?.['id'])) ? message : null;
    if (message.name === 'sidebarLayoutChanged') {
      return { ...message, payload: filterLayout(message.payload as SidebarLayout, sees, (folderId) => scopeSees(scope, lookups.folderProfile(folderId) ?? 'default')) } as HubMessage;
    }
    if (message.name === 'movesChanged') {
      const move = payload?.['move'] as Record<string, unknown> | undefined;
      return sees(str(move?.['agentSessionId']) ?? null) ? message : null;
    }
    if (message.name === 'notice') {
      const match = /^\/(?:sessions|agents)\/([^/?#]+)/.exec(str(payload?.['url']) ?? '');
      return match && !sees(decodeURIComponent(match[1] as string)) ? null : message;
    }
    // The Inbox count of this client's profile (the map never leaves the server).
    if (message.name === 'inboxChanged') {
      const byProfile = payload?.['byProfile'] as Record<string, number> | undefined;
      const count = scope === null ? 0 : (byProfile?.[scope] ?? (typeof payload?.['count'] === 'number' ? payload['count'] : 0));
      return { ...message, payload: { count } } as HubMessage;
    }
    // A plan's events go to its owner's profile only (a plan that is gone: to everyone, it only drops out of lists).
    if (message.name === 'planChanged') {
      const source = lookups.planSession(str(payload?.['planId']) ?? '');
      return source === null || sees(source) ? message : null;
    }
    if (message.name === 'teamChanged') {
      const profile = lookups.teamProfile(str(payload?.['teamId']) ?? '');
      return profile === null || scopeSees(scope, profile) ? message : null;
    }
    if (payload && typeof payload === 'object' && typeof payload['sessionId'] === 'string') return sees(payload['sessionId']) ? message : null;
    return message;
  };
}