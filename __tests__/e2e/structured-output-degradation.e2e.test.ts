import { spawnSync, SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

type ReviewReport = {
  findings: Array<{ file: string; line: number; title: string }>;
  metrics: {
    providersSuccess: number;
    providersFailed: number;
  };
  runDetails?: {
    providers: Array<{
      name: string;
      status: string;
      errorMessage?: string;
    }>;
  };
};

type FakeProviderLog = {
  model: string;
  attempt: number;
  prompt: string;
  args?: string[];
};

const cliPath = path.join(process.cwd(), 'dist/cli/index.js');

describe('structured-output degradation e2e', () => {
  it('retries invalid JSON and completes when at least one provider succeeds', () => {
    const fixture = createFixture('review-router-json-degraded-', [
      'opencode/success',
      'opencode/invalid',
    ]);

    try {
      const result = runReview(fixture);

      expect(result.status).toBe(0);
      const report = readReviewReport(fixture.dir);
      expect(report.findings).toEqual([
        expect.objectContaining({
          file: 'src/app.ts',
          line: 2,
          title: 'Runtime exception',
        }),
      ]);
      expect(report.metrics.providersSuccess).toBe(1);
      expect(report.metrics.providersFailed).toBe(1);
      expect(report.runDetails?.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'opencode/success',
            status: 'success',
          }),
          expect.objectContaining({
            name: 'opencode/invalid',
            status: 'error',
            errorMessage: expect.stringContaining(
              'returned invalid review JSON'
            ),
          }),
        ])
      );

      const log = readFakeLog(fixture.logPath);
      const invalidAttempts = log.filter(
        (entry) => entry.model === 'opencode/invalid'
      );
      expect(invalidAttempts).toHaveLength(3);
      expect(invalidAttempts[1].prompt).toContain('JSON OUTPUT RETRY NOTICE');
      expect(invalidAttempts[1].prompt).toContain(
        'Return ONLY one valid JSON object'
      );
      expect(invalidAttempts[2].prompt).toContain(
        'previous response was rejected because it did not produce valid ReviewRouter JSON'
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('fails when every provider returns invalid JSON and blocking failure is enabled', () => {
    const fixture = createFixture('review-router-json-all-failed-', [
      'opencode/invalid-a',
      'opencode/invalid-b',
    ]);

    try {
      const result = runReview(fixture);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain('All LLM providers failed during review');
      expect(fs.existsSync(path.join(fixture.dir, 'review-router.json'))).toBe(
        false
      );

      const log = readFakeLog(fixture.logPath);
      expect(
        log.filter((entry) => entry.model.includes('invalid'))
      ).toHaveLength(6);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('does not retry timed-out providers and still completes with a successful provider', () => {
    const fixture = createFixture('review-router-timeout-degraded-', [
      'opencode/success',
      'opencode/timeout',
    ]);

    try {
      const result = runReview(fixture);

      expect(result.status).toBe(0);
      const report = readReviewReport(fixture.dir);
      expect(report.findings).toEqual([
        expect.objectContaining({
          file: 'src/app.ts',
          line: 2,
          title: 'Runtime exception',
        }),
      ]);
      expect(report.metrics.providersSuccess).toBe(1);
      expect(report.metrics.providersFailed).toBe(1);
      expect(report.runDetails?.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'opencode/success',
            status: 'success',
          }),
          expect.objectContaining({
            name: 'opencode/timeout',
            status: 'timeout',
            errorMessage: expect.stringContaining('timed out'),
          }),
        ])
      );

      const log = readFakeLog(fixture.logPath);
      expect(
        log.filter((entry) => entry.model === 'opencode/timeout')
      ).toHaveLength(1);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('exercises public OpenRouter providers through the Codex OpenRouter route', () => {
    const fixture = createFixture(
      'review-router-json-openrouter-degraded-',
      ['openrouter/success', 'openrouter/invalid'],
      'codex'
    );

    try {
      const result = runReview(fixture);

      expect(result.status).toBe(0);
      const report = readReviewReport(fixture.dir);
      expect(report.findings).toEqual([
        expect.objectContaining({
          file: 'src/app.ts',
          line: 2,
          title: 'Runtime exception',
        }),
      ]);
      expect(report.metrics.providersSuccess).toBe(1);
      expect(report.metrics.providersFailed).toBe(1);
      expect(report.runDetails?.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'openrouter/success',
            status: 'success',
          }),
          expect.objectContaining({
            name: 'openrouter/invalid',
            status: 'error',
            errorMessage: expect.stringContaining(
              'returned invalid review JSON'
            ),
          }),
        ])
      );

      const log = readFakeLog(fixture.logPath);
      const invalidAttempts = log.filter((entry) => entry.model === 'invalid');
      expect(invalidAttempts).toHaveLength(3);
      expect(invalidAttempts[0].args).toEqual(
        expect.arrayContaining([
          'model_provider="openrouter"',
          'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
        ])
      );
      expect(invalidAttempts[1].prompt).toContain('JSON OUTPUT RETRY NOTICE');
      expect(invalidAttempts[1].prompt).toContain(
        'Return ONLY one valid JSON object'
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

function createFixture(
  prefix: string,
  providers: string[],
  fakeTool: 'opencode' | 'codex' = 'opencode'
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(dir, 'bin');
  const stateDir = path.join(dir, 'state');
  const logPath = path.join(dir, 'provider-calls.jsonl');
  fs.mkdirSync(binDir);
  fs.mkdirSync(stateDir);
  if (fakeTool === 'codex') {
    writeFakeCodex(path.join(binDir, 'codex'));
  } else {
    writeFakeOpenCode(path.join(binDir, 'opencode'));
  }
  writeConfig(dir, providers);

  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src/app.ts'),
    [
      'export function render(value: string | null): string {',
      '  return value ?? "fallback";',
      '}',
      '',
    ].join('\n')
  );
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.email', 'reviewrouter@example.test']);
  runGit(dir, ['config', 'user.name', 'ReviewRouter E2E']);
  runGit(dir, ['add', 'src/app.ts', '.multi-review.yml']);
  runGit(dir, ['commit', '-m', 'test: initial fixture']);
  fs.writeFileSync(
    path.join(dir, 'src/app.ts'),
    [
      'export function render(value: string | null): string {',
      '  return value.trim();',
      '}',
      '',
    ].join('\n')
  );

  return { dir, binDir, stateDir, logPath, providers };
}

function writeConfig(dir: string, providers: string[]): void {
  fs.writeFileSync(
    path.join(dir, '.multi-review.yml'),
    [
      'providers:',
      ...providers.map((provider) => `  - ${provider}`),
      `synthesis_model: ${providers[0]}`,
      `provider_limit: ${providers.length}`,
      `provider_discovery_limit: ${providers.length}`,
      'provider_retries: 3',
      'provider_max_parallel: 1',
      'provider_selection_strategy: round-robin',
      'run_timeout_seconds: 2',
      'intensity_provider_counts:',
      `  thorough: ${providers.length}`,
      `  standard: ${providers.length}`,
      `  light: ${providers.length}`,
      'intensity_timeouts:',
      '  thorough: 2000',
      '  standard: 2000',
      '  light: 2000',
      'inline_max_comments: 10',
      'inline_min_severity: minor',
      'inline_min_agreement: 1',
      'enable_ast_analysis: false',
      'enable_security: false',
      'enable_caching: false',
      'enable_test_hints: false',
      'enable_ai_detection: false',
      'incremental_enabled: false',
      'analytics_enabled: false',
      'graph_enabled: false',
      'skip_trivial_changes: false',
      'skip_dependency_updates: false',
      'skip_documentation_only: false',
      'skip_test_fixtures: false',
      'skip_config_files: false',
      'skip_build_artifacts: false',
      'dry_run: true',
      '',
    ].join('\n')
  );
}

function writeFakeOpenCode(filePath: string): void {
  fs.writeFileSync(
    filePath,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      '',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) {",
      "  console.log('fake-opencode 0.0.0');",
      '  process.exit(0);',
      '}',
      '',
      "const model = args[args.indexOf('-m') + 1] || '';",
      "const promptPath = args[args.indexOf('--file') + 1];",
      "const prompt = promptPath ? fs.readFileSync(promptPath, 'utf8') : '';",
      'const stateDir = process.env.FAKE_OPENCODE_STATE || process.cwd();',
      'fs.mkdirSync(stateDir, { recursive: true });',
      "const key = model.replace(/[^a-zA-Z0-9_-]/g, '_');",
      "const statePath = path.join(stateDir, key + '.txt');",
      'const attempt = fs.existsSync(statePath)',
      "  ? Number(fs.readFileSync(statePath, 'utf8')) + 1",
      '  : 1;',
      'fs.writeFileSync(statePath, String(attempt));',
      '',
      'if (process.env.FAKE_OPENCODE_LOG) {',
      '  fs.appendFileSync(',
      '    process.env.FAKE_OPENCODE_LOG,',
      "    JSON.stringify({ model, attempt, prompt }) + '\\n'",
      '  );',
      '}',
      '',
      "if (model.includes('success')) {",
      '  console.log(JSON.stringify({',
      '    findings: [{',
      "      file: 'src/app.ts',",
      '      startLine: null,',
      '      line: 2,',
      '      endLine: null,',
      "      severity: 'minor',",
      "      title: 'Runtime exception',",
      "      message: 'The changed line calls trim on value when value is null, so this path will throw at runtime.',",
      '      suggestion: null',
      '    }],',
      '    revalidations: []',
      '  }));',
      '  process.exit(0);',
      '}',
      '',
      "if (model.includes('invalid')) {",
      "  console.log('not valid review json');",
      '  process.exit(0);',
      '}',
      '',
      "if (model.includes('timeout')) {",
      '  setTimeout(() => {}, 10000);',
      '}',
      '',
      'console.log(JSON.stringify({ findings: [], revalidations: [] }));',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
}

function writeFakeCodex(filePath: string): void {
  fs.writeFileSync(
    filePath,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      '',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) {",
      "  console.log('fake-codex 0.0.0');",
      '  process.exit(0);',
      '}',
      '',
      "const model = args[args.indexOf('--model') + 1] || '';",
      "const prompt = fs.readFileSync(0, 'utf8');",
      "const outputPath = args[args.indexOf('--output-last-message') + 1];",
      "const stateDir = path.join(process.cwd(), '.fake-codex-state');",
      'fs.mkdirSync(stateDir, { recursive: true });',
      "const key = model.replace(/[^a-zA-Z0-9_-]/g, '_');",
      "const statePath = path.join(stateDir, key + '.txt');",
      'const attempt = fs.existsSync(statePath)',
      "  ? Number(fs.readFileSync(statePath, 'utf8')) + 1",
      '  : 1;',
      'fs.writeFileSync(statePath, String(attempt));',
      '',
      "const logPath = path.join(process.cwd(), 'provider-calls.jsonl');",
      'if (logPath) {',
      '  fs.appendFileSync(',
      '    logPath,',
      "    JSON.stringify({ model, attempt, prompt, args }) + '\\n'",
      '  );',
      '}',
      '',
      'let output = JSON.stringify({ findings: [], revalidations: [] });',
      "if (model.includes('success')) {",
      '  output = JSON.stringify({',
      '    findings: [{',
      "      file: 'src/app.ts',",
      '      startLine: null,',
      '      line: 2,',
      '      endLine: null,',
      "      severity: 'minor',",
      "      title: 'Runtime exception',",
      "      message: 'The changed line calls trim on value when value is null, so this path will throw at runtime.',",
      '      suggestion: null',
      '    }],',
      '    revalidations: []',
      '  });',
      '}',
      '',
      "if (model.includes('invalid')) {",
      "  output = 'not valid review json';",
      '}',
      '',
      'if (outputPath) {',
      '  fs.writeFileSync(outputPath, output);',
      '}',
      'console.log(output);',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
}

function runReview(fixture: {
  dir: string;
  binDir: string;
  stateDir: string;
  logPath: string;
  providers: string[];
}): SpawnSyncReturns<string> {
  const env = cleanReviewEnv();
  const usesOpenRouter = fixture.providers.some((provider) =>
    provider.startsWith('openrouter/')
  );
  return spawnSync(process.execPath, [cliPath, 'review'], {
    cwd: fixture.dir,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...env,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
      FAKE_OPENCODE_STATE: fixture.stateDir,
      FAKE_OPENCODE_LOG: fixture.logPath,
      ...(usesOpenRouter ? { OPENROUTER_API_KEY: 'test-openrouter-key' } : {}),
      FAIL_ON_NO_HEALTHY_PROVIDERS: 'true',
      REVIEW_ROUTER_PROGRESS_COMMENTS: 'false',
      NO_COLOR: '1',
    },
  });
}

function cleanReviewEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'REVIEW_PROVIDERS',
    'FALLBACK_PROVIDERS',
    'SYNTHESIS_MODEL',
    'PROVIDER_LIMIT',
    'PROVIDER_DISCOVERY_LIMIT',
    'PROVIDER_RETRIES',
    'PROVIDER_MAX_PARALLEL',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'CODEX_AUTH_JSON',
    'CODEX_HOME',
    'FAIL_ON_NO_HEALTHY_PROVIDERS',
    'REPORT_BASENAME',
  ]) {
    delete env[key];
  }
  return env;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
}

function readReviewReport(dir: string): ReviewReport {
  return JSON.parse(
    fs.readFileSync(path.join(dir, 'review-router.json'), 'utf8')
  ) as ReviewReport;
}

function readFakeLog(logPath: string): FakeProviderLog[] {
  return fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeProviderLog);
}
