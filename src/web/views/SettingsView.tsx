import { useState } from 'react';
import type { Settings } from '../../core/api.ts';
import { type KnownSettings, readKnownSettings } from '../../core/settings.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { Link } from '../router.tsx';
import { SETTINGS_SECTIONS, type SettingsSection, resolveSection } from './settings/model.ts';
import { ClaudeSection, GithubSection, NotifySection, type SaveSettings, SchedulesSection, SessionsSection } from './settings/sections.tsx';
import { ToolsSection } from './settings/ToolsSection.tsx';
import { MachinesSection } from './settings/MachinesSection.tsx';
import { WorkspaceSection } from './settings/WorkspaceSection.tsx';
import './settings.css';

function Section({ section, settings, save }: { readonly section: SettingsSection; readonly settings: KnownSettings; readonly save: SaveSettings }) {
  switch (section) {
    case 'claude':
      return <ClaudeSection settings={settings} />;
    case 'workspace':
      return <WorkspaceSection />;
    case 'sessions':
      return <SessionsSection settings={settings} save={save} />;
    case 'notify':
      return <NotifySection settings={settings} save={save} />;
    case 'schedules':
      return <SchedulesSection />;
    case 'tools':
      return <ToolsSection />;
    case 'github':
      return <GithubSection settings={settings} />;
    case 'machines':
      return <MachinesSection />;
  }
}

/**
 * Settings (SPEC → Settings, M8.2, `docs/settings.md`): `230px nav | content (max
 * 860px)` with the seven sections of the prototype, one per URL
 * (`/settings/<section>`, Claude Code by default); D14 turned *Workspace &
 * solutions* into *Folders* (`/settings/workspace`, also `/settings/folders`). Preferences are stored by the
 * service in SQLite (`GET/PUT /api/settings`); tool URLs through `PUT /api/tools`.
 */
export function SettingsView({ section }: { readonly section: string | null }) {
  const current = resolveSection(section);
  const loaded = useApi(api.settings);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const body = saved ?? loaded.data;
  const settings = body ? readKnownSettings(body) : null;

  const save: SaveSettings = async (patch) => {
    try {
      setSaved(await api.saveSettings(patch));
      setSaveError(null);
    } catch {
      setSaveError('The setting could not be saved.');
    }
  };

  return (
    <section className="sb-view sb-settings-view" data-view="settings" data-testid="view-settings" data-section={current}>
      <nav className="sb-set-nav" aria-label="Settings sections">
        <div className="sb-set-nav-title">Settings</div>
        {SETTINGS_SECTIONS.map((item) => (
          <Link
            key={item.key}
            to={{ view: 'settings', section: item.key }}
            className="sb-set-nav-item"
            data-testid={`settings-nav-${item.key}`}
            aria-current={item.key === current ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="sb-set-content" data-testid="settings-content">
        {settings ? <Section section={current} settings={settings} save={save} /> : null}
        {!settings && loaded.error ? (
          <div className="sb-set-note sb-set-error" data-testid="settings-note">
            Settings could not be loaded.
          </div>
        ) : null}
        {saveError ? (
          <div className="sb-set-note sb-set-error" role="alert" data-testid="settings-save-error">
            {saveError}
          </div>
        ) : null}
      </div>
    </section>
  );
}
