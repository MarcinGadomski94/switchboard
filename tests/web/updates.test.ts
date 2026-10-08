import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../src/core/api.ts';
import {
  availableText,
  bannerState,
  confirmText,
  gitUpdateCommands,
  installKindLabel,
  lastCheckText,
  manualStartCommand,
  phaseText,
  sessionsNote,
  updateRunning,
  type UpdatePhase,
  type UpdateStatus,
} from '../../src/core/updates.ts';
import { routeAfter } from '../../src/web/views/inbox.ts';
import { SETTINGS_SECTIONS, resolveSection } from '../../src/web/views/settings/model.ts';
import { bannerKind, canUpdate, formatWhen, hideKey, latestDescription, restartRow } from '../../src/web/updates/updates-view.ts';

/** D55: the update UI's state and copy (banner, dialog, Settings → Updates, the Inbox item's What's new). */

const BASE: UpdateStatus = {
  current: '1.0.0',
  install: { kind: 'release', dir: '/opt/switchboard-1.0.0' },
  restart: 'service',
  repo: 'acme/switchboard',
  checking: false,
  lastCheck: { at: '2026-09-30T08:00:00.000Z', ok: true, via: 'api', error: null },
  latest: { version: '1.1.0', tag: 'v1.1.0', name: 'Switchboard 1.1.0', notes: '- new', publishedAt: null, url: null },
  available: true,
  dismissed: null,
  progress: { phase: 'idle', version: null, message: '', error: null, dir: null, at: null },
  previous: null,
  liveSessions: 0,
};

function withPhase(phase: UpdatePhase, extra: Partial<UpdateStatus['progress']> = {}): UpdateStatus {
  return { ...BASE, progress: { ...BASE.progress, phase, version: '1.1.0', at: '2026-09-30T08:01:00.000Z', ...extra } };
}

describe('banner', () => {
  it('shows a newer release until it is dismissed', () => {
    expect(bannerKind(BASE, '1.0.0')).toBe('available');
    expect(bannerKind({ ...BASE, dismissed: '1.1.0' }, '1.0.0')).toBeNull();
    expect(bannerKind({ ...BASE, dismissed: '1.0.5' }, '1.0.0')).toBe('available');
    expect(bannerKind({ ...BASE, available: false }, '1.0.0')).toBeNull();
    expect(bannerKind(null, null)).toBeNull();
    expect(availableText('1.1.0')).toBe('Switchboard 1.1.0 is available');
    expect(hideKey(BASE, 'available')).toBeNull();
  });

  it("shows an update's progress, even when the release was dismissed; an ended one can be closed here", () => {
    const running = { ...withPhase('installing'), dismissed: '1.1.0' };
    expect(bannerKind(running, '1.0.0')).toBe('progress');
    expect(bannerState(running)).toBe('progress');
    const failed = withPhase('failed', { error: 'checksum mismatch' });
    const key = hideKey(failed, 'progress') ?? '';
    expect(bannerKind(failed, '1.0.0', new Set([key]))).toBeNull();
    expect(bannerKind(running, '1.0.0', new Set([hideKey(running, 'progress') ?? '']))).toBe('progress');
  });

  it('says "updated, reload" once the service runs another version than the page', () => {
    const after = { ...BASE, current: '1.1.0', available: false };
    expect(bannerKind(after, '1.0.0')).toBe('reload');
    expect(bannerKind(after, '1.0.0', new Set([hideKey(after, 'reload') ?? '']))).toBeNull();
  });
});

describe('update copy', () => {
  it('names each phase', () => {
    expect(phaseText(withPhase('downloading').progress)).toBe('Downloading Switchboard 1.1.0…');
    expect(phaseText(withPhase('verifying').progress)).toBe('Checking the SHA-256 checksum…');
    expect(phaseText(withPhase('installing').progress)).toBe('Installing dependencies (npm ci --omit=dev)…');
    expect(phaseText(withPhase('restarting').progress)).toBe('Restarting into 1.1.0… Sessions resume after the restart.');
    expect(phaseText(withPhase('restart-manually').progress)).toBe('Switchboard 1.1.0 is installed. Restart Switchboard to use it.');
    expect(phaseText(withPhase('failed', { error: 'npm ci --omit=dev failed: boom' }).progress)).toBe('Update failed: npm ci --omit=dev failed: boom');
    expect(updateRunning(withPhase('switching').progress)).toBe(true);
    expect(updateRunning(withPhase('failed').progress)).toBe(false);
  });

  it('warns about the sessions and how the restart happens', () => {
    expect(sessionsNote(0)).toBe('');
    expect(sessionsNote(1)).toBe('1 session will be resumed after the restart.');
    expect(sessionsNote(3)).toBe('3 sessions will be resumed after the restart.');
    expect(confirmText('1.1.0', 'service')).toMatch(/restarts through its login service\.$/);
    expect(confirmText('1.1.0', 'manual')).toMatch(/you restart it yourself afterwards\.$/);
    expect(manualStartCommand('/data/versions/1.1.0')).toBe('cd "/data/versions/1.1.0" && npm start');
  });

  it('gives a git checkout the commands, never the Update button', () => {
    expect(gitUpdateCommands('v1.1.0')).toEqual(['git fetch --tags origin', 'git merge --ff-only v1.1.0    # or: git pull --ff-only', 'npm ci', 'npm run build', '# then restart Switchboard']);
    expect(canUpdate({ ...BASE, install: { kind: 'git', dir: '/repo' } })).toBe(false);
    expect(installKindLabel('git')).toBe('git checkout');
    expect(installKindLabel('release')).toBe('release install');
  });

  it('offers Update only for a newer release with nothing running', () => {
    expect(canUpdate(BASE)).toBe(true);
    expect(canUpdate(withPhase('failed'))).toBe(true);
    expect(canUpdate(withPhase('extracting'))).toBe(false);
    expect(canUpdate(withPhase('restart-manually'))).toBe(false);
    expect(canUpdate({ ...BASE, available: false })).toBe(false);
    expect(canUpdate({ ...BASE, checking: true })).toBe(false);
    expect(canUpdate(null)).toBe(false);
  });
});

describe('Settings → Updates', () => {
  it('is a section after Machines', () => {
    // D73: Devices sits between Machines and Updates.
    expect(SETTINGS_SECTIONS.map((s) => s.key).slice(-3)).toEqual(['machines', 'devices', 'updates']);
    expect(resolveSection('updates')).toBe('updates');
  });

  it('describes the last check, the latest release and the restart', () => {
    expect(lastCheckText(null, '—')).toBe('not checked yet');
    expect(lastCheckText(BASE.lastCheck, 'Sep 30')).toBe('Sep 30 · GitHub API');
    expect(lastCheckText({ at: 'x', ok: true, via: 'gh', error: null }, 'Sep 30')).toBe('Sep 30 · through gh');
    expect(lastCheckText({ at: 'x', ok: false, via: null, error: "Can't reach releases" }, 'Sep 30')).toBe('Sep 30 · failed');
    expect(latestDescription(BASE)).toBe('Newer than yours (1.0.0)');
    expect(latestDescription({ ...BASE, available: false })).toBe("You're up to date");
    expect(latestDescription({ ...BASE, latest: null })).toBe('No release published yet');
    expect(restartRow(BASE).value).toBe('automatic');
    expect(restartRow({ ...BASE, restart: 'manual' }).value).toBe('by hand');
    expect(restartRow({ ...BASE, install: { kind: 'git', dir: '/r' } }).description).toMatch(/git/);
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen('nope')).toBe('—');
  });
});

describe("the Inbox item's What's new", () => {
  const item: InboxItem = { id: 'i', kind: 'system', sessionId: null, source: 'switchboard', status: 'idle', title: 'Switchboard 1.1.0 is available', label: 'Update available', detail: '', createdAt: '', branches: [] };
  it('opens Settings → Updates for this machine only', () => {
    expect(routeAfter(item, 'whats-new')).toBe('/settings/updates');
    expect(routeAfter(item, 'dismiss')).toBeNull();
    expect(routeAfter({ ...item, machine: { id: 'm', name: 'PC', state: 'online' } as unknown as InboxItem['machine'] }, 'whats-new')).toBeNull();
  });
});
