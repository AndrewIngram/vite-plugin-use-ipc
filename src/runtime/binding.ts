export interface IpcBinding<T> {
  bind(value: T): () => void;
  get(): { readonly value: T; readonly signal: AbortSignal };
}

export function createIpcBinding<T>(name: string): IpcBinding<T> {
  let owner: { value: T; signal: AbortSignal } | undefined;

  return {
    bind(value) {
      if (owner) throw new Error(`${name} is already bound`);
      const controller = new AbortController();
      const lease = { value, signal: controller.signal };
      owner = lease;

      return () => {
        if (owner !== lease) return;
        owner = undefined;
        controller.abort();
      };
    },
    get() {
      if (!owner) throw new Error(`${name} is not bound`);

      return owner;
    },
  };
}
