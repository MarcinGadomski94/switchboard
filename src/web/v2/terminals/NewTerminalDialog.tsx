import { useEffect, useState } from 'react';
import type { Folder } from '../../../core/api.ts';
import type { TerminalsView } from '../../../core/terminals.ts';
import { ApiError, machineApi } from '../../api/client.ts';
import { usePairedMachines } from '../../takeover/usePairedMachines.ts';
import { Button, Dialog, Select } from '../components/index.ts';
import { TERMINAL_WORDS as W } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { v2Path } from '../routes.ts';

function errorText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' && body.message ? body.message : 'The terminal could not open.';
}

/**
 * D170 · + New › Terminal (`docs/terminals.md`): the computer (this one, or a paired one that is
 * online), its shells and a start folder (home or one of its saved folders), then the terminal's
 * page.
 */
export function NewTerminalDialog({ machine: initial, onClose }: { readonly machine: string | null; readonly onClose: () => void }) {
  const { navigate } = useV2Router();
  const { machines } = usePairedMachines(true);
  const online = machines.filter((entry) => entry.state === 'online');
  const [machine, setMachine] = useState<string | null>(initial);
  const [view, setView] = useState<TerminalsView | null>(null);
  const [folders, setFolders] = useState<readonly Folder[]>([]);
  const [shell, setShell] = useState('default');
  const [folderId, setFolderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    setFolders([]);
    setShell('default');
    setFolderId('');
    setError(null);
    const calls = machineApi(machine);
    calls.terminals().then(
      (next) => live && setView(next),
      (caught: unknown) => live && setError(errorText(caught)),
    );
    calls.savedFolders().then(
      (next) => live && setFolders(next),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [machine]);

  const open = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const info = await machineApi(machine).openTerminal({ shell, ...(folderId ? { folderId } : {}) });
      onClose();
      navigate(v2Path({ area: 'terminal', machine, id: info.id }));
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={W.newTitle}
      icon="cmd"
      testId="v2-new-terminal"
      footer={
        <>
          <span className="v2-grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="cmd" disabled={busy || view === null} onClick={() => void open()} data-testid="v2-new-terminal-open" data-tour="v2-new-terminal">
            {busy ? W.opening : W.open}
          </Button>
        </>
      }
    >
      {online.length > 0 ? (
        <Select
          label={W.computer}
          value={machine ?? ''}
          options={[{ value: '', label: W.thisComputer }, ...online.map((entry) => ({ value: entry.id, label: entry.name }))]}
          onChange={(event) => setMachine(event.currentTarget.value === '' ? null : event.currentTarget.value)}
          data-testid="v2-new-terminal-computer"
        />
      ) : null}
      <Select
        label={W.shell}
        value={shell}
        options={(view?.shells ?? [{ id: 'default', label: '…' }]).map((entry) => ({ value: entry.id, label: entry.label }))}
        onChange={(event) => setShell(event.currentTarget.value)}
        data-testid="v2-new-terminal-shell"
      />
      <Select
        label={W.folder}
        value={folderId}
        options={[{ value: '', label: view ? `${W.home} (${view.home})` : W.home }, ...folders.map((folder) => ({ value: folder.id, label: folder.label ?? folder.name }))]}
        onChange={(event) => setFolderId(event.currentTarget.value)}
        data-testid="v2-new-terminal-folder"
      />
      <p className="v2-muted v2-terminal-note">{W.security}</p>
      {error ? (
        <p className="v2-field-error" role="alert" data-testid="v2-new-terminal-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
