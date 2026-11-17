import { useCallback, useEffect, useState } from 'react';
import type { TerminalInfo } from '../../../core/terminals.ts';
import { machineApi } from '../../api/client.ts';
import { useLayout } from '../../shell/useLayout.ts';
import { usePairedMachines } from '../../takeover/usePairedMachines.ts';
import { Button, Card, Chip, EmptyState, Icon, useToast } from '../components/index.ts';
import { TERMINAL_WORDS as W } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import { openNew } from '../new/index.tsx';
import { v2Path } from '../routes.ts';
import { type TerminalLink, TerminalView } from './TerminalView.tsx';
import './terminals.css';

/** One computer's terminals on the list. */
interface ComputerTerminals {
  readonly machine: string | null;
  readonly name: string;
  readonly terminals: readonly TerminalInfo[];
  readonly error: string | null;
}

/**
 * D170 · the Terminals page (`/terminals`, `docs/terminals.md`): the open terminals of this
 * computer and of each paired one that is online (this profile's), each with Open and Close.
 */
export function TerminalsPage() {
  const { self, machines } = usePairedMachines(true);
  const online = machines.filter((entry) => entry.state === 'online');
  const [list, setList] = useState<readonly ComputerTerminals[] | null>(null);
  const toast = useToast();
  const onlineKey = online.map((entry) => entry.id).join(',');

  const load = useCallback(async () => {
    const computers: Array<{ machine: string | null; name: string }> = [{ machine: null, name: self?.name ?? W.thisComputer }, ...online.map((entry) => ({ machine: entry.id, name: entry.name }))];
    const read = await Promise.all(
      computers.map(async (computer): Promise<ComputerTerminals> => {
        try {
          return { ...computer, terminals: (await machineApi(computer.machine).terminals()).terminals, error: null };
        } catch {
          return { ...computer, terminals: [], error: W.unreachable(computer.name) };
        }
      }),
    );
    setList(read);
    // The paired machines' list is part of the key: re-read when one comes or goes.
  }, [self?.name, onlineKey]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const close = async (machine: string | null, terminal: TerminalInfo): Promise<void> => {
    try {
      await machineApi(machine).closeTerminal(terminal.id);
    } catch {
      toast({ text: 'The terminal could not be closed.', tone: 'error' });
    }
    await load();
  };

  const any = (list ?? []).some((computer) => computer.terminals.length > 0);
  return (
    <div className="v2-page" data-testid="v2-page-terminals" data-area="terminals">
      <div className="v2-p-ph">
        <div className="v2-grow">
          <h1>{W.title}</h1>
          <p className="v2-page-sub">{W.sub}</p>
        </div>
        <Button variant="primary" icon="cmd" onClick={() => openNew({ kind: 'terminal' })} data-testid="v2-terminals-new" data-tour="v2-terminals-new">
          {W.newTerminal}
        </Button>
      </div>
      {list !== null && !any ? <EmptyState icon="cmd" tone="grey" title={W.none} text={W.noneSub} testId="v2-terminals-empty" /> : null}
      {(list ?? [])
        .filter((computer) => computer.terminals.length > 0 || computer.error)
        .map((computer) => (
          <section key={computer.machine ?? 'local'} className="v2-terminals-computer" data-testid="v2-terminals-computer">
            <h2 className="v2-terminals-h">
              <Icon name="desktop" size="s" /> {computer.name}
            </h2>
            {computer.error ? <p className="v2-muted">{computer.error}</p> : null}
            <Card>
              {computer.terminals.map((terminal) => (
                <div key={terminal.id} className="v2-plain-row" data-testid="v2-terminals-row" data-terminal={terminal.id}>
                  <span className="v2-ficon">
                    <Icon name="cmd" />
                  </span>
                  <div className="v2-grow">
                    <div className="v2-ttl">{terminal.title}</div>
                    <div className="v2-sub">
                      {terminal.cwd} · {W.clients(terminal.clients)}
                    </div>
                  </div>
                  {terminal.exited ? <Chip tone="grey">{W.exited(terminal.exited.code)}</Chip> : null}
                  <V2Link to={v2Path({ area: 'terminal', machine: computer.machine, id: terminal.id })} className="v2-btn" data-size="sm" data-testid="v2-terminals-open">
                    {W.reopen}
                  </V2Link>
                  <Button size="sm" icon="x" title={W.closeTitle} onClick={() => void close(computer.machine, terminal)} data-testid="v2-terminals-close">
                    {W.close}
                  </Button>
                </div>
              ))}
            </Card>
          </section>
        ))}
    </div>
  );
}

/** D170 · one terminal's page (`/terminals/:machine/:id`): its title, computer and folder, Close, and the terminal. */
export function TerminalPage({ machine, id }: { readonly machine: string | null; readonly id: string }) {
  const { navigate } = useV2Router();
  const phone = useLayout() === 'phone';
  const { machines } = usePairedMachines(true);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [link, setLink] = useState<TerminalLink>('connecting');
  const computer = machine === null ? W.thisComputer : (machines.find((entry) => entry.id === machine)?.name ?? machine);
  const close = async (): Promise<void> => {
    await machineApi(machine)
      .closeTerminal(id)
      .catch(() => undefined);
    navigate('/terminals');
  };
  return (
    <div className="v2-page v2-terminal-page" data-testid="v2-page-terminal" data-area="terminal" data-link={link}>
      <div className="v2-terminal-head">
        <V2Link to="/terminals" className="v2-btn" data-size="sm" data-variant="ghost" aria-label={W.backToList}>
          <Icon name="chevron-left" size="s" />
        </V2Link>
        <div className="v2-grow v2-terminal-title">
          <b>{info?.title ?? W.title}</b>
          <span className="v2-muted">
            {computer}
            {info ? ` · ${info.cwd}` : ''}
          </span>
        </div>
        {link !== 'open' ? (
          <Chip tone={link === 'gone' ? 'grey' : 'amber'} size="s">
            {link === 'gone' ? W.gone : link === 'unreachable' ? W.unreachable(computer) : link === 'reconnecting' ? W.reconnecting : W.connecting}
          </Chip>
        ) : null}
        <Button size="sm" icon="x" title={W.closeTitle} onClick={() => void close()} data-testid="v2-terminal-close">
          {W.close}
        </Button>
      </div>
      {link === 'gone' ? (
        <EmptyState icon="cmd" tone="grey" title={W.gone} action={<Button onClick={() => navigate('/terminals')}>{W.backToList}</Button>} testId="v2-terminal-gone" />
      ) : (
        <TerminalView key={`${machine ?? 'local'}/${id}`} machine={machine} id={id} phone={phone} onInfo={setInfo} onLink={setLink} />
      )}
    </div>
  );
}
