import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { LOOPBACK_HOST } from './config.ts';

/** Thrown when asked to bind anywhere but 127.0.0.1. */
export class BindRefusedError extends Error {
  override name = 'BindRefusedError';
}

/**
 * Refuses every bind address except {@link LOOPBACK_HOST}: no `0.0.0.0`, `::`,
 * LAN address, `localhost` (which may resolve to `::1` too) or `::1`.
 * @throws {BindRefusedError}
 */
export function assertLoopbackBind(host: string): void {
  if (host !== LOOPBACK_HOST) {
    throw new BindRefusedError(`Refusing to bind to "${host}": Switchboard listens on ${LOOPBACK_HOST} only`);
  }
}

/** Options for {@link listenLoopback}. */
export interface ListenOptions {
  readonly port: number;
  /** Must be `127.0.0.1`; anything else is refused before a socket is opened. */
  readonly host?: string;
}

/**
 * Listens on 127.0.0.1 only and checks the address the socket actually bound;
 * if it is not 127.0.0.1 the server is closed and the call fails.
 * @throws {BindRefusedError}
 */
export async function listenLoopback(app: FastifyInstance, options: ListenOptions): Promise<AddressInfo> {
  const host = options.host ?? LOOPBACK_HOST;
  assertLoopbackBind(host);
  await app.listen({ host, port: options.port });
  const address = app.server.address();
  if (address === null || typeof address === 'string' || address.address !== LOOPBACK_HOST) {
    await app.close();
    throw new BindRefusedError(`Bound to an unexpected address ${JSON.stringify(address)}; closed`);
  }
  return address;
}
