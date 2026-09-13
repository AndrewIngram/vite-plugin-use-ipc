import test from 'node:test';
import assert from 'node:assert/strict';
import { pair } from './helpers.mjs';
import { isMessage } from '../dist/runtime/protocol.js';

for (const direction of ['left', 'right']) {
  test(`${direction} preserves error types, causes, and custom properties`, async (t) => {
    const error = Object.assign(
      new TypeError('invalid', { cause: new RangeError('range') }),
      { code: 'E_INVALID', details: { field: 'title' }, ignored: () => {} },
    );

    Object.defineProperty(error, '__proto__', {
      value: { marker: true },
      enumerable: true,
    });

    const peers = pair(t, {
      run() {
        throw error;
      },
    });

    await assert.rejects(peers[direction].call('run', []), (received) => {
      assert.ok(received instanceof TypeError);
      assert.ok(received.cause instanceof RangeError);
      assert.equal(received.cause.message, 'range');
      assert.equal(received.code, 'E_INVALID');
      assert.deepEqual(received.details, { field: 'title' });
      assert.equal(Object.hasOwn(received, 'ignored'), false);
      assert.equal(Object.getPrototypeOf(received), TypeError.prototype);
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(received, '__proto__').value,
        { marker: true },
      );

      return true;
    });
  });
}

test('aggregate errors preserve nested errors and repeated causes', async (t) => {
  const cause = new SyntaxError('syntax');

  const error = new AggregateError([cause, cause, { code: 3 }], 'aggregate', {
    cause,
  });

  const { left } = pair(t, {
    run() {
      throw error;
    },
  });

  await assert.rejects(left.call('run', []), (received) => {
    assert.ok(received instanceof AggregateError);
    assert.ok(received.cause instanceof SyntaxError);
    assert.ok(received.errors[0] instanceof SyntaxError);
    assert.ok(received.errors[1] instanceof SyntaxError);
    assert.deepEqual(received.errors[2], { code: 3 });

    return true;
  });
});

for (const value of [
  undefined,
  null,
  42,
  'failure',
  { code: 'PLAIN', values: new Map([['x', 1]]) },
]) {
  test(`non-Error thrown value survives: ${String(value)}`, async (t) => {
    const { left } = pair(t, {
      run() {
        throw value;
      },
    });

    await assert.rejects(left.call('run', []), (received) => {
      assert.deepEqual(received, value);

      return true;
    });
  });
}

test(
  'circular causes and hostile errors do not leave calls pending',
  { timeout: 2000 },
  async (t) => {
    const circular = new Error('circular');
    circular.cause = circular;
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('getter');
      },
    });

    const { left } = pair(t, {
      circular() {
        throw circular;
      },
      hostile() {
        throw hostile;
      },
      uncloneable() {
        throw () => {};
      },
      healthy() {
        return 1;
      },
    });

    await assert.rejects(left.call('circular', []), (error) =>
      /Circular/.test(error.cause.message),
    );
    await assert.rejects(left.call('hostile', []), /could not be serialized/);
    await assert.rejects(
      left.call('uncloneable', []),
      (error) => error instanceof Error,
    );
    assert.equal(await left.call('healthy', []), 1);
  },
);

test('custom error classes preserve name and explicit undefined cause', async (t) => {
  class Conflict extends Error {
    constructor() {
      super('conflict', { cause: undefined });
      this.name = 'Conflict';
      this.code = 'CONFLICT';
    }
  }

  const { left } = pair(t, {
    run() {
      throw new Conflict();
    },
  });

  await assert.rejects(left.call('run', []), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof Conflict, false);
    assert.equal(error.name, 'Conflict');
    assert.equal(error.code, 'CONFLICT');
    assert.ok(Object.hasOwn(error, 'cause'));
    assert.equal(error.cause, undefined);

    return true;
  });
});

test('stream errors use the same codec and clean up', async (t) => {
  let cleaned = false;

  const { left } = pair(t, {
    async *run() {
      try {
        yield 1;
        throw Object.assign(new URIError('stream'), { code: 'STREAM' });
      } finally {
        cleaned = true;
      }
    },
  });

  const iterator = left.iterate('run', []);
  await iterator.next();
  await assert.rejects(
    iterator.next(),
    (error) => error instanceof URIError && error.code === 'STREAM',
  );
  assert.equal(cleaned, true);
  assert.equal((await iterator.next()).done, true);
});

test('malformed and cyclic nested error envelopes are rejected', () => {
  const valid = { kind: 'error', name: 'Error', message: 'failure' };
  const cyclic = { ...valid };
  cyclic.cause = cyclic;

  for (const error of [
    { ...valid, cause: {} },
    { ...valid, aggregateErrors: [null] },
    { ...valid, stack: 42 },
    { ...valid, properties: 1 },
    { kind: 'value' },
    cyclic,
  ]) {
    assert.equal(
      isMessage({ type: 'response', id: 1, ok: false, error }),
      false,
    );
  }

  assert.equal(
    isMessage({
      type: 'response',
      id: 1,
      ok: false,
      error: { kind: 'value', value: undefined },
    }),
    true,
  );
});
