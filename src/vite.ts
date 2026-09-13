import { realpathSync, watch, type FSWatcher } from 'node:fs';
import { readFile, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';
import type { Plugin, ViteDevServer, transformWithOxc } from 'vite';
import { compile, type Compiled } from './compiler/compile.js';
import type { Target } from './runtime/references.js';
import { record } from './runtime/protocol.js';

export type { Target };

export interface IpcOptions {
  target: Target;
  root: string;
  include?: string[];
}

const register = '\0virtual:use-ipc/register';

const entryPrefix = '\0virtual:use-ipc/entry/';

const extension = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const declaration = /\.d\.[cm]?ts$/;

function hasIpcLocation(
  value: Partial<Pick<IpcOptions, 'target' | 'root'>> | null | undefined,
): value is Pick<IpcOptions, 'target' | 'root'> {
  return (
    record(value) &&
    (value.target === 'main' || value.target === 'renderer') &&
    typeof value.root === 'string'
  );
}

export default function useIpc(options: IpcOptions): Plugin {
  if (!hasIpcLocation(options))
    throw new TypeError('useIpc requires target and root');
  const root = realpathSync(path.resolve(options.root));

  const include = options.include ?? [
    'src/**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}',
  ];

  let modules = new Map<string, Compiled>();
  let discovered = new Set<string>();
  let discoveryPaths = new Set<string>();
  let settings: Parameters<typeof transformWithOxc>[2] = {};
  let generation = 0;
  let buildWatch = false;
  let outputDirectory = '';
  let cacheDirectory = '';
  let directoryWatcher: FSWatcher | undefined;
  let watchDirectory: string | undefined;
  let sentinel: string | undefined;
  let watchRevision = 0;
  let pendingWatchChanges = Promise.resolve();
  let refresh: Promise<void> | undefined;
  let server: ViteDevServer | undefined;

  async function sourceFiles(): Promise<string[]> {
    return (
      await glob(include, {
        cwd: root,
        absolute: true,
        ignore: ['**/node_modules/**', '**/*.d.ts', '**/*.d.mts', '**/*.d.cts'],
      })
    ).sort();
  }

  async function affectsDiscovery(file: string): Promise<boolean> {
    const contains = (source: string) =>
      source === file || source.startsWith(file + path.sep);

    // Retain deleted paths until the next scan; globbing also finds new files and directories.
    return (
      [...discoveryPaths].some(contains) || (await sourceFiles()).some(contains)
    );
  }

  async function scan(): Promise<void> {
    const current = ++generation;
    const files = await sourceFiles();
    const next = new Map<string, Compiled>();
    const found = new Set<string>();

    for (const file of files) {
      const canonical = await realpath(file);
      found.add(canonical);

      const compiled = await compile(
        await readFile(canonical, 'utf8'),
        canonical,
        root,
        settings,
      );

      if (compiled) next.set(canonical, compiled);
    }

    if (generation === current) {
      modules = next;
      discovered = found;
      // Filesystem events name symlinks, while module identity uses their real targets.
      discoveryPaths = new Set([...files, ...found]);
    }
  }

  function rescan(): Promise<void> {
    refresh = scan();

    return refresh;
  }

  async function canonical(id: string): Promise<string> {
    try {
      return await realpath(id);
    } catch {
      return id;
    }
  }

  async function checkQuery(id: string): Promise<void> {
    const file = await canonical(id.split('?')[0]);

    if (modules.has(file))
      throw new Error(`IPC modules do not support query imports: ${id}`);

    if (extension.test(file) && !file.includes('/node_modules/')) {
      let source: string;

      try {
        source = await readFile(file, 'utf8');
      } catch {
        return;
      }

      if (await compile(source, file, root, settings))
        throw new Error(`IPC modules do not support query imports: ${id}`);
    }
  }

  return {
    name: 'use-ipc',
    enforce: 'pre',
    config() {
      return {
        optimizeDeps: {
          exclude: [
            'vite-plugin-use-ipc',
            'vite-plugin-use-ipc/renderer',
            'vite-plugin-use-ipc/binding',
          ],
        },
        resolve: { dedupe: ['vite-plugin-use-ipc'] },
      };
    },
    configResolved(config) {
      buildWatch = config.command === 'build' && !!config.build.watch;
      outputDirectory = path.resolve(
        realpathSync(config.root),
        config.build.outDir,
      );
      cacheDirectory = path.resolve(
        realpathSync(config.root),
        path.relative(config.root, config.cacheDir),
      );

      if (config.oxc) {
        const {
          include: _include,
          exclude: _exclude,
          jsxInject: _inject,
          jsxRefreshInclude: _refreshInclude,
          jsxRefreshExclude: _refreshExclude,
          ...compatible
        } = config.oxc;

        settings = compatible;
      }
    },
    async buildStart() {
      await rescan();

      for (const file of discovered) this.addWatchFile(file);

      if (buildWatch && !directoryWatcher) {
        watchDirectory = await realpath(
          await mkdtemp(path.join(tmpdir(), 'use-ipc-watch-')),
        );
        sentinel = path.join(watchDirectory, 'discovery');
        await writeFile(sentinel, '0');
        // Rolldown file watching does not reliably report additions to watched directories.
        // Relay only source events so another build's output cannot start a rebuild cycle.
        directoryWatcher = watch(
          root,
          { recursive: true },
          (_event, relative) => {
            if (!relative) return;
            const file = path.resolve(root, relative);

            if (
              [outputDirectory, cacheDirectory].some(
                (directory) =>
                  file === directory || file.startsWith(directory + path.sep),
              ) ||
              /(?:^|[/\\])(?:node_modules|\.git)(?:[/\\]|$)/.test(relative)
            )
              return;
            pendingWatchChanges = pendingWatchChanges
              .then(async () => {
                if (sentinel && (await affectsDiscovery(file)) && sentinel) {
                  await writeFile(sentinel, String(++watchRevision));
                }
              })
              .catch(() => {});
          },
        );
      }

      if (sentinel) this.addWatchFile(sentinel);
    },
    async resolveId(source, importer) {
      if (source === 'virtual:use-ipc/register')
        return { id: register, moduleSideEffects: true };

      if (source === 'virtual:use-ipc/runtime')
        return this.resolve(
          fileURLToPath(new URL('./runtime/references.js', import.meta.url)),
          importer,
          { skipSelf: true },
        );

      if (source.startsWith(entryPrefix)) return source;

      if (source.includes('?') && !source.startsWith('\0')) {
        const resolved = await this.resolve(source, importer, {
          skipSelf: true,
        });

        if (resolved) {
          await refresh;
          await checkQuery(resolved.id);
        }
      }
    },
    async load(id) {
      await refresh;

      if (id === register) {
        if (sentinel) this.addWatchFile(sentinel);

        return {
          code:
            'import { register } from "virtual:use-ipc/runtime";\n' +
            [...modules.values()]
              .filter((module) => module.target === options.target)
              .flatMap((module) =>
                module.exports.map((item) => {
                  const functionId = JSON.stringify(
                    module.key + ':' + item.name,
                  );

                  return `register(${functionId}, () => import(${JSON.stringify(entryPrefix + module.key)}).then(m => m.handlers[${functionId}]));`;
                }),
              )
              .join('\n'),
          moduleSideEffects: true,
        };
      }

      if (id.startsWith(entryPrefix)) {
        const match = [...modules].find(
          ([, module]) => module.key === id.slice(entryPrefix.length),
        );

        if (!match) throw new Error(`Unknown IPC entry: ${id}`);
        const [filename, module] = match;

        return `import * as implementation from ${JSON.stringify(filename)};\nexport const handlers = {${module.exports.map((item) => `[${JSON.stringify(module.key + ':' + item.name)}]: implementation[${JSON.stringify(item.name)}]`).join(',')}};`;
      }

      if (id.includes('?')) {
        await checkQuery(id);

        return;
      }

      if (
        id.startsWith('\0') ||
        id.includes('/node_modules/') ||
        !extension.test(id) ||
        declaration.test(id)
      )
        return;
      const filename = await canonical(id);
      let source: string;

      try {
        source = await readFile(filename, 'utf8');
      } catch {
        return;
      }

      const compiled = await compile(source, filename, root, settings);

      if (!compiled) return;

      if (!discovered.has(filename))
        throw new Error(
          `${filename}: add this module to useIpc.include; both builds must discover it before registry generation`,
        );

      // Replace before Vite records its original source for downstream source maps.
      if (compiled.target !== options.target)
        return { code: compiled.caller, map: null };
    },
    async transform(source, id) {
      if (
        id.startsWith('\0') ||
        id.includes('/node_modules/') ||
        !extension.test(id) ||
        declaration.test(id)
      )
        return;
      await refresh;
      const filename = await canonical(id);
      const compiled = await compile(source, filename, root, settings);

      if (!compiled) return;

      if (!discovered.has(filename))
        throw new Error(
          `${filename}: add this module to useIpc.include; both builds must discover it before registry generation`,
        );

      return compiled.target === options.target
        ? { code: compiled.code, map: compiled.map.toString() }
        : {
            code: compiled.caller,
            map: { version: 3, mappings: '', sources: [], names: [] },
          };
    },
    configureServer(current) {
      server = current;
      current.watcher.add(root);

      const changed = (file: string) => {
        if (
          !file.startsWith(root + path.sep) ||
          file.includes('/node_modules/') ||
          !extension.test(file)
        )
          return;
        void rescan()
          .then(() => {
            for (const module of current.moduleGraph.idToModuleMap.values()) {
              if (module.id === register || module.id?.startsWith(entryPrefix))
                current.moduleGraph.invalidateModule(module);
            }

            current.ws.send({ type: 'full-reload' });
          })
          .catch((error) =>
            current.ws.send({
              type: 'error',
              err: {
                message: String(error),
                stack: error instanceof Error ? (error.stack ?? '') : '',
              },
            }),
          );
      };

      current.watcher
        .on('add', changed)
        .on('change', changed)
        .on('unlink', changed);
      current.httpServer?.once('close', () => {
        current.watcher
          .off('add', changed)
          .off('change', changed)
          .off('unlink', changed);
      });
    },
    async watchChange() {
      if (!server) await rescan();
    },
    async closeWatcher() {
      directoryWatcher?.close();
      directoryWatcher = undefined;
      sentinel = undefined;
      await pendingWatchChanges;

      if (watchDirectory)
        await rm(watchDirectory, { recursive: true, force: true });
      watchDirectory = undefined;
    },
  };
}
