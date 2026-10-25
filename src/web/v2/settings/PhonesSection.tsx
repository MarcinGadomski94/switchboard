import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Device, DevicePairingCode } from '../../../core/devices.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { QrCode } from '../../components/QrCode.tsx';
import { appInstallPrompt } from '../../pwa/app-install.ts';
import { isStandalone, subscribeStandalone } from '../../pwa/display-mode.ts';
import { accessDescription, accessProblem, deviceDetail } from '../../views/settings/devices.ts';
import { DevicesSection } from '../../views/settings/DevicesSection.tsx';
import { INSTALL_APP_DESCRIPTION, SAFARI_INSTALL_HINT, installRowForm } from '../../views/settings/install-app.ts';
import { codeTimeLeft, refusalText } from '../../views/settings/machines.ts';
import { Button, Card, Dialog, EmptyState, Icon, Skeleton, StatusBadge, Switch, useToast } from '../components/index.ts';
import { SETTINGS_WORDS as W } from '../glossary.ts';
import { ClassicFrame } from './ClassicFrame.tsx';

function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) return refusalText(caught.body, fallback);
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/**
 * D131 · lane R · Settings › Phones (the prototype's `#set-phones`): on the
 * computer, the paired phones (revoke after a confirm), Pair a phone by QR code
 * (D73's one-time code), phone access, and Install as an app; on a paired phone
 * itself, its own name and notifications per kind with the quiet hours (D73's
 * classic panel, which owns the browser's push subscription).
 */
export function PhonesSection() {
  const self = useApi(api.deviceSelf);
  if (!self.data) {
    return self.error ? (
      <EmptyState icon="alert" tone="grey" title={W.loadError} />
    ) : (
      <Card pad>
        <Skeleton width="30%" height={14} />
        <Skeleton lines={2} style={{ marginTop: 12 }} />
      </Card>
    );
  }
  if (self.data.device) {
    // A paired phone: its notifications live on the phone (the browser's push subscription).
    return (
      <div className="v2-set-stack" data-testid="v2-set-phones" data-device="">
        <Card pad className="v2-set-card">
          <ClassicFrame testId="v2-phone-self">
            <DevicesSection />
          </ClassicFrame>
        </Card>
        <InstallRow />
      </div>
    );
  }
  return <LocalPhones />;
}

function LocalPhones() {
  const view = useApi(api.devices);
  const toast = useToast();
  const [pairing, setPairing] = useState(false);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const data = view.data;
  if (!data) {
    return view.error ? <EmptyState icon="alert" tone="grey" title={W.loadError} /> : <Skeleton lines={3} />;
  }
  const access = data.access;
  return (
    <div className="v2-set-stack" data-testid="v2-set-phones">
      <p className="v2-muted v2-set-p">{W.phonesSub}</p>
      {data.devices.length === 0 ? <p className="v2-muted v2-set-small">{W.noPhones}</p> : null}
      {data.devices.map((device) => (
        <Card pad className="v2-set-card" key={device.id} data-testid="v2-phone" data-device-id={device.id}>
          <div className="v2-set-card-h">
            <div className="v2-comp-icon">
              <Icon name="phone" size="l" />
            </div>
            <div className="v2-grow">
              <h3>{device.name}</h3>
              <div className="v2-muted v2-set-small">{deviceDetail(device)}</div>
            </div>
            <StatusBadge status="done" label="Paired" />
          </div>
          <div className="v2-set-row">
            <span className="v2-grow">
              Push notifications when something needs you: <b>{device.push ? 'on' : 'off'}</b>
              <div className="v2-muted v2-set-small">{W.notificationsOnPhone}</div>
            </span>
            <Button variant="danger" size="sm" onClick={() => setRevoking(device)} data-testid="v2-phone-revoke">
              {W.revoke}
            </Button>
          </div>
        </Card>
      ))}
      <Card pad className="v2-set-card" data-testid="v2-phone-access">
        <div className="v2-set-card-h">
          <h3 className="v2-grow">Phone access</h3>
          <Switch
            checked={access.enabled}
            label="Phone access"
            testId="v2-phone-access-switch"
            onChange={(on) => void api.setDeviceAccess({ enabled: on }).then(view.reload, (caught: unknown) => toast({ text: errorText(caught, 'It could not be changed.'), tone: 'error' }))}
          />
        </div>
        <p className={accessProblem(access) ? 'v2-set-error' : 'v2-muted v2-set-small'}>
          {accessDescription(access)}
          {access.actionUrl ? (
            <>
              {' '}
              <a href={access.actionUrl} target="_blank" rel="noreferrer noopener">
                Open Tailscale
              </a>
            </>
          ) : null}
        </p>
        <Button variant="primary" icon="qr" onClick={() => setPairing(true)} data-testid="v2-pair-phone">
          {W.pairPhone}
        </Button>
      </Card>
      <InstallRow />
      <PairPhoneDialog open={pairing} ready={access.enabled && access.https === 'ok'} onClose={() => setPairing(false)} onPaired={view.reload} known={data.devices.map((d) => d.id)} reload={view.reload} />
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={revoking ? `${W.revoke} ${revoking.name}?` : W.revoke}
        icon="phone"
        testId="v2-revoke-dialog"
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="v2-revoke-confirm"
              onClick={() => {
                const device = revoking;
                setRevoking(null);
                if (!device) return;
                void api.revokeDevice(device.id).then(
                  () => {
                    toast({ text: `${device.name} revoked. ${W.revokeConfirm}` });
                    view.reload();
                  },
                  (caught: unknown) => toast({ text: errorText(caught, 'It could not be revoked.'), tone: 'error' }),
                );
              }}
            >
              {W.revoke}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{W.revokeConfirm}</p>
      </Dialog>
    </div>
  );
}

/** Pair a phone: the QR code (D73's one-time code, 10 minutes), the steps; closes once the phone shows up. */
function PairPhoneDialog({ open, ready, onClose, onPaired, known, reload }: { readonly open: boolean; readonly ready: boolean; readonly onClose: () => void; readonly onPaired: () => void; readonly known: readonly string[]; readonly reload: () => void }) {
  const [code, setCode] = useState<DevicePairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const toast = useToast();
  const seen = useRef<ReadonlySet<string>>(new Set(known));
  useEffect(() => {
    if (!open) {
      if (code) void api.cancelDevicePairing().catch(() => undefined);
      setCode(null);
      setError(null);
      return undefined;
    }
    seen.current = new Set(known);
    if (!ready) return undefined;
    api.devicePairingCode().then(setCode, (caught: unknown) => setError(errorText(caught, 'No code could be made.')));
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    const poll = window.setInterval(reload, 2000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);
  useEffect(() => {
    if (!open || !code) return;
    const fresh = known.find((id) => !seen.current.has(id));
    if (fresh) {
      toast({ text: 'The phone is paired.' });
      setCode(null);
      onPaired();
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known.join(',')]);
  const left = code ? codeTimeLeft(code.expiresAt, now) : null;
  return (
    <Dialog open={open} onClose={onClose} title={W.pairPhone} icon="qr" testId="v2-pair-phone-dialog" width={620} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="v2-pair-phone">
        <div className="v2-grow">
          <ol className="v2-set-steps">
            {W.pairSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="v2-muted v2-set-small">{W.pairNote}</p>
          {code && left ? (
            <p className="v2-set-small">
              Or open <span className="v2-mono">{code.url.split('#')[0]}</span> on the phone and type <b data-testid="v2-phone-code">{code.code}</b> · {left} left
            </p>
          ) : null}
          {!ready ? <p className="v2-set-error">Phone access must be on and working first (the switch above).</p> : null}
          {error ? (
            <p className="v2-set-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="v2-pair-qr" data-testid="v2-pair-qr">
          {code && left ? <QrCode text={code.url} size={176} label="Pairing QR code" /> : ready && !error ? <Skeleton width={176} height={176} /> : <Icon name="qr" size="l" />}
        </div>
      </div>
    </Dialog>
  );
}

/** D34: Install as an app (the browser's own install dialog, or Safari's hint); nothing once installed. */
function InstallRow() {
  const offer = useSyncExternalStore(appInstallPrompt.subscribe, appInstallPrompt.current);
  const standalone = useSyncExternalStore(subscribeStandalone, isStandalone);
  const form = installRowForm({ offered: offer !== null, standalone, userAgent: navigator.userAgent });
  if (form === 'none') return null;
  return (
    <Card pad className="v2-set-card" data-testid="v2-install-app">
      <div className="v2-set-card-h">
        <Icon name="download" />
        <div className="v2-grow">
          <h3>{W.installApp}</h3>
          <div className="v2-muted v2-set-small">{form === 'safari-hint' ? SAFARI_INSTALL_HINT : INSTALL_APP_DESCRIPTION}</div>
        </div>
        {form === 'install' ? <Button onClick={() => void appInstallPrompt.install()}>Install</Button> : null}
      </div>
    </Card>
  );
}
