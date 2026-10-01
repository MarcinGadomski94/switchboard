import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AccountsOverview, Session } from '../../core/api.ts';
import { isCliProviderId } from '../../core/cli-providers.ts';
import { AccountError } from '../accounts/service.ts';
import type { ApiContext } from '../routes.ts';
import { toSession } from '../sessions/wire.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';

function refuse(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AccountError) {
    if (error.status === 422) return reply.code(422).send({ error: 'invalid', errors: [{ field: error.field ?? 'body', message: error.message }] });
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  throw error;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * D63 routes (`docs/accounts.md`, `docs/handoff/contracts/local-api.md` → *CLI accounts (D63)*):
 * - `GET /api/accounts[?refresh=1]` → {@link AccountsOverview}: the profiles (status from each CLI's own status command) and the rules;
 * - `PUT /api/accounts/settings` (partial) → the settings;
 * - `POST /api/accounts/profiles { cli, name, shareSettings? }` → 201 profile; `PUT|DELETE /api/accounts/profiles/{id}`; `PUT /api/accounts/order { cli, order }`;
 * - `POST /api/accounts/profiles/{id}/check | sync-settings | signin | signout`; `GET|DELETE /api/accounts/signin/{id}`, `POST …/paste`;
 * - `POST /api/sessions/{id}/account { profileId }` (the Switch account action) and `PUT /api/sessions/{id}/profile-pin { pinned }`.
 */
export async function registerAccountRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { accounts, signIn, store, supervisor } = context;

  const overview = async (refresh: boolean): Promise<AccountsOverview> => ({ profiles: await accounts.list({ refresh }), settings: await accounts.settings() });

  app.get<{ Querystring: { refresh?: string } }>('/api/accounts', async (request) => overview(request.query.refresh === '1'));

  app.put('/api/accounts/settings', async (request, reply) => {
    try {
      return await accounts.setSettings(request.body);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post('/api/accounts/profiles', async (request, reply) => {
    const body = record(request.body);
    if (!isCliProviderId(body['cli'])) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'cli', message: 'cli must be claude, codex or opencode' }] });
    try {
      const created = await accounts.create({ cli: body['cli'], name: body['name'], ...(typeof body['shareSettings'] === 'boolean' ? { shareSettings: body['shareSettings'] } : {}) });
      return reply.code(201).send((await accounts.list({ check: false })).find((p) => p.id === created.id));
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/accounts/profiles/:id', async (request, reply) => {
    try {
      const body = record(request.body);
      await accounts.update(request.params.id, { name: body['name'], enabled: body['enabled'], shareSettings: body['shareSettings'] });
      return (await accounts.list({ check: false })).find((p) => p.id === request.params.id);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { removeFiles?: string } }>('/api/accounts/profiles/:id', async (request, reply) => {
    try {
      await accounts.remove(request.params.id, { removeFiles: request.query.removeFiles === '1', live: (profileId) => supervisor.liveSessions().some((s) => s.profileId === profileId) });
      return reply.code(204).send();
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.put('/api/accounts/order', async (request, reply) => {
    const body = record(request.body);
    if (!isCliProviderId(body['cli'])) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'cli', message: 'cli must be claude, codex or opencode' }] });
    try {
      await accounts.reorder(body['cli'], body['order']);
      return overview(false);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/accounts/profiles/:id/check', async (request, reply) => {
    try {
      await accounts.check(request.params.id, { refresh: true });
      return (await accounts.list({ check: false })).find((p) => p.id === request.params.id);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/accounts/profiles/:id/sync-settings', async (request, reply) => {
    try {
      return await accounts.syncShared(request.params.id);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/accounts/profiles/:id/signin', async (request, reply) => {
    const body = record(request.body);
    const text = (name: string): string | undefined => (typeof body[name] === 'string' && (body[name] as string).trim() !== '' ? (body[name] as string).trim() : undefined);
    try {
      return await signIn.start(request.params.id, {
        ...(text('email') ? { email: text('email') as string } : {}),
        ...(body['deviceCode'] === true ? { deviceCode: true } : {}),
        ...(text('provider') ? { provider: text('provider') as string } : {}),
        ...(typeof body['apiKey'] === 'string' && body['apiKey'] !== '' ? { apiKey: body['apiKey'] } : {}),
      });
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/accounts/profiles/:id/signout', async (request, reply) => {
    try {
      const result = await signIn.signOut(request.params.id);
      return { ...result, profile: (await accounts.list({ check: true })).find((p) => p.id === request.params.id) };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/accounts/signin/:id', async (request, reply) => {
    try {
      return signIn.get(request.params.id);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/accounts/signin/:id/paste', async (request, reply) => {
    try {
      return await signIn.paste(request.params.id, record(request.body)['value']);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/signin/:id', async (request, reply) => {
    try {
      return await signIn.cancel(request.params.id);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  // The session's account: the header's Switch account action (202 once the switch ran; it answers when it is over) and the pin.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/account', async (request, reply): Promise<Session | FastifyReply> => {
    const profileId = record(request.body)['profileId'];
    if (typeof profileId !== 'string' || profileId === '') return reply.code(422).send({ error: 'invalid', errors: [{ field: 'profileId', message: 'profileId must be a profile id' }] });
    const session = await store.sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'not-found', message: `no session ${request.params.id}` });
    try {
      const updated = await supervisor.switchAccount(session.id, profileId, { reason: 'switched by you', handoverDir: path.join(context.config.dataDir, 'handovers') });
      return await toSession(store, updated, supervisor.activity(updated.id));
    } catch (error) {
      if (error instanceof SupervisorError) {
        const status = error.code === 'not-found' ? 404 : error.code === 'switch-failed' ? 502 : error.code === 'closing' ? 503 : 409;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string } }>('/api/sessions/:id/profile-pin', async (request, reply): Promise<Session | FastifyReply> => {
    const pinned = record(request.body)['pinned'];
    if (typeof pinned !== 'boolean') return reply.code(422).send({ error: 'invalid', errors: [{ field: 'pinned', message: 'pinned must be true or false' }] });
    const session = await store.sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'not-found', message: `no session ${request.params.id}` });
    const updated = await supervisor.setProfilePinned(session.id, pinned);
    return toSession(store, updated, supervisor.activity(updated.id));
  });
}
