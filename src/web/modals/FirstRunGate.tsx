import { useEffect, useRef } from 'react';
import { api } from '../api/client.ts';
import { useModals } from './ModalHost.tsx';
import { SKIPPED_KEY } from './setup-wizard.ts';

function skippedInThisTab(): boolean {
  try {
    return sessionStorage.getItem(SKIPPED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Opens the setup wizard once when the app loads while the setup is not done
 * (`GET /api/setup` → `autoOpen`, M5.3, `docs/setup.md`), unless it was closed
 * unfinished earlier in this tab or another modal is already open. Renders nothing.
 */
export function FirstRunGate() {
  const { modal, open } = useModals();
  const modalRef = useRef(modal);
  modalRef.current = modal;

  useEffect(() => {
    if (skippedInThisTab()) return;
    let cancelled = false;
    api.setup().then(
      (state) => {
        if (!cancelled && state.autoOpen && modalRef.current === null) open('setup-wizard');
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  return null;
}
