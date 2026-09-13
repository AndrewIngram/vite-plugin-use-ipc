import { copyFile } from 'node:fs/promises';

await copyFile(
  new URL('../src/env.d.ts', import.meta.url),
  new URL('../dist/env.d.ts', import.meta.url),
);
