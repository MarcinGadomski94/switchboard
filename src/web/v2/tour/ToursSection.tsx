import type { TourRecord } from '../../../core/tutorial.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { Button } from '../components/index.ts';
import { TOUR_WORDS } from '../glossary.ts';
import { replayV2Tours } from './TourHost.tsx';
import { v2Features } from './tour-model.ts';

/** How a tour's stored state reads in its row. */
function statusText(record: TourRecord | undefined): string {
  switch (record?.status ?? null) {
    case 'completed':
      return TOUR_WORDS.seen;
    case 'skipped':
      return TOUR_WORDS.skipped;
    case 'pending':
      return TOUR_WORDS.notSeen;
    default:
      return TOUR_WORDS.notShown;
  }
}

/**
 * D131 · lane X · Settings › Advanced › What's new tours in v2: the v2 tours
 * (each with whether it was seen on this machine) and Replay, which runs it in
 * v2 with its highlights and records nothing. The classic tours point at classic
 * pages, so they are not listed here; a note says where they are.
 */
export function V2ToursSection() {
  const state = useApi(api.tutorial);
  const features = v2Features();
  const records = new Map((state.data?.whatsNew ?? []).map((entry) => [entry.id, entry] as const));
  return (
    <div className="v2-tours" data-testid="v2-tours">
      <p className="v2-tours-sub">{TOUR_WORDS.pageSub}</p>
      {features.length > 1 ? (
        <div className="v2-tours-row">
          <span className="v2-tours-grow" />
          <Button size="sm" onClick={() => replayV2Tours(features.map((feature) => feature.id))} data-testid="v2-tours-replay-all">
            {TOUR_WORDS.replayAll}
          </Button>
        </div>
      ) : null}
      {features.map((feature) => (
        <div key={feature.id} className="v2-tours-row" data-row={`v2-tour-${feature.id}`}>
          <div className="v2-tours-grow">
            <b>{feature.title}</b>
            <div className="v2-tours-meta" data-testid={`v2-tours-status-${feature.id}`}>
              {feature.version} · {feature.steps.length} steps · {statusText(records.get(feature.id))}
            </div>
          </div>
          <Button size="sm" icon="sparkle" onClick={() => replayV2Tours([feature.id])} data-testid={`v2-tours-replay-${feature.id}`}>
            {TOUR_WORDS.replay}
          </Button>
        </div>
      ))}
      <p className="v2-tours-note" data-testid="v2-tours-classic-note">
        {TOUR_WORDS.classicNote}
      </p>
      {!state.data && state.error ? (
        <p className="v2-tours-note" role="alert">
          {TOUR_WORDS.loadError}
        </p>
      ) : null}
    </div>
  );
}
