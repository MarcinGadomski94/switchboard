import type { NewSessionPrefill } from '../../../core/api.ts';
import { Button, Dialog } from '../components/index.ts';
import { openStore } from '../shared/open-store.ts';

/** What the + New sheet can make (the prototype's types). */
export type NewKind = 'agent' | 'conversation' | 'task' | 'project' | 'routine' | 'teammate' | 'crew';

/** How the sheet opens: the kind, and what to fill in (an Inbox "Fix it in a new agent", a start box's text). */
export interface NewRequest {
  readonly kind: NewKind;
  readonly text?: string;
  readonly prefill?: NewSessionPrefill;
  /** Start it on a paired computer. */
  readonly machine?: string | null;
}

const sheet = openStore<NewRequest>();

/** D131 · opens the + New sheet from anywhere (the top bar's + New, Home's start box, an answer card). */
export function openNew(request: NewRequest): void {
  sheet.open(request);
}

/**
 * D131 · the + New sheet (lane R): agent / conversation / task / project / routine
 * / teammate / crew. The shell renders it once; this stub only says what it will
 * be. See `README.md`.
 */
export function NewSheet() {
  const request = sheet.use();
  return (
    <Dialog open={request !== null} onClose={sheet.close} title="Start something new" icon="plus" testId="v2-new-sheet" footer={<Button onClick={sheet.close}>Close</Button>}>
      <p className="v2-muted" style={{ margin: 0 }}>
        The new + New sheet ({request?.kind ?? 'agent'}) is coming with lane R. Until then, start it from the classic UI (Settings › Appearance › Theme).
      </p>
    </Dialog>
  );
}
