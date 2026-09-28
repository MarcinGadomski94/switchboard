import { useState } from 'react';
import { FrameHelperSetupPanel, FrameHelperStatusLine, useFrameHelperSetup } from '../../tools/FrameHelperSetup.tsx';
import { Row } from './rows.tsx';

/** The row's label. */
export const FRAME_HELPER_LABEL = 'Frame helper';

/** The row's description. */
export const FRAME_HELPER_DESCRIPTION = 'A Chrome extension in this repo that lets signed-in sites such as Jira open in a tool frame. Set up once per browser.';

/**
 * D35 (`docs/frame-helper.md` → *Guided setup*): Settings → Embedded tools →
 * **Frame helper**, under the tool cards: a settings row with the helper's live
 * status and **Set up**, which opens the guided setup panel inline under the row
 * (Close hides it). Safari gets the status alone: there is nothing to set up.
 */
export function FrameHelperRow() {
  const [open, setOpen] = useState(false);
  const setup = useFrameHelperSetup(open);
  const safari = setup.status.kind === 'safari';
  return (
    <div className="sb-fh-settings" data-testid="settings-frame-helper">
      <Row id="frame-helper" label={FRAME_HELPER_LABEL} description={FRAME_HELPER_DESCRIPTION}>
        <div className="sb-fh-settings-control">
          <FrameHelperStatusLine status={setup.status} />
          {safari ? null : (
            <button
              type="button"
              className="sb-set-action"
              data-testid="frame-helper-setup-toggle"
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? 'Close' : 'Set up'}
            </button>
          )}
        </div>
      </Row>
      {open && !safari ? <FrameHelperSetupPanel setup={setup} showStatus={false} /> : null}
    </div>
  );
}
