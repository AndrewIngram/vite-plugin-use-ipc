import 'virtual:use-ipc/register';
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { installMainIpc } from 'vite-plugin-use-ipc/main';

const ipc = installMainIpc();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  ipc.attach(window);

  try {
    if (process.env.ELECTRON_RENDERER_URL)
      await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(path.join(__dirname, '../renderer/index.html'));
  } catch (error) {
    window.destroy();
    throw error;
  }
});

app.on('before-quit', () => ipc.dispose());

app.on('window-all-closed', () => app.quit());
