import type { Node, Program } from 'oxc-parser';

// Jest 29 virtualizes module.createRequire; use Node's supported builtin loader
// to load the parser's native ESM entrypoint without transforming dependencies.
const { parseSync, visitorKeys } = process
  .getBuiltinModule('module')
  .createRequire(__filename)('oxc-parser') as typeof import('oxc-parser');

export function parseSource(filePath: string, text: string): Program {
  const parsed = parseSync(filePath, text);
  if (parsed.errors.length > 0) {
    throw new Error('Architecture fixture parse failed: ' + filePath);
  }
  return parsed.program;
}

export function visitSource(node: Node, inspect: (node: Node) => void): void {
  inspect(node);
  for (const key of visitorKeys[node.type] ?? []) {
    const value: unknown = (node as unknown as Record<string, unknown>)[key];
    const children: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child && typeof child === 'object' && 'type' in child) {
        visitSource(child as Node, inspect);
      }
    }
  }
}
