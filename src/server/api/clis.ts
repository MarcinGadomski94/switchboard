import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CliInfo, CliOverview, ModelSettings } from '../../core/api.ts';
import { CLI_BIN_ENV, CLI_LABELS, isCliProviderId } from '../../core/cli-providers.ts';
import { cliCommandKey } from '../cli/registry.ts';
import { demoCliOverview } from '../demo/clis.ts';
import type { ApiContext } from '../routes.ts';
import { readModelSettings } from '../settings/models.ts';

interface RefreshQuery {
  readonly refresh?: string;
}

interface ProviderQuery {
  readonly provider?: string;
}

/** Longest command override part (a path). */
const COMMAND_PART_MAX = 4096;

/**
 * D62 routes (`docs/providers.md` → *Settings*, `docs/handoff/contracts/local-api.md`
 * → *CLI providers (D62)*):
 * - `GET /api/clis[?refresh=1]` → {@link CliOverview}: each CLI's command,
 *   version, sign-in, models and whether it can be chosen (with the reason);
 * - `PUT /api/clis/default { provider }` → the overview: the CLI new sessions
 *   start on (422 for an unknown or unavailable one);
 * - `PUT /api/clis/{provider}/command { command: string[] | null }` → the
 *   checked {@link CliInfo}: a Codex / OpenCode command override (`null` = back to
 *   the environment's); Claude Code's command is `SWITCHBOARD_CLAUDE_BIN` only (422);
 * - `POST /api/clis/{provider}/check` → the {@link CliInfo} checked again, its
 *   models read from the CLI where it can list them without a session;
 * - `GET /api/models?provider=` (D42, extended) → that CLI's model list and last choice.
 * In the demo (`SWITCHBOARD_DEMO=1`) the overview is the demo's and nothing runs.
 */
export async function registerCliRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, clis, config } = context;

  app.get<{ Querystring: RefreshQuery }>('/api/clis', async (request): Promise<CliOverview> => {
    if (config.demo) return demoCliOverview();
    return clis.overview({ refresh: request.query.refresh === '1' });
  });

  app.put('/api/clis/default', async (request, reply): Promise<CliOverview | FastifyReply> => {
    const body = request.body as Record<string, unknown> | null;
    const provider = body && typeof body === 'object' ? body['provider'] : undefined;
    if (!isCliProviderId(provider)) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'provider', message: 'provider must be claude, codex or opencode' }] });
    if (config.demo) return demoCliOverview();
    const refusal = await clis.refusal(provider);
    if (refusal) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'provider', message: refusal }] });
    await clis.setDefaultProvider(provider);
    return clis.overview();
  });

  app.put<{ Params: { provider: string } }>('/api/clis/:provider/command', async (request, reply): Promise<CliInfo | FastifyReply> => {
    const { provider } = request.params;
    if (!isCliProviderId(provider)) return reply.code(404).send({ error: 'not-found', message: `no CLI ${provider}` });
    if (provider === 'claude') {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'command', message: `${CLI_LABELS.claude}'s command is set by ${CLI_BIN_ENV.claude} (the service's environment)` }] });
    }
    const body = request.body as Record<string, unknown> | null;
    const command = body && typeof body === 'object' ? body['command'] : undefined;
    if (command === null) {
      await store.settings.delete(cliCommandKey(provider));
    } else if (Array.isArray(command) && command.length > 0 && command.length <= 32 && command.every((part) => typeof part === 'string' && part.trim() !== '' && part.length <= COMMAND_PART_MAX)) {
      await store.settings.set(cliCommandKey(provider), command.map((part: string) => part.trim()));
    } else {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'command', message: 'command must be a list of 1–32 non-empty strings (the program, then its arguments), or null' }] });
    }
    clis.invalidate(provider);
    return clis.info(provider, { refresh: true });
  });

  app.post<{ Params: { provider: string } }>('/api/clis/:provider/check', async (request, reply): Promise<CliInfo | FastifyReply> => {
    const { provider } = request.params;
    if (!isCliProviderId(provider)) return reply.code(404).send({ error: 'not-found', message: `no CLI ${provider}` });
    if (config.demo) return demoCliOverview().clis.find((cli) => cli.provider === provider) as CliInfo;
    return clis.info(provider, { refresh: true });
  });

  app.get<{ Querystring: ProviderQuery }>('/api/models', async (request, reply): Promise<ModelSettings | FastifyReply> => {
    const provider = request.query.provider ?? 'claude';
    if (!isCliProviderId(provider)) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'provider', message: 'provider must be claude, codex or opencode' }] });
    return readModelSettings(store.settings, provider);
  });
}
