import { useState } from 'react';
import { autoCleanRecordText } from '../../../core/auto-clean.ts';
import type { KnownSettings } from '../../../core/settings.ts';
import { Row, ToggleValue } from './rows.tsx';
import type { SaveSettings } from './sections.tsx';

/** The words of {@link AutoCleanRows} (classic by default; v2 passes its glossary's, `AUTO_CLEAN_WORDS`). */
export interface AutoCleanWords {
  readonly label: string;
  readonly description: string;
  readonly remoteLabel: string;
  readonly remoteDescription: string;
}

/** Classic's words. */
export const CLASSIC_AUTO_CLEAN_WORDS: AutoCleanWords = {
  label: 'Clean up merged worktrees automatically',
  description:
    'Once a session’s work is merged into its base (or its PR is merged), its worktree folder and local branch are removed by themselves, also the worktrees its agent made (such as .claude/worktrees). Never while the agent works, or with uncommitted, untracked or unpushed changes, or a process still running in it: those stay for Clean-up.',
  remoteLabel: 'Also delete the branch on the remote',
  remoteDescription: 'Only a merged branch the agent pushed itself; never main, master, dev, develop, a release branch, the base or the default branch.',
};

/**
 * D145 · Settings → Sessions & worktrees (v2: Settings › Advanced › Agents & separate copies):
 * the automatic clean-up of merged worktrees (`worktrees.autoClean`) with, under it, what it did
 * ("Cleaned up 3 worktrees so far, the last today 14:02"), and its remote branch option
 * (`worktrees.autoCleanRemote`, off while the clean-up is off).
 */
export function AutoCleanRows({ settings, save, words = CLASSIC_AUTO_CLEAN_WORDS }: { readonly settings: KnownSettings; readonly save: SaveSettings; readonly words?: AutoCleanWords }) {
  const [busy, setBusy] = useState(false);
  const on = settings['worktrees.autoClean'];
  const flip = (key: 'worktrees.autoClean' | 'worktrees.autoCleanRemote'): void => {
    setBusy(true);
    void save({ [key]: !settings[key] }).finally(() => setBusy(false));
  };
  const last = autoCleanRecordText(settings['worktrees.autoCleanRecord']);
  return (
    <>
      <Row
        id="auto-clean"
        tour="setting-auto-clean"
        label={words.label}
        description={
          <>
            {words.description}
            {last ? (
              <span className="sb-set-auto-clean-last" data-testid="auto-clean-last" style={{ display: 'block', marginTop: 4 }}>
                {last}
              </span>
            ) : null}
          </>
        }
      >
        <ToggleValue label={words.label} value={on} disabled={busy} onToggle={() => flip('worktrees.autoClean')} />
      </Row>
      <Row id="auto-clean-remote" label={words.remoteLabel} description={words.remoteDescription}>
        <ToggleValue label={words.remoteLabel} value={on && settings['worktrees.autoCleanRemote']} disabled={busy || !on} onToggle={() => flip('worktrees.autoCleanRemote')} />
      </Row>
    </>
  );
}
