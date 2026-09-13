import {
  access,
  mkdtemp,
  mkdir,
  cp,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const exec = promisify(execFile);

const repository = fileURLToPath(new URL('../', import.meta.url));

const temporary = await mkdtemp(path.join(tmpdir(), 'use-ipc-package-'));

async function pnpm(args, cwd) {
  try {
    const result = await exec('pnpm', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    });

    process.stdout.write(result.stdout);
  } catch (error) {
    throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`);
  }
}

try {
  await pnpm(['pack', '--pack-destination', temporary], repository);

  const tarball = (await readdir(temporary)).find((name) =>
    name.endsWith('.tgz'),
  );

  assert.ok(tarball);
  const consumer = path.join(temporary, 'consumer');
  await mkdir(consumer);

  const sourcePackage = JSON.parse(
    await readFile(path.join(repository, 'package.json'), 'utf8'),
  );

  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      name: 'ipc-consumer',
      private: true,
      type: 'module',
      dependencies: {
        'vite-plugin-use-ipc': 'file:' + path.join(temporary, tarball),
        ...sourcePackage.devDependencies,
      },
    }),
  );
  await cp(path.join(repository, '.npmrc'), path.join(consumer, '.npmrc'));
  await pnpm(['install', '--no-frozen-lockfile'], consumer);
  const installed = path.join(consumer, 'node_modules/vite-plugin-use-ipc');

  const manifest = JSON.parse(
    await readFile(path.join(installed, 'package.json'), 'utf8'),
  );

  for (const entry of Object.values(manifest.exports))
    for (const filename of Object.values(entry))
      assert.ok((await readFile(path.join(installed, filename))).length);

  async function audit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'node_modules') continue;
      const filename = path.join(directory, item.name);

      if (item.isDirectory()) await audit(filename);
      else {
        const text = await readFile(filename, 'utf8');
        assert.ok(!text.includes(repository), `Checkout path in ${filename}`);
        assert.doesNotMatch(text, /\/Users\/[a-z][^\s"']*|[A-Z]:\\Users\\/i);

        if (filename.endsWith('.map')) {
          const map = JSON.parse(text);

          for (const [index, source] of map.sources.entries()) {
            if (map.sourcesContent?.[index] != null) {
              assert.match(map.sourcesContent[index], /^[\s\S]*$/);
              continue;
            }

            const target = path.resolve(
              path.dirname(filename),
              map.sourceRoot ?? '',
              source,
            );

            assert.ok(
              target.startsWith(installed + path.sep),
              `Source escapes package: ${target}`,
            );
            await access(target);
          }
        }

        if (filename.endsWith('.md')) {
          for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
            const target = link.split('#')[0];

            if (!target || /^[a-z]+:/i.test(target)) continue;
            await access(path.resolve(path.dirname(filename), target));
          }
        }
      }
    }
  }

  await audit(installed);
  assert.equal(
    manifest.repository.url,
    'git+https://github.com/AndrewIngram/vite-plugin-use-ipc.git',
  );
  assert.equal(
    manifest.homepage,
    'https://github.com/AndrewIngram/vite-plugin-use-ipc#readme',
  );
  assert.equal(
    manifest.bugs.url,
    'https://github.com/AndrewIngram/vite-plugin-use-ipc/issues',
  );
  // pnpm 10 may skip lifecycle scripts. Provision only the declared Electron binary.
  await pnpm(['exec', 'node', 'node_modules/electron/install.js'], consumer);
  await writeFile(
    path.join(consumer, 'types.ts'),
    `import 'virtual:use-ipc/register';
import useIpc, { type Target, type IpcOptions } from 'vite-plugin-use-ipc';
import {installMainIpc,callRenderer,type MainIpc} from 'vite-plugin-use-ipc/main';
import {installIpcPreload} from 'vite-plugin-use-ipc/preload';
import {installRendererIpc} from 'vite-plugin-use-ipc/renderer';
import {createIpcBinding,type IpcBinding} from 'vite-plugin-use-ipc/binding';
const window={webContents:{id:1}};
async function add(a:number,b:number):Promise<number>{return a+b}
const answer:Promise<number>=callRenderer(window,add,1,2);
// @ts-expect-error wrong tuple
callRenderer(window,add,'1',2);
// @ts-expect-error missing argument
callRenderer(window,add,1);
// @ts-expect-error wrong result
const wrong:Promise<string>=callRenderer(window,add,1,2);
async function* stream():AsyncGenerator<number,string,boolean>{const next:boolean=yield 1;return String(next)}
const iterator:AsyncGenerator<number,string,boolean>=callRenderer(window,stream);
iterator.next(true);
// @ts-expect-error wrong next type
iterator.next('bad');
const options:IpcOptions={target:'main',root:'.'}; useIpc(options);
const binding:IpcBinding<number>=createIpcBinding('number');binding.bind(1);
const preload:()=>void=installIpcPreload();const renderer:Promise<()=>void>=installRendererIpc();const main:MainIpc=installMainIpc();
`,
  );
  await writeFile(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ESNext',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        types: ['node', 'vite-plugin-use-ipc/env'],
      },
      include: ['types.ts', 'tests/fixtures/electron/src/**/*.ts'],
    }),
  );
  await cp(
    path.join(repository, 'tests/fixtures'),
    path.join(consumer, 'tests/fixtures'),
    { recursive: true },
  );
  await pnpm(['exec', 'tsc', '-p', 'tsconfig.json'], consumer);
  await mkdir(path.join(consumer, 'scripts'));
  await cp(
    path.join(repository, 'scripts/electron-test.mjs'),
    path.join(consumer, 'scripts/electron-test.mjs'),
  );
  await pnpm(['exec', 'node', 'scripts/electron-test.mjs'], consumer);
  await cp(
    path.join(repository, 'examples/basic'),
    path.join(consumer, 'basic'),
    {
      recursive: true,
      filter: (source) =>
        !source.includes('/node_modules') && !source.includes('/out'),
    },
  );
  await writeFile(
    path.join(consumer, 'basic/package.json'),
    JSON.stringify({
      name: 'ipc-basic-consumer',
      private: true,
      type: 'module',
      main: 'out/main/index.cjs',
    }),
  );
  await pnpm(
    ['exec', 'tsc', '-p', 'tsconfig.json'],
    path.join(consumer, 'basic'),
  );
  await pnpm(['exec', 'electron-vite', 'build'], path.join(consumer, 'basic'));
  console.log(
    'Installed tarball exports, types, audit, Vite, Electron and ASAR checks passed',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
