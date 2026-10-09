import { useState } from 'react';
import { APPLY_INSTRUCTION_LABEL, type InstructionApplyResult, applySummary, staleInstructionCount, staleInstructionText } from '../../../core/standing-instruction.ts';
import { ApiError, api } from '../../api/client.ts';
import { useSessionList } from '../../folders/useFolders.ts';
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
    <Row id="standing-instruction" tour="standing-instruction" label={STANDING_INSTRUCTION_LABEL} description={STANDING_INSTRUCTION_DESCRIPTION}>
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
        <ApplyToOpenSessions />
      </div>
    </Row>
  );
}

/**
 * D91: **Apply to open sessions**: the count of this machine's open sessions whose
 * running process uses an older instruction (live from `sessionUpdated`), the button
 * (enabled when there is one), "Applying…" while it runs, then the result line and
 * each failure's reason.
 */
function ApplyToOpenSessions() {
  const sessions = useSessionList();
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<InstructionApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = staleInstructionCount(sessions.data ?? []);
  const stale = staleInstructionText(count);
  const apply = (): void => {
    setApplying(true);
    setError(null);
    setResult(null);
    void api
      .applyInstruction()
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => {
        setApplying(false);
        sessions.reload();
      });
  };
  return (
    <div className="sb-standing-apply" data-tour="standing-apply" data-testid="standing-apply">
      <div className="sb-standing-buttons">
        <button type="button" className="sb-set-action" data-testid="standing-apply-button" disabled={applying || count === 0} onClick={apply}>
          {applying ? 'Applying…' : APPLY_INSTRUCTION_LABEL}
        </button>
        <span className="sb-standing-note" data-testid="standing-apply-count">
          {stale ?? 'Every open session uses this instruction'}
        </span>
      </div>
      {result ? (
        <div className="sb-standing-result" data-testid="standing-apply-result" role="status">
          <div>{applySummary(result)}</div>
          {result.failed.map((failure) => (
            <div key={failure.sessionId} className="sb-standing-failure" data-testid="standing-apply-failure">
              {failure.title}: {failure.reason}
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="sb-standing-result sb-standing-failure" data-testid="standing-apply-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
