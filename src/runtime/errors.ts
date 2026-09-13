export type SerializedThrown =
  | { kind: 'value'; value: unknown }
  | {
      kind: 'error';
      name: string;
      message: string;
      stack?: string;
      cause?: SerializedThrown;
      aggregateErrors?: SerializedThrown[];
      properties?: Record<string, unknown>;
    };

const maxDepth = 64;

const reserved = new Set(['name', 'message', 'stack', 'cause', 'errors']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isSerializedThrown(
  value: unknown,
  depth = 0,
): value is SerializedThrown {
  if (depth > maxDepth || !isRecord(value)) return false;

  if (value.kind === 'value') return Object.hasOwn(value, 'value');

  return (
    value.kind === 'error' &&
    isString(value.name) &&
    isString(value.message) &&
    (value.stack === undefined || isString(value.stack)) &&
    (!Object.hasOwn(value, 'cause') ||
      isSerializedThrown(value.cause, depth + 1)) &&
    (value.aggregateErrors === undefined ||
      (Array.isArray(value.aggregateErrors) &&
        value.aggregateErrors.every((item) =>
          isSerializedThrown(item, depth + 1),
        ))) &&
    (value.properties === undefined || isRecord(value.properties))
  );
}

/** Adapted from use-worker's thrown-value codec; kept local to this package. */
export function serializeThrown(thrown: unknown): SerializedThrown {
  const ancestors = new WeakSet<object>();

  function encode(value: unknown, depth: number): SerializedThrown {
    if (!(value instanceof Error)) {
      try {
        return { kind: 'value', value: structuredClone(value) };
      } catch {
        return { kind: 'error', name: 'Error', message: String(value) };
      }
    }

    if (ancestors.has(value) || depth >= maxDepth) {
      return {
        kind: 'error',
        name: 'Error',
        message: 'Circular or excessively deep IPC error cause',
      };
    }

    ancestors.add(value);

    try {
      const result: Extract<SerializedThrown, { kind: 'error' }> = {
        kind: 'error',
        name: String(value.name),
        message: String(value.message),
      };

      if (isString(value.stack)) result.stack = value.stack;

      if ('cause' in value) result.cause = encode(value.cause, depth + 1);

      if (value instanceof AggregateError)
        result.aggregateErrors = Array.from(value.errors, (error) =>
          encode(error, depth + 1),
        );
      const properties: Record<string, unknown> = {};

      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value),
      )) {
        if (
          reserved.has(key) ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        )
          continue;

        try {
          Object.defineProperty(properties, key, {
            value: structuredClone(descriptor.value),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } catch {
          /* Non-cloneable custom properties are omitted. */
        }
      }

      result.properties = properties;

      return result;
    } finally {
      ancestors.delete(value);
    }
  }

  try {
    return encode(thrown, 0);
  } catch {
    return {
      kind: 'error',
      name: 'Error',
      message: 'IPC error could not be serialized',
    };
  }
}

export function reviveThrown(serialized: SerializedThrown): unknown {
  if (serialized.kind === 'value') return serialized.value;
  let error: Error;

  switch (serialized.name) {
    case 'AggregateError':
      error = new AggregateError(
        (serialized.aggregateErrors ?? []).map(reviveThrown),
        serialized.message,
      );
      break;
    case 'EvalError':
      error = new EvalError(serialized.message);
      break;
    case 'RangeError':
      error = new RangeError(serialized.message);
      break;
    case 'ReferenceError':
      error = new ReferenceError(serialized.message);
      break;
    case 'SyntaxError':
      error = new SyntaxError(serialized.message);
      break;
    case 'TypeError':
      error = new TypeError(serialized.message);
      break;
    case 'URIError':
      error = new URIError(serialized.message);
      break;
    default:
      error = new Error(serialized.message);
      error.name = serialized.name;
  }

  error.stack = serialized.stack;

  if (serialized.cause !== undefined)
    Object.defineProperty(error, 'cause', {
      value: reviveThrown(serialized.cause),
      configurable: true,
      writable: true,
    });

  for (const [key, value] of Object.entries(serialized.properties ?? {})) {
    if (reserved.has(key)) continue;
    Object.defineProperty(error, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return error;
}
