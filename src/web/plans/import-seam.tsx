import type { ReactNode } from 'react';
import type { Plan } from '../../core/plans.ts';

/**
 * D99 · the seam the Jira lane plugs its import into (`docs/plans.md` → *Import from Jira*).
 * The Plans list shows **Import from Jira…** while Plans is on; with no importer registered it
 * says "coming soon". The Jira lane registers one (`registerPlanImporter` from its own module,
 * imported once by `PlansPage.tsx`) whose `render` draws its dialog; `onImported` opens the
 * plan it made (a draft), `onClose` closes the dialog.
 */
export interface PlanImporter {
  /** `jira`. */
  readonly id: string;
  /** The dialog. */
  readonly render: (props: { readonly onImported: (plan: Plan) => void; readonly onClose: () => void }) => ReactNode;
}

const importers = new Map<string, PlanImporter>();

/** Registers (or replaces) an importer. */
export function registerPlanImporter(importer: PlanImporter): void {
  importers.set(importer.id, importer);
}

/** The importer registered under `id`, `null` when none is (yet). */
export function planImporter(id: string): PlanImporter | null {
  return importers.get(id) ?? null;
}

/** The note shown while no Jira importer is registered. */
export const IMPORT_COMING_SOON = 'Import from Jira is coming soon.';
