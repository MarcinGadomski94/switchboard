import type { LoginServiceErrorCode } from '../../core/login-service.ts';

/** A refusal or failure while installing / removing the per-user service (M9.1, `docs/service.md`). */
export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly code: LoginServiceErrorCode;

  constructor(code: LoginServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
