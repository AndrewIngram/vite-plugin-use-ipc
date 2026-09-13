import 'virtual:use-ipc/register';
import { installRendererIpc } from 'vite-plugin-use-ipc/renderer';
import { announce } from './ipc/main';

void installRendererIpc()
  .then(async (dispose) => {
    Object.assign(window, { disposeIpc: dispose });
    await announce(Number(new URL(location.href).searchParams.get('slot')));
  })
  .catch((error) => {
    document.title = String(error);
  });
