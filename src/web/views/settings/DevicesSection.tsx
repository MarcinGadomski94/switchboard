import { useEffect, useRef, useState } from 'react';
import { type Device, type DevicePairingCode, type DeviceSelfView, PUSH_EVENT_KINDS, PUSH_EVENT_LABELS } from '../../../core/devices.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { QrCode } from '../../components/QrCode.tsx';
import { currentPushEnvironment, subscribePush, unsubscribePush } from '../../pwa/push.ts';
import { pushSupport, pushSupportText } from '../../pwa/push-support.ts';
import { accessDescription, accessProblem, deviceDetail } from './devices.ts';
import { codeTimeLeft, refusalText } from './machines.ts';
import { Row, SectionTitle } from './rows.tsx';
import './devices.css';

/** While a pairing code is shown, the list is read this often (to see the device arrive). */
const PAIRING_POLL_MS = 2_000;

function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) return refusalText(caught.body, fallback);
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/**
 * Settings → Devices (D73, `docs/devices.md`). On this machine: the device access
 * switch (off by default; what is missing when HTTPS is not available), "Pair a
 * device" (QR code + one-time code), and the paired devices (rename, revoke). On a
 * paired device: its name and its notifications (enable, per-event toggles, test).
 */
export function DevicesSection() {
  const self = useApi(api.deviceSelf);
  if (!self.data) {
    return (
      <>
        <SectionTitle>Devices</SectionTitle>
        {self.error ? (
          <div className="sb-set-note sb-set-error" data-testid="settings-note">
            Devices could not be loaded.
          </div>
        ) : null}
      </>
    );
  }
  return self.data.device ? <ThisDevice view={self.data} reload={self.reload} /> : <LocalDevices />;
}

/** This machine's UI: access, pairing, the list. */
function LocalDevices() {
  const view = useApi(api.devices);
  const [code, setCode] = useState<DevicePairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  // While a code waits, look for the device it pairs.
  useEffect(() => {
    if (!code) return undefined;
    const timer = window.setInterval(() => view.reload(), PAIRING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [code]);
  useEffect(() => {
    const devices = view.data?.devices;
    if (!devices) return;
    const ids = new Set(devices.map((device) => device.id));
    if (known.current && code) {
      const fresh = devices.find((device) => !known.current?.has(device.id));
      if (fresh) {
        setCode(null);
        setPaired(fresh.name);
      }
    }
    known.current = ids;
  }, [view.data]);

  const run = async (key: string, action: () => Promise<unknown>, fallback: string): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(null);
      view.reload();
    }
  };

  const data = view.data;
  const left = code ? codeTimeLeft(code.expiresAt, now) : null;
  const access = data?.access;
  return (
    <>
      <SectionTitle withLede>Devices</SectionTitle>
      <div className="sb-set-lede">
        Use Switchboard from your phone or tablet over Tailscale. Each device is paired here once and can be revoked any time. Pairing devices, machines, hooks, MCP servers, updates and the other machine settings stay on this computer.
      </div>
      {data && access ? (
        <>
          <Row
            id="device-access"
            label="Device access"
            description={
              <span data-testid="devices-access-desc" data-state={access.enabled ? access.https : 'off'} className={accessProblem(access) ? 'sb-dev-problem' : undefined}>
                {accessDescription(access)}
                {access.actionUrl ? (
                  <>
                    {' '}
                    <a href={access.actionUrl} target="_blank" rel="noreferrer noopener" data-testid="devices-access-link">
                      Open Tailscale
                    </a>
                  </>
                ) : null}
              </span>
            }
          >
            <button
              type="button"
              className="sb-set-value-button"
              data-testid="devices-access"
              role="switch"
              aria-checked={access.enabled}
              aria-label="Device access"
              disabled={busy !== null}
              onClick={() => void run('access', () => api.setDeviceAccess({ enabled: !access.enabled }), 'Device access could not be changed.')}
            >
              {access.enabled ? 'on' : 'off'}
            </button>
          </Row>
          <Row
            id="pair-device"
            label="Pair a device"
            description={
              code && left ? (
                <span>
                  Scan the QR code with the phone or tablet (or open <span data-testid="devices-pair-url" className="sb-dev-url">{code.url.split('#')[0]}</span> and type the code) within{' '}
                  <span data-testid="devices-code-left">{left}</span>. It works once.
                </span>
              ) : paired ? (
                <span data-testid="devices-paired-note">Paired: {paired}.</span>
              ) : (
                'Shows a QR code and a one-time code (10 minutes, single use). Device access must be on.'
              )
            }
          >
            {code && left ? (
              <button type="button" className="sb-set-action" data-testid="devices-pair-cancel" onClick={() => void run('cancel', async () => { await api.cancelDevicePairing(); setCode(null); }, 'The code could not be cancelled.')}>
                Cancel
              </button>
            ) : (
              <button
                type="button"
                className="sb-set-action"
                data-testid="devices-pair"
                disabled={busy !== null || !access.enabled || access.https !== 'ok'}
                onClick={() =>
                  void run(
                    'pair',
                    async () => {
                      setPaired(null);
                      setCode(await api.devicePairingCode());
                    },
                    'No code could be made.',
                  )
                }
              >
                Pair a device
              </button>
            )}
          </Row>
          {code && left ? (
            <div className="sb-dev-pairing" data-testid="devices-pairing">
              <QrCode text={code.url} size={176} label="QR code to pair a device" />
              <span className="sb-mach-code" data-testid="devices-code">
                {code.code}
              </span>
            </div>
          ) : null}
          {error ? (
            <div className="sb-set-note sb-set-error" role="alert" data-testid="devices-error">
              {error}
            </div>
          ) : null}
          <div className="sb-dev-list" data-testid="devices-list">
            {data.devices.map((device) => (
              <DeviceRow key={device.id} device={device} busy={busy !== null} run={run} now={now} />
            ))}
            {data.devices.length === 0 ? (
              <div className="sb-set-note" data-testid="devices-empty">
                No paired devices.
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      {!data && view.error ? (
        <div className="sb-set-note sb-set-error" data-testid="settings-note">
          Devices could not be loaded.
        </div>
      ) : null}
    </>
  );
}

function DeviceRow({
  device,
  busy,
  run,
  now,
}: {
  readonly device: Device;
  readonly busy: boolean;
  readonly run: (key: string, action: () => Promise<unknown>, fallback: string) => Promise<void>;
  readonly now: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.name);
  return (
    <div className="sb-set-row sb-dev" data-testid="device" data-device-id={device.id}>
      <div className="sb-set-row-text">
        <div className="sb-set-row-label">
          {renaming ? (
            <input className="sb-set-input" data-kind="name" data-testid="device-rename-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} aria-label="Device name" />
          ) : (
            <span data-testid="device-name">{device.name}</span>
          )}
        </div>
        <div className="sb-set-row-desc" data-testid="device-detail">
          {deviceDetail(device, now)}
        </div>
      </div>
      <div className="sb-set-folder-actions">
        {renaming ? (
          <>
            <button type="button" className="sb-set-action" data-testid="device-rename-save" disabled={busy} onClick={() => void run('rename', () => api.renameDevice(device.id, name), 'The name could not be saved.').then(() => setRenaming(false))}>
              Save
            </button>
            <button type="button" className="sb-set-action" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="sb-set-action" data-testid="device-rename" disabled={busy} onClick={() => setRenaming(true)}>
            Rename
          </button>
        )}
        <button type="button" className="sb-set-action" data-testid="device-revoke" disabled={busy} onClick={() => void run('revoke', () => api.revokeDevice(device.id), 'The device could not be revoked.')}>
          Revoke
        </button>
      </div>
    </div>
  );
}

/** A paired device's own settings: its name and notifications. */
function ThisDevice({ view, reload }: { readonly view: DeviceSelfView; readonly reload: () => void }) {
  const device = view.device as Device;
  const [current, setCurrent] = useState<DeviceSelfView>(view);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState(device.name);
  const [support, setSupport] = useState(() => pushSupport(currentPushEnvironment()));
  useEffect(() => setCurrent(view), [view]);

  const run = async (key: string, action: () => Promise<DeviceSelfView | void>, fallback: string): Promise<void> => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      const next = await action();
      if (next) setCurrent(next);
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(null);
      setSupport(pushSupport(currentPushEnvironment()));
    }
  };

  const enabled = current.device?.push === true;
  const supportText = pushSupportText(support);
  return (
    <>
      <SectionTitle withLede>Devices</SectionTitle>
      <div className="sb-set-lede">This phone or tablet is paired with Switchboard. Pairing and revoking devices is done on the computer, under Settings → Devices.</div>
      <Row id="this-device" label="This device" description={<span data-testid="this-device-name">{current.device?.name ?? device.name}</span>}>
        <form
          className="sb-dev-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void run('rename', async () => {
              await api.renameThisDevice(name);
              return api.deviceSelf();
            }, 'The name could not be saved.');
          }}
        >
          <input className="sb-set-input" data-kind="name" data-testid="this-device-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} aria-label="Name of this device" />
          <button type="submit" className="sb-set-action" data-testid="this-device-save" disabled={busy !== null || name.trim() === ''}>
            Save
          </button>
        </form>
      </Row>
      <Row
        id="device-notifications"
        label="Notifications"
        description={
          <span data-testid="device-push-desc" data-support={support} data-enabled={enabled ? 'true' : 'false'}>
            {enabled ? 'On: permission requests, questions, finished turns and the other items you pick below reach this device.' : (supportText ?? 'Get a notification when a session needs you or finishes.')}
          </span>
        }
      >
        {enabled ? (
          <button type="button" className="sb-set-action" data-testid="device-push-disable" disabled={busy !== null} onClick={() => void run('disable', async () => {
            await unsubscribePush().catch(() => undefined);
            return api.deleteDevicePush();
          }, 'Notifications could not be switched off.')}>
            Disable
          </button>
        ) : (
          <button
            type="button"
            className="sb-set-action"
            data-testid="device-push-enable"
            disabled={busy !== null || support !== 'ready' || !current.vapidPublicKey}
            onClick={() =>
              void run(
                'enable',
                async () => {
                  const subscription = await subscribePush(current.vapidPublicKey as string);
                  return api.saveDevicePush({ subscription, events: current.events });
                },
                'Notifications could not be enabled.',
              )
            }
          >
            Enable notifications
          </button>
        )}
      </Row>
      {enabled ? (
        <div className="sb-dev-events" data-testid="device-push-events">
          {/* D87: a device with Switchboard open in front gets toasts, not system notifications. */}
          <div className="sb-set-row-desc sb-dev-quiet" data-testid="device-push-quiet">
            No notifications while Switchboard is open on this device.
          </div>
          {PUSH_EVENT_KINDS.map((kind) => (
            <div className="sb-set-row" data-row={`push-${kind}`} key={kind}>
              <div className="sb-set-row-text">
                <div className="sb-set-row-label">{PUSH_EVENT_LABELS[kind]}</div>
              </div>
              <button
                type="button"
                className="sb-set-value-button"
                role="switch"
                data-testid={`device-push-${kind}`}
                aria-checked={current.events[kind]}
                aria-label={PUSH_EVENT_LABELS[kind]}
                disabled={busy !== null}
                onClick={() => void run(kind, () => api.saveDevicePush({ events: { [kind]: !current.events[kind] } }), 'The setting could not be saved.')}
              >
                {current.events[kind] ? 'on' : 'off'}
              </button>
            </div>
          ))}
          <div className="sb-dev-test">
            <button
              type="button"
              className="sb-set-action"
              data-testid="device-push-test"
              disabled={busy !== null}
              onClick={() =>
                void run('test', async () => {
                  const answer = await api.testDevicePush();
                  setNote(answer.ok ? 'Test notification sent.' : `The test failed: ${answer.error ?? 'unknown error'}`);
                  if (!answer.ok) reload();
                }, 'The test could not be sent.')
              }
            >
              Send test
            </button>
          </div>
        </div>
      ) : null}
      {note ? (
        <div className="sb-set-note" role="status" data-testid="device-note">
          {note}
        </div>
      ) : null}
      {error ? (
        <div className="sb-set-note sb-set-error" role="alert" data-testid="devices-error">
          {error}
        </div>
      ) : null}
    </>
  );
}
