import { createContext, useContext } from 'react';
import type { SessionActivity } from '../../../core/api.ts';
import { Icon, type MenuItem } from '../components/index.ts';
import { AGENTS_WORDS, STATUS, type V2Status } from '../glossary.ts';
import type { AgentEntry } from './agents-model.ts';
import type { TreeActions } from './useTreeActions.ts';

/**
 * D131 · lane A · what every part of the Agents page shares: the tree's actions,
 * the dialogs' openers and the agent's ⋯ menu.
 */
export interface AgentsPageApi {
  readonly actions: TreeActions;
  readonly openAgent: (agent: AgentEntry) => void;
  readonly openMove: (agent: AgentEntry) => void;
  readonly openFolderDialog: (request: FolderDialogRequest) => void;
  readonly agentMenu: (agent: AgentEntry) => MenuItem[];
  /** "Synced to Studio-PC." (empty when the layout is not shared). */
  readonly shareNote: string;
  /** Show the AI engine on rows (Advanced). */
  readonly advanced: boolean;
  /** An agent's live activity (`activity` hub events over the listed sessions'). */
  readonly activityOf: (id: string) => SessionActivity | null;
}

/** Which folder dialog to open. */
export type FolderDialogRequest = { readonly mode: 'new'; readonly parentId: string | null } | { readonly mode: 'rename'; readonly folderId: string } | { readonly mode: 'delete'; readonly folderId: string };

const Context = createContext<AgentsPageApi | null>(null);

/** The page's provider. */
export const AgentsPageProvider = Context.Provider;

/** The page's shared API (inside the Agents page only). */
export function useAgentsPage(): AgentsPageApi {
  const value = useContext(Context);
  if (!value) throw new Error('useAgentsPage outside the Agents page');
  return value;
}

/** A small status mark (icon + the word for screen readers): the tree's and phone's rows. */
export function MiniStatus({ status }: { readonly status: V2Status }) {
  const look = STATUS[status];
  return (
    <span className="v2-mst" data-tone={look.tone} title={look.label}>
      {look.icon === 'pulse' ? <span className="v2-pulse" aria-hidden="true" /> : <Icon name={look.icon} size="s" />}
      <span className="v2-sr">{look.label}</span>
    </span>
  );
}

/** The kind tag of an agent that is not a plain one ("Conversation", "Teammate · Mobile", "Step · PROJ-100"). */
export function kindLabel(agent: Pick<AgentEntry, 'kind' | 'crew' | 'plan'>): string | null {
  switch (agent.kind) {
    case 'conv':
      return AGENTS_WORDS.kind.conv;
    case 'routine':
      return AGENTS_WORDS.kind.routine;
    case 'mate':
      return `${AGENTS_WORDS.kind.mate}${agent.crew ? ` · ${agent.crew.name}` : ''}`;
    case 'step':
      return `${AGENTS_WORDS.kind.step}${agent.plan ? ` · ${agent.plan.title.split(' ')[0] ?? ''}` : ''}`;
    default:
      return null;
  }
}
