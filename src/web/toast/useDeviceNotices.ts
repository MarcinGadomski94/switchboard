import { useEffect, useRef } from 'react';
import type { DeviceNotice } from '../../core/devices.ts';
import { api, onDeviceOrigin } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useRouter } from '../router.tsx';
import { noticeFromMessage, noticeToast, shouldToast } from './device-notice.ts';
import type { Toast } from './ToastHost.tsx';

/**
 * D87 (`docs/devices.md` → *No notifications while Switchboard is open*): on a
 * paired device's page, every push-worthy happening (the `/hub` `notice` event,
 * or the service worker's message when it held a system notification back)
 * becomes a toast, once per happening, when the device's toggle for its kind is
 * on (`device-notice.ts` has the rules). This machine's own UI shows none.
 */
export function useDeviceNotices(show: (toast: Toast) => void): void {
  const { route } = useRouter();
  const seen = useRef(new Set<string>());
  const viewing = useRef<string | null>(null);
  viewing.current = route.view === 'session' ? route.id : null;
  const showRef = useRef(show);
  showRef.current = show;
  const handleRef = useRef<(notice: DeviceNotice) => void>(() => undefined);

  handleRef.current = (notice: DeviceNotice): void => {
    if (!onDeviceOrigin() || seen.current.has(notice.id)) return;
    void (async () => {
      let self;
      try {
        self = await api.deviceSelf();
      } catch {
        return;
      }
      const context = { device: self.device !== null, events: self.events, viewing: viewing.current, hidden: document.hidden, seen: seen.current };
      if (!shouldToast(notice, context)) return;
      seen.current.add(notice.id);
      showRef.current(noticeToast(notice));
    })();
  };

  useHubEvent('notice', (notice) => handleRef.current(notice));

  useEffect(() => {
    const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!container) return;
    const onMessage = (event: MessageEvent): void => {
      const notice = noticeFromMessage(event.data);
      if (notice) handleRef.current(notice);
    };
    container.addEventListener('message', onMessage);
    return () => container.removeEventListener('message', onMessage);
  }, []);
}
