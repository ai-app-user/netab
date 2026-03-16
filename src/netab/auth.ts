import { createHmac, timingSafeEqual } from "node:crypto";
import type { JwtClaims } from "./types.js";

function base64urlEncode(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function sign(secret: string, input: string): string {
  return base64urlEncode(createHmac("sha256", secret).update(input).digest());
}

export class JwtHmac {
  constructor(private readonly getSecretForDb: (db: string) => string | null) {}

  issue(claims: JwtClaims): string {
    const secret = this.getSecretForDb(claims.db);
    if (!secret) {
      throw new Error(`No secret configured for db ${claims.db}`);
    }

    const header = { alg: "HS256", typ: "JWT" };
    const headerEncoded = base64urlEncode(JSON.stringify(header));
    const payloadEncoded = base64urlEncode(JSON.stringify(claims));
    const body = `${headerEncoded}.${payloadEncoded}`;
    const signature = sign(secret, body);
    return `${body}.${signature}`;
  }

  decode(token: string): JwtClaims {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT format");
    }

    const payload = JSON.parse(base64urlDecode(parts[1]).toString("utf8")) as JwtClaims;
    const secret = this.getSecretForDb(payload.db);
    if (!secret) {
      throw new Error(`No secret configured for db ${payload.db}`);
    }

    const body = `${parts[0]}.${parts[1]}`;
    const expected = sign(secret, body);
    const left = Buffer.from(expected);
    const right = Buffer.from(parts[2]);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new Error("Invalid JWT signature");
    }

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error("Token expired");
    }

    return payload;
  }
}
