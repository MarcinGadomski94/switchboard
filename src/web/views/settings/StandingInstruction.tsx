import { useState } from 'react';
import type { KnownSettings } from '../../../core/settings.ts';
import { DEFAULT_STANDING_INSTRUCTION } from '../../../core/settings.ts';
import { Row, ToggleValue } from './rows.tsx';
import type { SaveSettings } from './sections.tsx';
import { STANDING_INSTRUCTION_DESCRIPTION, STANDING_INSTRUCTION_LABEL, standingDraftState } from './standing-instruction.ts';
import './standing-instruction.css';

/**
 * "Standing instruction for agents" (D64, `docs/settings.md`): a toggle (on by
 * default), a multi-line field, Save and "Reset to default". It lives in Sessions &
 * worktrees because it applies to every session whichever CLI runs it.
 */
export function StandingInstructionRow({ settings, save }: { readonly settings: KnownSettings; readonly save: SaveSettings }) {
  const stored = settings['agents.standingInstruction'];
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = draft ?? stored;
  const state = standingDraftState(stored, text);
  const run = (patch: Partial<KnownSettings>, after?: () => void): void => {
    setBusy(true);
    void save(patch)
      .then(after)
      .finally(() => setBusy(false));
  };
  return (
    <Row id="standing-instruction" label={STANDING_INSTRUCTION_LABEL} description={STANDING_INSTRUCTION_DESCRIPTION}>
      <ToggleValue
        label={STANDING_INSTRUCTION_LABEL}
        value={settings['agents.standingInstruction.enabled']}
        disabled={busy}
        onToggle={() => run({ 'agents.standingInstruction.enabled': !settings['agents.standingInstruction.enabled'] })}
      />
      <div className="sb-standing-field">
        <textarea
          className="sb-standing-text"
          data-testid="standing-instruction-text"
          aria-label={`${STANDING_INSTRUCTION_LABEL} (text)`}
          rows={5}
          value={text}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="sb-standing-buttons">
          <button type="button" className="sb-set-action" data-testid="standing-instruction-save" disabled={busy || !state.canSave} onClick={() => run({ 'agents.standingInstruction': text }, () => setDraft(null))}>
            Save
          </button>
          <button
            type="button"
            className="sb-set-action"
            data-testid="standing-instruction-reset"
            disabled={busy || !state.canReset}
            onClick={() => run({ 'agents.standingInstruction': DEFAULT_STANDING_INSTRUCTION }, () => setDraft(null))}
          >
            Reset to default
          </button>
        </div>
      </div>
    </Row>
  );
}
