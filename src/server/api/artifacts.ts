import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Artifact routes (contract → REST) not implemented yet. */
export const ARTIFACT_ROUTES_PENDING: readonly PendingRoute[] = [{ method: 'GET', url: '/api/artifacts', item: 'M7.3' }];

/** Registers the artifact routes. */
export async function registerArtifactRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, ARTIFACT_ROUTES_PENDING);
}
