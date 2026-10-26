import { useMemo, useState } from 'react';
import { draftField } from '../../../core/drafts.ts';
import { readKnownSettings } from '../../../core/settings.ts';
import type { SessionListItem } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { Button, Card, EmptyState, Field, Icon, IconButton, Skeleton, useToast } from '../components/index.ts';
import { AGENTS_WORDS } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import { openNew } from '../new/index.tsx';
import { AgentComputerTag } from '../shared/agent-row.tsx';
import { timeAgo } from '../shared/time.ts';
import { type AgentEntry, matchesQuery, nameOf, teammateIds } from './agents-model.ts';
import { type NewDraft, useTeams } from './useAgentsData.ts';

/**
 * D131 · lane A · the Drafts card at the top of Agents (the composers' unsent
 * messages, D88, and this computer's New-agent draft, with Continue and Delete)
 * and Archived (`/agents?show=closed`: the archived agents, searchable, with Restore; D137).
 */

/** D137: an archived row's countdown or kept reason (its own computer's, sent with the session); `null` when neither. */
function archiveLine(session: Pick<SessionListItem, 'deletesAt' | 'keptReason'>): string | null {
  if (session.keptReason) return AGENTS_WORDS.kept(session.keptReason);
  if (session.deletesAt) return AGENTS_WORDS.deletesIn(session.deletesAt);
  return null;
}

/** The Drafts card; nothing when there is no draft. */
export function DraftsCard({ agents, newDraft, onRemoveNew, onOpen }: { readonly agents: readonly AgentEntry[]; readonly newDraft: NewDraft | null; readonly onRemoveNew: () => Promise<void>; readonly onOpen: (agent: AgentEntry) => void }) {
  const toast = useToast();
  const withDrafts = agents.filter((agent) => agent.draft !== null);
  const count = withDrafts.length + (newDraft ? 1 : 0);
  if (!count) return null;
  const removeAgentDraft = async (agent: AgentEntry): Promise<void> => {
    try {
      const stored = (await api.sessionDrafts(agent.id)).find((draft) => draft.field === draftField.composer);
      await api.deleteDraft(agent.id, draftField.composer);
      toast({ text: AGENTS_WORDS.draftDeleted, undo: stored ? () => api.putDraft(agent.id, draftField.composer, { value: stored.value }) : undefined });
    } catch (error) {
      toast({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  };
  return (
    <Card className="v2-drafts-card" data-testid="v2-drafts-card">
      <div className="v2-cgroup" style={{ color: 'var(--v2-text-2)' }}>
        <Icon name="edit" size="s" />
        {AGENTS_WORDS.draftsTitle(count)}
        <span className="v2-grow" />
        <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{AGENTS_WORDS.draftsNote}</span>
      </div>
      {newDraft ? (
        <div className="v2-plain-row" data-testid="v2-draft-new">
          <span className="v2-ficon">
            <Icon name="sparkle" />
          </span>
          <div className="v2-grow">
            <div className="v2-ttl">{newDraft.text || newDraft.name}</div>
            <div className="v2-sub">{AGENTS_WORDS.newAgentDraft(timeAgo(newDraft.updatedAt) || 'just now')}</div>
          </div>
          <Button size="sm" variant="primary" onClick={() => openNew({ kind: 'agent', text: newDraft.text })}>
            {AGENTS_WORDS.continue}
          </Button>
          <IconButton
            icon="trash"
            label={AGENTS_WORDS.deleteDraft}
            onClick={() => {
              void onRemoveNew().then(
                () => toast({ text: AGENTS_WORDS.draftDeleted }),
                (error: unknown) => toast({ text: error instanceof Error ? error.message : String(error), tone: 'error' }),
              );
            }}
          />
        </div>
      ) : null}
      {withDrafts.map((agent) => (
        <div key={agent.id} className="v2-plain-row" data-testid="v2-draft-row" data-session={agent.id}>
          <span className="v2-ficon">
            <Icon name="chat" />
          </span>
          <div className="v2-grow">
            <div className="v2-ttl">
              {agent.name} <span className="v2-draft-tag">{AGENTS_WORDS.draft}</span>
            </div>
            <div className="v2-sub">{`“${(agent.draft ?? '').slice(0, 90)}”`}</div>
          </div>
          <Button size="sm" variant="primary" onClick={() => onOpen(agent)} data-testid="v2-draft-continue">
            {AGENTS_WORDS.continue}
          </Button>
          <IconButton icon="trash" label={AGENTS_WORDS.deleteDraft} onClick={() => void removeAgentDraft(agent)} data-testid="v2-draft-delete" />
        </div>
      ))}
    </Card>
  );
}

/** How many closed agents are shown before "search to find one". */
const CLOSED_SHOWN = 60;

/**
 * Archived (D137; was Closed (history)): the archived agents, newest first, with search and
 * Restore; a line on top says when the archive deletes them (Change in Settings), and each row
 * its countdown ("Deletes in 12 days", "Deletes today") or why it is kept ("Kept: pinned").
 */
export function ClosedView() {
  const all = useSessionListOf('all');
  const settings = useApi(api.settings);
  const archiveDays = settings.data ? readKnownSettings(settings.data)['sessions.archiveDays'] : null;
  // Teammates are the Crews pages' (fix after 2.0), closed or not.
  const teams = useTeams();
  const mates = useMemo(() => teammateIds(teams), [teams]);
  const toast = useToast();
  const { navigate } = useV2Router();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const closed = useMemo(
    () =>
      (all.data ?? [])
        .filter((session) => session.closedAt && !mates.has(session.id))
        .sort((a, b) => Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? ''))
        .filter((session) => !query.trim() || matchesQuery(`${nameOf(session)} ${session.folderPath ?? ''} ${session.machine?.name ?? ''}`, query)),
    [all.data, query, mates],
  );
  const total = (all.data ?? []).filter((session) => session.closedAt && !mates.has(session.id)).length;
  const reopen = async (id: string, name: string): Promise<void> => {
    setBusy(id);
    try {
      await api.reopenSession(id);
      all.reload();
      toast({ text: AGENTS_WORDS.reopened(name), undo: () => api.closeSession(id, true) });
    } catch (error) {
      toast({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div data-testid="v2-closed">
      <div className="v2-crumbs">
        <V2Link to="/agents" className="v2-crumb-btn" style={{ textDecoration: 'none' }}>
          {AGENTS_WORDS.title}
        </V2Link>
        <Icon name="chev" size="s" />
        <b>{AGENTS_WORDS.closedTitle}</b>
        <span>{`· ${AGENTS_WORDS.agentsCount(total)}`}</span>
      </div>
      {archiveDays !== null ? (
        <p className="v2-muted v2-closed-policy" data-testid="v2-archive-policy">
          {AGENTS_WORDS.archivePolicy(archiveDays)}{' '}
          <V2Link to="/settings/advanced/sessions" data-testid="v2-archive-settings">
            {AGENTS_WORDS.archiveSettings}
          </V2Link>
          .
        </p>
      ) : null}
      <div className="v2-closed-search">
        <Field type="search" placeholder={AGENTS_WORDS.searchClosed} aria-label={AGENTS_WORDS.searchClosed} value={query} onChange={(event) => setQuery(event.target.value)} data-testid="v2-closed-search" />
      </div>
      {all.data === null ? (
        <Card>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="v2-plain-row">
              <Skeleton width={36} height={36} />
              <div className="v2-grow">
                <Skeleton width="45%" />
                <Skeleton width="70%" height={9} style={{ marginTop: 8 }} />
              </div>
            </div>
          ))}
        </Card>
      ) : closed.length === 0 ? (
        <EmptyState icon="clock" tone="grey" title={query ? AGENTS_WORDS.closedNoMatch : AGENTS_WORDS.closedEmpty} text={query ? undefined : AGENTS_WORDS.closedEmptyText} action={<Button onClick={() => navigate('/agents')}>{AGENTS_WORDS.backToAgents}</Button>} testId="v2-closed-empty" />
      ) : (
        <Card>
          {closed.slice(0, CLOSED_SHOWN).map((session) => {
            const name = nameOf(session);
            const offline = session.machine ? session.machine.state !== 'online' : false;
            return (
              <div key={session.id} className="v2-plain-row" data-testid="v2-closed-row" data-session={session.id}>
                <span className="v2-ficon">
                  <Icon name="clock" />
                </span>
                <div className="v2-grow">
                  <div className="v2-ttl">{name}</div>
                  <div className="v2-sub">
                    {AGENTS_WORDS.closedAgo(timeAgo(session.closedAt) || 'just now')}
                    {archiveLine(session) ? (
                      <span className="v2-closed-countdown" data-testid="v2-closed-countdown" data-kept={session.keptReason ? '' : undefined}>
                        {` · ${archiveLine(session)}`}
                      </span>
                    ) : null}
                  </div>
                </div>
                <AgentComputerTag machine={session.machine} short />
                <Button size="sm" icon="refresh" disabled={busy === session.id || offline} title={offline && session.machine ? AGENTS_WORDS.offlineWhy(session.machine.name) : undefined} onClick={() => void reopen(session.id, name)} data-testid="v2-closed-reopen">
                  {AGENTS_WORDS.reopen}
                </Button>
              </div>
            );
          })}
          {closed.length > CLOSED_SHOWN ? (
            <div className="v2-plain-row" style={{ justifyContent: 'center' }}>
              <span className="v2-muted">{`${closed.length - CLOSED_SHOWN} more · search to find one`}</span>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
