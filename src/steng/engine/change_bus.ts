import type { ChangeEvent, Filter, Unsub } from '../types.js';
import { getField } from '../../shared/utils.js';

type Subscriber = {
  filter: Filter;
  cb: (evt: ChangeEvent) => void;
};

/**
 * Handles matches filter.
 * @param filter Optional filter expression.
 * @param value Value to process.
 */
function matchesFilter(filter: Filter, value: unknown): boolean {
  if (!filter || filter.length === 0) {
    return true;
  }

  return filter.every(([field, op, expected]) => {
    const actual = getField(value, field);
    switch (op) {
      case '==':
        return actual === expected;
      case '!=':
        return actual !== expected;
      case '>':
        return (
          typeof actual === 'number' &&
          typeof expected === 'number' &&
          actual > expected
        );
      case '>=':
        return (
          typeof actual === 'number' &&
          typeof expected === 'number' &&
          actual >= expected
        );
      case '<':
        return (
          typeof actual === 'number' &&
          typeof expected === 'number' &&
          actual < expected
        );
      case '<=':
        return (
          typeof actual === 'number' &&
          typeof expected === 'number' &&
          actual <= expected
        );
      case 'between':
        return (
          Array.isArray(expected) &&
          expected.length === 2 &&
          typeof actual === 'number' &&
          typeof expected[0] === 'number' &&
          typeof expected[1] === 'number' &&
          actual >= expected[0] &&
          actual < expected[1]
        );
      case 'in':
        return Array.isArray(expected) && expected.includes(actual);
      case 'contains':
        return Array.isArray(actual)
          ? actual.includes(expected)
          : typeof actual === 'string' && actual.includes(String(expected));
      case 'prefix':
        return (
          typeof actual === 'string' && actual.startsWith(String(expected))
        );
      default:
        return false;
    }
  });
}

/**
 * Subscription hub that fans change events out to matching listeners.
 */
export class ChangeBus {
  private readonly subscribers = new Map<number, Set<Subscriber>>();

  /**
   * Subscribes to the value.
   * @param tableId Table identifier.
   * @param filter Optional filter expression.
   * @param cb Cb.
   */
  subscribe(
    tableId: number,
    filter: Filter,
    cb: (evt: ChangeEvent) => void,
  ): Unsub {
    const bucket = this.subscribers.get(tableId) ?? new Set<Subscriber>();
    const subscriber = { filter, cb };
    bucket.add(subscriber);
    this.subscribers.set(tableId, bucket);
    return () => {
      bucket.delete(subscriber);
      if (bucket.size === 0) {
        this.subscribers.delete(tableId);
      }
    };
  }

  /**
   * Publishes the value.
   * @param tableId Table identifier.
   * @param evt Evt.
   */
  publish(tableId: number, evt: ChangeEvent): void {
    const bucket = this.subscribers.get(tableId);
    if (!bucket) {
      return;
    }

    for (const subscriber of bucket) {
      if (
        evt.op === 'deleted' ||
        matchesFilter(subscriber.filter, evt.value ?? { id: evt.id })
      ) {
        subscriber.cb(evt);
      }
    }
  }
}
