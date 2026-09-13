import { createIpcBinding } from 'vite-plugin-use-ipc/binding';

export const ready = new Map<number, number>();

export const binding = createIpcBinding<object>('event source');

export let subscriptions = 0;

export let waiting = 0;

export const count = { value: 0 };

export async function* events(signal: AbortSignal) {
  const lease = binding.get();
  const lifetime = AbortSignal.any([signal, lease.signal]);
  let close!: () => void;

  const idle = new Promise<void>((resolve) => {
    close = resolve;
  });

  let closed = false;

  const stop = () => {
    if (closed) return;
    closed = true;
    subscriptions--;
    lifetime.removeEventListener('abort', stop);
    close();
  };

  subscriptions++;
  lifetime.addEventListener('abort', stop, { once: true });

  try {
    yield 'initial';
    waiting++;

    try {
      await idle;
    } finally {
      waiting--;
    }
  } finally {
    stop();
  }
}
