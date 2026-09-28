import type { MouseEvent } from 'react';
import { CONTINUE_ANYWAY, CONTINUE_IN_SWITCHBOARD, SKIP, addFolderLabel, lastMoved, moveStateText, movesSettled } from './history-move.ts';
import type { ConversationMoves } from './useConversationMoves.ts';

/**
 * The move dialog of History (D16): one line per conversation being moved into
 * Switchboard with where it stands, and its actions when it waits for the
 * developer: **Add <folder> and continue** (no saved folder holds it), **Continue
 * anyway** (a terminal may still have it open), **Skip**; a refusal shows its
 * reason (**Open** when it is already in Switchboard). Once every conversation
 * is settled: **Open <last moved>** and Close; before that, Cancel skips the rest.
 * Over the view like the other modals (prototype overlay, SPEC tokens, mono
 * labels, pill buttons).
 */
export function MoveDialog({ moves, onOpen }: { readonly moves: ConversationMoves; readonly onOpen: (sessionId: string) => void }) {
  const items = moves.items ?? [];
  const settled = movesSettled(items);
  const last = lastMoved(items);
  const close = (): void => {
    if (settled) moves.close();
  };
  return (
    <div className="sb-hist-move-overlay" data-testid="move-dialog-overlay" onClick={close}>
      <div
        className="sb-hist-move"
        role="dialog"
        aria-modal="true"
        aria-label={CONTINUE_IN_SWITCHBOARD}
        data-testid="move-dialog"
        data-settled={settled ? 'true' : 'false'}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <div className="sb-hist-move-head">
          <div className="sb-hist-move-title">{CONTINUE_IN_SWITCHBOARD}</div>
          <div className="sb-hist-move-sub">{`${items.length} conversation${items.length === 1 ? '' : 's'} · same conversation, history imported`}</div>
        </div>
        <div className="sb-hist-move-items">
          {items.map((item) => {
            const state = item.state;
            return (
              <div key={item.claudeSessionId} className="sb-hist-move-item" data-testid="move-item" data-claude-session-id={item.claudeSessionId} data-state={state.kind}>
                <div className="sb-hist-move-name">{item.title}</div>
                <div className="sb-hist-move-state" data-testid="move-state" data-kind={state.kind}>
                  {moveStateText(state)}
                </div>
                {state.kind === 'needs-folder' || state.kind === 'terminal-open' || (state.kind === 'refused' && state.sessionId) ? (
                  <div className="sb-hist-move-actions">
                    {state.kind === 'needs-folder' ? (
                      <button type="button" className="sb-button sb-hist-move-primary" data-testid="move-add-folder" disabled={moves.busy} onClick={() => moves.addFolder(item.claudeSessionId)}>
                        {addFolderLabel(state.check)}
                      </button>
                    ) : null}
                    {state.kind === 'terminal-open' ? (
                      <button type="button" className="sb-button sb-hist-move-primary" data-testid="move-confirm" disabled={moves.busy} onClick={() => moves.confirm(item.claudeSessionId)}>
                        {CONTINUE_ANYWAY}
                      </button>
                    ) : null}
                    {state.kind === 'refused' && state.sessionId ? (
                      <button type="button" className="sb-button sb-hist-move-outlined" data-testid="move-open-existing" onClick={() => onOpen(state.sessionId as string)}>
                        Open
                      </button>
                    ) : (
                      <button type="button" className="sb-button sb-hist-move-outlined" data-testid="move-skip" onClick={() => moves.skip(item.claudeSessionId)}>
                        {SKIP}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="sb-hist-move-footer">
          {settled ? (
            <>
              {last ? (
                <button type="button" className="sb-button sb-hist-move-primary" data-testid="move-open" onClick={() => onOpen(last.sessionId)}>
                  {`Open ${last.name}`}
                </button>
              ) : null}
              <button type="button" className="sb-button sb-hist-move-outlined" data-testid="move-close" onClick={() => moves.close()}>
                Close
              </button>
            </>
          ) : (
            <button type="button" className="sb-button sb-hist-move-outlined" data-testid="move-cancel" onClick={() => moves.cancel()}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
