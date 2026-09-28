import type { LoginServiceStatus } from '../../core/login-service.ts';
import type { LoginServiceProvider } from '../providers.ts';

/**
 * The demo's "Start at login" (M9.1, D13): a flag in memory that starts **on**,
 * as the prototype's Settings → Claude Code shows it. It never writes a service
 * definition or runs a service manager, so clicking the toggle in demo mode (the
 * visual oracle) cannot install anything on the machine.
 */
export function createDemoLoginService(initial = true): LoginServiceProvider {
  let on = initial;
  const status = (): LoginServiceStatus => ({ manager: 'launchd', startAtLogin: on, file: '~/Library/LaunchAgents/local.switchboard.plist' });
  return {
    async status() {
      return status();
    },
    async setStartAtLogin(enabled) {
      on = enabled;
      return status();
    },
  };
}
