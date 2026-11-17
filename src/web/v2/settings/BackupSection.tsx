import { useState } from 'react';
import type { BackupInspection, BackupStatus } from '../../../core/backup.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { Button, Card, Checkbox, Field, Select, Switch, useToast } from '../components/index.ts';
import { BACKUP_WORDS as W } from '../glossary.ts';

/**
 * D168 · Settings → Backup (`docs/backup.md`): Back up now (a passphrase, the file into the backup
 * folder, downloadable), the automatic daily backups, and Restore (check a backup with its
 * passphrase, map the folders this computer lacks, choose the identity, then Switchboard restarts
 * and applies it), with the last restore's report.
 */
export function BackupSection() {
  const status = useApi(api.backupStatus);
  const data = status.data as BackupStatus | null;
  return (
    <section className="v2-set-section" data-testid="v2-settings-backup-section">
      <p className="v2-muted">{W.intro}</p>
      {data?.lastRestore ? <LastRestore status={data} /> : null}
      <BackupNow status={data} onDone={() => status.reload()} />
      {data ? <AutoBackups status={data} onSaved={() => status.reload()} /> : null}
      {data ? <Restore status={data} /> : null}
    </section>
  );
}

function errorText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' && body.message ? body.message : error instanceof Error ? error.message : String(error);
}

function size(bytes: number | null): string {
  if (bytes === null) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function LastRestore({ status }: { readonly status: BackupStatus }) {
  const report = status.lastRestore;
  if (!report) return null;
  return (
    <Card>
      <div className="v2-backup-report" data-testid="v2-backup-report" data-ok={report.ok ? 'true' : 'false'}>
        <b>{W.lastRestore}</b>
        <p>{report.ok ? W.restored(report.agents, report.fromMachine ?? 'the backup') : W.restoreFailed(report.error ?? '')}</p>
        {report.previousData ? <p className="v2-muted">{W.keptAside(report.previousData)}</p> : null}
        {report.todo.length > 0 ? (
          <ul>
            {report.todo.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}

function BackupNow({ status, onDone }: { readonly status: BackupStatus | null; readonly onDone: () => void }) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const differ = again !== '' && again !== pass;
  const run = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const last = await api.backupNow(pass);
      setMessage(last.ok ? { ok: true, text: W.savedTo(last.file ?? '', size(last.size)) } : { ok: false, text: W.failed(last.error ?? '') });
      setPass('');
      setAgain('');
    } catch (error) {
      setMessage({ ok: false, text: W.failed(errorText(error)) });
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <Card>
      <h3>{W.nowTitle}</h3>
      <Field label={W.passphrase} type="password" autoComplete="new-password" value={pass} onChange={(event) => setPass(event.currentTarget.value)} hint={W.passphraseHint} data-testid="v2-backup-passphrase" />
      <Field label={W.passphraseAgain} type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.currentTarget.value)} error={differ ? W.passphrasesDiffer : null} data-testid="v2-backup-passphrase-again" />
      <Button variant="primary" icon="download" disabled={busy || pass.length < 8 || pass !== again || status?.running !== null} onClick={() => void run()} data-testid="v2-backup-now" data-tour="v2-backup-now">
        {busy ? W.backingUp : W.backUp}
      </Button>
      {message ? (
        <p className={message.ok ? 'v2-muted' : 'v2-field-error'} role="status" data-testid="v2-backup-result">
          {message.text}
        </p>
      ) : null}
      <div className="v2-backup-files" data-testid="v2-backup-files">
        <b>{W.files}</b> <span className="v2-muted">{status?.folder ?? ''}</span>
        {status && status.files.length === 0 ? <p className="v2-muted">{W.noFiles}</p> : null}
        <ul>
          {(status?.files ?? []).map((file) => (
            <li key={file.name}>
              {file.name} <span className="v2-muted">{size(file.size)}</span>{' '}
              <a href={`/api/backup/files/${encodeURIComponent(file.name)}`} download={file.name}>
                {W.download}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function AutoBackups({ status, onSaved }: { readonly status: BackupStatus; readonly onSaved: () => void }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(status.auto.enabled);
  const [folder, setFolder] = useState(status.auto.folder ?? '');
  const [keep, setKeep] = useState(String(status.auto.keep));
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api.setBackupAuto({ enabled, folder: folder.trim() === '' ? null : folder.trim(), keep: Number(keep), ...(pass ? { passphrase: pass } : {}) });
      setPass('');
      toast({ text: W.saved });
      onSaved();
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return (
    <Card>
      <h3>{W.autoTitle}</h3>
      <p className="v2-muted">{W.autoHint}</p>
      <div className="v2-row" data-testid="v2-backup-auto" data-tour="v2-backup-auto">
        <Switch checked={enabled} onChange={setEnabled} label={W.autoOn} testId="v2-backup-auto-switch" />
        <span>{W.autoOn}</span>
      </div>
      <Field label={W.folder} value={folder} placeholder={status.defaultFolder} hint={W.folderHint(status.defaultFolder)} onChange={(event) => setFolder(event.currentTarget.value)} data-testid="v2-backup-folder" />
      <Select label={W.keep} value={keep} options={[3, 7, 14, 30].map((n) => ({ value: String(n), label: W.keepN(n) }))} onChange={(event) => setKeep(event.currentTarget.value)} />
      <Field label={W.autoPassphrase} type="password" autoComplete="new-password" value={pass} placeholder={status.auto.hasKey ? W.autoPassphraseSet : ''} onChange={(event) => setPass(event.currentTarget.value)} data-testid="v2-backup-auto-passphrase" />
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
      {status.last ? (
        <p className="v2-muted" data-testid="v2-backup-last">
          {status.last.ok ? W.savedTo(status.last.file ?? '', size(status.last.size)) : W.failed(status.last.error ?? '')}
        </p>
      ) : null}
      <Button onClick={() => void save()} data-testid="v2-backup-auto-save">
        {W.save}
      </Button>
    </Card>
  );
}

const OTHER = '__other__';

function Restore({ status }: { readonly status: BackupStatus }) {
  const [choice, setChoice] = useState(status.files[0]?.name ?? OTHER);
  const [other, setOther] = useState('');
  const [pass, setPass] = useState('');
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [keepIdentity, setKeepIdentity] = useState(false);
  const [replace, setReplace] = useState(false);
  const [allowMissing, setAllowMissing] = useState(false);
  const [busy, setBusy] = useState<'check' | 'restore' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const file = choice === OTHER ? other.trim() : choice;
  const check = async (): Promise<void> => {
    setBusy('check');
    setError(null);
    try {
      setInspection(await api.inspectBackup(file, pass, map));
    } catch (caught) {
      setInspection(null);
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };
  const restore = async (): Promise<void> => {
    setBusy('restore');
    setError(null);
    try {
      const answer = await api.restoreBackup({ file, passphrase: pass, map, identity: keepIdentity ? 'keep' : 'new', replace, allowMissing });
      setDone(answer.restart === 'restarting' ? W.restarting : W.manual);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };
  const missing = inspection?.missingFolders.filter((folder) => !(map[folder.from] ?? '').trim()) ?? [];
  const ready = inspection !== null && inspection.refusal === null && (inspection.agentsHere === 0 || replace) && (missing.length === 0 || allowMissing);
  return (
    <Card>
      <h3>{W.restoreTitle}</h3>
      <p className="v2-muted">{W.restoreIntro}</p>
      <div data-testid="v2-backup-restore" data-tour="v2-backup-restore">
        <Select
          label={W.file}
          hint={W.fileHint}
          value={choice}
          options={[...status.files.map((entry) => ({ value: entry.name, label: entry.name })), { value: OTHER, label: W.pathOther }]}
          onChange={(event) => {
            setChoice(event.currentTarget.value);
            setInspection(null);
          }}
        />
        {choice === OTHER ? <Field label={W.file} value={other} onChange={(event) => setOther(event.currentTarget.value)} data-testid="v2-backup-restore-path" /> : null}
        <Field label={W.passphrase} type="password" autoComplete="off" value={pass} onChange={(event) => setPass(event.currentTarget.value)} data-testid="v2-backup-restore-passphrase" />
        <Button disabled={busy !== null || file === '' || pass === ''} onClick={() => void check()} data-testid="v2-backup-check">
          {busy === 'check' ? W.checking : W.check}
        </Button>
      </div>
      {inspection ? (
        <div className="v2-backup-preview" data-testid="v2-backup-preview">
          <p>
            <b>{W.from(inspection.preview.machineName ?? '?', inspection.preview.switchboardVersion, new Date(inspection.preview.createdAt).toLocaleString())}</b>
          </p>
          <p className="v2-muted">{W.holds(inspection.preview.counts.agents, inspection.preview.counts.folders, inspection.preview.conversations, inspection.preview.counts.projects, inspection.preview.counts.secrets)}</p>
          {inspection.refusal ? (
            <p className="v2-field-error" role="alert">
              {inspection.refusal}
            </p>
          ) : null}
          {inspection.missingFolders.length > 0 ? (
            <div data-testid="v2-backup-missing">
              <b>{W.missingTitle}</b>
              {inspection.missingFolders.map((folder) => (
                <Field key={folder.from} label={folder.from} placeholder={W.mapTo} value={map[folder.from] ?? ''} onChange={(event) => setMap((now) => ({ ...now, [folder.from]: event.currentTarget.value }))} />
              ))}
              <Checkbox label={W.allowMissing} checked={allowMissing} onChange={(event) => setAllowMissing(event.currentTarget.checked)} />
            </div>
          ) : null}
          <Checkbox label={W.identityKeep} checked={keepIdentity} onChange={(event) => setKeepIdentity(event.currentTarget.checked)} data-testid="v2-backup-identity" />
          {inspection.agentsHere > 0 ? <Checkbox label={W.replace(inspection.agentsHere)} checked={replace} onChange={(event) => setReplace(event.currentTarget.checked)} data-testid="v2-backup-replace" /> : null}
          <Button variant="primary" disabled={!ready || busy !== null || done !== null} onClick={() => void restore()} data-testid="v2-backup-restore-go">
            {busy === 'restore' ? W.restoring : W.restore}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="v2-field-error" role="alert" data-testid="v2-backup-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" data-testid="v2-backup-restore-done">
          {done}
        </p>
      ) : null}
    </Card>
  );
}
