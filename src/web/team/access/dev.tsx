import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TeamNeedsYouItem } from '../../../core/team.ts';
import '../../fonts.ts';
import '../../styles/tokens.css';
import '../../styles/global.css';
import { onHubEvent } from '../../api/useHub.ts';
import { AccessRequestActions } from './AccessRequestActions.tsx';
import { AccessTab } from './AccessTab.tsx';

/**
 * D100-T2 · a stand-alone mount of the access UI (development and
 * `tests/e2e/team-access.spec.ts`): `/team-access-dev.html?member=<memberId>` shows
 * the member's access Needs-you items (Set up… / Deny / Not now) above its Access
 * tab, as T3's Team page will. Not linked from the app.
 */
function DevMount({ memberId }: { readonly memberId: string }) {
  const [items, setItems] = useState<TeamNeedsYouItem[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch('/api/team/needs-you', { credentials: 'same-origin' });
    if (response.ok) setItems(((await response.json()) as TeamNeedsYouItem[]).filter((item) => item.kind === 'access' && item.memberId === memberId));
  }, [memberId]);
  useEffect(() => {
    void load();
    return onHubEvent('teamChanged', () => void load());
  }, [load]);
  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Needs you</h2>
      <div data-testid="dev-needs-you" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.length === 0 ? <span style={{ fontSize: 12 }}>Nothing.</span> : null}
        {items.map((item) => (
          <div key={item.id} data-testid={`dev-needs-you-${item.id}`}>
            <div style={{ fontSize: 12, marginBottom: 4 }}>
              {item.label}: {item.title}
            </div>
            <AccessRequestActions item={item} onSetUp={(_member, accessId) => setFocus(accessId)} onDecided={() => void load()} />
          </div>
        ))}
      </div>
      <h2 style={{ margin: 0, fontSize: 16 }}>Access</h2>
      <AccessTab memberId={memberId} focusAccessId={focus} onChanged={() => void load()} />
    </div>
  );
}

const container = document.getElementById('root');
const memberId = new URLSearchParams(location.search).get('member') ?? '';
if (container) {
  createRoot(container).render(<StrictMode>{memberId ? <DevMount memberId={memberId} /> : <p>Add ?member=&lt;memberId&gt; to the URL.</p>}</StrictMode>);
}
