import { createHash, timingSafeEqual } from 'node:crypto';

import { serviceError } from '../application/service-error.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function assertProvisionedToken(token: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(token) || Buffer.from(token, 'base64url').length < 32) {
    throw serviceError(503, 'service_unavailable', 'The operator service token is not provisioned safely.');
  }
}

export class ServiceTokenVerifier {
  readonly #expectedDigest: Buffer;

  public constructor(token: string) {
    assertProvisionedToken(token);
    this.#expectedDigest = digest(token);
  }

  public verify(authorization: string | undefined): void {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/u);
    const suppliedDigest = digest(match?.[1] ?? '');
    if (!timingSafeEqual(this.#expectedDigest, suppliedDigest) || match === null || match === undefined) {
      throw serviceError(401, 'authentication_failed', 'Bearer authentication failed.');
    }
  }
}
