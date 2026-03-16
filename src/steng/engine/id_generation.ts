import { createHash, randomBytes } from "node:crypto";

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += CROCKFORD32[(value << (5 - bits)) & 31];
  }

  return out;
}

function encodeTime(timeMs: number, length: number): string {
  let value = timeMs;
  const chars = new Array<string>(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    chars[index] = CROCKFORD32[value % 32];
    value = Math.floor(value / 32);
  }
  return chars.join("");
}

export function generateUlid(timeMs = Date.now()): string {
  const timePart = encodeTime(timeMs, 10);
  const randomPart = encodeCrockford(randomBytes(10)).slice(0, 16);
  return `${timePart}${randomPart}`;
}

export function deriveClusterShort(clusterId: string, length = 4): string {
  const digest = createHash("sha256").update(clusterId).digest();
  return encodeCrockford(digest).slice(0, length).toLowerCase();
}

export function sanitizeIdToken(value: string, fallback = "obj"): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

export function defaultIdPrefix(tableName: string): string {
  return sanitizeIdToken(tableName, "obj");
}

export function generateDistributedId(prefix: string, clusterShort: string, nowMs = Date.now()): string {
  return `${sanitizeIdToken(prefix)}_${sanitizeIdToken(clusterShort, "local")}_${generateUlid(nowMs)}`;
}
