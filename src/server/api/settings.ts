import type { FastifyInstance, FastifyReply } from 'fastify';
import type { KnownSettings } from '../../core/settings.ts';
import { checkRuleTargets } from '../../core/model-routing.ts';
import type { ApiContext } from '../routes.ts';
import { readModelOptionsSetting } from '../settings/models.ts';
import { readSettings, validateSettingsPatch } from '../settings/settings.ts';
import { applyInstructionToOpenSessions } from '../settings/apply-instruction.ts';
import type { InstructionApplyResult } from '../../core/standing-instruction.ts';
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
 *   read-only or unknown key or a wrong value, and nothing changes; D82's
 *   `sessions.modelRules` is also checked against each CLI's model list and
 *   its enabled account profiles (`checkRuleTargets`);
 * - `GET /api/models` (additive, D42) → `{ options, last }`: the latest model
 *   list any claude process reported and the developer's last model choice, the
 *   service's own settings (`settings/models.ts`), which the New-session form's
 *   Model row offers and starts on. Read-only: the service writes them.
 */
export async function registerSettingsRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, config, folders, accounts } = context;

  app.get('/api/settings', async (): Promise<KnownSettings> => readSettings(store.settings, config, await folders.defaultRecord()));

  app.put('/api/settings', async (request, reply): Promise<KnownSettings | FastifyReply> => {
    const result = validateSettingsPatch(request.body);
    if (!result.ok) return reply.code(422).send({ error: 'invalid', errors: result.errors });
    // D82: each rule's model must exist for its CLI and its account be one of that CLI's enabled profiles.
    const rules = result.value['sessions.modelRules'];
    if (rules) {
      const problems = await checkRuleTargets(rules, {
        models: (provider) => readModelOptionsSetting(store.settings, provider),
        profile: async (id) => (await accounts.find(id)) ?? null,
      });
      if (problems.length > 0) return reply.code(422).send({ error: 'invalid', errors: problems });
    }
    await store.settings.setMany(result.value);
    // D91: a changed standing instruction makes running sessions' processes "older" (their `instructionOutdated`).
    if ('agents.standingInstruction' in result.value || 'agents.standingInstruction.enabled' in result.value) await context.supervisor.instructionSettingChanged();
    return readSettings(store.settings, config, await folders.defaultRecord());
  });

  // D91 (`docs/settings.md` → *Apply to open sessions*): gives this machine's open sessions the current standing
  // instruction (idle → restarted with `--resume`, busy / waiting → after the turn, no process → next start). Desktop
  // only (a settings action, DEVICE_REFUSED); not on the peer API (a paired machine's sessions are applied there).
  app.post('/api/settings/standing-instruction/apply', async (): Promise<InstructionApplyResult> => applyInstructionToOpenSessions(store, context.supervisor));

  // D62: `GET /api/models` (D42) moved to api/clis.ts, where it takes `?provider=`.
}
