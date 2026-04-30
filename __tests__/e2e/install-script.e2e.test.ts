import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const installerPath = path.join(repoRoot, 'scripts/install.sh');

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runInstaller(env: Record<string, string>, workdir = makeTempDir('airr-workdir-')) {
  const result = spawnSync('bash', [installerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AI_ROBOT_REVIEW_NON_INTERACTIVE: '1',
      AI_ROBOT_REVIEW_LOCAL_ONLY: '1',
      AI_ROBOT_REVIEW_SKIP_GH_CHECK: '1',
      AI_ROBOT_REVIEW_REPO: 'test-owner/test-repo',
      AI_ROBOT_REVIEW_WORKDIR: workdir,
      ...env,
    },
    encoding: 'utf-8',
  });

  return {
    ...result,
    workdir,
    workflowPath: path.join(workdir, '.github/workflows/ai-robot-review.yml'),
  };
}

function workflowText(workflowPath: string): string {
  return fs.readFileSync(workflowPath, 'utf-8');
}

describe('ai-robot-review curl installer e2e', () => {
  it('generates github-actions bot workflow for OpenRouter auth without GitHub App setup', () => {
    const result = runInstaller({
      AI_ROBOT_REVIEW_IDENTITY: 'actions',
      AI_ROBOT_REVIEW_AUTH: 'openrouter',
      AI_ROBOT_REVIEW_PRESET: 'minimal',
      AI_ROBOT_REVIEW_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(result.workflowPath)).toBe(true);

    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('name: AI Robot Review');
    expect(workflow).toContain('uses: 777genius/multi-provider-code-review@fix/codex-oauth-exec');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}');
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '3'");
    expect(workflow).toContain("CODEX_REASONING_EFFORT: 'low'");
    expect(workflow).toContain("ENABLE_AST_ANALYSIS: 'false'");
    expect(workflow).toContain("if: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.fork != true }}");
    expect(workflow).not.toContain('actions/create-github-app-token');
    expect(workflow).not.toContain('actions/setup-node');
    expect(workflow).not.toContain('\\${{');
  });

  it('generates GitHub App bot workflow for Codex OAuth auth', () => {
    const codexDir = makeTempDir('airr-codex-');
    const authFile = path.join(codexDir, 'auth.json');
    const configFile = path.join(codexDir, 'config.toml');
    fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'refresh-token' } }));
    fs.writeFileSync(configFile, 'model = "gpt-5.4-mini"\n');

    const result = runInstaller({
      AI_ROBOT_REVIEW_IDENTITY: 'app',
      AI_ROBOT_REVIEW_AUTH: 'codex',
      AI_ROBOT_REVIEW_PRESET: 'safe',
      AI_ROBOT_REVIEW_SKIP_APP_CREATE: '1',
      AI_ROBOT_REVIEW_CODEX_AUTH_FILE: authFile,
      AI_ROBOT_REVIEW_CODEX_CONFIG_FILE: configFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping CODEX_CONFIG_TOML by default');
    expect(result.stdout).not.toContain('gh secret set CODEX_CONFIG_TOML');
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain('client-id: ${{ vars.REVIEW_APP_CLIENT_ID }}');
    expect(workflow).toContain('private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}');
    expect(workflow).toContain('repositories: test-repo');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}');
    expect(workflow).not.toContain('secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain('npm install -g @openai/codex@0.125.0');
    expect(workflow).toContain('CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}');
    expect(workflow).toContain('codex-oauth-ok');
    expect(workflow).toContain("REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}");
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '5'");
    expect(workflow).toContain("CODEX_REASONING_EFFORT: 'medium'");
    expect(workflow).toContain("MIN_CONFIDENCE: '0.6'");
    expect(workflow).toContain("CONSENSUS_REQUIRED_FOR_CRITICAL: 'false'");
    expect(workflow).not.toContain('\\${{');
  });

  it('generates Codex CLI API-key workflow without requiring local OAuth auth', () => {
    const result = runInstaller({
      AI_ROBOT_REVIEW_IDENTITY: 'actions',
      AI_ROBOT_REVIEW_AUTH: 'openai',
      AI_ROBOT_REVIEW_PRESET: 'strict',
      AI_ROBOT_REVIEW_OPENAI_API_KEY: 'sk-test-key',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    expect(workflow).toContain('codex-api-ok');
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '10'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: minor");
    expect(workflow).toContain("CODEX_REASONING_EFFORT: 'high'");
    expect(workflow).toContain("GRAPH_ENABLED: 'true'");
    expect(workflow).not.toContain('CODEX_AUTH_JSON');
  });

  it('does not open GitHub App manifest flow in dry-run mode', () => {
    const result = runInstaller({
      AI_ROBOT_REVIEW_LOCAL_ONLY: '0',
      AI_ROBOT_REVIEW_DRY_RUN: '1',
      AI_ROBOT_REVIEW_IDENTITY: 'app',
      AI_ROBOT_REVIEW_AUTH: 'openrouter',
      AI_ROBOT_REVIEW_PRESET: 'safe',
      AI_ROBOT_REVIEW_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping GitHub App creation in dry-run/local-only/test mode');
    expect(result.stdout).toContain('would clone test-owner/test-repo');
    expect(result.stdout).toContain('would commit .github/workflows/ai-robot-review.yml');
  });

  it('rejects invalid Codex OAuth files before writing workflow', () => {
    const codexDir = makeTempDir('airr-bad-codex-');
    const authFile = path.join(codexDir, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));

    const result = runInstaller({
      AI_ROBOT_REVIEW_IDENTITY: 'actions',
      AI_ROBOT_REVIEW_AUTH: 'codex',
      AI_ROBOT_REVIEW_PRESET: 'safe',
      AI_ROBOT_REVIEW_CODEX_AUTH_FILE: authFile,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('tokens.refresh_token is missing');
    expect(fs.existsSync(result.workflowPath)).toBe(false);
  });
});
