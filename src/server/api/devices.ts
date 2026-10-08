import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { deviceNameFromUserAgent } from '../../core/devices.ts';
import { DeviceError, PAIR_BODY_LIMIT, isDeviceRequest } from '../devices/service.ts';
import { pairPage } from '../devices/pair-page.ts';
import type { DeviceRecord } from '../db/repos/devices.ts';
import type { ApiContext } from '../routes.ts';

/**
 * D73 (`docs/devices.md`): Settings → Devices, the device's own settings, and the
 * pairing page of the device listener.
 *
 * This machine's UI only (local-only for devices, `devices/local-only.ts`):
 * - `GET /api/devices` → DevicesView (the access switch and the paired devices);
 * - `PUT /api/devices/access` `{ enabled?, port?, httpsPort? }` → DeviceAccessState;
 * - `POST /api/devices/pairing` → DevicePairingCode ("Pair a device"), `DELETE /api/devices/pairing`;
 * - `PUT /api/devices/{id}` `{ name }` → Device, `DELETE /api/devices/{id}` (revoke) → 204.
 *
 * Any UI:
 * - `GET /api/device` → DeviceSelfView (`device: null` on this machine's own UI).
 *
 * A paired device only (404 `not-a-device` elsewhere):
 * - `PUT /api/device` `{ name }` → Device;
 * - `PUT /api/device/push` `{ subscription?, events? }` → DeviceSelfView, `DELETE /api/device/push`;
 * - `POST /api/device/push/test` → `{ ok, error? }`.
 *
 * Device listener without a credential:
 * - `GET /pair` → the pairing page; `POST /device/v1/pair` `{ code, name? }` → 201 `{ device }` + the credential cookie.
 */
export async function registerDeviceRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { devices } = context;

  const run = async (reply: FastifyReply, action: () => Promise<unknown>, status = 200): Promise<FastifyReply> => {
    try {
      const body = await action();
      return status === 204 ? reply.code(204).send() : reply.code(status).send(body);
    } catch (error) {
      if (error instanceof DeviceError) return reply.code(error.status).send({ error: error.code, message: error.message });
      throw error;
    }
  };

  /** The asking device, or a 404 reply when the request is not from one. */
  const deviceOf = (request: FastifyRequest, reply: FastifyReply): DeviceRecord | null => {
    if (request.device) return request.device;
    void reply.code(404).send({ error: 'not-a-device', message: 'Only a paired device has this setting.' });
    return null;
  };

  app.get('/api/devices', async () => devices.view());
  app.put('/api/devices/access', async (request, reply) => run(reply, () => devices.setAccess(request.body)));
  app.post('/api/devices/pairing', async (_request, reply) => run(reply, () => devices.createPairingCode()));
  app.delete('/api/devices/pairing', async (_request, reply) => run(reply, () => devices.cancelPairingCode(), 204));
  app.put<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) =>
    run(reply, () => devices.rename(request.params.id, (request.body as { name?: unknown } | null)?.name)),
  );
  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) => run(reply, () => devices.revoke(request.params.id), 204));

  app.get('/api/device', async (request) => devices.selfView(request.device));
  app.put('/api/device', async (request, reply) => {
    const device = deviceOf(request, reply);
    if (!device) return reply;
    return run(reply, () => devices.rename(device.id, (request.body as { name?: unknown } | null)?.name));
  });
  app.put('/api/device/push', async (request, reply) => {
    const device = deviceOf(request, reply);
    if (!device) return reply;
    return run(reply, () => devices.savePush(device, request.body));
  });
  app.delete('/api/device/push', async (request, reply) => {
    const device = deviceOf(request, reply);
    if (!device) return reply;
    return run(reply, () => devices.deletePush(device));
  });
  app.post('/api/device/push/test', async (request, reply) => {
    const device = deviceOf(request, reply);
    if (!device) return reply;
    return run(reply, async () => {
      const outcome = await devices.testPush(device);
      return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
    });
  });

  // The device listener's own pages (public there: the device guard lets them through without a credential).
  app.get('/pair', { config: { public: true } }, async (request, reply) => {
    if (!isDeviceRequest(request.raw)) return reply.callNotFound();
    if (request.device) return reply.code(302).header('location', '/').header('cache-control', 'no-store').send();
    const page = pairPage({ machineName: await devices.machineName(), suggestedName: deviceNameFromUserAgent(request.headers['user-agent']) });
    return reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', page.csp)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(page.html);
  });
  app.post('/device/v1/pair', { config: { public: true }, bodyLimit: PAIR_BODY_LIMIT }, async (request, reply) => {
    if (!isDeviceRequest(request.raw)) return reply.callNotFound();
    const answer = await devices.pair(request.body, request.headers);
    if (answer.cookie) reply.header('set-cookie', answer.cookie);
    return reply.code(answer.status).header('cache-control', 'no-store').send(answer.body);
  });
}
