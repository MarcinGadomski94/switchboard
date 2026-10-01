import { CLI_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import type { UsageReadingRecord } from '../db/repos/usage.ts';
import type { ProviderUsage } from './bridge-common.ts';
import type { CliStatusService } from './status.ts';
import type { SwitchCapacity } from '../supervisor/supervisor.ts';

/** A window at or above 100 % that has not reset yet. */
function spent(pct: number | null, resetsAt: string | null, now: number): boolean {
  if (pct === null || pct < 100) return false;
  if (resetsAt === null) return true;
  const reset = Date.parse(resetsAt);
  return !Number.isFinite(reset) || reset > now;
}

/**
 * D62 P5: whether the outgoing CLI can still write a handover (ruling: "if the
 * outgoing CLI still has capacity: it is runnable and not out of usage / limits,
 * using what each CLI reports"): it is installed, not signed out, and none of its
 * reported usage windows is spent (Claude Code: the D17 / D46 5-hour and weekly
 * readings; Codex: its rate-limit windows; OpenCode reports none, so only
 * runnable counts).
 */
export async function outgoingCapacity(input: {
  readonly provider: CliProviderId;
  readonly clis: Pick<CliStatusService, 'info'>;
  readonly supported: boolean;
  readonly claudeUsage: UsageReadingRecord | null;
  readonly providerUsage: ProviderUsage | null;
  readonly now?: number;
}): Promise<SwitchCapacity> {
  const label = CLI_LABELS[input.provider];
  const now = input.now ?? Date.now();
  if (!input.supported) return { ok: false, reason: `${label} is not supported by this Switchboard` };
  const info = await input.clis.info(input.provider);
  if (!info.installed) return { ok: false, reason: `${label} is not installed` };
  if (info.signedIn === false) return { ok: false, reason: `${label} is signed out` };
  if (input.provider === 'claude' && input.claudeUsage) {
    const usage = input.claudeUsage;
    if (spent(usage.fiveHourPct, usage.fiveHourResetsAt, now)) return { ok: false, reason: `${label} is out of usage (the 5-hour limit is at ${usage.fiveHourPct}%)` };
    if (spent(usage.sevenDayPct, usage.sevenDayResetsAt, now)) return { ok: false, reason: `${label} is out of usage (the weekly limit is at ${usage.sevenDayPct}%)` };
  }
  if (input.provider !== 'claude' && input.providerUsage) {
    const window = input.providerUsage.windows.find((entry) => spent(entry.pct, entry.resetsAt, now));
    if (window) return { ok: false, reason: `${label} is out of usage (a ${window.minutes ? `${Math.round(window.minutes / 60)}-hour` : ''} limit is at ${window.pct}%)`.replace('a  limit', 'a limit') };
  }
  return { ok: true, reason: null };
}
