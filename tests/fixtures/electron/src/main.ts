import { checkFixtureError } from './errors';
import 'virtual:use-ipc/register';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, protocol, net } from 'electron';
import { installMainIpc, callRenderer } from 'vite-plugin-use-ipc/main';
import {
  richFailure,
  setTitle,
  probe,
  sequence,
  startIdle,
  hang,
} from './ipc/renderer';
import { increment } from './ipc/main';
import { ready, subscriptions, waiting, binding } from './state';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ipc-fixture',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const deadline = setTimeout(() => {
  console.error('Electron fixture deadline exceeded');
  app.exit(1);
}, 45_000);

app.setPath('userData', process.env.IPC_TEST_USER_DATA!);

const windows: BrowserWindow[] = [];

let installation = installMainIpc();

let unbind = binding.bind({});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 1500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    'Electron fixture condition did not become true: ' +
      predicate.toString() +
      '; titles: ' +
      windows
        .flatMap((w) => (w.isDestroyed() ? [] : [w.getTitle()]))
        .join(', '),
  );
}

const base = process.env.IPC_TEST_URL ?? 'ipc-fixture://app/index.html';

function create(preload = true) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preload ? path.join(__dirname, 'preload.cjs') : undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInSubFrames: true,
    },
  });

  windows.push(window);

  return window;
}

async function open(slot: number, attach = true, preload = true) {
  const window = create(preload);

  if (attach) installation.attach(window);
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(event.message);
  });
  await window.loadURL(base + '?slot=' + slot);

  return window;
}

app
  .whenReady()
  .then(async () => {
    protocol.handle('ipc-fixture', (request) => {
      const url = new URL(request.url);
      const filename = path.join(__dirname, 'renderer', url.pathname);

      return net.fetch(pathToFileURL(filename).href);
    });
    assert.throws(() => installMainIpc(), /already installed/);

    const first = await open(1),
      second = await open(2);

    await until(() => ready.has(1) && ready.has(2));
    installation.attach(first);
    assert.equal(await increment(), 1);
    assert.equal(await callRenderer(first, setTitle, 'first'), 'first');
    assert.equal(await callRenderer(second, setTitle, 'second'), 'second');
    assert.equal(
      await first.webContents.executeJavaScript('document.title'),
      'first',
    );
    await first.webContents.executeJavaScript(`new Promise(resolve => {
    let count = 0;
    const listener = event => {
      if (event.data?.type !== 'fixture:rejected-port-closed') return;
      if (++count === 2) { window.removeEventListener('message', listener); resolve(true); }
    };
    window.addEventListener('message', listener);
    window.postMessage({type:'fixture:invalid-ports'}, '*');
  })`);
    assert.equal(await callRenderer(first, setTitle, 'first'), 'first');
    await first.webContents
      .executeJavaScript(`new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = ${JSON.stringify(base + '?slot=77')};
    document.body.append(frame);
    const start = Date.now();
    const timer = setInterval(() => {
      const title = frame.contentDocument?.title ?? '';
      if (title.includes('connection closed')) { clearInterval(timer); frame.remove(); resolve(true); }
      else if (Date.now() - start > 12000) { clearInterval(timer); reject(new Error('Subframe setup was not rejected: ' + title)); }
    }, 20);
  })`);
    assert.equal(ready.has(77), false);

    assert.equal(
      await second.webContents.executeJavaScript('document.title'),
      'second',
    );
    assert.throws(() => callRenderer(first, async () => {}), /transformed/);
    await assert.rejects(setTitle('missing'), /callRenderer/);
    await assert.rejects(callRenderer(first, richFailure), (error) => {
      checkFixtureError(error);

      return true;
    });
    const report = await callRenderer(first, probe);
    assert.deepEqual(report, {
      value: 23,
      bytes: 4,
      errorName: 'TypeError',
      count: 2,
      platform: process.platform,
      values: [1, 2],
    });
    const controller = new AbortController();
    const stream = callRenderer(first, sequence, controller.signal);
    assert.deepEqual(await stream.next(), { done: false, value: 'first' });
    const next = stream.next();
    controller.abort();
    assert.equal((await next).done, true);
    await callRenderer(first, startIdle);
    await until(() => waiting === 1);
    assert.equal(subscriptions, 1);
    unbind();
    await until(() => subscriptions === 0);
    unbind = binding.bind({});
    assert.equal(
      await callRenderer(second, setTitle, 'still connected'),
      'still connected',
    );
    await callRenderer(first, startIdle);
    await until(() => waiting === 1);
    first.webContents.reload();
    await until(() => ready.get(1) === 2 && subscriptions === 0);
    await callRenderer(first, startIdle);
    await until(() => waiting === 1);
    await first.loadURL(base + '?slot=3');
    await until(() => ready.has(3) && subscriptions === 0);
    const crashed = callRenderer(first, hang);
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.webContents.forcefullyCrashRenderer();
    await assert.rejects(crashed, /connection closed/);
    const closed = callRenderer(second, hang);
    await new Promise((resolve) => setTimeout(resolve, 50));
    second.destroy();
    await assert.rejects(closed, /connection closed/);
    const unattached = await open(4, false);
    await until(() => unattached.getTitle().includes('connection closed'));
    unattached.destroy();
    const absent = await open(5, true, false);
    await until(() =>
      absent.getTitle().includes('preload connection timed out'),
    );
    absent.destroy();
    installation.dispose();
    installation.dispose();
    installation = installMainIpc();
    const restarted = await open(6);
    await until(() => ready.has(6));
    assert.equal(
      await callRenderer(restarted, setTitle, 'restarted'),
      'restarted',
    );
    console.log('IPC_ELECTRON_OK');
  })
  .then(() => {
    clearTimeout(deadline);
    unbind();
    installation.dispose();

    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    clearTimeout(deadline);
    unbind();
    installation.dispose();

    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  });
