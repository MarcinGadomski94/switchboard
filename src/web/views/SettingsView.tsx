/**
 * Settings (SPEC → Settings): `230px nav | content`, 7 sections. Placeholder from
 * M1.4 (docs/lanes.md); M8.2 fills it (M5.3 "Run setup again", M8.1 Embedded tools).
 */
export function SettingsView({ section }: { readonly section: string | null }) {
  return <section className="sb-view" data-view="settings" data-testid="view-settings" data-section={section ?? ''} />;
}
