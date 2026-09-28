import { useEffect, useRef, useState } from 'react';
import { statusColor } from '../../shell/format.ts';
import { handoff } from './session-header.ts';

/** How long "copied" shows after a copy (prototype: 1.5 s). */
const COPIED_MS = 1_500;

/**
 * The terminal handoff card (SPEC → Session → Right panel; prototype `handoff`):
 * state ("attached" / "in terminal"), the explanation, and `claude --resume <id>`
 * with copy. Built with the header's "⇄ Continue in terminal" / "⇄ Attach here"
 * (M4.1): the command is the one `/detach` returns (`Session.resumeCommand`, the
 * same text). Since M4.3 it sits under the agent cards and the terminal tail
 * (`RightPanel.tsx`, `docs/session-panel.md`). D14: under the command, the
 * folder to run it in (`Session.cwd`: the workspace root, the repo, or a repo
 * session's worktree), because `claude --resume` finds the session by its folder.
 */
export function HandoffCard({ attached, command, cwd = null }: { readonly attached: boolean; readonly command: string; readonly cwd?: string | null }) {
  const card = handoff(attached);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = (): void => {
    try {
      void navigator.clipboard?.writeText(command).catch(() => undefined);
    } catch {
      // No clipboard access (insecure context): the command stays selectable.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className="sb-handoff" data-testid="handoff-card" data-state={card.state}>
      <div className="sb-handoff-head">
        Terminal handoff
        <span className="sb-handoff-state" data-testid="handoff-state" style={{ color: statusColor(card.status) }}>
          {card.state}
        </span>
      </div>
      <div className="sb-handoff-text">{card.text}</div>
      <div className="sb-handoff-command">
        <span className="sb-handoff-command-text" data-testid="handoff-command">
          {command}
        </span>
        <button type="button" className="sb-button sb-handoff-copy" data-testid="handoff-copy" onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {cwd ? (
        <div className="sb-handoff-cwd" data-testid="handoff-cwd" title="Run the command in this folder">
          <span className="sb-handoff-cwd-k">cwd </span>
          {cwd}
        </div>
      ) : null}
    </div>
  );
}
