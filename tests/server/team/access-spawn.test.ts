import { afterEach, describe, expect, it } from 'vitest';
import { type MaskedSecret, maskSecrets } from '../../../src/core/team-access.ts';
import type { AccessEnv } from '../../../src/server/team/access/service.ts';
import { registerTeamHooks } from '../../../src/server/team/hooks.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D100-T2 on the real spawn path (fake-claude): the supervisor gives a member's
 * session its access values as environment variables, and the masking pass replaces
 * them in everything recorded of that session (a Bash tool result that prints the
 * key, `[fake:echo-env]`). A plain session started alongside gets neither the
 * variable nor (having nothing to mask) any mask.
 */
let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

const KEY = 'acme-live-0c9b7a5e3d1f2468';

describe('D100-T2 · delivery at spawn', () => {
  it('the member gets the variable, its tool result is masked before it is stored; a plain session gets nothing', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const members = new Set<string>();
    const secrets: MaskedSecret[] = [{ name: 'ACME_ANALYTICS_KEY', value: KEY }];
    registerTeamHooks(w.store, {
      charterFor: async () => null,
      roleOf: () => null,
      switchChanged: async () => undefined,
      accessEnv: async (sessionId): Promise<AccessEnv> => {
        const record = await w.store.sessions.get(sessionId);
        if (record?.name !== 'member-run') return { env: {}, secrets: [] };
        members.add(sessionId);
        return { env: { ACME_ANALYTICS_KEY: KEY }, secrets };
      },
      mask: (sessionId) => (text) => (members.has(sessionId) ? maskSecrets(text, secrets) : text),
    });
    const member = await w.supervisor.start(newSession({ name: 'member-run', task: '[fake:echo-env ACME_ANALYTICS_KEY]' }), w.place);
    const plain = await w.supervisor.start(newSession({ name: 'plain-run', task: '[fake:echo-env ACME_ANALYTICS_KEY]' }), w.place);
    await waitForStatus(w.store, member.id, ['done']);
    await waitForStatus(w.store, plain.id, ['done']);

    const memberEvents = JSON.stringify(await w.store.events.list(member.id));
    expect(memberEvents).not.toContain(KEY);
    expect(memberEvents).toContain('•••• (ACME_ANALYTICS_KEY)');
    expect(memberEvents).toContain('printenv ACME_ANALYTICS_KEY');

    const plainEvents = JSON.stringify(await w.store.events.list(plain.id));
    expect(plainEvents).not.toContain(KEY);
    expect(plainEvents).not.toContain('•••• (ACME_ANALYTICS_KEY)');
    expect(plainEvents).toContain('printenv ACME_ANALYTICS_KEY');
  });
});
