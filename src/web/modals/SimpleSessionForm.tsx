import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import type { NewSessionMode } from '../../core/settings.ts';
import { AttachButton, type AttachmentDraft, AttachmentChips, pasteFiles, useFileDrop } from '../components/Attachments.tsx';
import { attachmentsBlocker } from '../components/attachments.ts';
import { MODEL_ROW_DESCRIPTION, MODEL_ROW_TITLE, type FormFolder, type NewSessionForm } from './new-session.ts';
import {
  MODE_OPTIONS,
  PLAIN_NOTE,
  WORKSPACE_NOTE,
  WORKTREE_LABEL,
  branchProblem,
  canStartSimple,
  isStartShortcut,
  offersWorktree,
  simpleBlockers,
  simpleBranch,
  startShortcutLabel,
  titlePlaceholder,
  usesWorktree,
  whereLine,
} from './simple-session.ts';

/**
 * D56 · the Simple / Full switch at the top of the New-session dialog (a
 * two-button radio group, the Full form's pill look). The dialog remembers the
 * pick (`newSession.mode`).
 */
export function ModeToggle({ mode, onPick, disabled = false }: { readonly mode: NewSessionMode; readonly onPick: (mode: NewSessionMode) => void; readonly disabled?: boolean }) {
  return (
    <div className="sb-ns-mode" role="radiogroup" aria-label="Form" data-testid="ns-mode" data-mode={mode}>
      {MODE_OPTIONS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          className="sb-button sb-ns-mode-option"
          data-testid={`ns-mode-${value}`}
          data-selected={mode === value ? 'true' : 'false'}
          disabled={disabled}
          onClick={() => {
            if (mode !== value) onPick(value);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** What the simple form gets from the dialog (the shared state and the parts both forms render). */
export interface SimpleSessionFormProps {
  readonly form: NewSessionForm;
  readonly update: (patch: Partial<NewSessionForm>) => void;
  readonly folder: FormFolder | null;
  readonly takenNames: readonly string[];
  /** The edited worktree branch (`null` = derived). */
  readonly branch: string | null;
  readonly onBranch: (branch: string | null) => void;
  /** The mode switch ({@link ModeToggle}). */
  readonly toggle: ReactNode;
  /** D48's Machine row (only with a paired machine), else `null`. */
  readonly machineRow: ReactNode;
  /** The Folder row (dropdown, Browse…, check line) and the add-a-folder panel under it. */
  readonly folderRow: ReactNode;
  /** D42's model picker, starting on the last choice. */
  readonly modelPicker: ReactNode;
  /** D62: the CLI choice (Claude Code / Codex CLI / OpenCode), on the default CLI. */
  readonly cliPicker?: ReactNode;
  readonly error: string | null;
  readonly busy: boolean;
  /** D57: the message's attachments (uploaded at Start); `undefined` = none offered. */
  readonly attachments?: AttachmentDraft;
  readonly onStart: () => void;
  readonly onClose: () => void;
}

/**
 * D56 · the simple New-session form (`docs/new-session.md` → *Simple mode
 * (D56)*): one 600px column. Folder (the saved folders, as in the Full form),
 * the message (a textarea: Enter types a new line, ⌘↩ / Ctrl+↩ starts), the
 * optional title (its placeholder is the title the message gives), the model
 * and, for a git repo folder, "Work in its own git worktree" with the derived
 * branch (read-only, **Edit** makes it a field). A muted line says where the
 * session runs; a workspace folder adds that no session-start answers are sent,
 * D59: a plain folder (any other folder) that the message goes alone.
 * Start posts a `NewSimpleSession`; a refusal stays as one line.
 */
export function SimpleSessionForm(props: SimpleSessionFormProps) {
  const { form, update, folder, takenNames, branch, onBranch, error, busy } = props;
  const [editing, setEditing] = useState(false);
  const messageId = useId();
  const titleId = useId();
  const start = { form, folder, branch, takenNames };
  const worktree = usesWorktree(form, folder);
  const branchName = simpleBranch(form, branch, takenNames);
  const problem = worktree ? branchProblem(branchName) : null;
  const blockers = simpleBlockers(start);
  const attachments = props.attachments;
  const attaching = attachments ? attachmentsBlocker(attachments.items) : null;
  const startable = canStartSimple(start) && !busy && attaching === null;
  const noop = (): void => undefined;
  const drop = useFileDrop(attachments?.add ?? noop, attachments !== undefined);
  const shortcut = startShortcutLabel(typeof navigator === 'undefined' ? '' : navigator.platform);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const { key, metaKey, ctrlKey, shiftKey, altKey } = event;
    if (!isStartShortcut({ key, metaKey, ctrlKey, shiftKey, altKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    if (startable) props.onStart();
  };

  return (
    <div className="sb-ns-simple" data-testid="ns-simple" onKeyDown={onKeyDown}>
      <div className="sb-ns-head sb-ns-simple-head">
        <div className="sb-ns-title" data-testid="ns-title">
          New session
        </div>
        <div className="sb-ns-sub">Claude Code · background · Max</div>
        {props.toggle}
      </div>

      {props.machineRow}

      <div className="sb-ns-simple-field" data-testid="ns-simple-field" data-field="folder" data-kind={folder?.kind}>
        <div className="sb-ns-label">Folder</div>
        {props.folderRow}
      </div>

      <div
        className="sb-ns-simple-field sb-ns-message-drop"
        data-testid="ns-simple-field"
        data-field="message"
        data-dragging={drop.dragging ? 'true' : undefined}
        {...drop.handlers}
      >
        <label className="sb-ns-label" htmlFor={messageId}>
          Message
        </label>
        <textarea
          id={messageId}
          className="sb-ns-input sb-ns-message"
          data-testid="ns-message"
          rows={5}
          value={form.task}
          placeholder="What should Claude do? This is the session's first message."
          autoFocus
          onChange={(event) => update({ task: event.target.value })}
          onPaste={attachments ? pasteFiles(attachments.add) : undefined}
        />
        {attachments ? (
          <div className="sb-ns-attach-row" data-testid="ns-attach-row">
            <AttachButton onFiles={attachments.add} />
            <AttachmentChips items={attachments.items} notice={attachments.notice} onRemove={attachments.remove} />
          </div>
        ) : null}
      </div>

      <div className="sb-ns-simple-field" data-testid="ns-simple-field" data-field="title">
        <label className="sb-ns-label" htmlFor={titleId}>
          Title <span className="sb-ns-simple-optional">optional</span>
        </label>
        <input
          id={titleId}
          className="sb-ns-input"
          data-testid="ns-simple-title"
          value={form.name}
          placeholder={titlePlaceholder(form)}
          spellCheck={false}
          onChange={(event) => update({ name: event.target.value })}
        />
      </div>

      {props.cliPicker ? (
        <div className="sb-ns-simple-row" data-testid="ns-simple-cli">
          <div className="sb-ns-toggle-text">
            <div className="sb-ns-toggle-title">CLI</div>
            <div className="sb-ns-toggle-desc">The agent CLI the session runs on</div>
          </div>
          {props.cliPicker}
        </div>
      ) : null}

      <div className="sb-ns-simple-row" data-testid="ns-simple-model">
        <div className="sb-ns-toggle-text">
          <div className="sb-ns-toggle-title">{MODEL_ROW_TITLE}</div>
          <div className="sb-ns-toggle-desc">{MODEL_ROW_DESCRIPTION}</div>
        </div>
        {props.modelPicker}
      </div>

      {offersWorktree(folder) ? (
        <div className="sb-ns-simple-worktree" data-testid="ns-simple-worktree">
          <label className="sb-ns-simple-check">
            <input type="checkbox" data-testid="ns-worktree" checked={form.worktrees} onChange={(event) => update({ worktrees: event.target.checked })} />
            <span>{WORKTREE_LABEL}</span>
          </label>
          {worktree ? (
            <div className="sb-ns-simple-branch" data-testid="ns-simple-branch-row">
              <span className="sb-ns-simple-branch-mark">⎇</span>
              {editing ? (
                <input
                  className="sb-ns-input sb-ns-simple-branch-input"
                  data-testid="ns-simple-branch"
                  aria-label="Branch"
                  aria-invalid={problem !== null}
                  value={branchName}
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                  onChange={(event) => onBranch(event.target.value)}
                />
              ) : (
                <span className="sb-ns-simple-branch-name" data-testid="ns-simple-branch-name" data-derived={branch === null ? 'true' : 'false'}>
                  {branchName}
                </span>
              )}
              {editing ? (
                <button
                  type="button"
                  className="sb-button sb-ns-simple-link"
                  data-testid="ns-simple-branch-reset"
                  onClick={() => {
                    onBranch(null);
                    setEditing(false);
                  }}
                >
                  Use derived
                </button>
              ) : (
                <button type="button" className="sb-button sb-ns-simple-link" data-testid="ns-simple-branch-edit" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
            </div>
          ) : null}
          {problem ? (
            <div className="sb-ns-simple-problem" data-testid="ns-simple-branch-problem">
              {problem}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="sb-ns-simple-where" data-testid="ns-simple-where">
        <div>{whereLine(start)}</div>
        {folder && folder.kind === 'workspace' ? <div data-testid="ns-simple-workspace-note">{WORKSPACE_NOTE}</div> : null}
        {folder && folder.kind === 'plain' ? <div data-testid="ns-simple-plain-note">{PLAIN_NOTE}</div> : null}
      </div>

      {error ? (
        <div className="sb-ns-error sb-ns-simple-error" data-testid="ns-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="sb-ns-simple-actions">
        <span className="sb-ns-simple-waiting" data-testid="ns-simple-waiting">
          {blockers.length > 0 ? blockers[0] : (attaching ?? '')}
        </span>
        <button type="button" className="sb-button sb-ns-cancel" data-testid="ns-cancel" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-ns-start sb-ns-simple-start" data-testid="ns-start" disabled={!startable} title={`Start session (${shortcut})`} onClick={props.onStart}>
          Start session <span className="sb-ns-simple-kbd">{shortcut}</span>
        </button>
      </div>
    </div>
  );
}
