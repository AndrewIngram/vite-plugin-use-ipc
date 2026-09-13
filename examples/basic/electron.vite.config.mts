import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import useIpc from 'vite-plugin-use-ipc';

const root = fileURLToPath(new URL('.', import.meta.url));

const include = ['src/ipc/**/*.ts'];

export default defineConfig({
  main: {
    plugins: [useIpc({ target: 'main', root, include })],
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: `${root}/src/main.ts`,
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: `${root}/src/preload.ts`,
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root,
    plugins: [useIpc({ target: 'renderer', root, include })],
    build: { rolldownOptions: { input: `${root}/index.html` } },
  },
});
