import type { Session } from '../../../core/api.ts';
import { type SessionMachine } from '../../../core/peers.ts';
import { api } from '../../api/client.ts';
import { continuePrefill } from '../../views/session/ChatMenu.tsx';
import { computerStateToV2 } from '../glossary.ts';
import { openNew } from '../new/index.tsx';

/**
 * D131 · lane S · small shared pieces of the agent view: the computer an agent
 * runs on, in v2 words, and a conversation's "Continue as agent".
 */

/** The paired computer an agent runs on (`null` = this one), with its v2 state. */
export function computerOf(machine: SessionMachine | null | undefined): { readonly name: string; readonly state: 'online' | 'reconnecting' | 'offline' } | null {
  if (!machine) return null;
  return { name: machine.name, state: computerStateToV2(machine.state) };
}

/** D106 · Continue as agent: the + New sheet for an agent, filled in from the conversation (it carries the conversation over). */
export async function continueAsAgent(session: Session): Promise<void> {
  const folders = await api.savedFolders().catch(() => []);
  openNew({ kind: 'agent', prefill: continuePrefill(session, folders), machine: session.machine?.id ?? null });
}
