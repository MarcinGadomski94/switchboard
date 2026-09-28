/**
 * Browser side of Settings → Notifications & usage (M8.2): the two-tone chime and
 * the OS notification that "Send test" fires, and the OS-notification permission
 * behind "Allow". Same behavior as the prototype's `beep()` / `notifyOS()` /
 * `askNotif` (SPEC → Modals → Toast: 784 Hz → 1046 Hz, about 0.25 s). M3.4 builds
 * the real triggers (questions, failed runs); the lane merge keeps one copy of
 * these helpers.
 */

type AudioContextCtor = new () => AudioContext;

/** Plays the chime; does nothing where Web Audio is missing or blocked. */
export function playChime(): void {
  try {
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as
      | AudioContextCtor
      | undefined;
    if (!Ctor) return;
    const audio = new Ctor();
    [0, 0.14].forEach((offset, index) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = index ? 1046 : 784;
      gain.gain.setValueAtTime(0.0001, audio.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + offset + 0.22);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(audio.currentTime + offset);
      oscillator.stop(audio.currentTime + offset + 0.25);
    });
  } catch {
    // No sound is better than a broken page.
  }
}

/** The OS-notification permission, or `unsupported` without the Notifications API. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Shows an OS notification when allowed; otherwise nothing. */
export function notifyOS(title: string, body: string): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body });
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}

/** Asks for the permission ("Allow"); on `granted` confirms with "Notifications are on." */
export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission === 'granted') notifyOS('Switchboard', 'Notifications are on.');
  return permission;
}
