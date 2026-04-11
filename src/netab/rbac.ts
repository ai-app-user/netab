import { pickFields, topLevelKeys } from '../shared/utils.js';
import type {
  AclRule,
  NetabContext,
  Permission,
  TablePermission,
} from './types.js';

/**
 * Merges string lists.
 * @param left Left.
 * @param right Right.
 */
function mergeStringLists(
  left?: string[],
  right?: string[],
): string[] | undefined {
  if (!left && !right) {
    return undefined;
  }
  if (!left || !right) {
    return left ?? right;
  }
  return Array.from(new Set([...left, ...right])).sort();
}

/**
 * Resolves permission.
 * @param rules ACL rules.
 * @param ctx Execution context.
 * @param tableName Table name.
 */
export function resolvePermission(
  rules: AclRule[],
  ctx: NetabContext,
  tableName: string,
): TablePermission | null {
  const matching = rules.filter((rule) => ctx.groups.includes(rule.group));
  if (matching.length === 0) {
    return null;
  }

  const resolved: TablePermission = { allow: [] };
  for (const rule of matching) {
    const tablePermission = rule.tables[tableName] ?? rule.tables['*'];
    if (!tablePermission) {
      continue;
    }

    resolved.allow = Array.from(
      new Set([...resolved.allow, ...tablePermission.allow]),
    );
    resolved.readFields = mergeStringLists(
      resolved.readFields,
      tablePermission.readFields,
    );
    resolved.writeFields = mergeStringLists(
      resolved.writeFields,
      tablePermission.writeFields,
    );
  }

  return resolved.allow.length > 0 ? resolved : null;
}

/**
 * Validates permission.
 * @param rules ACL rules.
 * @param ctx Execution context.
 * @param tableName Table name.
 * @param action Permission action.
 */
export function assertPermission(
  rules: AclRule[],
  ctx: NetabContext,
  tableName: string,
  action: Permission,
): TablePermission {
  const permission = resolvePermission(rules, ctx, tableName);
  if (
    !permission ||
    (!permission.allow.includes(action) && !permission.allow.includes('admin'))
  ) {
    throw new Error(`Forbidden: ${action} on ${tableName}`);
  }
  return permission;
}

/**
 * Handles filter readable value.
 * @param value Value to process.
 * @param permission Resolved permission.
 */
export function filterReadableValue(
  value: unknown,
  permission: TablePermission,
): unknown {
  return permission.readFields
    ? pickFields(value, permission.readFields)
    : value;
}

/**
 * Validates writable fields.
 * @param value Value to process.
 * @param permission Resolved permission.
 */
export function assertWritableFields(
  value: unknown,
  permission: TablePermission,
): void {
  if (!permission.writeFields || permission.allow.includes('admin')) {
    return;
  }
  const keys = topLevelKeys(value);
  const disallowed = keys.filter(
    (key) => !permission.writeFields?.includes(key),
  );
  if (disallowed.length > 0) {
    throw new Error(`Forbidden fields: ${disallowed.join(', ')}`);
  }
}
