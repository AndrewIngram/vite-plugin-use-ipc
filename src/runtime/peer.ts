import { serializeThrown, reviveThrown } from './errors.js';
import {
  isIterator,
  record,
  isMessage,
  type RequestBody,
  type Message,
  type StreamIterator,
} from './protocol.js';
import { remoteIterator } from './remote-iterator.js';

export interface Port {
  postMessage(message: Message): void;
  listen(receive: (message: unknown) => void, closed: () => void): () => void;
  close(): void;
}

export type Handler = (...args: unknown[]) => unknown;

type Stream = {
  iterator: StreamIterator;
  controller: AbortController;
  queue: Promise<unknown>;
};

export class Peer {
  private closed = false;
  private requestSequence = 0;
  private streamSequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  private readonly streams = new Map<number, Stream>();
  private readonly opening = new Set<AbortController>();
  private readonly closeListeners = new Set<() => void>();
  private readonly unlisten: () => void;

  constructor(
    private readonly port: Port,
    private readonly lookup: (id: string) => Promise<Handler>,
    private readonly limits = { requests: 256, streams: 256, iterator: 256 },
  ) {
    this.unlisten = port.listen(
      (value) => {
        if (!this.closed && isMessage(value)) void this.receive(value);
      },
      () => this.dispose(),
    );
  }
  assertOpen(): void {
    if (this.closed) throw new Error('IPC connection closed');
  }
  onClose(listener: () => void): () => void {
    if (this.closed) listener();
    else this.closeListeners.add(listener);

    return () => {
      this.closeListeners.delete(listener);
    };
  }
  request(body: RequestBody): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.assertOpen();

      if (this.pending.size >= this.limits.requests)
        throw new Error('IPC request limit reached');

      if (this.requestSequence === Number.MAX_SAFE_INTEGER)
        throw new Error('IPC request sequence exhausted');
      const id = ++this.requestSequence;
      this.pending.set(id, { resolve, reject });

      try {
        this.port.postMessage({ type: 'request', id, ...body });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  call(functionId: string, args: unknown[]): Promise<unknown> {
    return this.request({ method: 'call', functionId, args });
  }
  iterate(
    functionId: string,
    args: unknown[],
  ): AsyncGenerator<unknown, unknown, unknown> {
    this.assertOpen();

    return remoteIterator(this, functionId, args, this.limits.iterator);
  }
  cancel(id: number): void {
    if (!this.closed) this.port.postMessage({ type: 'cancel', id });
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten();
    this.port.close();

    for (const pending of this.pending.values())
      pending.reject(new Error('IPC connection closed'));
    this.pending.clear();

    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();

    for (const controller of this.opening) controller.abort();
    this.opening.clear();

    for (const stream of this.streams.values()) {
      stream.controller.abort();
      void this.cleanup(stream.iterator).catch(() => {});
    }

    this.streams.clear();
  }
  private async cleanup(iterator: StreamIterator): Promise<void> {
    await iterator.return?.();
  }
  private send(message: Message): void {
    if (!this.closed) this.port.postMessage(message);
  }
  private async receive(value: Message): Promise<void> {
    if (this.closed) return;

    if (value.type === 'response') {
      const pending = this.pending.get(value.id);

      if (!pending) return;
      this.pending.delete(value.id);

      if (value.ok) pending.resolve(value.value);
      else pending.reject(reviveThrown(value.error));

      return;
    }

    if (value.type === 'cancel') {
      this.streams.get(value.id)?.controller.abort();

      return;
    }

    try {
      const result = await this.dispatch(value);
      this.send({ type: 'response', id: value.id, ok: true, value: result });
    } catch (error) {
      try {
        this.send({
          type: 'response',
          id: value.id,
          ok: false,
          error: serializeThrown(error),
        });
      } catch {
        /* A port unable to send errors has no delivery guarantee. */
      }
    }
  }
  private async dispatch(request: RequestBody): Promise<unknown> {
    if (request.method === 'call')
      return (await this.lookup(request.functionId))(...request.args);

    if (request.method === 'open') {
      const controller = new AbortController();
      this.opening.add(controller);
      let iterator: StreamIterator | undefined;

      try {
        const handler = await this.lookup(request.functionId);
        const args = [...request.args];

        if (request.signalIndex !== undefined)
          args[request.signalIndex] = controller.signal;
        const result = await handler(...args);

        if (!isIterator(result))
          throw new TypeError('IPC stream did not return an iterator');
        iterator = result;

        if (this.closed || this.streams.size >= this.limits.streams) {
          throw new Error('IPC stream limit reached or connection closed');
        }

        if (this.streamSequence === Number.MAX_SAFE_INTEGER)
          throw new Error('IPC stream sequence exhausted');
        const id = ++this.streamSequence;
        this.streams.set(id, {
          iterator,
          controller,
          queue: Promise.resolve(),
        });

        return id;
      } catch (error) {
        controller.abort();

        if (iterator) await this.cleanup(iterator);
        throw error;
      } finally {
        this.opening.delete(controller);
      }
    }

    const stream = this.streams.get(request.streamId);

    if (!stream)
      return {
        done: true,
        value: request.method === 'return' ? request.value : undefined,
      };

    if (request.method === 'return') stream.controller.abort();

    const operation = stream.queue.then(async () => {
      if (!this.streams.has(request.streamId)) {
        return {
          done: true,
          value: request.method === 'return' ? request.value : undefined,
        };
      }

      try {
        const method = stream.iterator[request.method];

        if (!method && request.method === 'throw') throw request.value;

        const result = method
          ? await method.call(stream.iterator, request.value)
          : { done: true, value: request.value };

        if (record(result) && 'done' in result && result.done) {
          this.streams.delete(request.streamId);
          stream.controller.abort();
        }

        return result;
      } catch (error) {
        this.streams.delete(request.streamId);
        stream.controller.abort();
        await this.cleanup(stream.iterator);
        throw error;
      }
    });

    stream.queue = operation.catch(() => {});

    return operation;
  }
}
