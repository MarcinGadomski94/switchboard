/**
 * D131 · lane P · Crews (`/crews`, `/crews/:id`, `?member=<id>&tab=access` opens a teammate's
 * Access tab): the router mounts these two pages (`../shell/Outlet.tsx`); keep their names and
 * props. A crew is a team (D100), a teammate one of its members; see `README.md`.
 * `NewTeammateDialog` / `NewCrewDialog` are exported for the + New sheet (lane R).
 */
export { CrewsPage } from './CrewsPage.tsx';
export { CrewPage } from './CrewPage.tsx';
export { NewCrewDialog, NewTeammateDialog } from './dialogs.tsx';
