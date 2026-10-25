import { useEffect, useMemo, useState } from 'react';
import type { ArtifactKind } from '../../../core/api.ts';
import type { SessionPr } from '../../../core/ci.ts';
import { api, artifactRawUrl } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { Button, Chip, Icon, Skeleton, useToast } from '../components/index.ts';
import { HOME_WORDS, STATUS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { agentName } from '../shared/agent-line.ts';
import { cardButtons, summaryOf } from '../shared/answer-model.ts';
import { defaultWhere, needsYouStore, useNeedsYou } from '../shared/needs-you.ts';
import { useOpenAgent } from '../shared/open-agent.ts';
import type { NeedsItem } from '../shared/needs-you-model.ts';
import { clock, timeAgo } from '../shared/time.ts';
import { DONE_LIMIT, type DoneRow, testsLine } from './home-model.ts';

/**
 * D131 · Home's "Done today" (lane H; the prototype's `#done-list`): agents that
 * finished today, with their change request's automatic tests (`GET
 * /api/sessions/{id}/ci`, live on `ciChanged`) and, when their work waits for
 * approval, the "Ready for approval" chip and **Combine** (the item's own action,
 * through the Needs-you store: Undo for 5 s); and the results saved today. Five
 * rows, then "Show more".
 */

/** Each listed agent's watched change requests (read once per agent, again on `ciChanged`). */
function useSessionCi(ids: readonly string[]): ReadonlyMap<string, readonly SessionPr[]> {
  const [prs, setPrs] = useState<ReadonlyMap<string, readonly SessionPr[]>>(new Map());
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set());
  const key = ids.join('|');
  useEffect(() => {
    let live = true;
    for (const id of ids) {
      if (prs.has(id) && !stale.has(id)) continue;
      api
        .sessionCi(id)
        .then((ci) => {
          if (!live) return;
          setPrs((current) => new Map(current).set(id, ci.prs));
          setStale((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // `prs` is what was read; re-reading is driven by the ids and `stale`.
  }, [key, stale]);
  useHubEvent('ciChanged', ({ sessionId }) => {
    if (ids.includes(sessionId)) setStale((current) => new Set(current).add(sessionId));
  });
  return prs;
}

const RESULT_ICON: Readonly<Record<ArtifactKind, string>> = { markdown: 'book', code: 'grid', html: 'results', mermaid: 'diagram', svg: 'image', image: 'image', pdf: 'results', csv: 'table' };

function CombineButton({ item, onCombined }: { readonly item: NeedsItem; readonly onCombined: () => void }) {
  const toast = useToast();
  const button = cardButtons(item).find((b) => b.intent.type === 'answer' && b.variant === 'primary');
  if (!button || button.intent.type !== 'answer') return null;
  const action = button.intent.action;
  const off = item.computer !== null && item.computer.state !== 'online';
  return (
    <Button
      variant="primary"
      size="sm"
      icon={button.icon ?? 'merge'}
      disabled={off}
      title={off ? `${item.computer?.name ?? ''} is offline` : undefined}
      data-testid="v2-done-combine"
      onClick={(event) => {
        event.stopPropagation();
        needsYouStore.answer(item, action, defaultWhere('home'));
        const summary = summaryOf(item, action);
        onCombined();
        toast({ text: `${summary}${item.agent?.name ? ` · sent to ${item.agent.name}` : ''}`, undo: () => {
          needsYouStore.undo(item.key);
        } });
      }}
    >
      {button.label}
    </Button>
  );
}

export function DoneToday({ rows, loaded, phone, now }: { readonly rows: readonly DoneRow[]; readonly loaded: boolean; readonly phone: boolean; readonly now: number }) {
  const { navigate } = useV2Router();
  // An agent row peeks (the prototype's `data-peek`; a phone opens the agent).
  const peek = useOpenAgent();
  const [expanded, setExpanded] = useState(false);
  const { answered } = useNeedsYou();
  /** The Ready-for-approval item combined from a row, by agent: the row shows the compact line while the store keeps it. */
  const [combined, setCombined] = useState<ReadonlyMap<string, string>>(new Map());
  const shown = expanded ? rows : rows.slice(0, DONE_LIMIT);
  const agentIds = useMemo(() => shown.flatMap((row) => (row.type === 'agent' && !row.session.machine ? [row.session.id] : [])), [shown]);
  const ci = useSessionCi(agentIds);

  if (!loaded) {
    return (
      <div className="v2-card v2-home-list" data-testid="v2-done-loading">
        {[0, 1].map((n) => (
          <div key={n} className="v2-home-lrow" aria-hidden="true">
            <Skeleton width={38} height={38} />
            <div className="v2-grow">
              <Skeleton width="45%" />
              <Skeleton width="70%" height={9} style={{ marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="v2-home-empty" data-testid="v2-done-empty">
        {HOME_WORDS.nothingDone}
      </div>
    );
  }

  return (
    <>
      <div className="v2-card v2-home-list" data-testid="v2-done">
        {shown.map((row) => {
          if (row.type === 'agent') {
            const session = row.session;
            const ready = row.ready;
            const doneKey = combined.get(session.id);
            const answer = !ready && doneKey ? answered.get(doneKey) : undefined;
            const tests = testsLine(ci.get(session.id));
            const ago = timeAgo(row.at, now);
            const sub = [session.status === 'done' ? HOME_WORDS.doneAgo(ago) : HOME_WORDS.activeAgo(ago), tests?.text].filter(Boolean).join(' · ');
            return (
              <div key={row.key} className="v2-home-lrow" role="button" tabIndex={0} data-testid="v2-done-row" data-type="agent" data-session={session.id} onClick={(event) => {
                if ((event.target as HTMLElement).closest('button, a')) return;
                peek(session.id);
              }} onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                  event.preventDefault();
                  peek(session.id);
                }
              }}>
                <div className="v2-home-ficon" data-tone={ready ? 'violet' : 'green'}>
                  <Icon name={ready ? 'half' : 'check'} />
                </div>
                <div className="v2-grow" style={{ minWidth: 0 }}>
                  <div className="v2-home-ttl">{agentName(session)}</div>
                  {phone ? null : <div className="v2-home-sub">{sub}</div>}
                </div>
                {ready ? (
                  <>
                    {phone ? null : (
                      <Chip tone="violet" icon={STATUS.ready.icon} size="s">
                        {STATUS.ready.label}
                      </Chip>
                    )}
                    <CombineButton item={ready} onCombined={() => setCombined((current) => new Map(current).set(session.id, ready.key))} />
                  </>
                ) : answer ? (
                  <Chip tone="green" icon="merge" size="s">
                    {answer.summary}
                  </Chip>
                ) : null}
              </div>
            );
          }
          const artifact = row.artifact;
          const from = artifact.sessionTitle ?? artifact.sessionName;
          const local = !artifact.machine && artifact.sessionId;
          const openResult = (): void => navigate(artifact.sessionId ? `/agents/${encodeURIComponent(artifact.sessionId)}/results/${encodeURIComponent(artifact.id)}` : '/results');
          return (
            <div key={row.key} className="v2-home-lrow" role="button" tabIndex={0} data-testid="v2-done-row" data-type="result" onClick={openResult} onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                event.preventDefault();
                openResult();
              }
            }}>
              <div className="v2-home-ficon" data-tone={artifact.kind === 'pdf' ? 'red' : undefined}>
                <Icon name={RESULT_ICON[artifact.kind] ?? 'results'} />
              </div>
              <div className="v2-grow" style={{ minWidth: 0 }}>
                <div className="v2-home-ttl">
                  {artifact.title} {artifact.versions > 1 ? <span className="v2-home-tag">{HOME_WORDS.version(artifact.versions)}</span> : null}
                </div>
                <div className="v2-home-sub">{from ? HOME_WORDS.resultFrom(from, clock(artifact.updatedAt)) : HOME_WORDS.resultAt(clock(artifact.updatedAt))}</div>
              </div>
              {local && !phone ? (
                <a className="v2-btn" data-size="sm" href={artifactRawUrl(artifact.sessionId as string, artifact.id, artifact.versions, true)} download onClick={(event) => event.stopPropagation()}>
                  <Icon name="download" size="s" />
                  {HOME_WORDS.download}
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
      {rows.length > DONE_LIMIT ? (
        <button type="button" className="v2-home-more-row" onClick={() => setExpanded(!expanded)} data-testid="v2-done-more" aria-expanded={expanded}>
          {expanded ? HOME_WORDS.showLess : HOME_WORDS.showMore(rows.length - DONE_LIMIT)}
          <Icon name={expanded ? 'chev' : 'chev-down'} size="s" />
        </button>
      ) : null}
    </>
  );
}
