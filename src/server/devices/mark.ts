import type { IncomingMessage } from 'node:http';

/**
 * D73: the mark the device listener puts on each raw request before handing it to
 * the app (`DeviceService`). It is a property only server code can set (a
 * `Symbol`), never a header: a client cannot make a main-listener request look
 * like a device request, nor the other way round.
 */
const DEVICE_REQUEST = Symbol('switchboard.device-request');

/** Marks `raw` as having arrived on the device listener. */
export function markDeviceRequest(raw: IncomingMessage): void {
  (raw as IncomingMessage & { [DEVICE_REQUEST]?: true })[DEVICE_REQUEST] = true;
}

/** `true` when `raw` arrived on the device listener. */
export function isDeviceRequest(raw: IncomingMessage): boolean {
  return (raw as IncomingMessage & { [DEVICE_REQUEST]?: true })[DEVICE_REQUEST] === true;
}
