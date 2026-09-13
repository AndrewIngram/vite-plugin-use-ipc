import test from 'node:test';
import assert from 'node:assert/strict';
import { pair, deferred, tick, until } from './helpers.mjs';
import { Peer } from '../dist/runtime/peer.js';
import { createIpcBinding } from '../dist/runtime/binding.js';
import {
  reference,
  configure,
  register,
  lookup,
  invokeRenderer,
} from '../dist/runtime/references.js';
import { isMessage } from '../dist/runtime/protocol.js';

test('concurrent calls, both directions, clone values and errors', async (t) => {
  const gate = deferred();

  const { left, right } = pair(t, {
    echo: async (x) => x,
    slow: () => gate.promise,
    error: () => {
      throw new TypeError('remote failure');
    },
    other: () => {
      throw 42;
    },
    bad: () => () => {},
  });

  const slow = left.call('slow', []);
  assert.equal(await left.call('echo', [42]), 42);
  gate.resolve('last');
  assert.equal(await slow, 'last');
  assert.equal(await right.call('echo', [7]), 7);
  const buffer = new ArrayBuffer(4);
  new Uint8Array(buffer)[0] = 17;
  const result = await left.call('echo', [new Map([['buffer', buffer]])]);
  assert.ok(result instanceof Map);
  assert.equal(new Uint8Array(result.get('buffer'))[0], 17);
  assert.equal(buffer.byteLength, 4);
  await assert.rejects(
    left.call('error', []),
    (error) =>
      error.name === 'TypeError' &&
      error.message === 'remote failure' &&
      error.stack.includes('runtime.test'),
  );
  await assert.rejects(left.call('other', []), (value) => value === 42);
  await assert.rejects(left.call('echo', [() => {}]));
  await assert.rejects(left.call('bad', []));
  await assert.rejects(left.call('toString', []), /Unknown IPC function/);
  assert.equal(await left.call('echo', ['healthy']), 'healthy');
});

test('malformed envelopes and unknown replies are ignored', async (t) => {
  const { left, port2 } = pair(t, { echo: (x) => x });

  for (const value of [
    null,
    {},
    { id: 1, type: 'request', method: 'call', functionId: 'echo' },
    { id: 1, type: 'response', ok: true },
    { id: 2, type: 'response', ok: false, error: {} },
    { id: 1, type: 'cancel' },
  ])
    port2.postMessage(value);
  port2.postMessage({ type: 'response', id: 9999, ok: true, value: 0 });
  assert.equal(await left.call('echo', [12]), 12);
  assert.equal(
    isMessage({
      id: 1,
      type: 'request',
      method: 'call',
      functionId: 'echo',
      args: [],
      signalIndex: 0,
    }),
    false,
  );
});

test('lazy pull, next values, caught throws, return and finally yields', async (t) => {
  let opened = 0;

  const { left } = pair(t, {
    async *run() {
      opened++;

      try {
        const input = yield 1;
        yield input;

        try {
          yield 3;
        } catch (error) {
          yield error;
        }
      } finally {
        yield 9;
      }

      return 10;
    },
  });

  const iterator = left.iterate('run', []);
  assert.equal(opened, 0);
  assert.equal(iterator[Symbol.asyncIterator](), iterator);
  assert.deepEqual(await iterator.next(), { done: false, value: 1 });
  assert.deepEqual(await iterator.next(2), { done: false, value: 2 });
  assert.deepEqual(await iterator.next(), { done: false, value: 3 });
  assert.deepEqual(await iterator.throw('caught'), {
    done: false,
    value: 'caught',
  });
  assert.deepEqual(await iterator.return(Promise.resolve(7)), {
    done: false,
    value: 9,
  });
  assert.deepEqual(await iterator.next(), { done: true, value: 7 });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  await assert.rejects(iterator.throw(new Error('terminal')), /terminal/);
});

test('unopened return, throw and already aborted signals open no stream', async (t) => {
  let opens = 0;

  const { left } = pair(t, {
    async *run() {
      opens++;
      yield 1;
    },
  });

  assert.deepEqual(await left.iterate('run', []).return(Promise.resolve(4)), {
    done: true,
    value: 4,
  });
  await assert.rejects(
    left.iterate('run', []).throw(new Error('never')),
    /never/,
  );
  assert.deepEqual(await left.iterate('run', [AbortSignal.abort()]).next(), {
    done: true,
    value: undefined,
  });
  assert.throws(
    () =>
      left.iterate('run', [
        new AbortController().signal,
        new AbortController().signal,
      ]),
    /one top-level/,
  );
  assert.equal(opens, 0);
});

test('queued operations serialize and continue after completion', async (t) => {
  const { left } = pair(t, {
    async *run() {
      yield 1;

      return 2;
    },
  });

  const iterator = left.iterate('run', []);
  assert.deepEqual(
    await Promise.all([
      iterator.next(),
      iterator.next(),
      iterator.next(),
      iterator.return(4),
    ]),
    [
      { done: false, value: 1 },
      { done: true, value: 2 },
      { done: true, value: undefined },
      { done: true, value: 4 },
    ],
  );
});

test('uncloneable yielded value closes producer and peer remains usable', async (t) => {
  let cleaned = false;

  const { left } = pair(t, {
    async *run() {
      try {
        yield () => {};
      } finally {
        cleaned = true;
      }
    },
    echo: (x) => x,
  });

  await assert.rejects(left.iterate('run', []).next());
  assert.equal(cleaned, true);
  assert.equal(await left.call('echo', [4]), 4);
});

for (const cancel of ['abort', 'return', 'disconnect', 'unbind'])
  test(`idle read cancellation: ${cancel}`, async (t) => {
    const pending = deferred();
    const binding = createIpcBinding('reader');
    const unbind = binding.bind({});

    let subscriptions = 0,
      abortedReason;

    const { left } = pair(t, {
      async *run(signal) {
        const lease = binding.get();
        const combined = AbortSignal.any([signal, lease.signal]);
        subscriptions++;
        let wake;

        const read = new Promise((resolve) => {
          wake = resolve;
        });

        let closed = false;

        const close = () => {
          if (closed) return;
          closed = true;
          abortedReason = signal.reason;
          subscriptions--;
          combined.removeEventListener('abort', close);
          wake();
        };

        combined.addEventListener('abort', close, { once: true });

        try {
          yield 'initial';
          pending.resolve();
          await read;
        } finally {
          close();
        }
      },
    });

    const controller = new AbortController();
    const iterator = left.iterate('run', [controller.signal]);
    await iterator.next();
    const next = iterator.next();
    await pending.promise;
    assert.equal(subscriptions, 1);

    if (cancel === 'abort') controller.abort('private reason');

    if (cancel === 'return') void iterator.return();

    if (cancel === 'disconnect') left.dispose();

    if (cancel === 'unbind') unbind();

    if (cancel === 'disconnect')
      await assert.rejects(next, /connection closed/);
    else assert.equal((await next).done, true);
    await until(() => subscriptions === 0);
    assert.notEqual(abortedReason, 'private reason');
    unbind();
  });

test('cancel while handler loads is remembered until stream ID arrives', async (t) => {
  const gate = deferred(),
    started = deferred();

  let observed;

  const { left } = pair(t, {
    run: async (signal) => {
      started.resolve();
      await gate.promise;

      return (async function* () {
        observed = signal.aborted;
        yield 1;
      })();
    },
  });

  const controller = new AbortController();
  const iterator = left.iterate('run', [controller.signal]);
  const next = iterator.next();
  await started.promise;
  controller.abort();
  gate.resolve();
  await next;
  await until(() => observed === true);
});

test('abort throws propagate and disconnect does not terminate ordinary work', async (t) => {
  const waiting = deferred(),
    gate = deferred();

  let completed = false;

  const { left } = pair(t, {
    async *run(signal) {
      yield 1;
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('aborted producer')),
          { once: true },
        );
        waiting.resolve();
      });
    },
    async slow() {
      await gate.promise;
      completed = true;
    },
  });

  const controller = new AbortController();
  const iterator = left.iterate('run', [controller.signal]);
  await iterator.next();
  const next = iterator.next();
  await waiting.promise;
  controller.abort();
  await assert.rejects(next, /aborted producer/);
  const slow = left.call('slow', []);
  await tick();
  left.dispose();
  await assert.rejects(slow, /connection closed/);
  assert.equal(completed, false);
  gate.resolve();
  await until(() => completed);
});

test('request, stream and iterator limits release slots', async (t) => {
  const gate = deferred();

  const { left } = pair(
    t,
    {
      slow: () => gate.promise,
      echo: (x) => x,
      async *run() {
        yield 1;
      },
    },
    { requests: 2, streams: 1, iterator: 2 },
  );

  const a = left.call('slow', []),
    b = left.call('slow', []);

  await assert.rejects(left.call('echo', [1]), /request limit/);
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(await left.call('echo', [2]), 2);
  const one = left.iterate('run', []);
  await one.next();
  await assert.rejects(left.iterate('run', []).next(), /stream limit/);
  await one.return();
  const two = left.iterate('run', []);
  await two.next();
  await two.return();
  const three = left.iterate('run', []);

  const n1 = three.next(),
    n2 = three.next();

  await assert.rejects(three.next(), /iterator request limit/);
  await Promise.all([n1, n2]);
  assert.equal((await three.next()).done, true);
});

test('closure rejects both directions and disposal is idempotent', async (t) => {
  const { left, right } = pair(t, { slow: () => new Promise(() => {}) });

  const a = left.call('slow', []),
    b = right.call('slow', []);

  left.dispose();
  left.dispose();
  await assert.rejects(a, /connection closed/);
  await assert.rejects(b, /connection closed/);
  await assert.rejects(left.call('slow', []), /connection closed/);
});

test('binding ownership, reentrancy, independent names and stale disposers', () => {
  const binding = createIpcBinding('service'),
    other = createIpcBinding('service');

  assert.throws(() => binding.get(), /not bound/);

  const unbind = binding.bind(1),
    lease = binding.get();

  assert.throws(() => binding.bind(2), /already bound/);
  other.bind(2);
  lease.signal.addEventListener('abort', () =>
    assert.throws(() => binding.get(), /not bound/),
  );
  unbind();
  assert.equal(lease.value, 1);
  assert.equal(lease.signal.aborted, true);
  const next = binding.bind(3);
  unbind();
  assert.equal(binding.get().value, 3);
  assert.equal(other.get().value, 2);
  next();
});

test('registry lazy caching, metadata and resolver ownership', async (t) => {
  let loads = 0;
  register('lazy', async () => {
    loads++;

    return async () => 5;
  });
  assert.equal(loads, 0);
  await Promise.all([lookup('lazy'), lookup('lazy')]);
  assert.equal(loads, 1);
  let failures = 0;
  register('failed', async () => {
    failures++;
    throw new Error('load failed');
  });
  await assert.rejects(lookup('failed'));
  await assert.rejects(lookup('failed'));
  assert.equal(failures, 1);
  await assert.rejects(lookup('toString'), /Unknown/);
  const ref = reference('main', 'echo', 'function');
  await assert.rejects(ref(), /not installed/);
  const { left } = pair(t, { echo: (x) => x });
  const clear = configure(() => left);
  assert.throws(() => configure(() => left), /already installed/);
  assert.equal(await ref(4), 4);
  assert.throws(
    () => invokeRenderer({ webContents: { id: 1 } }, ref.bind(null), 4),
    /transformed/,
  );
  clear();
  const next = configure(() => left);
  clear();
  assert.equal(await ref(5), 5);
  next();
});

test('single-operation iterator bound frees its slot before awaited result returns', async (t) => {
  const { left } = pair(
    t,
    {
      async *run() {
        yield 1;
        yield 2;
      },
    },
    { requests: 2, streams: 2, iterator: 1 },
  );

  const iterator = left.iterate('run', []);
  assert.equal((await iterator.next()).value, 1);
  assert.equal((await iterator.next()).value, 2);
  await iterator.return();
});

test('two independent peers reuse sequence numbers without colliding', async (t) => {
  const a = pair(t, { echo: async () => 1 }),
    b = pair(t, { echo: async () => 2 });

  assert.deepEqual(
    await Promise.all([
      a.left.call('echo', []),
      b.left.call('echo', []),
      a.right.call('echo', []),
      b.right.call('echo', []),
    ]),
    [1, 2, 1, 2],
  );
});

test('disconnect aborts a controller while lazy open is still waiting', async (t) => {
  const gate = deferred(),
    started = deferred();

  let signal,
    cleaned = false;

  const { left } = pair(t, {
    run: async (forwarded) => {
      signal = forwarded;
      started.resolve();
      await gate.promise;

      return {
        next: async () => ({ done: false, value: 1 }),
        return: async () => {
          cleaned = true;

          return { done: true, value: undefined };
        },
      };
    },
  });

  const next = left.iterate('run', [new AbortController().signal]).next();
  await started.promise;
  left.dispose();
  await assert.rejects(next, /connection closed/);
  await until(() => signal.aborted);
  gate.resolve();
  await until(() => cleaned);
});

test('failed success and error posting do not claim delivery or crash peer', async () => {
  let receive;
  let close;
  let posts = 0;

  const peer = new Peer(
    {
      postMessage() {
        posts++;
        throw new Error('transport failed');
      },
      listen(onMessage, onClose) {
        receive = onMessage;
        close = onClose;

        return () => {};
      },
      close() {},
    },
    async () => () => 1,
  );

  receive({
    type: 'request',
    method: 'call',
    id: 1,
    functionId: 'run',
    args: [],
  });
  await tick();
  assert.equal(posts, 2);
  close();
  peer.dispose();
});

test('invalid stream replies trigger cleanup', async (t) => {
  let cleaned = false;

  const { left } = pair(t, {
    run: () => ({
      next: () => ({ value: 1 }),
      return: () => {
        cleaned = true;

        return { done: true, value: undefined };
      },
    }),
  });

  await assert.rejects(
    left.iterate('run', []).next(),
    /Invalid IPC iterator result/,
  );
  assert.equal(cleaned, true);
});

test('messageerror events have no recovery policy and later delivered messages still work', async (t) => {
  const { left, port1 } = pair(t, { echo: (value) => value });
  port1.emit('messageerror', new Error('deserialization failed'));
  assert.equal(await left.call('echo', [9]), 9);
});

test('rejected return values close active streams and release their slot', async (t) => {
  let cleaned = 0;

  const { left } = pair(
    t,
    {
      async *run() {
        try {
          yield 1;
          yield 2;
        } finally {
          cleaned++;
        }
      },
    },
    { requests: 4, streams: 1, iterator: 4 },
  );

  const iterator = left.iterate('run', []);
  await iterator.next();
  const failure = new Error('return value rejected');
  await assert.rejects(
    iterator.return(Promise.reject(failure)),
    (error) => error === failure,
  );
  assert.equal(cleaned, 1);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  const replacement = left.iterate('run', []);
  assert.equal((await replacement.next()).value, 1);
  await replacement.return();
});

test('rejected return values leave unopened iterators terminal without opening a stream', async (t) => {
  let opened = 0;

  const { left } = pair(t, {
    async *run() {
      opened++;
      yield 1;
    },
  });

  const iterator = left.iterate('run', []);
  await assert.rejects(
    iterator.return(Promise.reject(new Error('return rejected'))),
    /return rejected/,
  );
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(opened, 0);
});

test(
  'errors with an absent stack reject rather than leaving a pending call',
  { timeout: 2000 },
  async (t) => {
    const { left } = pair(t, {
      run() {
        const error = new Error('without stack');
        delete error.stack;
        throw error;
      },
    });

    await assert.rejects(
      left.call('run', []),
      (error) => error.message === 'without stack' && error.stack === undefined,
    );
  },
);

test('failed generator parameter initialization aborts the opening lifetime', async (t) => {
  let signal;

  function initialize(forwarded) {
    signal = forwarded;
    throw new Error('initialization failed');
  }

  const { left } = pair(t, {
    async *run(forwarded, value = initialize(forwarded)) {
      yield value;
    },
  });

  await assert.rejects(
    left.iterate('run', [new AbortController().signal]).next(),
    /initialization failed/,
  );
  assert.equal(signal.aborted, true);
});
