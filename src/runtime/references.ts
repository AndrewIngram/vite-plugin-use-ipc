import type { Handler, Peer } from './peer.js';

export type Target = 'main' | 'renderer';

type Kind = 'function' | 'async-generator';

type Metadata = { target: Target; id: string; kind: Kind };

type Resolver = (target: Target, windowId?: number) => Peer;

const metadata = new WeakMap<Function, Metadata>();

const handlers = new Map<string, () => Promise<Handler>>();

let resolver: Resolver | undefined;

function isHandler(value: unknown): value is Handler {
  return typeof value === 'function';
}

export function register(id: string, load: () => Promise<unknown>): void {
  let cached: Promise<Handler> | undefined;
  handlers.set(
    id,
    () =>
      (cached ??= Promise.resolve()
        .then(load)
        .then((value) => {
          if (!isHandler(value))
            throw new TypeError(`Unknown IPC function: ${id}`);

          return (...args: unknown[]) => value(...args);
        })),
  );
}

export async function lookup(id: string): Promise<Handler> {
  const load = handlers.get(id);

  if (!load) throw new Error(`Unknown IPC function: ${id}`);

  return load();
}

export function configure(next: Resolver): () => void {
  if (resolver) throw new Error('IPC runtime already installed');
  resolver = next;

  return () => {
    if (resolver === next) resolver = undefined;
  };
}

function invoke(info: Metadata, args: unknown[], windowId?: number): unknown {
  if (!resolver) throw new Error('IPC runtime is not installed');
  const peer = resolver(info.target, windowId);

  return info.kind === 'function'
    ? peer.call(info.id, args)
    : peer.iterate(info.id, args);
}

export function reference(target: Target, id: string, kind: Kind): Function {
  const info = { target, id, kind };

  const fn =
    kind === 'function'
      ? async (...args: unknown[]) => invoke(info, args)
      : (...args: unknown[]) => invoke(info, args);

  metadata.set(fn, info);

  return fn;
}

export function invokeRenderer<A extends unknown[], R>(
  window: { webContents: { id: number } },
  fn: (...args: A) => R,
  ...args: A
): R {
  const info = metadata.get(fn);

  if (!info) throw new TypeError('Expected a function transformed by use-ipc');

  // SAFETY: Metadata identifies a compiler-generated reference whose source signature
  // defines R. This relies on the compiler contract, not runtime payload validation.
  return invoke(info, args, window.webContents.id) as R;
}
