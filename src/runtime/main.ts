import {
  ipcMain,
  type BrowserWindow,
  type Event,
  type IpcMainEvent,
  type WebContentsDidStartNavigationEventParams,
} from 'electron';
import { Peer } from './peer.js';
import { configure, lookup, invokeRenderer } from './references.js';

export { invokeRenderer as callRenderer };

export interface MainIpc {
  attach(window: BrowserWindow): void;
  dispose(): void;
}

interface AttachedWindow {
  closePeer(): void;
  dispose(): void;
  peer?: Peer;
}

export function installMainIpc(): MainIpc {
  const windows = new Map<number, AttachedWindow>();
  let disposed = false;

  const clear = configure((target, id) => {
    if (target !== 'renderer')
      throw new Error('Main IPC references must target a renderer');
    const peer = id === undefined ? undefined : windows.get(id)?.peer;

    if (!peer)
      throw new Error(
        'Target renderer is not connected; use callRenderer after readiness',
      );
    peer.assertOpen();

    return peer;
  });

  const connect = (event: IpcMainEvent) => {
    const entry = windows.get(event.sender.id);

    if (
      !entry ||
      event.senderFrame !== event.sender.mainFrame ||
      event.ports.length !== 1
    ) {
      for (const port of event.ports) port.close();

      return;
    }

    entry.closePeer();
    const [port] = event.ports;
    entry.peer = new Peer(
      {
        postMessage: (message) => port.postMessage(message),
        close: () => port.close(),
        listen(receive, closed) {
          const message = (event: { data: unknown }) => receive(event.data);
          port.on('message', message);
          port.on('close', closed);
          port.start();

          return () => {
            port.off('message', message);
            port.off('close', closed);
          };
        },
      },
      lookup,
    );
  };

  ipcMain.on('use-ipc:connect', connect);

  return {
    attach(window) {
      if (disposed) throw new Error('IPC installation is disposed');
      const contents = window.webContents;
      const id = contents.id;

      if (windows.has(id)) return;

      const entry: AttachedWindow = {
        closePeer() {
          entry.peer?.dispose();
          entry.peer = undefined;
        },
        dispose() {
          entry.closePeer();
          contents.off('did-start-navigation', navigate);
          contents.off('render-process-gone', gone);
          window.off('closed', closed);
          windows.delete(id);
        },
      };

      const navigate = (
        _event: Event<WebContentsDidStartNavigationEventParams>,
        _url: string,
        inPlace: boolean,
        mainFrame: boolean,
      ) => {
        if (mainFrame && !inPlace) entry.closePeer();
      };

      const gone = () => entry.closePeer();
      const closed = () => entry.dispose();
      windows.set(id, entry);
      contents.on('did-start-navigation', navigate);
      contents.on('render-process-gone', gone);
      window.on('closed', closed);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ipcMain.off('use-ipc:connect', connect);

      for (const entry of windows.values()) entry.dispose();
      clear();
    },
  };
}
