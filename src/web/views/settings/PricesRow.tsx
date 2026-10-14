import { useState } from 'react';
import type { Settings } from '../../../core/api.ts';
import { EXAMPLE_PRICES, type ModelPrice, type PriceTable } from '../../../core/insights.ts';
import type { KnownSettings } from '../../../core/settings.ts';
import { ApiError, api } from '../../api/client.ts';
import { Row } from './rows.tsx';
import './prices.css';

/** The row's label and description. */
export const PRICES_LABEL = 'Prices (Insights)';
export const PRICES_DESCRIPTION =
  "What Insights' Cost per todo run multiplies tokens by: per model (the first row whose text the model's name contains), per 1M tokens of input, output, cache writes and cache reads. Prices change: check your provider's current list.";

const FIELDS: ReadonlyArray<readonly [keyof Omit<ModelPrice, 'match'>, string]> = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheWrite', 'Cache write'],
  ['cacheRead', 'Cache read'],
];

/** The errors of a refused save, by field (`insights.prices.models[1].output` → its message). */
function priceErrors(error: unknown): string[] {
  if (error instanceof ApiError && typeof error.body === 'object' && error.body !== null && Array.isArray((error.body as { errors?: unknown }).errors)) {
    return ((error.body as { errors: Array<{ field?: string; message?: string }> }).errors ?? []).map((e) => `${e.field ?? ''}: ${e.message ?? ''}`);
  }
  return ['The prices could not be saved.'];
}

/**
 * D108 · Settings → Notifications & usage → *Prices (Insights)* (`docs/settings.md`,
 * `insights.prices`): the currency and one row per model match with its four prices per 1M
 * tokens; + Add row, ×, Reset to example prices, Save. Until saved, the table is
 * Switchboard's example (marked so here and on the Insights page).
 */
export function PricesRow({ settings, onSaved }: { readonly settings: KnownSettings; readonly onSaved: (body: Settings) => void }) {
  const stored = settings['insights.prices'];
  const [draft, setDraft] = useState<PriceTable | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const table = draft ?? stored;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  const edit = (next: PriceTable): void => {
    setDraft(next);
    setErrors([]);
  };
  const setRow = (index: number, patch: Partial<ModelPrice>): void => edit({ ...table, models: table.models.map((row, i) => (i === index ? { ...row, ...patch } : row)) });

  const save = (next: PriceTable): void => {
    setBusy(true);
    api
      .saveSettings({ 'insights.prices': next })
      .then((body) => {
        onSaved(body);
        setDraft(null);
        setErrors([]);
      })
      .catch((error: unknown) => setErrors(priceErrors(error)))
      .finally(() => setBusy(false));
  };

  return (
    <Row id="insights-prices" tour="setting-prices" label={PRICES_LABEL} description={PRICES_DESCRIPTION}>
      <div className="sb-prices" data-testid="prices">
        {table.example ? (
          <p className="sb-prices-example" data-testid="prices-example">
            Example prices (USD, the Anthropic API's list prices of October 2026), not authoritative: edit and save them to use your own.
          </p>
        ) : null}
        <label className="sb-prices-currency">
          <span>Currency</span>
          <input data-testid="prices-currency" value={table.currency} maxLength={8} disabled={busy} onChange={(event) => edit({ ...table, currency: event.target.value.toUpperCase() })} />
        </label>
        <div className="sb-prices-scroll">
          <table className="sb-prices-table">
            <thead>
              <tr>
                <th scope="col">Model name contains</th>
                {FIELDS.map(([key, label]) => (
                  <th key={key} scope="col">
                    {label} / 1M
                  </th>
                ))}
                <th scope="col">
                  <span className="sb-prices-hidden">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {table.models.map((row, index) => (
                <tr key={index} data-testid="price-row">
                  <td>
                    <input data-testid="price-match" aria-label={`Row ${index + 1}: model name contains`} value={row.match} disabled={busy} onChange={(event) => setRow(index, { match: event.target.value })} />
                  </td>
                  {FIELDS.map(([key, label]) => (
                    <td key={key}>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        inputMode="decimal"
                        data-testid={`price-${key}`}
                        aria-label={`Row ${index + 1}: ${label} per 1M tokens`}
                        value={row[key]}
                        disabled={busy}
                        onChange={(event) => setRow(index, { [key]: Number(event.target.value) })}
                      />
                    </td>
                  ))}
                  <td>
                    <button type="button" className="sb-button sb-prices-remove" aria-label={`Remove row ${index + 1}`} disabled={busy} onClick={() => edit({ ...table, models: table.models.filter((_, i) => i !== index) })}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {errors.length > 0 ? (
          <ul className="sb-prices-errors" role="alert" data-testid="prices-errors">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        <div className="sb-prices-actions">
          <button type="button" className="sb-set-action" data-testid="prices-add" disabled={busy} onClick={() => edit({ ...table, models: [...table.models, { match: '', input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }] })}>
            + Add row
          </button>
          <button type="button" className="sb-set-action" data-testid="prices-reset" disabled={busy || (table.example && !dirty)} onClick={() => save(EXAMPLE_PRICES)}>
            Reset to example prices
          </button>
          <button type="button" className="sb-set-action" data-testid="prices-save" disabled={busy || !dirty} onClick={() => save({ ...table, example: false })}>
            Save
          </button>
        </div>
      </div>
    </Row>
  );
}
