import { useState } from 'react';
import { ARCHIVE_DAYS_CHOICES, archiveDaysLabel, archiveSweepText } from '../../../core/session-archive.ts';
import type { KnownSettings } from '../../../core/settings.ts';
import { Row } from './rows.tsx';
import type { SaveSettings } from './sections.tsx';

/** The words of {@link ArchiveRow} (classic by default; v2 passes its glossary's, `ARCHIVE_WORDS`). */
export interface ArchiveRowWords {
  readonly label: string;
  readonly description: string;
  /** The select's accessible name. */
  readonly select: string;
  /** What the sweep record counts ("session" / "agent"). */
  readonly noun: string;
}

/** Classic's words. */
export const CLASSIC_ARCHIVE_WORDS: ArchiveRowWords = {
  label: 'Delete archived sessions after',
  description: 'An archived session is deleted by itself after this long, with its worktrees when nothing in them would be lost. Pinned ones, Team members, plan sessions and those with an active loop are kept. Never keeps them until you delete them in Clean-up.',
  select: 'Delete archived sessions after',
  noun: 'session',
};

/**
 * D137 · Settings → Sessions & worktrees (v2: Settings › Advanced › Sessions): the archive's
 * period (`sessions.archiveDays`: 1 / 7 / 14 / 30 / 60 / 90 days or Never) and, under it, the
 * last sweep's record ("Last: deleted 3 archived sessions, 2 worktrees, today 14:02").
 */
export function ArchiveRow({ settings, save, words = CLASSIC_ARCHIVE_WORDS }: { readonly settings: KnownSettings; readonly save: SaveSettings; readonly words?: ArchiveRowWords }) {
  const [busy, setBusy] = useState(false);
  const days = settings['sessions.archiveDays'];
  const choices = ARCHIVE_DAYS_CHOICES.includes(days) ? ARCHIVE_DAYS_CHOICES : [...ARCHIVE_DAYS_CHOICES.slice(0, -1), days, 0].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const last = archiveSweepText(settings['sessions.archiveSweep'], words.noun);
  return (
    <Row
      id="archive"
      tour="setting-archive"
      label={words.label}
      description={
        <>
          {words.description}
          {last ? (
            <span className="sb-set-archive-last" data-testid="archive-last" style={{ display: 'block', marginTop: 4 }}>
              {last}
            </span>
          ) : null}
        </>
      }
    >
      <select
        className="sb-set-select"
        data-testid="archive-days"
        aria-label={words.select}
        value={days}
        disabled={busy}
        onChange={(event) => {
          setBusy(true);
          void save({ 'sessions.archiveDays': Number(event.target.value) }).finally(() => setBusy(false));
        }}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {archiveDaysLabel(choice)}
          </option>
        ))}
      </select>
    </Row>
  );
}
