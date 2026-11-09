import { LocalReviewRunRequest, LocalReviewScope, LocalReviewUsageError } from './contracts';

export type LocalReviewCliOptions = {
  request: LocalReviewRunRequest;
  format: 'text' | 'json';
  configFile?: string;
};

/** Parse new explicit CLI options without changing legacy positional syntax. */
export function parseLocalReviewOptions(args: readonly string[]): LocalReviewCliOptions {
  const values = new Map<string, string | boolean>();
  let positional: string | null = null;
  const switches = new Set(['include-untracked', 'preview', 'dry-run']);
  const withValue = new Set(['engine', 'scope', 'base', 'ref', 'format', 'provider', 'model', 'config']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const equal = arg.indexOf('=');
      const key = equal === -1 ? arg.slice(2) : arg.slice(2, equal);
      if (values.has(key)) throw new LocalReviewUsageError(`Duplicate --${key}.`);
      if (switches.has(key)) {
        if (equal !== -1) throw new LocalReviewUsageError(`--${key} does not accept a value.`);
        values.set(key, true);
      } else if (withValue.has(key)) {
        const value = equal !== -1 ? arg.slice(equal + 1) : args[++i];
        if (!value || value.startsWith('--')) throw new LocalReviewUsageError(`Missing value for --${key}.`);
        values.set(key, value);
      } else throw new LocalReviewUsageError(`Unknown review option: --${key}.`);
    } else if (arg.startsWith('-')) throw new LocalReviewUsageError(`Unknown short review option: ${arg}.`);
    else if (positional === null) positional = arg;
    else throw new LocalReviewUsageError('Only one positional revision is allowed.');
  }
  const engine = values.get('engine') ?? 'legacy';
  if (engine !== 'legacy' && engine !== 'ocr') throw new LocalReviewUsageError('--engine must be legacy or ocr.');
  const format = values.get('format') ?? 'text';
  if (format !== 'text' && format !== 'json') throw new LocalReviewUsageError('--format must be text or json.');
  const explicitScope = values.get('scope');
  if (explicitScope && !['worktree', 'branch', 'commit'].includes(String(explicitScope))) {
    throw new LocalReviewUsageError('--scope must be worktree, branch or commit.');
  }
  if (positional && explicitScope) throw new LocalReviewUsageError('Cannot combine a positional revision and --scope.');
  const base = values.get('base');
  const ref = values.get('ref');
  let scope: LocalReviewScope;
  if (positional) {
    if (positional.includes('..')) {
      const parts = positional.split('..');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new LocalReviewUsageError('Invalid Git range.');
      // Explicit native mode uses merge-base, legacy CLI without flags retains old tip semantics.
      scope = { kind: 'branch', base: parts[0] };
      if (parts[1] !== 'HEAD') throw new LocalReviewUsageError('Explicit engine range requires HEAD as its second ref; use checkout first.');
    } else scope = { kind: 'commit', ref: positional };
  } else if (explicitScope === 'branch') {
    if (typeof base !== 'string') throw new LocalReviewUsageError('--scope branch requires --base.');
    scope = { kind: 'branch', base };
  } else if (explicitScope === 'commit') {
    if (typeof ref !== 'string') throw new LocalReviewUsageError('--scope commit requires --ref.');
    scope = { kind: 'commit', ref };
  } else scope = { kind: 'worktree' };
  if ((base && scope.kind !== 'branch') || (ref && scope.kind !== 'commit')) {
    throw new LocalReviewUsageError('--base and --ref must match the selected scope.');
  }
  const includeUntracked = values.has('include-untracked');
  const preview = values.has('preview');
  if (includeUntracked && (engine !== 'ocr' || scope.kind !== 'worktree')) {
    throw new LocalReviewUsageError('--include-untracked is supported only for OCR worktree review.');
  }
  if (preview && engine !== 'ocr') throw new LocalReviewUsageError('--preview requires --engine ocr.');
  if (values.has('dry-run') && engine !== 'legacy') {
    throw new LocalReviewUsageError('--dry-run applies only to legacy GitHub-publication controls, not model billing.');
  }
  if ((values.has('provider') || values.has('model')) && engine !== 'ocr') {
    throw new LocalReviewUsageError('--provider and --model currently apply only to the native OCR engine.');
  }
  if (values.has('config') && engine !== 'legacy') {
    throw new LocalReviewUsageError('--config currently applies only to the legacy engine.');
  }
  return {
    request: { engine, scope, includeUntracked, preview,
      ...(typeof values.get('provider') === 'string' ? { provider: values.get('provider') as string } : {}),
      ...(typeof values.get('model') === 'string' ? { model: values.get('model') as string } : {}),
    },
    format,
    ...(typeof values.get('config') === 'string' ? { configFile: values.get('config') as string } : {}),
  };
}

export function usesExplicitLocalOptions(args: readonly string[]): boolean {
  return args.some(arg => /^(--engine|--scope|--include-untracked|--preview|--format|--base|--ref|--provider|--model)(=|$)/.test(arg));
}

