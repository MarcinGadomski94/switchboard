import { useMemo, useState } from 'react';
import { type StrayCleanResult, type StrayItem, type StrayRestorable, type StrayScan, strayBytes, strayKindLabel, straySafe } from '../../../core/strays.ts';
import { api } from '../../api/client.ts';
import { ConfirmDialog } from '../agent/dialogs.tsx';
import { Button, Card, Checkbox, Chip, useToast } from '../components/index.ts';
import { STRAY_WORDS as W } from '../glossary.ts';

/**
 * D191 (`docs/worktrees.md` → *Stray worktrees*): Settings › Advanced › Clean-up's card for the
 * worktrees no open agent uses and the leftovers (stale records, agent branches, temp folders).
 * "Find leftovers now" scans (nothing changes); the list is grouped by repository; the safe items
 * are ticked, the risky ones (work found nowhere else) are not and need a second confirmation;
 * the deleted branches can be restored for 7 days.
 */
export function StrayWorktreesCard() {
  const toast = useToast();
  const [scan, setScan] = useState<StrayScan | null>(null);
  const [restorable, setRestorable] = useState<readonly StrayRestorable[]>([]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'scan' | 'clean' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<StrayCleanResult | null>(null);

  const fail = (error: unknown): void => toast({ text: error instanceof Error ? error.message : 'It did not work.', tone: 'error' });

  const find = (): void => {
    setBusy('scan');
    api.strayScan().then(
      (view) => {
        setScan(view.scan);
        setRestorable(view.restorable);
        setTicked(new Set(view.scan.items.filter(straySafe).map((item) => item.id)));
        setBusy(null);
      },
      (error: unknown) => {
        setBusy(null);
        fail(error);
      },
    );
  };

  const groups = useMemo(() => {
    const map = new Map<string, StrayItem[]>();
    for (const item of scan?.items ?? []) {
      const key = item.repo ?? W.temp;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [scan]);

  const items = scan?.items ?? [];
  const tickedItems = items.filter((item) => ticked.has(item.id));
  const riskyTicked = tickedItems.filter((item) => !straySafe(item));
  const totalBytes = items.reduce((sum, item) => sum + (item.bytes ?? 0), 0);

  const toggle = (id: string, on: boolean): void => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
  };

  const clean = (force: boolean): void => {
    setConfirm(false);
    setBusy('clean');
    api.cleanStrays({ ids: tickedItems.map((item) => item.id), force }).then(
      (answer) => {
        setResult(answer);
        setRestorable(answer.restorable);
        setBusy(null);
        find();
      },
      (error: unknown) => {
        setBusy(null);
        fail(error);
      },
    );
  };

  const restore = (entry: StrayRestorable): void => {
    api.restoreStray({ repo: entry.repo, branch: entry.branch, sha: entry.sha }).then(
      (answer) => {
        setRestorable(answer.restorable);
        toast({ text: W.restored(entry.branch), tone: 'ok' });
      },
      fail,
    );
  };

  const count = (what: 'removed' | 'skipped' | 'failed'): number => result?.outcomes.filter((o) => o.result === what).length ?? 0;

  return (
    <Card pad className="v2-set-card" data-testid="v2-stray-worktrees" data-tour="v2-stray-worktrees">
      <div className="v2-set-card-h">
        <h3 className="v2-grow">{W.title}</h3>
        <Button size="sm" icon="search" onClick={find} disabled={busy !== null} data-testid="v2-stray-find">
          {busy === 'scan' ? W.finding : W.find}
        </Button>
      </div>
      <p className="v2-muted v2-set-small">{W.sub}</p>
      {result ? (
        <p className="v2-set-small" role="status" data-testid="v2-stray-result">
          {W.result(count('removed'), count('skipped'), count('failed'), result.freedBytes > 0 ? strayBytes(result.freedBytes) : '')}
        </p>
      ) : null}
      {result
        ? result.outcomes
            .filter((o) => o.result !== 'removed' && o.message)
            .map((o) => (
              <p key={o.id} className="v2-muted v2-set-small" data-testid="v2-stray-outcome" data-result={o.result}>
                {o.message}
              </p>
            ))
        : null}
      {scan ? (
        <>
          <p className="v2-set-small" data-testid="v2-stray-summary">
            {items.length === 0 ? W.none : W.found(items.length, totalBytes > 0 ? strayBytes(totalBytes) : '')}
            {scan.inUse > 0 ? <span className="v2-muted"> · {W.inUse(scan.inUse)}</span> : null}
          </p>
          {scan.errors.length > 0 ? (
            <p className="v2-muted v2-set-small" data-testid="v2-stray-errors">
              {W.errors} {scan.errors.map((e) => `${e.repo} (${e.message})`).join('; ')}
            </p>
          ) : null}
          {groups.map(([repo, rows]) => (
            <section key={repo} data-testid="v2-stray-repo" data-repo={repo}>
              <h4 className="v2-set-small">{repo}</h4>
              {rows.map((item) => {
                const safe = straySafe(item);
                return (
                  <div key={item.id} className="v2-set-row" data-testid="v2-stray-item" data-kind={item.kind} data-safe={safe ? 'true' : 'false'}>
                    <Checkbox
                      checked={ticked.has(item.id)}
                      onChange={(event) => toggle(item.id, event.currentTarget.checked)}
                      label={
                        <span>
                          <b>{item.path ?? item.branch}</b> <span className="v2-muted">· {strayKindLabel(item.kind)}</span>
                          {item.path && item.branch ? <span className="v2-muted"> · {item.branch}</span> : null}
                          {item.bytes !== null ? <span className="v2-muted"> · {strayBytes(item.bytes)}{item.bytesCapped ? '+' : ''}</span> : null}{' '}
                          {item.uncommitted ? <Chip tone="amber" size="s">{W.uncommitted(item.uncommitted)}</Chip> : null}{' '}
                          {item.uniqueCommits ? <Chip tone="amber" size="s">{W.uniqueCommits(item.uniqueCommits)}</Chip> : null}
                          {item.uniqueCommits === null && item.kind !== 'temp' && item.kind !== 'stale-record' ? <Chip tone="grey" size="s">{W.unknownCommits}</Chip> : null}
                          {safe ? null : (
                            <span className="v2-muted v2-set-small" data-testid="v2-stray-risky">
                              {' '}
                              {W.risky}
                            </span>
                          )}
                        </span>
                      }
                      data-testid="v2-stray-tick"
                    />
                  </div>
                );
              })}
            </section>
          ))}
          {items.length > 0 ? (
            <Button variant="primary" icon="trash" disabled={busy !== null || tickedItems.length === 0} onClick={() => (riskyTicked.length > 0 ? setConfirm(true) : clean(false))} data-testid="v2-stray-clean">
              {busy === 'clean' ? W.cleaning : W.clean(tickedItems.length)}
            </Button>
          ) : null}
        </>
      ) : null}
      {restorable.length > 0 ? (
        <>
          <h4 className="v2-set-small">{W.restorableTitle}</h4>
          {restorable.map((entry) => (
            <div key={`${entry.repo}|${entry.branch}|${entry.sha}`} className="v2-set-row" data-testid="v2-stray-restorable">
              <span className="v2-grow">
                <b>{entry.branch}</b> <span className="v2-muted">· {entry.repo} · {entry.sha.slice(0, 8)}</span>
              </span>
              <Button size="sm" icon="undo" onClick={() => restore(entry)} data-testid="v2-stray-restore">
                {W.restore}
              </Button>
            </div>
          ))}
        </>
      ) : null}
      <ConfirmDialog open={confirm} title={W.title} text={W.confirmRisky(riskyTicked.length)} yes={W.clean(tickedItems.length)} danger onYes={() => clean(true)} onClose={() => setConfirm(false)} testId="v2-stray-confirm" />
    </Card>
  );
}
