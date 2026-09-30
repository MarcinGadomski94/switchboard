import { ChatMarkdown } from '../views/session/ChatMarkdown.tsx';

/** A release's notes as GitHub-flavored Markdown (D20's renderer: no raw HTML, no images, safe links). */
export function ReleaseNotes({ notes }: { readonly notes: string }) {
  return (
    <div className="sb-update-notes" data-testid="update-notes">
      {notes.trim() ? <ChatMarkdown text={notes} /> : <div className="sb-update-muted">This release has no notes.</div>}
    </div>
  );
}
