import { MessageChannel } from 'node:worker_threads';
import { Peer } from '../dist/runtime/peer.js';

export function pair(t, handlers = {}, limits) {
  const { port1, port2 } = new MessageChannel();

  function adapt(port) {
    return {
      postMessage: (message) => port.postMessage(message),
      close: () => port.close(),
      listen(receive, closed) {
        port.on('message', receive);
        port.on('close', closed);
        port.start();

        return () => {
          port.off('message', receive);
          port.off('close', closed);
        };
      },
    };
  }

  const lookup = async (id) => {
    if (!Object.hasOwn(handlers, id)) throw new Error('Unknown IPC function');

    return handlers[id];
  };

  const left = new Peer(adapt(port1), lookup, limits);
  const right = new Peer(adapt(port2), lookup, limits);
  t.after(() => {
    left.dispose();
    right.dispose();
  });

  return { left, right, port1, port2 };
}

export function deferred() {
  let resolve, reject;

  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

export async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await tick();
  }

  throw new Error('Condition did not become true');
}
