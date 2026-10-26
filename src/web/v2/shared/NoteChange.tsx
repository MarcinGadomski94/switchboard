import { type MemoryEntry, changeKindOf, memoryWordDiff } from '../../../core/memory.ts';
// Project memory (D107) hook (docs/memory-removal.md): the import above.
import { NOTES_WORDS } from '../glossary.ts';
import './shared.css';

/** One side of the comparison: `before` → `after` word by word; "now" marks what goes, "proposed" what comes. */
function Side({ before, after, side, testId }: { readonly before: string; readonly after: string; readonly side: 'now' | 'proposed'; readonly testId: string }) {
  const parts = memoryWordDiff(before, after).filter((part) => part.kind === 'same' || part.kind === (side === 'now' ? 'del' : 'add'));
  return (
    <span data-testid={testId}>
      {parts.map((part, index) =>
        part.kind === 'same' ? (
          <span key={index}>{part.text}</span>
        ) : part.kind === 'del' ? (
          <del key={index} className="v2-nc-del">
            {part.text}
          </del>
        ) : (
          <ins key={index} className="v2-nc-add">
            {part.text}
          </ins>
        ),
      )}
    </span>
  );
}

/**
 * D135 · a proposed change of an approved note, as the Notes page and the Needs-you card show it:
 * an **edit** side by side (the note now, with the removed words struck, and as proposed, with the
 * added words marked; one column on a phone), a **removal** as the note that would go; then the
 * agent's reason. `entry.target` is the note now (`null` once it is gone).
 */
export function NoteChange({ entry }: { readonly entry: MemoryEntry }) {
  const kind = changeKindOf(entry);
  const target = entry.target ?? null;
  const now = target ?? { title: entry.targetTitle ?? entry.title, text: entry.targetText ?? entry.text };
  return (
    <div className="v2-nc" data-testid="v2-note-change" data-change={kind}>
      {target === null ? (
        <p className="v2-nc-gone" role="note" data-testid="v2-note-change-gone">
          {NOTES_WORDS.targetGone}
        </p>
      ) : null}
      {kind === 'edit' ? (
        <div className="v2-nc-compare">
          <div className="v2-nc-side" data-testid="v2-note-change-now">
            <div className="v2-nc-label">{NOTES_WORDS.now}</div>
            <div className="v2-nc-title">
              <Side before={now.title} after={entry.title} side="now" testId="v2-note-change-now-title" />
            </div>
            <div className="v2-nc-text">
              <Side before={now.text} after={entry.text} side="now" testId="v2-note-change-now-text" />
            </div>
          </div>
          <div className="v2-nc-side v2-nc-side--proposed" data-testid="v2-note-change-proposed">
            <div className="v2-nc-label">{NOTES_WORDS.proposedSide}</div>
            <div className="v2-nc-title">
              <Side before={now.title} after={entry.title} side="proposed" testId="v2-note-change-proposed-title" />
            </div>
            <div className="v2-nc-text">
              <Side before={now.text} after={entry.text} side="proposed" testId="v2-note-change-proposed-text" />
            </div>
          </div>
        </div>
      ) : (
        <div className="v2-nc-side v2-nc-side--removed" data-testid="v2-note-change-removed">
          <div className="v2-nc-label">{NOTES_WORDS.wouldBeRemoved}</div>
          <div className="v2-nc-title">{now.title}</div>
          <div className="v2-nc-text">{now.text}</div>
        </div>
      )}
      <p className="v2-nc-reason" data-testid="v2-note-change-reason">
        <b>{NOTES_WORDS.why}:</b> {entry.reason ?? NOTES_WORDS.noReason}
      </p>
    </div>
  );
}
