import { useEffect, useMemo, useState } from 'react';
import type { ArtifactKind, ArtifactSaveResult } from '../../../core/api.ts';
import { ARTIFACT_KINDS, checkArtifactLanguage, checkArtifactTitle, isTextKind, textContentProblem } from '../../../core/artifacts.ts';
import type { CheckpointPlan } from '../../../core/checkpoints.ts';
import { ApiError, api } from '../../api/client.ts';
import { qrPath } from '../../components/qr.ts';
import { KIND_LABELS, codeDraft, messageDraft } from '../../views/session/artifacts.ts';
import { refreshCheckpoints } from '../../views/session/checkpoints.ts';
import { actionErrorText } from '../../views/session/session-header.ts';
import { Button, Dialog, Field, Select, Switch, TextArea } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { openStore } from '../shared/open-store.ts';

/**
 * D131 · lane S · the agent view's dialogs in v2 style: Undo from here (the D80
 * revert confirmation), Save as result (D89), Rename, Continue in a terminal,
 * Remote control (link + QR) and the yes / no confirmations. Same routes as the
 * classic dialogs; v2 words and look.
 */

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null);
}

// ── Undo from here (D80) ──────────────────────────────────────────────

/** A revert being confirmed. */
export interface RevertRequest {
  readonly sessionId: string;
  readonly turn: number;
}

const revertStore = openStore<RevertRequest>();

/** Opens "Undo from here" for the reply's turn. */
export function openRevert(request: RevertRequest): void {
  revertStore.open(request);
}

const CHANGE_MARK: Readonly<Record<string, string>> = { added: '+', modified: '~', deleted: '−' };

/** The open Undo-from-here confirmation (mounted once by the agent view). */
export function RevertHost() {
  const request = revertStore.use();
  return request ? <RevertDialog key={`${request.sessionId}:${request.turn}`} request={request} /> : null;
}

function RevertDialog({ request }: { readonly request: RevertRequest }) {
  const [plan, setPlan] = useState<CheckpointPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.checkpointPlan(request.sessionId, request.turn).then(
      (answer) => live && setPlan(answer),
      (caught: unknown) => live && setError(errorText(caught)),
    );
    return () => {
      live = false;
    };
  }, [request.sessionId, request.turn]);
  const revert = (filesOnly: boolean): void => {
    setBusy(true);
    setError(null);
    api.revertTurn(request.sessionId, request.turn, filesOnly).then(
      () => {
        setBusy(false);
        revertStore.close();
        refreshCheckpoints(request.sessionId);
      },
      (caught: unknown) => {
        setBusy(false);
        const body = caught instanceof ApiError ? (caught.body as { error?: unknown; plan?: CheckpointPlan } | null) : null;
        if (body?.error === 'files-only-needed' && body.plan) setPlan(body.plan);
        else setError(errorText(caught));
        refreshCheckpoints(request.sessionId);
      },
    );
  };
  const replies = plan ? plan.latestTurn - plan.turn + 1 : 0;
  return (
    <Dialog
      open
      onClose={() => !busy && revertStore.close()}
      title={AGENT_WORDS.undoFromHere}
      icon="undo"
      width={560}
      testId="v2-agent-revert"
      footer={
        <>
          <Button onClick={() => revertStore.close()} disabled={busy} data-testid="v2-agent-revert-cancel">
            {AGENT_WORDS.cancel}
          </Button>
          {plan ? (
            <Button variant="danger" icon="undo" disabled={busy} data-testid="v2-agent-revert-confirm" onClick={() => revert(plan.filesOnlyReason !== null)}>
              {plan.filesOnlyReason ? 'Undo the files only' : `Undo ${replies} ${replies === 1 ? 'reply' : 'replies'}`}
            </Button>
          ) : null}
        </>
      }
    >
      {plan ? (
        <>
          <p style={{ marginTop: 0 }}>
            The files go back to how they were before this reply. The chat stays; the agent hears about it with your next message. <b>Redo</b> in the chat brings them back.
          </p>
          {plan.firstLine ? <blockquote className="v2-ag-quote">{plan.firstLine}</blockquote> : null}
          {plan.repos.map((repo) => (
            <div key={repo.path} className="v2-ag-revert-repo" data-testid="v2-agent-revert-repo">
              <b>{repo.name}</b> <span className="v2-muted">{repo.fileCount === 0 ? 'no file changes' : `${repo.fileCount} file${repo.fileCount === 1 ? '' : 's'}`}</span>
              {repo.files.length > 0 ? (
                <ul className="v2-ag-revert-files">
                  {repo.files.map((file) => (
                    <li key={file.path} className="v2-mono">
                      {CHANGE_MARK[file.change] ?? '·'} {file.path}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
          {plan.filesOnlyReason ? <p className="v2-ag-warn">{plan.filesOnlyReason}</p> : null}
        </>
      ) : error ? null : (
        <p className="v2-muted">Reading what changed…</p>
      )}
      {error ? (
        <p role="alert" className="v2-ag-dock-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

// ── Save as result (D89) ──────────────────────────────────────────────

/** What Save as result starts with. */
export interface SaveRequest {
  readonly sessionId: string;
  readonly text: string;
  readonly kind: 'markdown' | 'code';
  readonly language: string | null;
}

const saveStore = openStore<SaveRequest>();

/** Opens Save as result (a reply, or a code block of one). */
export function openSaveResult(request: SaveRequest): void {
  saveStore.open(request);
}

const TEXT_KINDS = ARTIFACT_KINDS.filter(isTextKind);

/** The open Save-as-result dialog. */
export function SaveResultHost({ onSaved }: { readonly onSaved?: (result: ArtifactSaveResult) => void }) {
  const request = saveStore.use();
  return request ? <SaveResultDialog key={`${request.sessionId}:${request.text.length}`} request={request} onSaved={onSaved} /> : null;
}

function SaveResultDialog({ request, onSaved }: { readonly request: SaveRequest; readonly onSaved?: ((result: ArtifactSaveResult) => void) | undefined }) {
  const draft = useMemo(() => (request.kind === 'code' ? codeDraft(request.text, request.language, null) : messageDraft(request.text)), [request]);
  const [title, setTitle] = useState(draft.title);
  const [kind, setKind] = useState<ArtifactKind>(draft.kind);
  const [language, setLanguage] = useState(draft.language ?? '');
  const [content, setContent] = useState(draft.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    const t = checkArtifactTitle(title);
    if (!t.ok) return setError(`Title: ${t.message}`);
    const l = checkArtifactLanguage(kind === 'code' ? language : null);
    if (!l.ok) return setError(`Language: ${l.message}`);
    const problem = textContentProblem(kind, content);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    api.saveArtifact(request.sessionId, { title: t.value, kind, content, ...(kind === 'code' ? { language: l.value } : {}) }).then(
      (result) => {
        setBusy(false);
        saveStore.close();
        onSaved?.(result);
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorText(caught));
      },
    );
  };
  return (
    <Dialog
      open
      onClose={() => !busy && saveStore.close()}
      title={AGENT_WORDS.saveResult}
      icon="results"
      width={620}
      testId="v2-agent-save-result"
      footer={
        <>
          <Button onClick={() => saveStore.close()} disabled={busy}>
            {AGENT_WORDS.cancel}
          </Button>
          <Button variant="primary" icon="results" disabled={busy} data-testid="v2-agent-save-result-save" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Title" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} data-testid="v2-agent-save-result-title" />
      <div className="v2-row" style={{ gap: 12, marginTop: 10 }}>
        <Select label="Kind" value={kind} options={TEXT_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} onChange={(event) => setKind(event.target.value as ArtifactKind)} />
        {kind === 'code' ? <Field label="Language" value={language} placeholder="ts, python, sql…" onChange={(event) => setLanguage(event.target.value)} /> : null}
      </div>
      <TextArea label="Content" rows={10} spellCheck={false} value={content} onChange={(event) => setContent(event.target.value)} style={{ marginTop: 10, fontFamily: 'var(--v2-mono)', fontSize: 13 }} />
      {error ? (
        <p role="alert" className="v2-ag-dock-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

// ── Rename ─────────────────────────────────────────────────────────

/** Rename an agent (D22 title; empty = back to its name). */
export function RenameDialog({ open, sessionId, current, onClose, onDone }: { readonly open: boolean; readonly sessionId: string; readonly current: string; readonly onClose: () => void; readonly onDone: (name: string, before: string) => void }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(current);
      setError(null);
    }
  }, [open, current]);
  const save = (): void => {
    const title = name.trim();
    setBusy(true);
    api.renameSession(sessionId, title === '' ? null : title.slice(0, 80)).then(
      () => {
        setBusy(false);
        onClose();
        onDone(title, current);
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorText(caught));
      },
    );
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename agent"
      icon="edit"
      testId="v2-agent-rename"
      footer={
        <>
          <Button onClick={onClose}>{AGENT_WORDS.cancel}</Button>
          <Button variant="primary" disabled={busy} data-testid="v2-agent-rename-save" onClick={save}>
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label="Name" value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} data-testid="v2-agent-rename-field" />
      </form>
      {error ? (
        <p role="alert" className="v2-ag-dock-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

// ── Continue in a terminal ───────────────────────────────────────────

/** Shows the command that continues the agent in a terminal (after the D7 detach). */
export function TerminalDialog({ command, cwd, onClose }: { readonly command: string | null; readonly cwd: string | null; readonly onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const full = command && cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command;
  return (
    <Dialog open={command !== null} onClose={onClose} title={AGENT_WORDS.continueInTerminal} icon="cmd" width={600} testId="v2-agent-terminal" footer={<Button onClick={onClose}>Close</Button>}>
      <p style={{ marginTop: 0 }}>Run this in a terminal on this computer. The agent keeps its chat and separate copy; bring it back here from its ⋯ menu.</p>
      <pre className="v2-ag-code">{full}</pre>
      <Button
        size="sm"
        icon="copy"
        onClick={() => {
          void navigator.clipboard?.writeText(full ?? '').then(() => setCopied(true));
        }}
      >
        {copied ? AGENT_WORDS.copied : AGENT_WORDS.copy}
      </Button>
    </Dialog>
  );
}

// ── Remote control (D24) ─────────────────────────────────────────────

/** A QR code drawn with the v2 colours. */
export function V2Qr({ text, size = 176 }: { readonly text: string; readonly size?: number }) {
  const qr = useMemo(() => qrPath(text), [text]);
  return (
    <svg className="v2-ag-qr" data-testid="v2-agent-qr" data-text={text} width={size} height={size} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label="QR code of the link">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#111" />
    </svg>
  );
}

/** Remote control: the switch, and while it is on the claude.ai link and its QR code. */
export function RemoteDialog({ open, on, url, disabledReason, busy, error, onToggle, onClose }: { readonly open: boolean; readonly on: boolean; readonly url: string | null; readonly disabledReason: string | null; readonly busy: boolean; readonly error: string | null; readonly onToggle: (on: boolean) => void; readonly onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={AGENT_WORDS.remoteControl} icon="qr" width={620} testId="v2-agent-remote" footer={<Button onClick={onClose}>Close</Button>}>
      <Switch checked={on} label="Reachable from your phone and the Claude app" disabled={busy || (disabledReason !== null && !on)} onChange={onToggle} testId="v2-agent-remote-switch" />
      {disabledReason && !on ? <p className="v2-muted">{disabledReason}</p> : null}
      {url ? (
        <div className="v2-row" style={{ gap: 20, alignItems: 'flex-start', marginTop: 12 }}>
          <V2Qr text={url} />
          <div>
            <p style={{ marginTop: 0 }}>Scan it with your phone, or open the link in the Claude app to steer this agent.</p>
            <a href={url} target="_blank" rel="noopener noreferrer" className="v2-mono" data-testid="v2-agent-remote-link">
              {url}
            </a>
            <p className="v2-muted">While it is on, the chat is stored on Anthropic’s servers.</p>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="v2-ag-dock-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

// ── Confirm ───────────────────────────────────────────────────────

/** A yes / no question. */
export function ConfirmDialog({ open, title, text, yes, danger = false, busy = false, error = null, onYes, onClose, testId }: { readonly open: boolean; readonly title: string; readonly text: string; readonly yes: string; readonly danger?: boolean; readonly busy?: boolean; readonly error?: string | null; readonly onYes: () => void; readonly onClose: () => void; readonly testId?: string }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      icon={danger ? 'trash' : 'alert'}
      testId={testId}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {AGENT_WORDS.cancel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onYes} data-testid={testId ? `${testId}-yes` : undefined}>
            {yes}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{text}</p>
      {error ? (
        <p role="alert" className="v2-ag-dock-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
