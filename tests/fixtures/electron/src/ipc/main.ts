'use ipc:main';

import { fixtureError } from '../errors';

import { platform } from 'node:os';
import { ready, count, events } from '../state';

if (typeof process === 'undefined' || process.type !== 'browser')
  throw new Error('Main implementation executed in caller');

export async function announce(slot: number) {
  ready.set(slot, (ready.get(slot) ?? 0) + 1);
}

export async function increment(step = 1) {
  return (count.value += step);
}

export async function nodeOperation() {
  return platform();
}

export async function echo<T>(value: T) {
  return value;
}

export async function failure() {
  throw new TypeError('remote failure');
}

export async function* numbers() {
  yield 1;
  yield 2;

  return 3;
}

export async function* watch(signal: AbortSignal) {
  yield* events(signal);
}

export async function richFailure() {
  throw fixtureError();
}
