import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../dist/compiler/compile.js';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { pathToFileURL } from 'node:url';
import { pair } from './helpers.mjs';
import { configure } from '../dist/runtime/references.js';

const compileSource = (source, target = 'main', ext = 'ts') =>
  compile(
    `"use ipc:${target}";\n${source}`,
    `/project/src/module.${ext}`,
    '/project',
  );

for (const target of ['main', 'renderer']) {
  for (const [name, source, kind] of [
    ['run', 'export async function run() {}', 'function'],
    ['run', 'export const run = async () => 1', 'function'],
    ['run', 'export const run = async function () {}', 'function'],
    [
      'execute',
      'const run = async () => 1; export {run as execute}',
      'function',
    ],
    ['default', 'export default async function run() {}', 'function'],
    ['default', 'export default async function () {}', 'function'],
    ['default', 'export default async () => 1', 'function'],
    ['default', 'const run = async () => 1; export default run', 'function'],
    [
      'run-job:odd',
      'const run = async () => 1; export {run as "run-job:odd"}',
      'function',
    ],
    ['run', 'export async function* run() {}', 'async-generator'],
    ['default', 'export default async function* () {}', 'async-generator'],
    [
      'execute',
      'async function* run() {}; export {run as execute}',
      'async-generator',
    ],
  ])
    test(`${target}: ${source}`, async () => {
      const compiled = await compileSource(source, target);
      assert.deepEqual(compiled.exports, [{ name, kind }]);
      assert.equal(compiled.target, target);
      assert.ok(
        compiled.caller.includes(JSON.stringify(compiled.key + ':' + name)),
      );
    });
}

for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'mts', 'cjs', 'cts'])
  test(`extension ${ext}`, async () => {
    assert.ok(
      await compileSource('export async function run() {}', 'main', ext),
    );
  });

for (const source of [
  'export function run() {}',
  'export function* run() {}',
  'export const value = 1',
  'export class Value {}',
  'export enum Value { A }',
  'export namespace Value { export const a = 1 }',
  'export const {run} = {run: async () => 1}',
  'export const run = wrap(async () => 1)',
  'export * from "./other"',
  'export {run} from "./other"',
  'export * as things from "./other"',
  'import {run} from "./other"; export {run}',
  'const run = async () => 1; const alias = run; export {alias}',
  'export type Value = string',
])
  test(`reject ${source}`, async () =>
    assert.rejects(compileSource(source), /async function|re-export/));

for (const [source, expected] of [
  [
    'import "x"; "use ipc:main"; export async function run(){}',
    /misplaced directive/,
  ],
  ['("use ipc:main"); export async function run(){}', /wrapped directive/],
  ['async function run(){"use ipc:main"}', /inline/],
  [
    '"use ipc:main"; "use ipc:renderer"; export async function run(){}',
    /exactly one target/,
  ],
  ['"useipc:main";', /misspelled directive/],
  ['"use ipc:maim";', /misspelled directive/],
  ['"use ip:main";', /misspelled directive/],
  ['"use ipc:mainn";', /misspelled directive/],
])
  test(`directive ${source}`, async () =>
    assert.rejects(compile(source, '/a.ts', '/'), expected));

test('data, comments and unrelated directives do not enable IPC', async () => {
  assert.equal(
    await compile(
      '"use client"; const text = "use ipc:maim"; // use ipc:main',
      '/a.ts',
      '/',
    ),
    undefined,
  );
});

test('comments, hashbang, BOM, other directives and erased types', async () => {
  const result = await compile(
    '\ufeff// comment\n"use strict"; "use ipc:main"; export interface Type {}\n export async function run<T>(a:T): Promise<T> {return a}',
    '/a.ts',
    '/',
  );

  assert.deepEqual(result.exports, [{ name: 'run', kind: 'function' }]);
  assert.ok(
    await compile(
      '#!/usr/bin/env node\n"use ipc:main"; export async function run(){}',
      '/a.js',
      '/',
    ),
  );
});

test('identity vector and roots', async () => {
  const source =
    '"use ipc:main"; export async function add(a, b) { return a + b; }\n';

  const first = await compile(source, '/one/src/ipc/calculator.ts', '/one');
  assert.equal(first.key, '11b00b529403b8f2:6f3cee61065efeba');
  assert.equal(
    first.key,
    (
      await compile(source, '/two/src/ipc/calculator.ts', '/two', {
        jsx: { runtime: 'classic' },
      })
    ).key,
  );
  assert.notEqual(
    first.key,
    (await compile(source + '\n', '/one/src/ipc/calculator.ts', '/one')).key,
  );
  assert.notEqual(
    first.key,
    (await compile(source, '/one/src/ipc/renamed.ts', '/one')).key,
  );
});

test('source maps recover original TypeScript throw', async () => {
  const result = await compileSource(
    'export async function run(value: string) {\n  throw new Error(value);\n}',
  );

  const lines = result.code.split('\n');
  const line = lines.findIndex((line) => line.includes('throw'));
  assert.equal(
    originalPositionFor(new TraceMap(result.map), {
      line: line + 1,
      column: lines[line].indexOf('throw'),
    }).line,
    3,
  );
});

test('compiled caller evaluates against compiled destination over MessageChannel', async (t) => {
  const compiled = await compileSource(
    'let count = 0; export async function run(step = 1) { count += step; return count }; export {run as "run-job"}; export async function* sequence(){ yield await run(); }',
  );

  const implementation = await import(
    'data:text/javascript,' + encodeURIComponent(compiled.code)
  );

  const handlers = Object.fromEntries(
    compiled.exports.map((item) => [
      compiled.key + ':' + item.name,
      implementation[item.name],
    ]),
  );

  const { left } = pair(t, handlers);
  const clear = configure(() => left);
  t.after(clear);

  const runtime = pathToFileURL(
    new URL('../dist/runtime/references.js', import.meta.url).pathname,
  ).href;

  const caller = await import(
    'data:text/javascript,' +
      encodeURIComponent(
        compiled.caller.replace('virtual:use-ipc/runtime', runtime),
      )
  );

  assert.equal(await caller.run(2), 2);
  assert.equal(await implementation.run(), 3);
  assert.equal(await caller['run-job'](), 4);
  assert.deepEqual(await caller.sequence().next(), { done: false, value: 5 });
  assert.equal(compiled.caller.includes('let count'), false);
});

test('named default functions support additional local aliases', async () => {
  const compiled = await compileSource(
    'export default async function* run(){yield 1}; export {run as again}',
  );

  assert.deepEqual(compiled.exports, [
    { name: 'default', kind: 'async-generator' },
    { name: 'again', kind: 'async-generator' },
  ]);
});
