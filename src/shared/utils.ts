import { createHash, randomBytes } from 'node:crypto';

/**
 * Create a detached deep clone of a structured-clone-compatible value.
 *
 * `undefined` is returned as-is so callers can preserve optional fields
 * without allocating placeholder objects.
 */
export function deepClone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}

/** True when `value` is a plain object-like record and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge two JSON-like objects recursively.
 *
 * Non-record inputs are replaced wholesale, which makes the function useful
 * for patch semantics where arrays and scalars should overwrite existing data.
 */
export function deepMerge<T>(target: T, patch: unknown): T {
  if (!isRecord(target) || !isRecord(patch)) {
    return deepClone(patch as T);
  }

  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] =
      isRecord(current) && isRecord(value)
        ? deepMerge(current, value)
        : deepClone(value);
  }

  return result as T;
}

/**
 * Merge top-level fields only.
 *
 * Nested objects are not traversed; a nested value in `patch` replaces the
 * existing nested value in `target`.
 */
export function shallowMerge<T>(target: T, patch: Partial<T>): T {
  if (!isRecord(target) || !isRecord(patch)) {
    return deepClone(patch as T);
  }
  return {
    ...(target as Record<string, unknown>),
    ...(patch as Record<string, unknown>),
  } as T;
}

/** Generate a compact random id with a readable prefix. */
export function randomId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

/**
 * Read one dotted field path from a JSON-like object.
 *
 * Example: `getField(order, "customer.email")`.
 */
export function getField(value: unknown, path: string): unknown {
  if (
    path === 'id' &&
    typeof value === 'object' &&
    value !== null &&
    'id' in value
  ) {
    return (value as { id: unknown }).id;
  }

  let current: unknown = value;
  for (const part of path.split('.')) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Return a deep-cloned projection containing only the requested dotted fields.
 */
export function pickFields(value: unknown, fields?: string[]): unknown {
  if (!fields || fields.length === 0 || !isRecord(value)) {
    return deepClone(value);
  }

  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split('.');
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

/** List the enumerable top-level keys of a record. */
export function topLevelKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value);
}

/** Stable JSON stringification that sorts only the first-level keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

/** Compute a lowercase SHA-256 hex digest. */
export function sha256Hex(value: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

/** Encode raw bytes as Base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Decode a Base64 string into raw bytes. */
export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
