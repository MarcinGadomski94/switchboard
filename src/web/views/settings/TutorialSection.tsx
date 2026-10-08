import { MAIN_TOUR, MAIN_TOUR_ID } from '../../../core/tutorial.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { startTours, tourStatusText } from '../../tutorial/tour.ts';
import { Action, Row, SectionTitle } from './rows.tsx';

/** The Settings row of the main tour's replay. */
export const TUTORIAL_REPLAY_LABEL = 'Show the tutorial again';

/**
 * D85 · Settings → Tutorial (`docs/tutorial.md`): replay the main tour, and the
 * What's-new mini-tours with whether each was seen on this machine. A replay
 * changes nothing stored (it is not a first run); ⌘K → Tutorial does the same.
 */
export function TutorialSection() {
  const state = useApi(api.tutorial);
  return (
    <>
      <SectionTitle>Tutorial</SectionTitle>
      <Row
        id="tutorial-replay"
        tour="tutorial-replay"
        label={TUTORIAL_REPLAY_LABEL}
        description={`A ${MAIN_TOUR.length}-step tour of the sidebar, sessions, chat, todos, Inbox and Settings. Shown once on this machine (${tourStatusText(state.data?.main ?? null)}); also ⌘K → Tutorial.`}
      >
        <Action testId="tutorial-replay" onClick={() => startTours([MAIN_TOUR_ID], { replay: true })}>
          Show the tutorial
        </Action>
      </Row>
      <Row id="whats-new" label="What's new tours: replay" description="A short tour of each feature added since this machine first ran Switchboard; each shows once after the update that brings it.">
        <Action testId="whats-new-replay-all" onClick={() => startTours(state.data?.whatsNew.map((entry) => entry.id) ?? [], { replay: true })}>
          Replay all
        </Action>
      </Row>
      {state.data?.whatsNew.map((entry) => (
        <Row key={entry.id} id={`whats-new-${entry.id}`} label={entry.title} description={`${entry.version} · ${tourStatusText(entry)}`}>
          <Action testId={`whats-new-replay-${entry.id}`} onClick={() => startTours([entry.id], { replay: true })}>
            Replay
          </Action>
        </Row>
      ))}
      {!state.data && state.error ? (
        <div className="sb-set-note sb-set-error" data-testid="settings-note">
          The tutorial's state could not be loaded.
        </div>
      ) : null}
    </>
  );
}
