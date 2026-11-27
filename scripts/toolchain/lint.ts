import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requested = process.argv.slice(2);
const files =
  requested.length > 0
    ? requested.map((file) => path.resolve(root, file))
    : [
        ...[
          'src',
          '__tests__',
          'scripts/toolchain',
          'scripts/native-ocr',
        ].flatMap((directory) => collect(path.join(root, directory))),
        path.join(root, 'jest.setup.ts'),
      ];
files.sort();

// Preserve the original ESLint parser's module mode, including strict syntax
// in TypeScript files that have no import or export declarations.
let syntaxErrors = 0;
for (const file of files) {
  const parsed = parseSync(file, readFileSync(file, 'utf8'), {
    sourceType: 'module',
    showSemanticErrors: true,
  });
  for (const error of parsed.errors) {
    console.error(path.relative(root, file) + ': ' + error.message);
    syntaxErrors += 1;
  }
}
if (syntaxErrors > 0) process.exit(1);

const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/oxlint/bin/oxlint'), '--no-ignore', ...files],
  { cwd: root, stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

function collect(directory: string): string[] {
  if (!existsSync(directory))
    throw new Error('Missing lint source: ' + directory);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(child);
    return entry.isFile() && entry.name.endsWith('.ts') ? [child] : [];
  });
}
