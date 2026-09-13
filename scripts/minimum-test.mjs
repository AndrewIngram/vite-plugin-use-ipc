import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repository = fileURLToPath(new URL('../', import.meta.url));

const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), 'use-ipc-minimum-')),
);

const manifest = JSON.parse(
  await readFile(path.join(repository, 'package.json'), 'utf8'),
);

let nodeVersion = '22.12.0';

function minimum(range) {
  const version = range.match(/\d+\.\d+\.\d+/)?.[0];

  if (!version) throw new Error(`No minimum version in ${range}`);

  return version;
}

async function pnpm(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      [`--config.use-node-version=${nodeVersion}`, ...args],
      {
        cwd: temporary,
        stdio: 'inherit',
        env: { ...process.env, CI: 'true' },
        shell: process.platform === 'win32',
      },
    );

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} exited with ${code}`));
    });
  });
}

try {
  for (const name of ['src', 'dist', 'tests', 'scripts', 'tsconfig.json'])
    await cp(path.join(repository, name), path.join(temporary, name), {
      recursive: true,
    });

  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies).map(([name, range]) => [
      name,
      minimum(range),
    ]),
  );

  const devDependencies = Object.fromEntries(
    [
      'typescript',
      '@types/node',
      '@jridgewell/trace-mapping',
      '@electron/asar',
    ].map((name) => [name, manifest.devDependencies[name]]),
  );

  await writeFile(
    path.join(temporary, 'package.json'),
    JSON.stringify({
      ...manifest,
      private: true,
      dependencies,
      devDependencies: {
        ...devDependencies,
        vite: minimum(manifest.peerDependencies.vite),
        electron: minimum(manifest.peerDependencies.electron),
      },
    }),
  );
  // Build tools such as ASAR use Node 22; package consumers can use Node 20.
  await pnpm(['install', '--no-frozen-lockfile']);
  await pnpm(['build']);

  for (const range of manifest.engines.node.split('||')) {
    nodeVersion = minimum(range);
    await pnpm([
      'exec',
      'node',
      '-e',
      `require('node:assert/strict').equal(process.versions.node, ${JSON.stringify(nodeVersion)})`,
    ]);
    console.log(`Testing minimum dependencies on Node ${nodeVersion}`);
    await pnpm([
      'exec',
      'node',
      '--test',
      'tests/compiler.test.mjs',
      'tests/errors.test.mjs',
      'tests/runtime.test.mjs',
      'tests/vite.test.mjs',
    ]);
  }

  nodeVersion = '22.12.0';
  await pnpm(['exec', 'node', 'node_modules/electron/install.js']);
  await pnpm(['exec', 'node', 'scripts/electron-test.mjs']);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
