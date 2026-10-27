import { useState, type ReactElement } from 'react';
import './command-copy.css';

/**
 * D139 (`docs/accounts.md` → *The account needs you*): a terminal command shown as code with a
 * **Copy** button (both themes: the Inbox / Needs-you item, the stopped session's divider). The
 * command is read-only text; copying needs the browser's clipboard (absent: the text can be selected).
 */
export function CommandCopy({ command, className, testId = 'command-copy' }: { readonly command: string; readonly className?: string; readonly testId?: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`sb-command-copy${className ? ` ${className}` : ''}`} data-testid={testId}>
      <code className="sb-command-copy__code" data-testid={`${testId}-text`}>
        {command}
      </code>
      <button
        type="button"
        className="sb-command-copy__button"
        data-testid={`${testId}-button`}
        aria-label={`Copy the command: ${command}`}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
