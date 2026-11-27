import { readdir, readFile } from 'fs/promises';
import path from 'path';
import type { Node } from 'oxc-parser';
import { parseSource, visitSource } from '../../helpers/native-source';

const CONTRACT_ROOTS = Object.freeze([
  path.resolve('src/review-investigation/application'),
  path.resolve('src/review-investigation/domain'),
]);
const FORBIDDEN_LAUNCH_PROPERTIES = new Set([
  'args',
  'command',
  'credentialEnvironment',
  'cwd',
  'executable',
  'providerCredentialEnvironment',
  'runtimeEnvironment',
]);

describe('Review Investigation application boundary', () => {
  it.each([
    ['infrastructure import', "import type { X } from '../infrastructure/x';"],
    ['NodeJS.ProcessEnv', 'export type Env = NodeJS.ProcessEnv;'],
    ['launch property command', 'export interface Port { command: string; }'],
    ['launch property args', 'export type Port = (args: string[]) => void;'],
    ['launch property cwd', "export function run(cwd = 'x') {}"],
    [
      'launch property executable',
      'export class Port { constructor(public executable: string) {} }',
    ],
    [
      'launch property credentialEnvironment',
      'export interface Port { [credentialEnvironment: string]: unknown; }',
    ],
    ['process access', 'export const value = process.env;'],
  ])('rejects %s with the native parser', (reason, source) => {
    expect(inspect('fixture.ts', source)).toEqual([
      expect.stringContaining(reason),
    ]);
  });

  it('does not confuse comments or string data with imports and launch contracts', () => {
    expect(
      inspect(
        'fixture.ts',
        "export const value = 'process.env'; // command: string"
      )
    ).toEqual([]);
  });

  it('rejects unparsable input instead of accepting an empty AST', () => {
    expect(() => inspect('fixture.ts', 'export interface {')).toThrow(
      'Architecture fixture parse failed'
    );
  });

  it('does not expose process launch, environment, auth-injection, or infrastructure details', async () => {
    const violations: string[] = [];

    for (const filePath of await contractFiles()) {
      const sourceText = await readFile(filePath, 'utf8');
      violations.push(...inspect(filePath, sourceText));
    }

    expect(violations).toEqual([]);
  });
});

async function contractFiles(): Promise<readonly string[]> {
  const files = await Promise.all(
    CONTRACT_ROOTS.map(async (root) =>
      (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => path.join(root, entry.name))
    )
  );
  return files.flat().sort();
}

function inspect(filePath: string, sourceText: string): string[] {
  const violations: string[] = [];
  const report = (node: Node, message: string): void => {
    const line = sourceText.slice(0, node.start).split('\n').length;
    violations.push(
      path.relative(process.cwd(), filePath) + ':' + line + ':' + message
    );
  };
  visitSource(parseSource(filePath, sourceText), (node) => {
    if (
      node.type === 'ImportDeclaration' &&
      /(?:^|\/)infrastructure(?:\/|$)/u.test(node.source.value)
    ) {
      report(node, 'infrastructure import');
    }
    if (
      node.type === 'TSTypeReference' &&
      sourceText.slice(node.start, node.end) === 'NodeJS.ProcessEnv'
    ) {
      report(node, 'NodeJS.ProcessEnv');
    }
    if (node.type === 'TSPropertySignature') {
      const name = propertyName(node.key);
      if (FORBIDDEN_LAUNCH_PROPERTIES.has(name)) {
        report(node, 'launch property ' + name);
      }
    }
    const parameters =
      'params' in node
        ? node.params
        : node.type === 'TSIndexSignature'
          ? node.parameters
          : [];
    for (const parameter of parameters) {
      const name = propertyName(parameter);
      if (FORBIDDEN_LAUNCH_PROPERTIES.has(name)) {
        report(parameter, 'launch property ' + name);
      }
    }
    if (
      node.type === 'MemberExpression' &&
      !node.computed &&
      sourceText.slice(node.object.start, node.object.end) === 'process'
    ) {
      report(node, 'process access');
    }
  });
  return violations;
}

function propertyName(node: Node): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value;
  if (node.type === 'AssignmentPattern') return propertyName(node.left);
  if (node.type === 'RestElement') return propertyName(node.argument);
  if (node.type === 'TSParameterProperty') return propertyName(node.parameter);
  return '';
}
