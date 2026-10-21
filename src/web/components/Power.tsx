import { type PowerStatus, powerView } from '../../core/power.ts';
import './power.css';

/**
 * D125 (`docs/power.md`): a machine's power as one line of text, its details in
 * the tooltip and a full sentence for screen readers (the glyph is decorative).
 * Nothing renders without a reading (a phone, an older machine, the demo).
 */

/** Settings → Machines: `🔋 64% · 2h10 left · 9.5 W`, `~210 W (estimated)`. */
export function PowerLine({ power, testId = 'power-line' }: { readonly power: PowerStatus | null | undefined; readonly testId?: string }) {
  const view = powerView(power);
  if (!view) return null;
  return (
    <span className="sb-power-line" data-testid={testId} data-state={view.state} title={view.title}>
      <span aria-hidden="true">
        {view.icon ? <span className="sb-power-icon">{view.icon}</span> : null}
        {view.line}
      </span>
      <span className="sb-power-sr">{view.label}</span>
    </span>
  );
}

/** The machine tags: `🔋64%`, `⚡81%`, `~210 W`. */
export function PowerBadge({ power }: { readonly power: PowerStatus | null | undefined }) {
  const view = powerView(power);
  if (!view) return null;
  return (
    <span className="sb-power-badge" data-testid="machine-power" data-state={view.state} title={view.title}>
      <span aria-hidden="true">{view.badge}</span>
      <span className="sb-power-sr">{view.label}</span>
    </span>
  );
}
