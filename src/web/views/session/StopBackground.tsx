import { type KeyboardEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BackgroundTask } from '../../../core/api.ts';
import {
  STOP_BACKGROUND_CANCEL,
  STOP_BACKGROUND_CONFIRM,
  STOP_BACKGROUND_LABEL,
  STOP_BACKGROUND_TITLE,
  STOP_BACKGROUND_TOOLTIP,
  WAKEUP_NOT_STOPPED,
  stoppableTask,
} from '../../../core/stop-turn.ts';
import { backgroundText } from '../../activity/activity.ts';
import { ApiError, api } from '../../api/client.ts';
import { refusalText } from '../inbox.ts';
import '../../components/close-session.css';

/**
 * D50 ruling (background): while no turn runs but background tasks do, the
 * composer offers **Stop background tasks** beside Send (`stoppableBackground`).
 * It opens a confirmation listing the tasks (the activity line's words; a wake-up
 * is listed as a timer the CLI cannot stop); **Stop tasks** posts
 * `POST /api/sessions/{id}/background/stop` with the stoppable ones (`stop_task`
 * each). Only this button and its confirmation do it: Esc never does.
 */
export function StopBackground({ sessionId, tasks }: { readonly sessionId: string; readonly tasks: readonly BackgroundTask[] }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.stopBackground(sessionId, { taskIds: tasks.filter(stoppableTask).map((task) => task.id) });
      if (result.failed.length > 0) setError(`Not stopped: ${result.failed.map((item) => `${item.id} (${item.error})`).join(', ')}`);
      else setAsking(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? refusalText(caught.status, caught.body) : refusalText(0, null));
    } finally {
      setBusy(false);
    }
  };
  const cancel = (): void => {
    if (busy) return;
    setAsking(false);
    setError(null);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancel();
    }
  };

  return (
    <>
      <button
        type="button"
        className="sb-button sb-chat-stop-background"
        data-testid="chat-stop-background"
        title={STOP_BACKGROUND_TOOLTIP}
        onClick={() => setAsking(true)}
      >
        ■ {STOP_BACKGROUND_LABEL}
      </button>
      {asking
        ? createPortal(
            <div className="sb-close-overlay" data-testid="stop-background-overlay" onClick={cancel} onKeyDown={onKeyDown}>
              <div
                className="sb-close-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="sb-stop-background-title"
                data-testid="stop-background-confirm"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="sb-close-text" id="sb-stop-background-title">
                  {STOP_BACKGROUND_TITLE}
                </div>
                <ul className="sb-stop-background-list">
                  {tasks.map((task) => (
                    <li key={task.id} data-testid="stop-background-task" data-task-id={task.id} data-stoppable={stoppableTask(task) ? 'true' : 'false'}>
                      {backgroundText(task)}
                      {stoppableTask(task) ? null : <span className="sb-stop-background-note"> · {WAKEUP_NOT_STOPPED}</span>}
                    </li>
                  ))}
                </ul>
                {error ? (
                  <div className="sb-close-error" role="alert" data-testid="stop-background-error">
                    {error}
                  </div>
                ) : null}
                <div className="sb-close-actions">
                  <button type="button" className="sb-button sb-close-primary" data-testid="stop-background-yes" disabled={busy} aria-busy={busy || undefined} onClick={() => void confirm()}>
                    {STOP_BACKGROUND_CONFIRM}
                  </button>
                  <button type="button" className="sb-button sb-close-outlined" data-testid="stop-background-cancel" disabled={busy} autoFocus onClick={cancel}>
                    {STOP_BACKGROUND_CANCEL}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
