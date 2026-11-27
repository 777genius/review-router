import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSource } from '../../helpers/native-source';

const root = process.cwd();
const lintScript = path.join(root, 'scripts/toolchain/lint.ts');

describe('native qualification boundaries', () => {
  it.each([
    ['unused value', 'const value = 1; export {};', 'no-unused-vars'],
    [
      'type-only use',
      'const value = 1; export type Value = typeof value;',
      'no-unused-vars',
    ],
    ['empty object type', 'export type Value = {};', 'no-empty-object-type'],
    ['legacy var', 'export var value = 1;', 'no-var'],
    [
      'constant loop condition',
      'export function value() { while (true) { break; } }',
      'no-constant-condition',
    ],
    [
      'block-scoped function',
      'export function value(input: boolean) { if (input) { function nested() { return 1; } return nested(); } return 0; }',
      'no-inner-declarations',
    ],
    ['extra semicolon', 'export const value = 1;;', 'no-extra-semi'],
    [
      'mixed indentation',
      'export function value() {\n \treturn 1;\n}',
      'no-mixed-spaces-and-tabs',
    ],
    ['legacy octal', 'export const value = 0123;', 'octal'],
    ['script legacy octal', 'const value = 0123; console.log(value);', 'octal'],
  ])('rejects %s without a classic compiler', (_name, source, diagnostic) => {
    const result = lint(source);
    expect(result.status).toBe(1);
    expect(result.output.toLowerCase()).toContain(diagnostic);
  });

  it('keeps the deliberate explicit-any warning non-blocking', () => {
    const result = lint('export const value: any = 1;');
    expect(result.status).toBe(0);
    expect(result.output).toContain('no-explicit-any');
  });

  it('keeps the existing underscore exception and normal typed control', () => {
    expect(
      lint(
        'export function value(_ignored: string, input: number) { return input; }'
      ).status
    ).toBe(0);
  });

  it('formats TypeScript through the configured parser without changing its AST', () => {
    const source =
      'export const value = {items:["x"] as const} satisfies {readonly items: readonly string[]};';
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/prettier/bin/prettier.cjs',
        '--stdin-filepath',
        path.join(root, 'fixture.ts'),
      ],
      { cwd: root, input: source, encoding: 'utf8', timeout: 15000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe(source);
    const ast = (text: string): string =>
      JSON.stringify(parseSource('fixture.ts', text), (key, value: unknown) =>
        ['start', 'end', 'range', 'raw'].includes(key) ? undefined : value
      );
    expect(ast(result.stdout)).toBe(ast(source));
  });

  it('locks the compiler to native TypeScript 7 without classic API consumers', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    const compilers = Object.entries(lock.packages).filter(([name]) =>
      name.endsWith('/typescript')
    );
    expect(compilers.map(([, data]) => data.version)).toEqual(['7.0.2']);
    expect(
      Object.keys(lock.packages).filter((name) =>
        /\/(?:ts-jest|typescript-estree|ts-api-utils)$|\/@typescript-eslint\/(?:parser|eslint-plugin|type-utils|utils)$/.test(
          name
        )
      )
    ).toEqual([]);
    const result = spawnSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '--version'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('Version 7.0.2');
  });
});

function lint(source: string): { status: number | null; output: string } {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'reviewrouter-native-lint-')
  );
  try {
    const file = path.join(directory, 'fixture.ts');
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [lintScript, file], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
