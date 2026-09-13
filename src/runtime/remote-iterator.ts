import type { Peer } from './peer.js';
import { isResult, type Operation, type RequestBody } from './protocol.js';

function isStreamId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function remoteIterator(
  peer: Peer,
  functionId: string,
  originalArgs: unknown[],
  limit: number,
): AsyncGenerator<unknown, unknown, unknown> {
  const args = [...originalArgs];
  let signal: AbortSignal | undefined;
  let signalIndex: number | undefined;
  args.forEach((arg, index) => {
    if (arg instanceof AbortSignal) {
      if (signal)
        throw new TypeError('IPC streams accept one top-level AbortSignal');
      signal = arg;
      signalIndex = index;
      args[index] = undefined;
    }
  });
  let state: 'unopened' | 'active' | 'finished' = 'unopened';
  let streamId: number | undefined;
  let cancelled = false;
  let queued = 0;
  let queue = Promise.resolve();
  let removeClose = () => {};

  const finish = () => {
    state = 'finished';
    signal?.removeEventListener('abort', abort);
    removeClose();
  };

  const cancel = () => {
    cancelled = true;

    if (streamId !== undefined) {
      try {
        peer.cancel(streamId);
      } catch {
        /* A queued operation reports transport failure. */
      }
    }
  };

  const abort = () => {
    cancel();
    void enqueue('return', undefined).catch(() => {});
  };

  async function perform(
    method: Operation,
    value: unknown,
  ): Promise<IteratorResult<unknown, unknown>> {
    if (
      state === 'finished' ||
      (state === 'unopened' && (method !== 'next' || signal?.aborted))
    ) {
      finish();

      if (method === 'throw') throw value;

      return {
        done: true,
        value: method === 'return' ? await value : undefined,
      };
    }

    try {
      if (method === 'return') value = await value;

      if (state === 'unopened') {
        state = 'active';
        peer.assertOpen();
        removeClose = peer.onClose(finish);
        signal?.addEventListener('abort', abort, { once: true });

        const request: Extract<RequestBody, { method: 'open' }> = {
          method: 'open',
          functionId,
          args,
        };

        if (signalIndex !== undefined) request.signalIndex = signalIndex;

        const opened = await peer.request(request);

        if (!isStreamId(opened)) {
          throw new TypeError('Invalid IPC stream ID');
        }

        streamId = opened;

        if (cancelled) cancel();
      }

      if (streamId === undefined) throw new TypeError('Invalid IPC stream ID');
      const result = await peer.request({ method, streamId, value });

      if (!isResult(result)) throw new TypeError('Invalid IPC iterator result');

      if (result.done) finish();

      return result;
    } catch (error) {
      finish();

      if (streamId !== undefined) {
        try {
          await peer.request({ method: 'return', streamId, value: undefined });
        } catch {
          /* Preserve the original caller error. */
        }
      }

      throw error;
    }
  }

  function enqueue(
    method: Operation,
    value: unknown,
  ): Promise<IteratorResult<unknown, unknown>> {
    if (queued >= limit)
      return Promise.reject(new Error('IPC iterator request limit reached'));
    queued++;

    const result = queue
      .then(() => perform(method, value))
      .finally(() => {
        queued--;
      });

    queue = result.then(
      () => {},
      () => {},
    );

    return result;
  }

  const iterator: AsyncGenerator<unknown, unknown, unknown> = {
    next: (...values) => enqueue('next', values[0]),
    return: (value) => {
      cancel();

      return enqueue('return', value);
    },
    throw: (value) => enqueue('throw', value),
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      await this.return(undefined);
    },
  };

  return iterator;
}
