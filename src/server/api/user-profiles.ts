import type { FastifyInstance, FastifyReply } from 'fastify';
import type { UserProfilesView } from '../../core/user-profiles.ts';
import type { ApiContext } from '../routes.ts';
import { toSession } from '../sessions/wire.ts';
import { UserProfileError, type UserProfileService } from '../user-profiles/service.ts';

/**
 * D165 · the profiles' routes (`docs/profiles.md`, contract → *Profiles*):
 *
 * - `GET /api/user-profiles` → `{ profiles, activeId, startId }` (`activeId`: this browser's profile, `null` = none chosen yet;
 *   `startId`: the profile a browser opens in before it chose one; D176 `otherComputers`: the computers known only through a paired one).
 * - `PUT /api/user-profiles/start` `{ id }` → `{ startId }` (2026-11-16, Settings → Profiles → *Open in*).
 * - `POST /api/user-profiles` `{ name, color?, password? }` → 201 the profile.
 * - `PUT /api/user-profiles/{id}` `{ name?, color?, password?, currentPassword?, defaultAccounts? }`; editing a
 *   profile that is not this browser's and has a password needs `currentPassword`.
 * - `DELETE /api/user-profiles/{id}` `{ password? }` → `{ archived }`: its open agents are archived first; Default stays.
 * - `POST /api/user-profiles/switch` `{ id, password? }` → the profile, and the signed cookie for this browser.
 * - `POST /api/user-profiles/merge` `{ a, b, passwordA?, passwordB?, keep: { name, color, password } }` (D172) →
 *   `{ survivor, mergedAway }`: two profiles become one on purpose; `keep.*` is `'a'` or `'b'`.
 * - `PUT /api/sessions/{id}/user-profile` `{ userProfileId, password? }` → moves the agent (a paired computer's
 *   agent: on its computer, through the peer API).
 *
 * - D173: `PUT /api/user-profiles/{id}/admin { admin, adminPassword }` and `PUT /api/user-profiles/{id}/access
 *   { computers: 'all' | [machine ids], adminPassword }` → the profile (403 `not-admin`, 409 `last-admin` /
 *   `needs-password`); the switch answers 403 `not-allowed-here` for a profile not allowed on this computer.
 *
 * Refusals: 404 `not-found`, 422 `invalid`, 409 `name-taken` / `default` / `archive-failed`, 401 `wrong-password`,
 * 429 `too-many-tries`. A paired phone is refused all but the list (`devices/local-only.ts`).
 */
export async function registerUserProfileRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const service = context.userProfiles;
  if (!service) return;

  const send = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof UserProfileError) return reply.code(error.status).header('cache-control', 'no-store').send({ error: error.code, message: error.message });
    throw error;
  };

  app.get('/api/user-profiles', async (request): Promise<UserProfilesView> => {
    const scope = request.userProfileScope;
    return { profiles: await service.list(), activeId: typeof scope === 'string' && scope !== '*' ? scope : null, startId: await service.startProfileId(), otherComputers: service.otherComputers(), orphans: await service.orphans() };
  });

  // D179 follow-up (2026-11-23): a removed profile's agents with no live successor, moved by hand (the target's password when it has one).
  app.post<{ Params: { profileId: string } }>('/api/user-profiles/orphans/:profileId/move', async (request, reply) => {
    try {
      return await service.moveOrphan(request.params.profileId, request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  // 2026-11-16: the profile a browser opens in before it chose one (before `/:profileId`: a static path wins anyway).
  app.put('/api/user-profiles/start', async (request, reply) => {
    try {
      return { startId: await service.setStartProfile(request.body) };
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post('/api/user-profiles', async (request, reply) => {
    try {
      return reply.code(201).send(await service.create(request.body));
    } catch (error) {
      return send(reply, error);
    }
  });

  app.put<{ Params: { profileId: string } }>('/api/user-profiles/:profileId', async (request, reply) => {
    try {
      await guardOther(service, request.userProfileScope, request.params.profileId, request.body);
      return await service.update(request.params.profileId, request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  // D173: admins and computer access (only an admin profile, its password; the bootstrap: a profile with a password makes itself the first admin).
  app.put<{ Params: { profileId: string } }>('/api/user-profiles/:profileId/admin', async (request, reply) => {
    try {
      return await service.setAdmin(request.params.profileId, request.body, request.userProfileScope);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.put<{ Params: { profileId: string } }>('/api/user-profiles/:profileId/access', async (request, reply) => {
    try {
      return await service.setAccess(request.params.profileId, request.body, request.userProfileScope);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.delete<{ Params: { profileId: string } }>('/api/user-profiles/:profileId', async (request, reply) => {
    try {
      return await service.remove(request.params.profileId, request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  // D172: two profiles become one, on purpose (both passwords; the name, colour and password picked).
  app.post('/api/user-profiles/merge', async (request, reply) => {
    try {
      return await service.mergeProfiles(request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post('/api/user-profiles/switch', async (request, reply) => {
    try {
      const { profile, cookie } = await service.switchTo(request.body);
      return reply.header('set-cookie', service.serializeCookie(cookie)).header('cache-control', 'no-store').send(profile);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/sessions/:id/user-profile', async (request, reply) => {
    try {
      const to = await service.moveSession(request.params.id, request.body);
      const record = await context.store.sessions.get(request.params.id);
      if (record) context.bus.publish('sessionUpdated', await toSession(context.store, record, context.supervisor.activity(record.id)));
      return { sessionId: request.params.id, userProfileId: to };
    } catch (error) {
      return send(reply, error);
    }
  });
}

/** Editing a profile other than this browser's, when it has a password, needs that password (`currentPassword`). */
async function guardOther(service: UserProfileService, scope: string | null, profileId: string, body: unknown): Promise<void> {
  if (scope === '*' || scope === profileId) return;
  const record = await service.get(profileId);
  if (!record || record.passwordHash === null) return;
  const given = typeof body === 'object' && body !== null ? (body as { currentPassword?: unknown }).currentPassword : undefined;
  await service.switchTo({ id: profileId, password: given });
}
