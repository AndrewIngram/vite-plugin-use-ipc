import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, createServer } from 'vite';
import useIpc from '../dist/vite.js';
import { until } from './helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'use-ipc-vite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src/ipc'), { recursive: true });
  await mkdir(path.join(root, 'renderer'));

  return {
    root,
    write: (file, source) => writeFile(path.join(root, file), source),
  };
}

test('minified destination build retains lazy registry and shared implementation state', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/counter.ts',
    '"use ipc:main"; let state=0; export async function increment(){ return ++state; }',
  );
  await write(
    'src/entry.ts',
    'import "virtual:use-ipc/register"; export {increment} from "./ipc/counter";',
  );

  const output = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [useIpc({ root, target: 'main' })],
    build: { ssr: path.join(root, 'src/entry.ts'), write: false, minify: true },
  });

  const code = output.output.map((item) => item.code ?? item.source).join('\n');
  assert.match(code, /increment/);
  assert.match(code, /import\(/);
  assert.match(code, /Unknown IPC function/);
});

for (const target of ['main', 'renderer'])
  test(`${target} caller excludes implementation imports and source maps`, async (t) => {
    const { root, write } = await fixture(t);
    const destination = target === 'main' ? 'renderer' : 'main';
    await write(
      'src/ipc/private.ts',
      `"use ipc:${destination}"; import "unresolvable-destination-only"; const secret="PRIVATE_SOURCE_SENTINEL"; export async function run(){return secret}`,
    );
    await write('src/entry.ts', 'export {run} from "./ipc/private";');

    const output = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [useIpc({ root, target })],
      build: {
        lib: { entry: path.join(root, 'src/entry.ts'), formats: ['es'] },
        write: false,
        sourcemap: true,
        minify: true,
      },
    });

    const text = JSON.stringify(output);
    assert.doesNotMatch(
      text,
      /PRIVATE_SOURCE_SENTINEL|unresolvable-destination-only/,
    );
  });

test('outside include and query imports fail before source disclosure', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/private.ts',
    '"use ipc:main"; export async function run(){return "PRIVATE_SOURCE_SENTINEL"}',
  );
  await write('src/entry.ts', 'export {run} from "./ipc/private";');
  await assert.rejects(
    build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [useIpc({ root, target: 'renderer', include: [] })],
      build: { ssr: path.join(root, 'src/entry.ts'), write: false },
    }),
    /useIpc.include/,
  );

  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [useIpc({ root, target: 'renderer' })],
    server: { host: '127.0.0.1', port: 0 },
  });

  t.after(() => server.close());
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const response = await fetch(url + 'src/ipc/private.ts?raw');
  assert.equal(response.status, 500);
  // Vite's error body must not contain the rejected implementation.
  assert.doesNotMatch(await response.text(), /PRIVATE_SOURCE_SENTINEL/);
  assert.doesNotMatch(
    (await server.transformRequest('/src/ipc/private.ts')).code,
    /PRIVATE_SOURCE_SENTINEL/,
  );
});

test('real Vite watcher updates edits, additions, deletions and reloads', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/counter.ts',
    '"use ipc:main"; export async function first(){return 1}',
  );

  const server = await createServer({
    configFile: false,
    root: path.join(root, 'renderer'),
    logLevel: 'silent',
    plugins: [useIpc({ root, target: 'main' })],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  });

  t.after(() => server.close());
  await server.listen();

  const registry = async () =>
    (await server.pluginContainer.load('\0virtual:use-ipc/register')).code;

  assert.match(await registry(), /:first/);
  let reloads = 0;
  const send = server.ws.send.bind(server.ws);
  server.ws.send = (...args) => {
    if (args[0]?.type === 'full-reload') reloads++;

    return send(...args);
  };

  await write(
    'src/ipc/counter.ts',
    '"use ipc:main"; export async function second(){return 2}',
  );
  await until(async () => /:second/.test(await registry()));
  assert.doesNotMatch(await registry(), /:first/);
  await write(
    'src/ipc/added.ts',
    '"use ipc:main"; export async function added(){return 3}',
  );
  await until(async () => /:added/.test(await registry()));
  await rm(path.join(root, 'src/ipc/added.ts'));
  await until(async () => !/:added/.test(await registry()));
  assert.ok(reloads >= 3);
});

test('source aliases and symlinks share a destination implementation', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/counter.ts',
    '"use ipc:main"; let count=0; export async function increment(){return ++count}',
  );
  const { symlink } = await import('node:fs/promises');
  await symlink(
    path.join(root, 'src/ipc/counter.ts'),
    path.join(root, 'src/alias.ts'),
  );
  await write(
    'src/entry.ts',
    'import "virtual:use-ipc/register"; export {increment as one} from "@counter"; export {increment as two} from "./alias";',
  );

  const output = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    resolve: { alias: { '@counter': path.join(root, 'src/ipc/counter.ts') } },
    plugins: [useIpc({ root, target: 'main' })],
    build: {
      ssr: path.join(root, 'src/entry.ts'),
      outDir: path.join(root, 'out'),
      minify: true,
    },
  });

  const { pathToFileURL } = await import('node:url');
  const entry = output.output.find((item) => item.isEntry);

  const module = await import(
    pathToFileURL(path.join(root, 'out', entry.fileName)).href
  );

  assert.equal(await module.one(), 1);
  assert.equal(await module.two(), 2);
  assert.equal(module.one, module.two);
});

test('compiler replacement precedes ordinary framework transforms', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/view.tsx',
    '"use ipc:renderer"; import "unresolvable-framework"; export async function view(){return <div>private UI</div>}',
  );
  await write('src/entry.ts', 'export {view} from "./ipc/view"');
  let checked = false;
  await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [
      useIpc({ root, target: 'main' }),
      {
        name: 'framework-order-check',
        transform(code, id) {
          if (id.endsWith('/view.tsx')) {
            assert.doesNotMatch(code, /private UI|unresolvable-framework/);
            assert.match(code, /reference/);
            checked = true;
          }
        },
      },
    ],
    build: { ssr: path.join(root, 'src/entry.ts'), write: false },
  });
  assert.ok(checked);
});

test('overlapping discovery refreshes retain the latest source revision', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/counter.ts',
    '"use ipc:main"; export async function oldName(){}',
  );
  const plugin = useIpc({ root, target: 'main' });
  const context = { addWatchFile() {} };
  const first = plugin.buildStart.call(context);
  await write(
    'src/ipc/counter.ts',
    '"use ipc:main"; export async function newestName(){}',
  );
  const second = plugin.buildStart.call(context);
  await Promise.all([first, second]);

  const registry = await plugin.load.call(
    context,
    '\0virtual:use-ipc/register',
  );

  assert.match(registry.code, /:newestName/);
  assert.doesNotMatch(registry.code, /:oldName/);
});

test('main build watcher and renderer discovery converge after edits, additions and deletion', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/counter.ts',
    '"use ipc:main"; export async function first(){return 1}',
  );
  await write('src/entry.ts', 'import "virtual:use-ipc/register";');

  const watcher = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [useIpc({ root, target: 'main' })],
    build: {
      ssr: path.join(root, 'src/entry.ts'),
      outDir: path.join(root, 'out'),
      watch: {},
      minify: true,
    },
  });

  t.after(() => watcher.close());

  let builds = 0,
    error;

  watcher.on('event', (event) => {
    if (event.code === 'END') builds++;

    if (event.code === 'ERROR') error = event.error;
  });

  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [useIpc({ root, target: 'renderer' })],
    server: { host: '127.0.0.1', port: 0 },
  });

  t.after(() => server.close());
  await server.listen();
  await until(() => builds > 0 || error);

  if (error) throw error;
  const first = (await server.transformRequest('/src/ipc/counter.ts')).code;
  assert.match(first, /:first/);
  const previous = builds;
  await write(
    'src/ipc/counter.ts',
    '"use ipc:main"; export async function second(){return 2}',
  );
  await until(() => builds > previous || error);

  if (error) throw error;
  await until(async () =>
    /:second/.test((await server.transformRequest('/src/ipc/counter.ts')).code),
  );
  const edited = builds;
  await write(
    'src/ipc/added.ts',
    '"use ipc:main"; export async function added(){return 3}',
  );
  await until(() => builds > edited || error);

  if (error) throw error;
  await until(async () => {
    try {
      return /:added/.test(
        (await server.transformRequest('/src/ipc/added.ts')).code,
      );
    } catch {
      return false;
    }
  });
  await until(async () =>
    /:added/.test(await readFile(path.join(root, 'out/entry.mjs'), 'utf8')),
  );
  const added = builds;
  await rm(path.join(root, 'src/ipc/added.ts'));
  await until(() => builds > added || error);

  if (error) throw error;
  const { glob } = await import('tinyglobby');
  const chunks = await glob('out/**/*.mjs', { cwd: root });
  await until(
    async () =>
      !/:added/.test(await readFile(path.join(root, 'out/entry.mjs'), 'utf8')),
  );
  assert.ok(chunks.length > 0);
});

test('two production watchers stay idle between source changes and discover additions', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/main.ts',
    '"use ipc:main"; export async function initialMain() {}',
  );
  await write(
    'src/ipc/renderer.ts',
    '"use ipc:renderer"; export async function initialRenderer() {}',
  );
  await write('src/entry.ts', 'import "virtual:use-ipc/register";');
  const counts = { main: 0, renderer: 0 };
  const errors = [];
  const watchers = [];
  t.after(async () => {
    for (const watcher of watchers) await watcher.close();
  });

  for (const target of ['main', 'renderer']) {
    const watcher = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [useIpc({ root, target })],
      build: {
        ssr: path.join(root, 'src/entry.ts'),
        outDir: path.join(root, 'out', target),
        watch: {},
        minify: true,
        rolldownOptions: { output: { entryFileNames: 'entry.mjs' } },
      },
    });

    watchers.push(watcher);
    watcher.on('event', (event) => {
      if (event.code === 'END') counts[target]++;

      if (event.code === 'ERROR') errors.push(event.error);
    });
    await until(() => counts[target] > 0 || errors.length > 0);
    assert.deepEqual(errors, []);
  }

  async function assertIdle() {
    await delay(150);
    const settled = { ...counts };
    await delay(500);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      counts,
      settled,
      'generated output must not trigger another build',
    );
  }

  await assertIdle();
  const previous = { ...counts };
  await write(
    'src/ipc/main.ts',
    '"use ipc:main"; export async function editedMain() {}',
  );
  await until(
    () => counts.main > previous.main && counts.renderer > previous.renderer,
  );
  await assertIdle();
  await mkdir(path.join(root, 'src/ipc/nested'));
  await write(
    'src/ipc/nested/added.ts',
    '"use ipc:renderer"; export async function newlyAdded() {}',
  );

  const registry = () =>
    readFile(path.join(root, 'out/renderer/entry.mjs'), 'utf8');

  await until(async () => /:newlyAdded/.test(await registry()));
  await assertIdle();
  await rm(path.join(root, 'src/ipc/nested'), { recursive: true });
  await until(async () => !/:newlyAdded/.test(await registry()));
  await assertIdle();
});

test('raw queries outside include cannot expose directive source', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'src/ipc/private.ts',
    '"use ipc:main"; export async function run(){ return "EXCLUDED_SOURCE_SENTINEL"; }',
  );

  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [useIpc({ root, target: 'renderer', include: [] })],
    server: { host: '127.0.0.1', port: 0 },
  });

  t.after(() => server.close());
  await server.listen();

  const response = await fetch(
    server.resolvedUrls.local[0] + 'src/ipc/private.ts?raw',
  );

  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /EXCLUDED_SOURCE_SENTINEL/);
});

test('discovery through an included symlink accepts the canonical implementation', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'implementation.ts',
    '"use ipc:main"; export async function run(){ return 1; }',
  );
  const { symlink } = await import('node:fs/promises');
  await symlink(
    path.join(root, 'implementation.ts'),
    path.join(root, 'src/ipc/link.ts'),
  );
  await write('src/entry.ts', 'export { run } from "./ipc/link";');
  await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [
      useIpc({ root, target: 'renderer', include: ['src/ipc/**/*.ts'] }),
    ],
    build: { ssr: path.join(root, 'src/entry.ts'), write: false },
  });
});

test('production discovery removes handlers when their included symlink is deleted', async (t) => {
  const { root, write } = await fixture(t);
  await write(
    'implementation.ts',
    '"use ipc:main"; export async function removedHandler(){ return 1; }',
  );
  const { symlink } = await import('node:fs/promises');
  const link = path.join(root, 'src/ipc/link.ts');
  await symlink(path.join(root, 'implementation.ts'), link);
  await write('src/entry.ts', 'import "virtual:use-ipc/register";');

  const watcher = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [useIpc({ root, target: 'main', include: ['src/ipc/**/*.ts'] })],
    build: {
      ssr: path.join(root, 'src/entry.ts'),
      outDir: path.join(root, 'out'),
      watch: {},
      rolldownOptions: { output: { entryFileNames: 'entry.mjs' } },
    },
  });

  t.after(() => watcher.close());
  let builds = 0;
  const errors = [];
  watcher.on('event', (event) => {
    if (event.code === 'END') builds++;

    if (event.code === 'ERROR') errors.push(event.error);
  });
  await until(() => builds > 0 || errors.length > 0);
  assert.deepEqual(errors, []);
  const registry = () => readFile(path.join(root, 'out/entry.mjs'), 'utf8');
  assert.match(await registry(), /:removedHandler/);
  // Let initial directory events settle so they cannot mask a missed unlink event.
  await delay(2000);
  await rm(link);
  await until(async () => !/:removedHandler/.test(await registry()));
  assert.deepEqual(errors, []);
  assert.match(
    await readFile(path.join(root, 'implementation.ts'), 'utf8'),
    /removedHandler/,
  );
});
