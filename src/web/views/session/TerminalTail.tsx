import type { TerminalLine } from './right-panel.ts';

/**
 * The terminal box (SPEC → Session → Right panel "terminal tail", and the
 * Timeline tab's terminal under its event log; prototype `ss.term`): mono lines on
 * the code background, each cut with an ellipsis, colored by its leading mark
 * (`lineTone`). The lines come from `terminalLines` (`docs/session-panel.md`).
 */
export function TerminalTail({ lines, className }: { readonly lines: readonly TerminalLine[]; readonly className?: string }) {
  return (
    <div className={className ? `sb-term ${className}` : 'sb-term'} data-testid="terminal-tail">
      {lines.map((line) => (
        <div key={line.key} className="sb-term-line" data-testid="terminal-line" data-tone={line.tone}>
          {line.text}
        </div>
      ))}
    </div>
  );
}
