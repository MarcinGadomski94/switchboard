import type { Device, DeviceAccessState } from '../../../core/devices.ts';
import { formatAge } from '../../shell/format.ts';

/**
 * Pure helpers of Settings → Devices (D73, `docs/devices.md`): the copy of the
 * access row and of a device row.
 */

/** The access row's description: what is on, where, or what to enable. */
export function accessDescription(access: DeviceAccessState): string {
  if (!access.enabled) {
    return 'Off. When on, paired phones and tablets reach Switchboard over your tailnet (HTTPS through tailscale serve). Nothing is opened to your LAN or the internet.';
  }
  switch (access.https) {
    case 'ok':
      return `On: ${access.origin ?? 'https://…ts.net'} → ${access.listening ?? `127.0.0.1:${access.port}`}`;
    case 'off':
      return 'Starting…';
    default:
      return access.message ?? 'Device access is not working.';
  }
}

/** `true` when the access row shows a problem (not off, not ok). */
export function accessProblem(access: DeviceAccessState): boolean {
  return access.enabled && access.https !== 'ok' && access.https !== 'off';
}

/** A device row's detail line: paired, last seen, notifications. */
export function deviceDetail(device: Device, now: number = Date.now()): string {
  const paired = `paired ${formatAge(device.pairedAt, now)} ago`.replace('now ago', 'just now');
  const seen = device.lastSeenAt ? `seen ${formatAge(device.lastSeenAt, now)} ago`.replace('seen now ago', 'seen just now') : 'never seen';
  return [paired, seen, device.push ? 'notifications on' : 'notifications off'].join(' · ');
}
