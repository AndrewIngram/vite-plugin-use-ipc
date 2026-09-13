import { installIpcPreload } from 'vite-plugin-use-ipc/preload';

installIpcPreload();

// Fixture-only malformed setup probes. This is not part of the library bridge.
import { ipcRenderer } from 'electron';

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'fixture:invalid-ports')
    return;
  const first = new MessageChannel();
  const second = new MessageChannel();

  for (const port of [first.port2, second.port2]) {
    port.addEventListener('close', () =>
      window.postMessage({ type: 'fixture:rejected-port-closed' }, '*'),
    );
    port.start();
  }

  ipcRenderer.postMessage('use-ipc:connect', null, []);
  ipcRenderer.postMessage('use-ipc:connect', null, [first.port1, second.port1]);
});
