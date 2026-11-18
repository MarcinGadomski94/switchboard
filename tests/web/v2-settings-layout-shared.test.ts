import { describe, expect, it } from 'vitest';
import { layoutSharedFor } from '../../src/web/v2/settings/settings-model.ts';

/** D179: Settings → Computers → Shared layout shows the browser's profile's own switch. */
describe('layoutSharedFor (D179)', () => {
  it('reads the profile’s own switch; an older computer’s view is the whole switch; no profile reads Default’s', () => {
    const sync = { enabled: true, profiles: ['default', 'team-1'] };
    expect(layoutSharedFor(sync, 'team-1')).toBe(true);
    expect(layoutSharedFor(sync, 'eskil')).toBe(false);
    expect(layoutSharedFor(sync, null)).toBe(true);
    expect(layoutSharedFor({ enabled: true, profiles: ['team-1'] }, null)).toBe(false);
    expect(layoutSharedFor({ enabled: true }, 'anyone')).toBe(true);
    expect(layoutSharedFor({ enabled: false }, 'anyone')).toBe(false);
    expect(layoutSharedFor(undefined, 'anyone')).toBe(false);
  });
});
