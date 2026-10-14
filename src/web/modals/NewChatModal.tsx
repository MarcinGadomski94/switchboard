import { type KeyboardEvent, type MouseEvent, useId, useState } from 'react';
import type { ModelSettings } from '../../core/api.ts';
import { CHAT_LOCKED_HINT, LOOK_AT_MAX, chatTitleFromMessage } from '../../core/chats.ts';
import { DEFAULT_MODEL_CHOICE, type ModelChoice } from '../../core/model-choice.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import { ApiError, api, machineApi } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { AttachButton, AttachmentChips, pasteFiles, useAttachmentDraft, useFileDrop } from '../components/Attachments.tsx';
import { attachmentsBlocker } from '../components/attachments.ts';
import { AccountPicker } from '../components/AccountPicker.tsx';
import { CliPicker } from '../components/CliPicker.tsx';
import { effectiveCli } from '../components/cli.ts';
import { useSavedFolders } from '../folders/useFolders.ts';
import { useRouter } from '../router.tsx';
import { ModelChoicePicker } from '../views/session/ModelPicker.tsx';
import { MODEL_ROW_DESCRIPTION, MODEL_ROW_TITLE, NO_MODEL_SETTINGS, formModel, formModelOptions, formModelPicker, pickFormEffort, pickFormModel, startErrorText } from './new-session.ts';
import { isStartShortcut, startShortcutLabel } from './simple-session.ts';
import './chats.css';

/**
 * D106 · the folders a chat may read (the New-chat form and the chat's ⋯ → Look at
 * folders…): the list with a × per folder, a path field with **Add** (an absolute
 * path; the server checks it exists), and the saved folders as one-click chips.
 */
export function LookAtField({ value, onChange, disabled = false, testId = 'look-at' }: { readonly value: readonly string[]; readonly onChange: (next: string[]) => void; readonly disabled?: boolean; readonly testId?: string }) {
  const [typed, setTyped] = useState('');
  const saved = useSavedFolders();
  const full = value.length >= LOOK_AT_MAX;
  const add = (path: string): void => {
    const trimmed = path.trim();
    if (trimmed === '' || value.includes(trimmed) || full) return;
    onChange([...value, trimmed]);
    setTyped('');
  };
  const offered = (saved.data ?? []).filter((folder) => !value.includes(folder.path) && !value.includes(folder.canonicalPath));
  return (
    <div className="sb-look-at" data-testid={testId}>
      {value.length > 0 ? (
        <ul className="sb-look-at-list" data-testid={`${testId}-list`}>
          {value.map((path) => (
            <li key={path} className="sb-look-at-item" data-testid={`${testId}-item`}>
              <span className="sb-look-at-path" title={path}>
                {path}
              </span>
              <button type="button" className="sb-button sb-look-at-remove" aria-label={`Stop looking at ${path}`} disabled={disabled} onClick={() => onChange(value.filter((entry) => entry !== path))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="sb-look-at-add">
        <input
          className="sb-ns-input"
          data-testid={`${testId}-input`}
          value={typed}
          placeholder="/absolute/path/to/a/folder"
          spellCheck={false}
          disabled={disabled || full}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add(typed);
            }
          }}
        />
        <button type="button" className="sb-button sb-ns-cancel" data-testid={`${testId}-add`} disabled={disabled || full || typed.trim() === ''} onClick={() => add(typed)}>
          Add
        </button>
      </div>
      {offered.length > 0 && !full ? (
        <div className="sb-look-at-saved" data-testid={`${testId}-saved`}>
          {offered.map((folder) => (
            <button key={folder.id} type="button" className="sb-button sb-look-at-chip" title={folder.path} disabled={disabled} onClick={() => add(folder.path)}>
              + {folder.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * D106 · the New-chat form (`docs/chats.md` → *Starting a chat*): minimal on purpose:
 * the message with its attachments, the CLI and account, the model and effort (the
 * New-session form's pickers), and optional folders to look at (read-only). The chat's
 * title comes from the message; it runs in its own scratch folder in plan mode. Start
 * (⌘↩) posts `POST /api/chats` and opens the chat.
 */
export function NewChatModal({ onClose }: { readonly onClose: () => void }) {
  const { navigate } = useRouter();
  const messageId = useId();
  const [message, setMessage] = useState('');
  const [picked, setPicked] = useState<CliProviderId | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [lookAt, setLookAt] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attach = useAttachmentDraft();
  const drop = useFileDrop(attach.add);
  const clis = useApi(() => api.clis().catch(() => null), []);
  const provider = effectiveCli(picked, clis.data ?? null);
  const models = useApi(() => machineApi(null).models(provider).then((settings) => ({ provider, settings })), [provider]);
  const modelSettings: ModelSettings | null = models.data?.provider === provider ? models.data.settings : models.error ? NO_MODEL_SETTINGS : null;
  const form = { model };
  const choice = formModel(form, modelSettings, provider);
  const attaching = attachmentsBlocker(attach.items);
  const startable = message.trim() !== '' && !busy && attaching === null;
  const shortcut = startShortcutLabel(typeof navigator === 'undefined' ? '' : navigator.platform);

  const start = async (): Promise<void> => {
    if (!startable) return;
    setBusy(true);
    setError(null);
    try {
      const ids = attach.items.length > 0 ? await attach.uploadAll((body) => machineApi(null).uploadAttachment(body)) : [];
      const chat = await api.createChat({
        message,
        provider,
        ...(profileId ? { profileId } : {}),
        ...(choice ? { model: choice.model, effort: choice.effort } : {}),
        ...(lookAt.length > 0 ? { lookAt } : {}),
        ...(ids.length > 0 ? { attachments: ids } : {}),
      });
      onClose();
      navigate({ view: 'session', id: chat.id, tab: 'chat' });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(startErrorText(apiError.status, apiError.body));
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const { key, metaKey, ctrlKey, shiftKey, altKey } = event;
    if (!isStartShortcut({ key, metaKey, ctrlKey, shiftKey, altKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    void start();
  };

  return (
    <div className="sb-overlay" data-modal="new-chat" onClick={onClose}>
      <div className="sb-modal-simple" role="dialog" aria-modal="true" aria-label="New chat" data-testid="modal-new-chat" onClick={(event: MouseEvent) => event.stopPropagation()}>
        <div className="sb-ns-simple" data-testid="nc-form" onKeyDown={onKeyDown}>
          <div className="sb-ns-head sb-ns-simple-head">
            <div className="sb-ns-title" data-testid="nc-title">
              New chat
            </div>
            <div className="sb-ns-sub" data-testid="nc-sub">
              {CHAT_LOCKED_HINT}
            </div>
          </div>

          <div className="sb-ns-simple-field sb-ns-message-drop" data-field="message" data-dragging={drop.dragging ? 'true' : undefined} {...drop.handlers}>
            <label className="sb-ns-label" htmlFor={messageId}>
              Message
            </label>
            <textarea
              id={messageId}
              className="sb-ns-input sb-ns-message"
              data-testid="nc-message"
              rows={5}
              value={message}
              placeholder="What do you want to think through? The chat's title comes from this first line."
              autoFocus
              disabled={busy}
              onChange={(event) => {
                setMessage(event.target.value);
                setError(null);
              }}
              onPaste={pasteFiles(attach.add)}
            />
            <div className="sb-ns-attach-row" data-testid="nc-attach-row">
              <AttachButton onFiles={attach.add} />
              <AttachmentChips items={attach.items} notice={attach.notice} onRemove={attach.remove} />
            </div>
            {message.trim() !== '' ? (
              <div className="sb-nc-title-preview" data-testid="nc-title-preview">
                Title: {chatTitleFromMessage(message)}
              </div>
            ) : null}
          </div>

          <div className="sb-ns-simple-row" data-testid="nc-cli">
            <div className="sb-ns-toggle-text">
              <div className="sb-ns-toggle-title">CLI</div>
              <div className="sb-ns-toggle-desc">Runs in its read-only / plan mode</div>
            </div>
            <span className="sb-cli-picker-group">
              <CliPicker
                testId="nc-cli-picker"
                value={provider}
                overview={clis.data ?? null}
                disabled={busy}
                onPick={(next) => {
                  setPicked(next);
                  setModel(null);
                  setProfileId(null);
                }}
              />
              <AccountPicker machine={null} provider={provider} value={profileId} onPick={setProfileId} testId="nc-account" disabled={busy} />
            </span>
          </div>

          <div className="sb-ns-simple-row" data-testid="nc-model">
            <div className="sb-ns-toggle-text">
              <div className="sb-ns-toggle-title">{MODEL_ROW_TITLE}</div>
              <div className="sb-ns-toggle-desc">{MODEL_ROW_DESCRIPTION}</div>
            </div>
            <ModelChoicePicker
              testId="nc-model-picker"
              picker={formModelPicker(form, modelSettings, provider)}
              keepEscape
              onPickModel={(value) => setModel(pickFormModel(choice ?? DEFAULT_MODEL_CHOICE, formModelOptions(modelSettings, provider), value))}
              onPickEffort={(value) => setModel(pickFormEffort(choice ?? DEFAULT_MODEL_CHOICE, value))}
            />
          </div>

          <div className="sb-ns-simple-field" data-field="look-at">
            <div className="sb-ns-label">
              Look at folders <span className="sb-ns-simple-optional">optional · read-only</span>
            </div>
            <LookAtField value={lookAt} onChange={setLookAt} disabled={busy} testId="nc-look-at" />
          </div>

          {error ? (
            <div className="sb-ns-error sb-ns-simple-error" role="alert" data-testid="nc-error">
              {error}
            </div>
          ) : null}
          <div className="sb-ns-simple-actions">
            <span className="sb-ns-simple-waiting" data-testid="nc-waiting">
              {attaching ?? ''}
            </span>
            <button type="button" className="sb-button sb-ns-cancel" data-testid="nc-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="sb-button sb-ns-start sb-ns-simple-start" data-testid="nc-start" disabled={!startable} title={`Start chat (${shortcut})`} onClick={() => void start()}>
              {busy ? 'Starting…' : 'Start chat'} <span className="sb-ns-simple-kbd">{shortcut}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
