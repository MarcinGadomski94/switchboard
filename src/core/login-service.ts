/**
 * Wire types of the "Start at login" toggle (M9.1, `docs/service.md`). Additive
 * to the contract: `GET /api/service` and `PUT /api/service` sit next to the
 * contract's routes because the setting's effect is a per-user OS service
 * definition, not a stored preference. The same value is mirrored into the
 * settings key `service.startAtLogin` for `GET /api/settings` (M8.2).
 */

/** The OS service manager that starts Switchboard at login. */
export type ServiceManagerName = 'launchd' | 'systemd' | 'task-scheduler';

/** `GET /api/service`, and the answer of `PUT /api/service`. */
export interface LoginServiceStatus {
  /** `launchd` (macOS), `systemd` (Linux, `--user`), `task-scheduler` (Windows); `null` = this OS is not supported. */
  readonly manager: ServiceManagerName | null;
  /** A per-user service definition is registered, so the service starts at the next sign-in. */
  readonly startAtLogin: boolean;
  /** Absolute path of the service definition (plist / unit / task XML); `null` when unsupported. */
  readonly file: string | null;
}

/** `PUT /api/service` body. */
export interface LoginServiceRequest {
  readonly startAtLogin: boolean;
}

/** Why `PUT /api/service` refused (`409 { error, message }`). */
export type LoginServiceErrorCode = 'unsupported' | 'node-missing' | 'node-too-old' | 'command-failed' | 'file-failed';

/** A `PUT /api/service` refusal body. */
export interface LoginServiceError {
  readonly error: LoginServiceErrorCode;
  readonly message: string;
}
