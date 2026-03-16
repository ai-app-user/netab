import { createHash, randomBytes } from "node:crypto";

export function deepClone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(target: T, patch: unknown): T {
  if (!isRecord(target) || !isRecord(patch)) {
    return deepClone(patch as T);
  }

  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] =
      isRecord(current) && isRecord(value) ? deepMerge(current, value) : deepClone(value);
  }

  return result as T;
}

export function shallowMerge<T>(target: T, patch: Partial<T>): T {
  if (!isRecord(target) || !isRecord(patch)) {
    return deepClone(patch as T);
  }
  return { ...(target as Record<string, unknown>), ...(patch as Record<string, unknown>) } as T;
}

export function randomId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

export function getField(value: unknown, path: string): unknown {
  if (path === "id" && typeof value === "object" && value !== null && "id" in value) {
    return (value as { id: unknown }).id;
  }

  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function pickFields(value: unknown, fields?: string[]): unknown {
  if (!fields || fields.length === 0 || !isRecord(value)) {
    return deepClone(value);
  }

  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split(".");
    let src: unknown = value;
    let dst: Record<string, unknown> = out;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!isRecord(src) && !Array.isArray(src)) {
        break;
      }
      const next = (src as Record<string, unknown>)[part];
      if (next === undefined) {
        break;
      }
      if (index === parts.length - 1) {
        dst[part] = deepClone(next);
        break;
      }
      if (!isRecord(dst[part])) {
        dst[part] = {};
      }
      dst = dst[part] as Record<string, unknown>;
      src = next;
    }
  }

  return out;
}

export function topLevelKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

export function sha256Hex(value: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
