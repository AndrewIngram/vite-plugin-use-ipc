'use ipc:renderer';

import { fixtureError, checkFixtureError } from '../errors';

import {
  richFailure as mainRichFailure,
  watch,
  echo,
  failure,
  increment,
  nodeOperation,
  numbers,
} from './main';

if (typeof document === 'undefined')
  throw new Error('Renderer implementation executed in caller');

export async function setTitle(title: string) {
  document.title = title;

  return document.title;
}

export async function probe() {
  await mainRichFailure().then(() => {
    throw new Error('Expected rich error');
  }, checkFixtureError);
  const buffer = new ArrayBuffer(4);
  new Uint8Array(buffer)[0] = 23;
  const result = await echo(new Map([['buffer', buffer]]));

  if (!(result instanceof Map))
    throw new Error('Echo did not preserve the Map');

  const receivedBuffer = result.get('buffer');

  if (!(receivedBuffer instanceof ArrayBuffer))
    throw new Error('Echo did not preserve the ArrayBuffer');
  let errorName = '';

  try {
    await failure();
  } catch (error) {
    if (error instanceof Error) errorName = error.name;
  }

  const values = [];

  for await (const value of numbers()) values.push(value);

  return {
    value: new Uint8Array(receivedBuffer)[0],
    bytes: buffer.byteLength,
    errorName,
    count: await increment(),
    platform: await nodeOperation(),
    values,
  };
}

export async function* sequence(signal: AbortSignal) {
  yield document.title;
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export async function startIdle() {
  const iterator = watch(new AbortController().signal);
  await iterator.next();
  void iterator.next().catch(() => {});
}

export async function hang() {
  await new Promise(() => {});
}

export async function richFailure() {
  throw fixtureError();
}
