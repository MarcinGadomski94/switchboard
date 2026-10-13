/**
 * D100-T2 · the access UI T3 mounts (`docs/team.md` → *Access requests*, contract →
 * *Team access (D100-T2)*):
 *
 * - {@link AccessTab} `{ memberId, focusAccessId?, loopLabels?, onChanged? }`: the
 *   member panel's **Access** tab (live through `teamChanged`).
 * - {@link AccessRequestActions} `{ item, onSetUp, onDecided? }`: the body and
 *   actions of a Needs-you item with `kind: 'access'` (Set up… / Deny / Not now);
 *   `onSetUp(memberId, accessId)` should open the member's Access tab with
 *   `focusAccessId = accessId`.
 * - {@link accessApi}: the calls, if T3 needs them directly.
 *
 * A stand-alone mount for development and the Playwright spec is
 * `/team-access-dev.html?member=<memberId>` (`src/web/team-access-dev.html`).
 */
export { AccessTab, type AccessTabProps } from './AccessTab.tsx';
export { AccessRequestActions, type AccessRequestActionsProps } from './AccessRequestActions.tsx';
export { AccessApiError, type AccessSetupBody, type ShareableServer, accessApi } from './api.ts';
