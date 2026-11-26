import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProfileScope } from '../../core/user-profiles.ts';
import { GitHubBindingError, type GitHubBindings } from '../github/bindings.ts';

/**
 * D190 (`docs/profiles.md` → *A profile's GitHub account*): a profile's GitHub binding. Local-only:
 * refused to paired phones (`devices/local-only.ts`) and never on the peer API (the sign-in itself
 * travels only on `POST /peer/v1/github`).
 * - `GET /api/user-profiles/{id}/github` → the binding, whether gh is signed in for it here, a sign-in in progress.
 * - `POST /api/user-profiles/{id}/github/connect { password?, email? }` → starts gh's device-code login.
 * - `POST /api/user-profiles/{id}/github/cancel { password? }` → stops it.
 * - `PUT /api/user-profiles/{id}/github/email { email | null, password? }` → the commit email.
 * - `POST /api/user-profiles/{id}/github/disconnect { password? }` → signs out everywhere, unbinds.
 * From inside the profile no password; otherwise the profile's password when it has one.
 */
export function registerGitHubBindingRoutes(app: FastifyInstance, github: GitHubBindings): void {
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof GitHubBindingError) return reply.code(error.status).send({ error: error.code, message: error.message });
    throw error;
  };
  const scopeOf = (request: { readonly userProfileScope?: ProfileScope }): ProfileScope => request.userProfileScope ?? null;
  const bodyOf = (body: unknown): Record<string, unknown> => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {});

  app.get<{ Params: { id: string } }>('/api/user-profiles/:id/github', async (request, reply) => {
    try {
      return await github.view(request.params.id);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post<{ Params: { id: string } }>('/api/user-profiles/:id/github/connect', async (request, reply) => {
    try {
      return await github.connect(request.params.id, request.body, scopeOf(request));
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post<{ Params: { id: string } }>('/api/user-profiles/:id/github/cancel', async (request, reply) => {
    try {
      return await github.cancel(request.params.id, scopeOf(request), bodyOf(request.body)['password']);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.put<{ Params: { id: string } }>('/api/user-profiles/:id/github/email', async (request, reply) => {
    try {
      return await github.setEmail(request.params.id, request.body, scopeOf(request));
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post<{ Params: { id: string } }>('/api/user-profiles/:id/github/disconnect', async (request, reply) => {
    try {
      return await github.disconnect(request.params.id, scopeOf(request), bodyOf(request.body)['password']);
    } catch (error) {
      return fail(reply, error);
    }
  });
}
