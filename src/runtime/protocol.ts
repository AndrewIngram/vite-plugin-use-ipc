import { isSerializedThrown, type SerializedThrown } from './errors.js';

export type Operation = 'next' | 'return' | 'throw';

export type RequestBody =
  | { method: 'call'; functionId: string; args: unknown[] }
  | {
      method: 'open';
      functionId: string;
      args: unknown[];
      signalIndex?: number;
    }
  | { method: Operation; streamId: number; value: unknown };

export type Message =
  | ({ type: 'request'; id: number } & RequestBody)
  | { type: 'response'; id: number; ok: true; value: unknown }
  | { type: 'response'; id: number; ok: false; error: SerializedThrown }
  | { type: 'cancel'; id: number };

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isMessage(value: unknown): value is Message {
  if (!record(value) || !integer(value.id)) return false;

  if (value.type === 'cancel') return true;

  if (value.type === 'response') {
    if (value.ok === true) return Object.hasOwn(value, 'value');

    return value.ok === false && isSerializedThrown(value.error);
  }

  if (value.type !== 'request') return false;

  if (value.method === 'call' || value.method === 'open') {
    return (
      typeof value.functionId === 'string' &&
      Array.isArray(value.args) &&
      (!Object.hasOwn(value, 'signalIndex') ||
        (value.method === 'open' &&
          integer(value.signalIndex) &&
          value.signalIndex >= 0 &&
          value.signalIndex < value.args.length))
    );
  }

  return (
    (value.method === 'next' ||
      value.method === 'return' ||
      value.method === 'throw') &&
    integer(value.streamId) &&
    Object.hasOwn(value, 'value')
  );
}

export interface StreamIterator {
  next(value?: unknown): unknown;
  return?(value?: unknown): unknown;
  throw?(value?: unknown): unknown;
}

export function isIterator(value: unknown): value is StreamIterator {
  return (
    record(value) &&
    typeof value.next === 'function' &&
    (value.return === undefined || typeof value.return === 'function') &&
    (value.throw === undefined || typeof value.throw === 'function')
  );
}

export function isResult(value: unknown): value is IteratorResult<unknown> {
  return (
    record(value) &&
    typeof value.done === 'boolean' &&
    Object.hasOwn(value, 'value')
  );
}
