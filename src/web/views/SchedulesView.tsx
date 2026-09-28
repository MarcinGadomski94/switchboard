import { LoopCards } from './LoopCards.tsx';
import './schedules.css';

/**
 * Schedules & loops (SPEC → Schedules & loops): schedule table + loop cards. Placeholder from M1.4 (docs/lanes.md);
 * M7.1 fills the header and the schedule table above the loop cards (M7.2, `LoopCards.tsx`).
 */
export function SchedulesView() {
  return (
    <section className="sb-view sb-schedules" data-view="schedules" data-testid="view-schedules">
      <LoopCards />
    </section>
  );
}
