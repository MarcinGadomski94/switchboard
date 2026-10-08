import { useEffect, useState } from 'react';
import type { Session } from '../../../core/api.ts';
import { FRESH_CONTINUE, FRESH_NOT_NOW, freshOfferState, freshOfferText, freshStepText, keepSnooze } from '../../../core/fresh-session.ts';
import { readKnownSettings } from '../../../core/settings.ts';
import { ApiError, api } from '../../api/client.ts';
import { useRouter } from '../../router.tsx';
import { refusalText } from '../inbox.ts';
import { freshBusy, freshEligible, loadSnooze, markFreshAsked, saveSnooze, takeFreshAsked } from './fresh-offer.ts';
import './fresh-offer.css';

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Settings → Sessions: the offer on / off and its threshold (this machine's; read when the view mounts). */
function useOfferSettings(): { readonly enabled: boolean; readonly pct: number } | null {
  const [value, setValue] = useState<{ enabled: boolean; pct: number } | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((body) => {
        if (!alive) return;
        const known = readKnownSettings(body);
        setValue({ enabled: known['sessions.freshOffer'], pct: known['sessions.freshOfferPct'] });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return value;
}

/**
 * D83 · the bar above the composer (`docs/fresh-session.md`): once the context
 * reaches the threshold of Settings → Sessions, **Context 82% — Continue in a fresh
 * session** with **Continue** and **Not now** (snoozed until 10 points more). Not
 * while a turn runs (it shows once the turn ends), never for a hooked terminal
 * session. While a continuation runs it says which step; once the fresh session
 * exists this tab opens it.
 */
export function FreshOffer({
  sessionId,
  session,
  activity,
  blocked,
  reserveTodo = false,
}: {
  readonly sessionId: string;
  readonly session: Session | null;
  readonly activity: unknown;
  readonly blocked: string | null;
  /** The composer's "+ Todo" sits over the bar's right end (an empty todo list): the buttons keep clear of it. */
  readonly reserveTodo?: boolean;
}) {
  const settings = useOfferSettings();
  const { navigate } = useRouter();
  const [snoozedAt, setSnoozedAt] = useState<number | null>(() => loadSnooze(storage(), sessionId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const percent = session?.context?.percent ?? null;
  const threshold = settings?.pct ?? null;

  useEffect(() => {
    setSnoozedAt(loadSnooze(storage(), sessionId));
    setError(null);
  }, [sessionId]);
  // A context that dropped below the threshold (a compaction) forgets the snooze.
  useEffect(() => {
    if (threshold === null) return;
    const kept = keepSnooze(snoozedAt, percent, threshold);
    if (kept !== snoozedAt) {
      setSnoozedAt(kept);
      saveSnooze(storage(), sessionId, kept);
    }
  }, [percent, threshold, snoozedAt, sessionId]);
  const target = session?.continuedTo?.sessionId ?? null;
  // This tab asked for the continuation (here or from the ⋯ menu): it follows to the fresh session.
  useEffect(() => {
    if (target && takeFreshAsked(sessionId)) navigate({ view: 'session', id: target, tab: 'chat' });
  }, [target, navigate, sessionId]);

  const progress = session?.freshContinue ?? null;
  if (progress) {
    return (
      <div className="sb-fresh-offer" data-testid="fresh-offer" data-state="running" role="status">
        <span className="sb-fresh-text" data-testid="fresh-offer-text">
          {freshStepText(progress.step)}
        </span>
      </div>
    );
  }
  const shown =
    settings !== null &&
    blocked === null &&
    freshOfferState({
      enabled: settings.enabled,
      thresholdPct: settings.pct,
      percent,
      eligible: freshEligible(session),
      busy: freshBusy(session, activity),
      snoozedAt,
    });
  if (!shown || percent === null) return null;

  const continueNow = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      markFreshAsked(sessionId);
      await api.freshSession(sessionId);
    } catch (caught) {
      takeFreshAsked(sessionId);
      setError(caught instanceof ApiError ? refusalText(caught.status, caught.body) : refusalText(0, null));
    } finally {
      setBusy(false);
    }
  };
  const notNow = (): void => {
    setSnoozedAt(percent);
    saveSnooze(storage(), sessionId, percent);
  };
  return (
    <div className="sb-fresh-offer" data-testid="fresh-offer" data-state="offer" data-reserve-todo={reserveTodo || undefined} role="region" aria-label="Context is filling up">
      <span className="sb-fresh-text" data-testid="fresh-offer-text">
        {freshOfferText(percent)}
      </span>
      <span className="sb-fresh-buttons">
        <button type="button" className="sb-button sb-sv-primary" data-testid="fresh-continue" disabled={busy} aria-busy={busy || undefined} onClick={() => void continueNow()}>
          {FRESH_CONTINUE}
        </button>
        <button type="button" className="sb-button sb-sv-outlined" data-testid="fresh-not-now" disabled={busy} onClick={notNow}>
          {FRESH_NOT_NOW}
        </button>
      </span>
      {error ? (
        <span className="sb-fresh-error" role="alert" data-testid="fresh-offer-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
