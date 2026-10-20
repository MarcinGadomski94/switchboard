import { useEffect, useRef, useState } from 'react';
import { type PeerSyncNote, type PeerSyncedList, peerSyncNotes } from '../../core/peers.ts';
import { useMachines } from '../api/useMachines.ts';
import './machine-status.css';
import './peer-sync.css';

/** A fetch shorter than this shows no "Syncing with …" (no flash for a quick refresh). */
export const PEER_SYNC_SHOW_AFTER_MS = 400;

/** What {@link usePeerSync} gives the page. */
export interface PeerSyncState {
  /** The notes to show: every offline machine's, and the syncing ones that took longer than {@link PEER_SYNC_SHOW_AFTER_MS}. */
  readonly notes: readonly PeerSyncNote[];
  /** The polite live region's words: `Syncing with studio-pc…`, then `Synced with studio-pc.` */
  readonly announcement: string;
}

/**
 * D113 (`docs/peers.md` → *List sync (D113)*): where each paired machine's copy
 * of `list` stands, for a page that merges it (the Artifacts page, the Inbox),
 * live from the machines' status (`GET /api/machines`, then `/hub`
 * `machineState`). `onArrived` runs when a machine's copy arrives (its
 * `listSync.<list>.syncedAt` moves), so the page reads its list again and the
 * machine's rows merge in.
 */
export function usePeerSync(list: PeerSyncedList, onArrived: () => void): PeerSyncState {
  const machines = useMachines();
  const all = peerSyncNotes(machines, list);

  // Arrivals: a machine's syncedAt moved (the first look only records them).
  const seen = useRef<Map<string, string | null> | null>(null);
  const callback = useRef(onArrived);
  callback.current = onArrived;
  const stamps = machines.map((machine) => `${machine.id}=${machine.listSync?.[list].syncedAt ?? ''}`).join('|');
  useEffect(() => {
    const next = new Map(machines.map((machine) => [machine.id, machine.listSync?.[list].syncedAt ?? null] as const));
    const before = seen.current;
    seen.current = next;
    if (before === null) return;
    for (const [id, at] of next) {
      if (at !== null && before.get(id) !== at) {
        callback.current();
        return;
      }
    }
  }, [stamps]);

  // A syncing machine shows once its fetch has taken a moment.
  const syncingKey = all
    .filter((note) => note.kind === 'syncing')
    .map((note) => note.id)
    .join(',');
  const [settled, setSettled] = useState('');
  useEffect(() => {
    if (syncingKey === '') {
      setSettled('');
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(syncingKey), PEER_SYNC_SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [syncingKey]);
  const shown = new Set(settled.split(',').filter((id) => id !== ''));
  const notes = all.filter((note) => note.kind === 'offline' || shown.has(note.id));

  // The live region: what is syncing now, then which ones finished (not the ones that went offline instead).
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef<readonly PeerSyncNote[]>([]);
  const shownKey = notes
    .filter((note) => note.kind === 'syncing')
    .map((note) => note.id)
    .join(',');
  useEffect(() => {
    const syncing = notes.filter((note) => note.kind === 'syncing');
    const offline = new Set(notes.filter((note) => note.kind === 'offline').map((note) => note.id));
    if (syncing.length > 0) setAnnouncement(`Syncing with ${syncing.map((note) => note.name).join(', ')}…`);
    else {
      const done = announced.current.filter((note) => !offline.has(note.id));
      if (done.length > 0) setAnnouncement(`Synced with ${done.map((note) => note.name).join(', ')}.`);
    }
    announced.current = syncing;
  }, [shownKey]);

  return { notes, announcement };
}

/**
 * D113: a page's per-machine sync notes: "Syncing with studio-pc…" with a
 * spinner while its copy is not in (non-blocking: the local rows are already
 * shown), "studio-pc is offline — …" (static) while it cannot be reached; and a
 * polite live region (visually hidden) that says when a sync starts and ends.
 */
export function PeerSyncNotes({ state, testId }: { readonly state: PeerSyncState; readonly testId: string }) {
  return (
    <>
      <span className="sb-peer-sync-live" role="status" aria-live="polite" data-testid={`${testId}-live`}>
        {state.announcement}
      </span>
      {state.notes.length > 0 ? (
        <div className="sb-peer-sync" data-testid={testId}>
          {state.notes.map((note) => (
            <span key={note.id} className="sb-peer-sync-note" data-testid={`${testId}-note`} data-kind={note.kind} data-machine-id={note.id}>
              {note.kind === 'syncing' ? <span className="sb-machine-spinner" data-testid={`${testId}-spinner`} aria-hidden="true" /> : <span className="sb-peer-sync-mark" aria-hidden="true" />}
              <span className="sb-peer-sync-text">{note.text}</span>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
