import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ModelSettings } from '../../core/api.ts';
import type { KnownSettings } from '../../core/settings.ts';
import type { ApiContext } from '../routes.ts';
import { readModelSettings } from '../settings/models.ts';
import { readSettings, validateSettingsPatch } from '../settings/settings.ts';
import type { PendingRoute } from './not-implemented.ts';

/** Settings routes (contract → REST) not implemented yet: none since M8.2. */
export const SETTINGS_ROUTES_PENDING: readonly PendingRoute[] = [];

/**
 * Registers the settings routes (M8.2, `docs/settings.md`):
 * - `GET /api/settings` → every known setting (`src/core/settings.ts`): the
 *   editable preferences (stored, else their defaults) and the read-only values
 *   the service reports (address, the default folder and its router title (D14),
 *   PR poll interval, start at login);
 * - `PUT /api/settings` → stores any subset of the editable keys in one
 *   transaction and answers like `GET`; `422 {error:"invalid", errors}` for a
 *   read-only or unknown key or a wrong value, and nothing changes;
 * - `GET /api/models` (additive, D42) → `{ options, last }`: the latest model
 *   list any claude process reported and the developer's last model choice, the
 *   service's own settings (`settings/models.ts`), which the New-session form's
 *   Model row offers and starts on. Read-only: the service writes them.
 */
export async function registerSettingsRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, config, folders } = context;

  app.get('/api/settings', async (): Promise<KnownSettings> => readSettings(store.settings, config, await folders.defaultRecord()));

  app.put('/api/settings', async (request, reply): Promise<KnownSettings | FastifyReply> => {
    const result = validateSettingsPatch(request.body);
    if (!result.ok) return reply.code(422).send({ error: 'invalid', errors: result.errors });
    await store.settings.setMany(result.value);
    return readSettings(store.settings, config, await folders.defaultRecord());
  });

  app.get('/api/models', async (): Promise<ModelSettings> => readModelSettings(store.settings));
}
