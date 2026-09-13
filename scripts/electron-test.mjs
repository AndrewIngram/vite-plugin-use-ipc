import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, createServer } from 'vite';
import { createPackage } from '@electron/asar';
import useIpc from 'vite-plugin-use-ipc';

const require = createRequire(import.meta.url);

const packageRoot = path.dirname(
  fileURLToPath(import.meta.resolve('vite-plugin-use-ipc')),
);

export async function electronTests() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'use-ipc-electron-'));
  let server;

  try {
    const root = path.join(temporary, 'application');
    await cp(new URL('../tests/fixtures/electron/', import.meta.url), root, {
      recursive: true,
    });

    // Resolve the same installed distribution for all entries and generated references.
    const alias = Object.fromEntries(
      ['main', 'preload', 'renderer', 'binding'].map((name) => [
        'vite-plugin-use-ipc/' + name,
        path.join(packageRoot, 'runtime', name + '.js'),
      ]),
    );

    const common = {
      configFile: false,
      root,
      logLevel: 'silent',
      resolve: { alias },
      ssr: { noExternal: true, external: ['electron'] },
    };

    await build({
      ...common,
      plugins: [useIpc({ root, target: 'main' })],
      build: {
        ssr: path.join(root, 'src/main.ts'),
        outDir: 'out',
        emptyOutDir: true,
        minify: true,
        rolldownOptions: {
          external: ['electron'],
          output: {
            format: 'cjs',
            entryFileNames: 'main.cjs',
            chunkFileNames: 'chunks/[name]-[hash].cjs',
          },
        },
      },
    });
    await build({
      ...common,
      build: {
        ssr: path.join(root, 'src/preload.ts'),
        outDir: 'out',
        emptyOutDir: false,
        minify: true,
        rolldownOptions: {
          external: ['electron'],
          output: {
            format: 'cjs',
            entryFileNames: 'preload.cjs',
            codeSplitting: false,
          },
        },
      },
    });
    await build({
      ...common,
      base: './',
      plugins: [useIpc({ root, target: 'renderer' })],
      build: { outDir: 'out/renderer', minify: true },
    });

    async function launch(app, url) {
      const userData = await mkdtemp(path.join(temporary, 'user-data-'));
      await new Promise((resolve, reject) => {
        const env = { ...process.env, IPC_TEST_USER_DATA: userData };
        delete env.ELECTRON_RUN_AS_NODE;

        if (url) env.IPC_TEST_URL = url;

        const child = spawn(require('electron'), [app], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Electron launch timed out\n' + output));
        }, 60_000);

        child.stdout.on('data', (data) => {
          output += data;
        });
        child.stderr.on('data', (data) => {
          output += data;
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);

          if (code === 0 && output.includes('IPC_ELECTRON_OK')) resolve();
          else reject(new Error(`Electron failed (${code})\n${output}`));
        });
      });
    }

    await launch(root);
    console.log('Electron custom-protocol fixture passed');
    server = await createServer({
      ...common,
      plugins: [useIpc({ root, target: 'renderer' })],
      server: {
        host: '127.0.0.1',
        port: 0,
        fs: { allow: [root, packageRoot] },
      },
    });
    await server.listen();
    await launch(root, server.resolvedUrls.local[0] + 'index.html');
    console.log('Electron Vite development fixture passed');
    await server.close();
    server = undefined;
    const archive = path.join(temporary, 'application.asar');
    await createPackage(root, archive);
    await launch(archive);
    console.log('Electron ASAR fixture passed');
  } finally {
    await server?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await electronTests();
