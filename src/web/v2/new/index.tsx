import type { NewSessionPrefill } from '../../../core/api.ts';
import { openStore } from '../shared/open-store.ts';
import { NewCrewDialogs } from './CrewDialogs.tsx';
import { NewSheetBody } from './NewSheet.tsx';
import { type NewKindId, opensDialog } from './new-model.ts';

/** What the + New sheet can make (the prototype's types). */
export type NewKind = NewKindId;

/** How the sheet opens: the kind, and what to fill in (an Inbox "Fix it in a new agent", a start box's text). */
export interface NewRequest {
  readonly kind: NewKind;
  readonly text?: string;
  readonly prefill?: NewSessionPrefill;
  /** Start it on a paired computer. */
  readonly machine?: string | null;
}

const sheet = openStore<NewRequest>();
let openings = 0;
let current: { readonly request: NewRequest; readonly key: number } | null = null;

/** D131 · opens the + New sheet from anywhere (the top bar's + New, Home's start box, an answer card, ⌘K). */
export function openNew(request: NewRequest): void {
  openings += 1;
  current = { request, key: openings };
  sheet.open(request);
}

/**
 * D131 · lane R · the + New sheet (`docs/design/v2-prototype.html` → `#m-new`):
 * one sheet with the kinds Agent / Conversation / Task / Project / Routine /
 * Teammate / Crew, each on its existing API (Teammate and Crew hand over to the
 * Crews dialogs, `CrewDialogs.tsx`), Save as draft (the `new-session`
 * machine draft, D88) and ⌘↩. The shell renders it once; `NewSheet.tsx` is the
 * body, `new-model.ts` its pure part.
 */
export function NewSheet() {
  const request = sheet.use();
  if (request === null) return null;
  const key = current?.request === request ? current.key : 0;
  const kind = request.kind;
  // Teammate and Crew open the Crews dialogs (one New teammate / New crew for the whole app, lane X).
  if (opensDialog(kind)) return <NewCrewDialogs key={key} kind={kind} onClose={sheet.close} />;
  return <NewSheetBody key={key} request={{ ...request, kind }} onClose={sheet.close} onDialog={(next) => openNew({ ...request, kind: next })} />;
}
