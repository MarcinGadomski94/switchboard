import { type DragEvent, useMemo, useState } from 'react';
import type { TeamSummary } from '../../../core/team.ts';
import { refusalText, teamApi } from '../../team/api.ts';
import { reloadTeam, useTeamData } from '../../team/useTeamData.ts';
import { useLayout } from '../../shell/useLayout.ts';
import { Avatar, Button, Card, ComputerTag, EmptyState, Icon, MenuButton, type MenuItem, Skeleton, StatusBadge, useToast } from '../components/index.ts';
import { CREW_WORDS, teammateStatusToV2 } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import { useCrewPins } from '../shared/crew-pins.ts';
import { useOpenAgent } from '../shared/open-agent.ts';
import { ARCHIVED_HREF, archivedLine, crewInitials, crewLine, crewStats, dropCrew, moveCrew, moveCrewReason, openChatReason, orderedCrews } from './crew-model.ts';
import { visibleTeam } from '../../team/model.ts';
import { DeleteCrewDialog, NewCrewDialog, NewTeammateDialog, RenameCrewDialog } from './dialogs.tsx';
import './crews.css';

/** The square avatar of a crew (its initials). */
export function CrewAvatar({ name, size = 44 }: { readonly name: string; readonly size?: number }) {
  return (
    <span className="v2-c-crew-av" style={{ width: size, height: size }} aria-hidden="true">
      {crewInitials(name)}
    </span>
  );
}

/**
 * 2026-10-27 (D137 follow-up, the developer chose B): "1 archived teammate · Show in Archived".
 * Archived teammates stay in their crew but are hidden until restored; the link opens Agents › Archived.
 */
export function ArchivedLine({ archived }: { readonly archived: number }) {
  const text = archivedLine(archived);
  if (!text) return null;
  return (
    <p className="v2-muted v2-c-small v2-c-archived" data-testid="v2-crew-archived">
      {text} ·{' '}
      <V2Link to={ARCHIVED_HREF} data-testid="v2-crew-archived-link" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        {CREW_WORDS.showInArchived}
      </V2Link>
    </p>
  );
}

type Overlay = { readonly kind: 'new-crew' } | { readonly kind: 'new-teammate'; readonly crewId: string | null } | { readonly kind: 'rename'; readonly crew: TeamSummary } | { readonly kind: 'delete'; readonly crew: TeamSummary };

/** The crew ⋯ menu (Open, Pin to sidebar / Unpin, Move up / down, New teammate here, Rename, Delete). */
export function crewMenuItems(
  crew: TeamSummary,
  ids: readonly string[],
  actions: { readonly open: () => void; readonly pinned: boolean; readonly togglePin: () => void; readonly move: (delta: -1 | 1) => void; readonly newTeammate: () => void; readonly rename: () => void; readonly remove: () => void },
): MenuItem[] {
  const up = moveCrewReason(ids, crew.id, -1);
  const down = moveCrewReason(ids, crew.id, 1);
  return [
    { id: 'open', label: CREW_WORDS.openCrew, icon: 'crew', onSelect: actions.open },
    { id: 'pin', label: actions.pinned ? CREW_WORDS.unpinFromSidebar : CREW_WORDS.pinToSidebar, icon: 'pin', onSelect: actions.togglePin },
    { id: 'up', label: CREW_WORDS.moveUp, icon: 'chev-down', ...(up ? { disabledReason: up } : {}), onSelect: () => actions.move(-1) },
    { id: 'down', label: CREW_WORDS.moveDown, icon: 'chev-down', ...(down ? { disabledReason: down } : {}), onSelect: () => actions.move(1) },
    { id: 'new', label: 'New teammate here', icon: 'plus', onSelect: actions.newTeammate },
    { id: 'rename', label: CREW_WORDS.renameCrew, icon: 'edit', onSelect: actions.rename },
    { separator: true, id: 'sep' },
    { id: 'delete', label: CREW_WORDS.deleteCrew, icon: 'trash', danger: true, ...(ids.length <= 1 ? { disabledReason: 'Your only crew stays.' } : {}), onSelect: actions.remove },
  ];
}

/** Reorders the crews (optimistic; Undo puts the old order back). */
export function useCrewOrder(crews: readonly TeamSummary[]): { readonly ordered: TeamSummary[]; readonly ids: string[]; readonly save: (next: string[], what: string) => Promise<void> } {
  const [pending, setPending] = useState<string[] | null>(null);
  const toast = useToast();
  const ordered = useMemo(() => orderedCrews(crews, pending), [crews, pending]);
  const ids = ordered.map((crew) => crew.id);
  const save = async (next: string[], what: string): Promise<void> => {
    const before = ids;
    setPending(next);
    try {
      await teamApi.reorderTeams(next);
      await reloadTeam();
      setPending(null);
      toast({
        text: `${what} Order synced to every computer.`,
        undo: async () => {
          setPending(before);
          await teamApi.reorderTeams(before);
          await reloadTeam();
          setPending(null);
        },
      });
    } catch (e) {
      setPending(null);
      toast({ text: refusalText(e), tone: 'error' });
    }
  };
  return { ordered, ids, save };
}

/** D131 · Crews (`/crews`), lane P: every crew, in order; drag (or ⋯ › Move up / down) to reorder. */
export function CrewsPage() {
  const data = useTeamData();
  const layout = useLayout();
  const phone = layout === 'phone';
  const { navigate } = useV2Router();
  const toast = useToast();
  const { ordered, ids, save } = useCrewOrder(data.teams);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const pins = useCrewPins();
  const openAgent = useOpenAgent();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const open = (id: string): void => navigate({ area: 'crew', id });
  const move = (crew: TeamSummary, delta: -1 | 1): void => {
    const next = moveCrew(ids, crew.id, delta);
    if (next) void save(next, `Moved “${crew.name}” ${delta < 0 ? 'up' : 'down'}.`);
  };
  const drop = (event: DragEvent, target: string): void => {
    event.preventDefault();
    const from = dragging ?? event.dataTransfer.getData('text/x-v2-crew');
    setDragging(null);
    setOver(null);
    if (!from) return;
    const next = dropCrew(ids, from, target);
    const crew = ordered.find((entry) => entry.id === from);
    if (next && crew) void save(next, `Moved “${crew.name}”.`);
  };
  return (
    <div className="v2-page" data-testid="v2-page-crews" data-area="crews">
      {phone ? (
        <nav className="v2-c-crumb" aria-label="Crew path">
          <b>Crews</b>
        </nav>
      ) : null}
      <div className="v2-c-ph">
        <div className="v2-grow">
          <h1>Crews</h1>
          <p className="v2-page-sub">{phone ? 'In your order. Tap a crew to see its teammates.' : CREW_WORDS.pageSub}</p>
        </div>
        <Button icon="plus" onClick={() => setOverlay({ kind: 'new-teammate', crewId: null })} data-testid="v2-crews-new-teammate">
          {CREW_WORDS.newTeammate}
        </Button>
        <Button variant="primary" icon="plus" onClick={() => setOverlay({ kind: 'new-crew' })} data-testid="v2-crews-new-crew">
          {CREW_WORDS.newCrew}
        </Button>
      </div>
      {!data.loaded ? (
        <div className="v2-c-crews" aria-busy="true">
          {[0, 1].map((index) => (
            <div key={index} className="v2-card v2-c-crewcard">
              <Skeleton width="50%" height={18} />
              <Skeleton lines={2} style={{ marginTop: 14 }} />
            </div>
          ))}
        </div>
      ) : data.error && ordered.length === 0 ? (
        <EmptyState icon="alert" tone="grey" title="Crews aren’t available" text={data.error} />
      ) : ordered.length === 0 ? (
        <EmptyState icon="crew" tone="grey" title="No crews yet" text="A crew is a group of long-lived teammates." />
      ) : phone ? (
        <div className="v2-c-plist" data-testid="v2-crews-list">
          {ordered.map((crew) => {
            const stats = crewStats(crew);
            return (
              <button key={crew.id} type="button" className="v2-c-prow" onClick={() => open(crew.id)} data-testid="v2-crew-row" data-crew={crew.id}>
                <CrewAvatar name={crew.name} size={40} />
                <span className="v2-grow">
                  <b>{crew.name}</b>
                  <span className="v2-muted v2-c-small">
                    {crewLine(stats)}
                    {stats.archived > 0 ? <span data-testid="v2-crew-archived"> · {archivedLine(stats.archived)}</span> : null}
                  </span>
                </span>
                {stats.needs > 0 ? <StatusBadge status="needs" label={String(stats.needs)} size="s" /> : null}
                <Icon name="chev" size="s" />
              </button>
            );
          })}
          <p className="v2-muted v2-c-small v2-c-note-line">
            <Icon name="grip" size="s" />
            {CREW_WORDS.phoneNote}
          </p>
        </div>
      ) : (
        <>
          <div className="v2-c-crews" role="list" aria-label="Crews, in your order" data-testid="v2-crews-list">
            {ordered.map((crew, index) => {
              const stats = crewStats(crew);
              return (
                <Card
                  key={crew.id}
                  interactive
                  role="listitem"
                  className="v2-c-crewcard"
                  draggable
                  data-testid="v2-crew-card"
                  data-crew={crew.id}
                  data-drop={over === crew.id && dragging !== crew.id ? '' : undefined}
                  aria-label={`Crew ${crew.name}, ${CREW_WORDS.teammates(stats.members)}, ${stats.working} working, ${stats.needs} need you`}
                  onClick={() => open(crew.id)}
                  onDragStart={(event) => {
                    setDragging(crew.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/x-v2-crew', crew.id);
                  }}
                  onDragOver={(event) => {
                    if (!dragging) return;
                    event.preventDefault();
                    setOver(crew.id);
                  }}
                  onDragLeave={() => setOver((current) => (current === crew.id ? null : current))}
                  onDrop={(event) => drop(event, crew.id)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                >
                  <div className="v2-row v2-c-crewcard-head">
                    <span className="v2-c-grip" title="Drag to reorder" aria-hidden="true">
                      <Icon name="grip" size="s" />
                    </span>
                    <CrewAvatar name={crew.name} />
                    <div className="v2-grow">
                      <h3 className="v2-c-crew-name">{crew.name}</h3>
                      <span className="v2-muted v2-c-small">
                        {CREW_WORDS.inOrder(index)} · {CREW_WORDS.teammates(stats.members)}
                      </span>
                    </div>
                    {stats.needs > 0 ? <StatusBadge status="needs" label={`${stats.needs} need${stats.needs === 1 ? 's' : ''} you`} size="s" /> : null}
                    <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                      <MenuButton
                        label={`Crew actions for ${crew.name}`}
                        testId="v2-crew-menu"
                        items={crewMenuItems(crew, ids, {
                          open: () => open(crew.id),
                          pinned: pins.isPinned(crew.id),
                          togglePin: () => void pins.toggle(crew),
                          move: (delta) => move(crew, delta),
                          newTeammate: () => setOverlay({ kind: 'new-teammate', crewId: crew.id }),
                          rename: () => setOverlay({ kind: 'rename', crew }),
                          remove: () => setOverlay({ kind: 'delete', crew }),
                        })}
                      />
                    </span>
                  </div>
                  <div className="v2-row v2-c-wrap v2-c-crewcard-foot">
                    {/* Fix after 2.0 (2.4.5): a teammate's avatar opens its chat; the rest of the card opens the crew. */}
                    <span className="v2-c-avs" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                      {(visibleTeam(crew).roster ?? []).map((entry) => {
                        const why = openChatReason(entry);
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className="v2-c-av-open"
                            draggable={false}
                            onClick={() => openAgent(entry.sessionRef)}
                            disabled={why !== null}
                            title={why ?? `${entry.name} · ${entry.status} · ${CREW_WORDS.openChat}`}
                            aria-label={why ? `${entry.name}: ${why}` : CREW_WORDS.openChatOf(entry.name)}
                            data-testid="v2-crew-card-mate"
                            data-session={entry.sessionRef}
                          >
                            <Avatar name={entry.name} status={teammateStatusToV2(entry.status)} size="m" />
                          </button>
                        );
                      })}
                    </span>
                    <span className="v2-grow" />
                    <span className="v2-c-kvs">
                      <b>{stats.working}</b> {CREW_WORDS.working}
                    </span>
                    <span className="v2-c-kvs">
                      <b className={stats.needs > 0 ? 'v2-c-amber' : undefined}>{stats.needs}</b> {CREW_WORDS.needYou}
                    </span>
                    {stats.computers.map((computer) => (
                      <ComputerTag key={computer.name} name={computer.name} kind={computer.local ? 'laptop' : 'desktop'} short />
                    ))}
                  </div>
                  {stats.archived > 0 ? <ArchivedLine archived={stats.archived} /> : null}
                </Card>
              );
            })}
          </div>
          <p className="v2-muted v2-c-small v2-c-note-line">
            <Icon name="grip" size="s" />
            {CREW_WORDS.reorderNote}
          </p>
        </>
      )}
      {overlay?.kind === 'new-crew' ? (
        <NewCrewDialog
          onClose={() => setOverlay(null)}
          onCreated={(crew) => {
            setOverlay(null);
            void reloadTeam();
            toast({ text: `Crew “${crew.name}” created. It’s last in your order; drag it anywhere.` });
            open(crew.id);
          }}
        />
      ) : null}
      {overlay?.kind === 'new-teammate' ? (
        <NewTeammateDialog
          crews={ordered}
          crewId={overlay.crewId}
          onClose={() => setOverlay(null)}
          onCreated={(member) => {
            setOverlay(null);
            void reloadTeam();
            toast({ text: `${member.name} joined ${ordered.find((crew) => crew.id === member.teamId)?.name ?? 'the crew'}.` });
            open(member.teamId);
          }}
        />
      ) : null}
      {overlay?.kind === 'rename' ? (
        <RenameCrewDialog
          crew={overlay.crew}
          onClose={() => setOverlay(null)}
          onDone={() => {
            setOverlay(null);
            void reloadTeam();
          }}
        />
      ) : null}
      {overlay?.kind === 'delete' ? (
        <DeleteCrewDialog
          crew={overlay.crew}
          onClose={() => setOverlay(null)}
          onDone={() => {
            setOverlay(null);
            void reloadTeam();
            toast({ text: `Deleted “${overlay.crew.name}”. Its teammates are back in Agents.` });
          }}
        />
      ) : null}
    </div>
  );
}
