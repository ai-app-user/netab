import { getField } from "../../shared/utils.js";
import type { Filter, FilterClause, FilterOp, TableConfig, TableInfo } from "../types.js";

export function matchesFilter(value: unknown, filter: Filter): boolean {
  if (!filter || filter.length === 0) {
    return true;
  }

  return filter.every(([field, op, expected]) => {
    const actual = field === "id" ? (value as { id?: unknown })?.id : getField(value, field);
    return matchClause(actual, op, expected);
  });
}

export function assertFilterSupported(info: TableInfo, filter: Filter): void {
  if (!filter) {
    return;
  }

  for (const [field] of filter) {
    if (field === "id") {
      continue;
    }
    if (!info.config.indexes[field]) {
      throw new Error(`Field ${field} is not indexed in table ${info.tableName}`);
    }
  }
}

export function indexValuesForField(config: TableConfig, field: string, value: unknown): unknown[] {
  const index = config.indexes[field];
  if (!index) {
    return [];
  }

  const raw = getField(value, field);
  if (raw === undefined || raw === null) {
    return [];
  }

  if (index.multi && Array.isArray(raw)) {
    return raw.filter((item) => item !== undefined && item !== null);
  }

  return [raw];
}

export function matchClause(actual: unknown, op: FilterOp, expected: unknown): boolean {
  switch (op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case ">=":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "<":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "<=":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "between":
      return (
        Array.isArray(expected) &&
        expected.length === 2 &&
        typeof actual === "number" &&
        typeof expected[0] === "number" &&
        typeof expected[1] === "number" &&
        actual >= expected[0] &&
        actual < expected[1]
      );
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "contains":
      return Array.isArray(actual) ? actual.includes(expected) : typeof actual === "string" && actual.includes(String(expected));
    case "prefix":
      return typeof actual === "string" && actual.startsWith(String(expected));
    default:
      return false;
  }
}

export function filterUpperBound(filter: Filter | null, field: string): number | undefined {
  if (!filter) {
    return undefined;
  }
  let upperBound: number | undefined;
  for (const clause of filter) {
    const bound = clauseUpperBound(clause, field);
    if (bound === undefined) {
      continue;
    }
    upperBound = upperBound === undefined ? bound : Math.min(upperBound, bound);
  }
  return upperBound;
}

function clauseUpperBound([currentField, op, value]: FilterClause, field: string): number | undefined {
  if (currentField !== field) {
    return undefined;
  }

  if ((op === "<" || op === "<=") && typeof value === "number") {
    return value;
  }

  if (op === "between" && Array.isArray(value) && value.length === 2 && typeof value[1] === "number") {
    return value[1];
  }

  return undefined;
}
