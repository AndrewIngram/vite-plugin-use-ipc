import { ipcRenderer } from 'electron';
import { record } from './protocol.js';

interface PortRequest {
  type: 'use-ipc:request-port';
  id: string;
}

function isPortRequest(value: unknown): value is PortRequest {
  return (
    record(value) &&
    value.type === 'use-ipc:request-port' &&
    typeof value.id === 'string'
  );
}

export function installIpcPreload(): () => void {
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== window || !isPortRequest(event.data)) return;
    const { port1, port2 } = new MessageChannel();

    try {
      ipcRenderer.postMessage('use-ipc:connect', null, [port1]);
      window.postMessage({ type: 'use-ipc:port', id: event.data.id }, '*', [
        port2,
      ]);
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
  };

  window.addEventListener('message', receive);

  return () => window.removeEventListener('message', receive);
}
