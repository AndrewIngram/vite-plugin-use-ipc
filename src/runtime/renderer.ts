import { Peer } from './peer.js';
import { configure, lookup } from './references.js';
import { record } from './protocol.js';

export function installRendererIpc(): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();

    const cleanStartup = () => {
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
    };

    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== window ||
        !record(event.data) ||
        event.data.type !== 'use-ipc:port' ||
        event.data.id !== id ||
        event.ports.length !== 1
      )
        return;
      cleanStartup();
      const [port] = event.ports;

      const peer = new Peer(
        {
          postMessage: (message) => port.postMessage(message),
          close: () => port.close(),
          listen(receive, closed) {
            const message = (event: MessageEvent<unknown>) =>
              receive(event.data);

            port.addEventListener('message', message);
            port.addEventListener('close', closed);
            port.start();

            return () => {
              port.removeEventListener('message', message);
              port.removeEventListener('close', closed);
            };
          },
        },
        lookup,
      );

      try {
        const clear = configure((target) => {
          if (target !== 'main')
            throw new Error('Renderer IPC references must target main');
          peer.assertOpen();

          return peer;
        });

        let disposed = false;

        const dispose = () => {
          if (disposed) return;
          disposed = true;
          window.removeEventListener('pagehide', dispose);
          peer.dispose();
          clear();
        };

        window.addEventListener('pagehide', dispose);
        resolve(dispose);
      } catch (error) {
        peer.dispose();
        reject(error);
      }
    };

    const timeout = setTimeout(() => {
      cleanStartup();
      reject(new Error('IPC preload connection timed out'));
    }, 10_000);

    window.addEventListener('message', receive);

    try {
      window.postMessage({ type: 'use-ipc:request-port', id }, '*');
    } catch (error) {
      cleanStartup();
      reject(error);
    }
  });
}
