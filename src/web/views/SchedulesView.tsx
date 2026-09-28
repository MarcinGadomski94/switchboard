import { ScheduleHeader, ScheduleTable } from './ScheduleTable.tsx';
import './schedule-table.css';

/**
 * Schedules & loops (SPEC → Schedules & loops): the header with "+ New scheduled
 * run" and the schedule table (M7.1, `ScheduleTable.tsx`, `docs/schedules.md`),
 * then the loop cards (M7.2).
 */
export function SchedulesView() {
  return (
    <section className="sb-view sb-schedules" data-view="schedules" data-testid="view-schedules">
      <ScheduleHeader />
      <ScheduleTable />
    </section>
  );
}
