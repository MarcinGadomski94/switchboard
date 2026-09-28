import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FrameHelperInfo, FrameHelperOpenError } from '../../core/api.ts';
import type { ApiContext } from '../routes.ts';
import { OpenFailedError, readFrameHelperInfo } from '../tools/frame-helper.ts';
import { sendNotImplemented } from './not-implemented.ts';

/** The decision these routes implement (501 while no opener is wired). */
const ITEM = 'D35';

/**
 * D35, additive to the contract (`docs/frame-helper.md` → *Guided setup*): the
 * frame-helper setup's routes. Behind the cookie guard like every route; none
 * reads a body or a query: every command is fixed (`tools/frame-helper.ts`).
 * - `GET /api/frame-helper` → {@link FrameHelperInfo}: the absolute path of
 *   `tools/frame-helper` in this checkout and its `manifest.json` version (read
 *   on every request, so a pulled update shows at once).
 * - `POST /api/frame-helper/reveal` opens the OS file manager on that folder;
 *   `POST /api/frame-helper/open-extensions` opens `chrome://extensions` in Chrome.
 *   Each answers 204 once its opener started, 502 {@link FrameHelperOpenError}
 *   with the opener's error when every command failed, and 501 without a
 *   `frameHelperOpener` provider (a bare test app).
 */
export async function registerFrameHelperRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const opener = context.providers.frameHelperOpener;

  app.get('/api/frame-helper', async (): Promise<FrameHelperInfo> => readFrameHelperInfo());

  const run = async (reply: FastifyReply, step: () => Promise<void>): Promise<FastifyReply> => {
    try {
      await step();
      return reply.code(204).send();
    } catch (error) {
      if (!(error instanceof OpenFailedError)) throw error;
      const body: FrameHelperOpenError = { error: 'open-failed', message: error.message };
      return reply.code(502).send(body);
    }
  };

  app.post('/api/frame-helper/reveal', async (_request, reply) => {
    if (!opener) return sendNotImplemented(reply, ITEM);
    return run(reply, () => opener.reveal());
  });

  app.post('/api/frame-helper/open-extensions', async (_request, reply) => {
    if (!opener) return sendNotImplemented(reply, ITEM);
    return run(reply, () => opener.openExtensions());
  });
}
