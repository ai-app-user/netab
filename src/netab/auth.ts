import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JwtClaims } from './types.js';

/** Base64URL-encode a JWT segment without padding. */
function base64urlEncode(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/** Decode one Base64URL JWT segment back into bytes. */
function base64urlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  return Buffer.from(padded, 'base64');
}

/** Sign a JWT body with HMAC-SHA256 and return the Base64URL signature. */
function sign(secret: string, input: string): string {
  return base64urlEncode(createHmac('sha256', secret).update(input).digest());
}

/**
 * Small HMAC-based JWT helper used by the reference netab service.
 *
 * It is intentionally minimal and only supports issuing and verifying the
 * reference token shape defined by {@link JwtClaims}.
 */
export class JwtHmac {
  /** Create the helper with a lookup function that resolves DB-specific secrets. */
  constructor(private readonly getSecretForDb: (db: string) => string | null) {}

  /** Issue a signed JWT for the supplied claims. */
  issue(claims: JwtClaims): string {
    const secret = this.getSecretForDb(claims.db);
    if (!secret) {
      throw new Error(`No secret configured for db ${claims.db}`);
    }

    const header = { alg: 'HS256', typ: 'JWT' };
    const headerEncoded = base64urlEncode(JSON.stringify(header));
    const payloadEncoded = base64urlEncode(JSON.stringify(claims));
    const body = `${headerEncoded}.${payloadEncoded}`;
    const signature = sign(secret, body);
    return `${body}.${signature}`;
  }

  /** Decode and verify a signed JWT, throwing on format, signature, or expiry errors. */
  decode(token: string): JwtClaims {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const payload = JSON.parse(
      base64urlDecode(parts[1]).toString('utf8'),
    ) as JwtClaims;
    const secret = this.getSecretForDb(payload.db);
    if (!secret) {
      throw new Error(`No secret configured for db ${payload.db}`);
    }

    const body = `${parts[0]}.${parts[1]}`;
    const expected = sign(secret, body);
    const left = Buffer.from(expected);
    const right = Buffer.from(parts[2]);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new Error('Invalid JWT signature');
    }

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }

    return payload;
  }
}
