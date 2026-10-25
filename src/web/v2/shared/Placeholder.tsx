import type { ReactNode } from 'react';
import { themeStore } from '../../theme.ts';
import { Button, EmptyState } from '../components/index.ts';

/**
 * D131 · the placeholder of a v2 page its lane has not built yet (the area stubs):
 * the page's title and a way to the same page in the classic UI (the theme switch
 * keeps the address). Lanes replace it.
 */
export function Placeholder({ area, title, sub, lane, children }: { readonly area: string; readonly title: string; readonly sub?: string; readonly lane: string; readonly children?: ReactNode }) {
  return (
    <div className="v2-page" data-testid={`v2-page-${area}`} data-area={area}>
      <h1>{title}</h1>
      {sub ? <p className="v2-page-sub">{sub}</p> : null}
      {children}
      <EmptyState
        icon="sparkle"
        tone="grey"
        title="This page is being rebuilt for Switchboard 2"
        text={`Coming with lane ${lane}. Until then the classic page has everything.`}
        action={
          <Button icon="external" onClick={() => themeStore.choose('classic')} data-testid="v2-open-classic">
            Open the classic page
          </Button>
        }
      />
    </div>
  );
}
