import 'virtual:use-ipc/register';
import { installRendererIpc } from 'vite-plugin-use-ipc/renderer';
import { add } from './ipc/calculator';

async function start() {
  await installRendererIpc();
  const result = await add(20, 22);
  document.body.textContent = `20 + 22 = ${result.answer}. Main process calls: ${result.calls}.`;
}

void start().catch((error) => {
  document.body.textContent = String(error);
});
