import { parseSync, transformWithOxc, Visitor, type ESTree } from 'vite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import MagicString from 'magic-string';
import remapping from '@jridgewell/remapping';
import type { Target } from '../runtime/references.js';

export type Export = { name: string; kind: 'function' | 'async-generator' };

export type Compiled = {
  target: Target;
  key: string;
  exports: Export[];
  code: string;
  map: ReturnType<typeof remapping>;
  caller: string;
};

const directives = ['use ipc:main', 'use ipc:renderer'];

const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

function similar(a: string, b: string): boolean {
  if (a.length === b.length) {
    const count = [...a].filter((char, i) => char !== b[i]).length;

    return count > 0 && count <= 2;
  }

  if (Math.abs(a.length - b.length) !== 1) return false;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];

  for (let i = 0; i < long.length; i++)
    if (long.slice(0, i) + long.slice(i + 1) === short) return true;

  return false;
}

function error(
  filename: string,
  node: { start: number },
  message: string,
): never {
  throw new Error(`${filename}:${node.start}: ${message}`);
}

function isStringLiteral(
  node: ESTree.Expression,
): node is ESTree.StringLiteral {
  return node.type === 'Literal' && typeof node.value === 'string';
}

function destination(
  file: ESTree.Program,
  filename: string,
  source: string,
): Target | undefined {
  let target: Target | undefined;
  const prologue = new Set<ESTree.Node>();

  for (const statement of file.body) {
    if (
      statement.type !== 'ExpressionStatement' ||
      !isStringLiteral(statement.expression)
    )
      break;
    prologue.add(statement);
  }

  new Visitor({
    ExpressionStatement(node) {
      let expression = node.expression;
      let wrapped = false;

      while (expression.type === 'ParenthesizedExpression') {
        wrapped = true;
        expression = expression.expression;
      }

      if (!isStringLiteral(expression)) return;
      const text = expression.value;
      const exact = directives.includes(text);

      if (!exact && !directives.some((valid) => similar(text, valid))) return;

      if (!exact)
        error(filename, node, `misspelled directive ${JSON.stringify(text)}`);

      if (wrapped)
        error(filename, node, `wrapped directive ${JSON.stringify(text)}`);

      if (!file.body.includes(node))
        error(
          filename,
          node,
          'Module-level directives required; inline definitions unsupported',
        );

      if (!prologue.has(node))
        error(filename, node, `misplaced directive ${JSON.stringify(text)}`);

      if (source.slice(expression.start + 1, expression.end - 1) !== text)
        error(filename, node, 'Escaped IPC directives are unsupported');
      const next = text === 'use ipc:main' ? 'main' : 'renderer';

      if (target && target !== next)
        error(filename, node, 'An IPC module must have exactly one target');
      target = next;
    },
  }).visit(file);

  return target;
}

function kind(node: ESTree.Node | null): Export['kind'] | undefined {
  if (
    !node ||
    (node.type !== 'FunctionDeclaration' &&
      node.type !== 'FunctionExpression' &&
      node.type !== 'ArrowFunctionExpression') ||
    !node.async
  )
    return;

  return node.generator ? 'async-generator' : 'function';
}

function analyze(file: ESTree.Program, filename: string): Export[] {
  const locals = new Map<string, Export['kind'] | undefined>();

  for (const statement of file.body) {
    const node =
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;

    if (node?.type === 'FunctionDeclaration' && node.id)
      locals.set(node.id.name, kind(node));

    if (node?.type === 'VariableDeclaration')
      for (const declaration of node.declarations) {
        if (declaration.id.type === 'Identifier')
          locals.set(declaration.id.name, kind(declaration.init));
      }
  }

  const exports: Export[] = [];

  const add = (
    node: ESTree.Node,
    name: string,
    value: Export['kind'] | undefined,
  ) => {
    if (!value)
      error(
        filename,
        node,
        `Export ${JSON.stringify(name)} requires a locally declared async function`,
      );
    exports.push({ name, kind: value });
  };

  for (const node of file.body) {
    if (node.type === 'ExportAllDeclaration')
      error(
        filename,
        node,
        'IPC re-export unsupported; locally declared function required',
      );

    if (node.type === 'ExportDefaultDeclaration') {
      add(
        node,
        'default',
        node.declaration.type === 'Identifier'
          ? locals.get(node.declaration.name)
          : kind(node.declaration),
      );
    }

    if (node.type !== 'ExportNamedDeclaration') continue;

    if (node.source)
      error(
        filename,
        node,
        'IPC re-export unsupported; locally declared function required',
      );

    if (node.declaration) {
      const declaration = node.declaration;

      if (declaration.type === 'FunctionDeclaration')
        add(declaration, declaration.id?.name ?? 'default', kind(declaration));
      else if (declaration.type === 'VariableDeclaration') {
        for (const item of declaration.declarations) {
          if (item.id.type !== 'Identifier')
            error(
              filename,
              item,
              'Destructured export requires a locally declared async function',
            );
          add(item, item.id.name, kind(item.init));
        }
      } else
        error(
          filename,
          declaration,
          'Runtime export requires a locally declared async function',
        );
    }

    for (const item of node.specifiers) {
      const name =
        item.exported.type === 'Identifier'
          ? item.exported.name
          : item.exported.value;

      const local =
        item.local.type === 'Identifier' ? item.local.name : item.local.value;

      add(item, name, locals.get(local));
    }
  }

  if (!exports.length)
    error(filename, file, 'At least one async function required');

  return exports;
}

export async function compile(
  source: string,
  filename: string,
  root: string,
  settings: Parameters<typeof transformWithOxc>[2] = {},
): Promise<Compiled | undefined> {
  const original = parseSync(filename, source, {
    sourceType: 'module',
    preserveParens: true,
  });

  const target = destination(original.program, filename, source);

  if (!target) return;

  if (original.errors.length)
    throw new Error(
      `${filename}: ${original.errors.map((error) => error.message).join('; ')}`,
    );

  const lowered = await transformWithOxc(source, filename, {
    ...settings,
    target: 'esnext',
    sourcemap: true,
  });

  const javascript = lowered.code;

  const file = parseSync(filename + '.js', javascript, {
    sourceType: 'module',
  }).program;

  const exports = analyze(file, filename);
  const key = `${digest(path.relative(root, filename).replaceAll('\\', '/'))}:${digest(source)}`;
  const edits = new MagicString(javascript);

  for (const statement of file.body) {
    if (
      statement.type === 'ExpressionStatement' &&
      isStringLiteral(statement.expression) &&
      directives.includes(statement.expression.value)
    )
      edits.remove(statement.start, statement.end);
  }

  const editMap = edits.generateMap({
    hires: true,
    source: filename,
    includeContent: true,
  });

  const map = remapping(
    lowered.map
      ? [editMap.toString(), JSON.stringify(lowered.map)]
      : editMap.toString(),
    () => null,
  );

  map.sources = [filename];

  const caller =
    'import { reference } from "virtual:use-ipc/runtime";\n' +
    exports
      .map(
        (item, index) =>
          `const ref${index} = reference(${JSON.stringify(target)}, ${JSON.stringify(key + ':' + item.name)}, ${JSON.stringify(item.kind)});\nexport { ref${index} as ${JSON.stringify(item.name)} };`,
      )
      .join('\n');

  return { target, key, exports, code: edits.toString(), map, caller };
}
