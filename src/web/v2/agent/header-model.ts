/**
 * D131 · lane S · the agent header's pure parts: the automatic-tests chip (D109's
 * PR watch in plain words) and the agent ⋯ menu (which actions there are for this
 * agent, and why one is disabled). The view (`Header.tsx`, `AgentMenu.tsx`) runs them.
 */
import { type SessionPr, ciChip } from '../../../core/ci.ts';
import { AGENT_WORDS, type Tone } from '../glossary.ts';

/** The automatic-tests chip. */
export interface CiView {
  readonly state: 'passing' | 'failing' | 'running' | 'merged';
  readonly label: string;
  readonly tone: Tone;
  readonly icon: string;
  /** The PR's number and address ("Open change request #42"), `null` without an address. */
  readonly pr: { readonly number: number; readonly url: string | null };
  /** The tooltip: the repo and branch, what failed. */
  readonly title: string;
}

/** The chip for the session's watched change requests, `null` without one (the prototype's `ciChip`). */
export function ciView(prs: readonly SessionPr[]): CiView | null {
  const chip = ciChip(prs);
  if (!chip) return null;
  const pr = chip.pr;
  const title = [`${pr.repo} · ${pr.branch} · #${pr.number}`, pr.summary ?? ''].filter(Boolean).join(' · ');
  const base = { pr: { number: pr.number, url: pr.url }, title };
  switch (chip.state) {
    case 'green':
      return { ...base, state: 'passing', label: `${AGENT_WORDS.testsPassing} ✓`, tone: 'green', icon: 'check' };
    case 'running':
      return { ...base, state: 'running', label: AGENT_WORDS.testsRunning, tone: 'blue', icon: 'pulse' };
    case 'merged':
      return { ...base, state: 'merged', label: AGENT_WORDS.testsMerged, tone: 'violet', icon: 'merge' };
    default: {
      const tail = pr.stopped ? AGENT_WORDS.testsGaveUp : pr.attempts > 0 ? AGENT_WORDS.sentBack(Math.min(pr.attempts + 1, pr.maxAttempts), pr.maxAttempts) : null;
      return { ...base, state: 'failing', label: `${AGENT_WORDS.testsFailing} ✗${tail ? ` · ${tail}` : ''}`, tone: 'red', icon: 'x' };
    }
  }
}

/** An agent ⋯ menu entry (the view adds what each does). */
export type AgentMenuId =
  | 'rename'
  | 'pause'
  | 'resume'
  | 'stop-background'
  | 'move'
  | 'terminal'
  | 'attach'
  | 'remote'
  | 'claude-app'
  | 'routine'
  | 'notes'
  | 'teammate'
  | 'return'
  | 'continue-agent'
  | 'continue-hooked'
  | 'close'
  | 'reopen'
  | 'delete';

/** One entry, or a separator (`sep`). */
export type AgentMenuSpec = { readonly id: AgentMenuId; readonly label: string; readonly icon: string; readonly disabledReason?: string; readonly danger?: boolean } | { readonly sep: string };

/** What the menu reads of the agent. */
export interface AgentMenuInput {
  readonly conversation: boolean;
  readonly closed: boolean;
  /** A live process or a stored `run` / `need`. */
  readonly running: boolean;
  /** Its process belongs to a terminal (detached): Pause / Resume wait for Attach. */
  readonly attached: boolean;
  /** A hand-started terminal session Switchboard hooked into (D48 P4). */
  readonly hooked: boolean;
  /** The paired computer it runs on, `null` = this one. */
  readonly machineName: string | null;
  /** Why nothing can reach it now (its computer is offline), `null` otherwise. */
  readonly offline: string | null;
  /** The Remote toggle (D24): `null` = no Remote state (never ran here). */
  readonly remote: { readonly on: boolean; readonly disabled: boolean; readonly reason: string | null } | null;
  /** Background tasks it can stop (D50 ruling). */
  readonly background: number;
  /** It can move to / be taken over from another computer (D65 `offersTakeover`). */
  readonly movable: boolean;
  /** Another computer is paired and online (where it could move). */
  readonly computers: number;
  /** It is a teammate (a crew member). */
  readonly teammate: boolean;
  /** Crews exist to join. */
  readonly crews: number;
  /**
   * Lane X · D72: it was started in a terminal and can continue as a Switchboard-run
   * agent (`offersHookedContinue`); `false` for every other agent. Optional: absent = `false`.
   */
  readonly hookedContinue?: boolean;
}

/** The agent ⋯ menu (the prototype's `agentMenu`, today's actions): every action listed, disabled with the reason where it cannot run. */
export function agentMenu(input: AgentMenuInput): AgentMenuSpec[] {
  const off = input.offline;
  const items: AgentMenuSpec[] = [{ id: 'rename', label: AGENT_WORDS.rename, icon: 'edit', ...(off ? { disabledReason: off } : {}) }];
  if (!input.conversation) {
    const reason = off ?? (input.hooked ? 'It runs in a terminal: pause it there.' : !input.attached ? 'It continues in a terminal: bring it back here first.' : input.closed ? 'Closed agents do not run.' : undefined);
    items.push(input.running ? { id: 'pause', label: AGENT_WORDS.pause, icon: 'pause', ...(reason ? { disabledReason: reason } : {}) } : { id: 'resume', label: AGENT_WORDS.resume, icon: 'play', ...(reason ? { disabledReason: reason } : {}) });
    items.push({ id: 'stop-background', label: AGENT_WORDS.stopBackground, icon: 'cpu', ...(off ? { disabledReason: off } : input.background === 0 ? { disabledReason: AGENT_WORDS.noBackground } : {}) });
    const moveReason = off
      ? AGENT_WORDS.offlineReason(input.machineName ?? 'Its computer')
      : input.closed
        ? 'Closed agents stay where they are.'
        : !input.movable
          ? 'It cannot move: it never ran here, or it moved already.'
          : input.machineName === null && input.computers === 0
            ? 'No other computer is paired and online.'
            : undefined;
    items.push({ id: 'move', label: AGENT_WORDS.moveToComputer, icon: 'desktop', ...(moveReason ? { disabledReason: moveReason } : {}) });
  }
  items.push({ sep: 'a' });
  if (!input.conversation) {
    const termReason = input.machineName ? `It runs on ${input.machineName}: continue it in a terminal there.` : input.hooked ? 'It already runs in a terminal.' : input.closed ? 'Closed agents do not run.' : undefined;
    // Lane X · D72: an agent started in a terminal continues here (its terminal's claude is stopped first, the dialog asks).
    if (input.hooked) items.push({ id: 'continue-hooked', label: AGENT_WORDS.continueHooked, icon: 'play', ...(off ? { disabledReason: off } : !input.hookedContinue ? { disabledReason: 'It moved to another computer, so it continues there.' } : {}) });
    items.push(input.attached || input.machineName ? { id: 'terminal', label: AGENT_WORDS.continueInTerminal, icon: 'cmd', ...(termReason ? { disabledReason: termReason } : {}) } : { id: 'attach', label: AGENT_WORDS.attachHere, icon: 'cmd' });
    const remoteReason = off ?? (input.remote === null ? 'It never ran here, so it has no remote control.' : input.remote.disabled && !input.remote.on ? (input.remote.reason ?? undefined) : undefined);
    items.push({ id: 'remote', label: AGENT_WORDS.remoteLink, icon: 'qr', ...(remoteReason ? { disabledReason: remoteReason } : {}) });
    items.push({ id: 'claude-app', label: AGENT_WORDS.openInClaude, icon: 'external', ...(remoteReason ? { disabledReason: remoteReason } : input.remote && !input.remote.on && input.remote.disabled ? { disabledReason: input.remote.reason ?? 'Remote control is off.' } : {}) });
  }
  items.push({ sep: 'b' });
  if (!input.conversation) items.push({ id: 'routine', label: AGENT_WORDS.addRoutine, icon: 'routine', ...(off ? { disabledReason: off } : {}) });
  items.push({ id: 'notes', label: AGENT_WORDS.draftNotes, icon: 'book', ...(off ? { disabledReason: off } : input.conversation ? { disabledReason: 'Conversations have no notes of their own.' } : {}) });
  if (input.conversation) items.push({ id: 'continue-agent', label: AGENT_WORDS.continueAsAgent, icon: 'sparkle', ...(off ? { disabledReason: off } : {}) });
  else if (input.teammate) items.push({ id: 'return', label: AGENT_WORDS.returnToAgents, icon: 'agents', ...(off ? { disabledReason: off } : {}) });
  else items.push({ id: 'teammate', label: AGENT_WORDS.makeTeammate, icon: 'crew', ...(off ? { disabledReason: off } : input.closed ? { disabledReason: 'Reopen it first.' } : input.crews === 0 ? { disabledReason: 'Make a crew first (+ New › Crew).' } : {}) });
  items.push({ sep: 'c' });
  items.push(input.closed ? { id: 'reopen', label: AGENT_WORDS.reopen, icon: 'refresh', ...(off ? { disabledReason: off } : {}) } : { id: 'close', label: AGENT_WORDS.close, icon: 'x', ...(off ? { disabledReason: off } : {}) });
  if (input.conversation) items.push({ id: 'delete', label: AGENT_WORDS.deleteConversation, icon: 'trash', danger: true, ...(off ? { disabledReason: off } : {}) });
  return items;
}

/** The sidebar folders an agent sits in, outermost first (`[]` = not in a folder). */
export function folderTrail(layout: { readonly folders: readonly { readonly id: string; readonly name: string; readonly sessionIds: readonly string[]; readonly parentId?: string | null }[] } | null, sessionId: string): Array<{ readonly id: string; readonly name: string }> {
  if (!layout) return [];
  const byId = new Map(layout.folders.map((folder) => [folder.id, folder]));
  let folder = layout.folders.find((candidate) => candidate.sessionIds.includes(sessionId)) ?? null;
  const out: Array<{ readonly id: string; readonly name: string }> = [];
  const seen = new Set<string>();
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    out.unshift({ id: folder.id, name: folder.name });
    folder = folder.parentId ? (byId.get(folder.parentId) ?? null) : null;
  }
  return out;
}

/** The last segment of a path ("/x/acme-checkout" → "acme-checkout"). */
export function baseName(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}
