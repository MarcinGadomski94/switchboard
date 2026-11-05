import { conversationOnlyHint, conversationOnlyLabel } from '../../takeover/conversation-only.ts';
import { Checkbox } from '../components/index.ts';

/**
 * D158 (`docs/peers.md` → *Conversation only (D158)*): the **Conversation only** tick
 * of the agent's and the crew's move dialogs. Ticked, the move carries only the chat
 * (and its settings, todos, loops); the repos are used as they are on the target.
 */
export function ConversationOnlyOption({ sourceName, targetName, checked, disabled, onChange }: { readonly sourceName: string; readonly targetName: string; readonly checked: boolean; readonly disabled?: boolean; readonly onChange: (on: boolean) => void }) {
  return (
    <div className="v2-mv-facts" data-testid="v2-move-conversation-only" data-tour="v2-move-conversation-only">
      <Checkbox label={conversationOnlyLabel(targetName)} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} data-testid="v2-move-conversation-only-check" />
      <p className="v2-muted v2-c-small">{conversationOnlyHint(sourceName, targetName)}</p>
    </div>
  );
}
