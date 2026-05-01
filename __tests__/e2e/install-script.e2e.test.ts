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
      REVIEW_ROUTER_NON_INTERACTIVE: '1',
      REVIEW_ROUTER_LOCAL_ONLY: '1',
      REVIEW_ROUTER_SKIP_GH_CHECK: '1',
      REVIEW_ROUTER_REPO: 'test-owner/test-repo',
      REVIEW_ROUTER_WORKDIR: workdir,
      ...env,
    },
    encoding: 'utf-8',
  });

  return {
    ...result,
    workdir,
    workflowPath: path.join(workdir, '.github/workflows/review-router.yml'),
  };
}

function workflowText(workflowPath: string): string {
  return fs.readFileSync(workflowPath, 'utf-8');
}

describe('review-router curl installer e2e', () => {
  it('generates github-actions bot workflow for OpenRouter auth without GitHub App setup', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(result.workflowPath)).toBe(true);

    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('name: ReviewRouter');
    expect(workflow).toContain('uses: 777genius/multi-provider-code-review@v0.3.0-alpha.1');
    expect(result.stdout).toContain('Action ref: 777genius/multi-provider-code-review@v0.3.0-alpha.1');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}');
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '3'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: 'major'");
    expect(workflow).toContain('UPDATE_PR_DESCRIPTION:');
    expect(workflow).toContain("FAIL_ON_CRITICAL: 'true'");
    expect(workflow).toContain("FAIL_ON_MAJOR: 'false'");
    expect(workflow).not.toContain('FAIL_ON_SEVERITY:');
    expect(workflow).not.toContain('CODEX_REASONING_EFFORT');
    expect(workflow).not.toContain('CODEX_MODEL');
    expect(workflow).toContain('REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}');
    expect(workflow).toContain("ENABLE_AST_ANALYSIS: 'false'");
    expect(workflow).toContain("if: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.fork != true }}");
    expect(workflow).not.toContain('actions/create-github-app-token');
    expect(workflow).not.toContain('actions/setup-node');
    expect(workflow).not.toContain('\\${{');
  });

  it('can generate a live main-branch workflow when requested', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_ACTION_REF_MODE: 'main',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: 777genius/multi-provider-code-review@main');
    expect(result.stdout).toContain('Action ref: 777genius/multi-provider-code-review@main');
  });

  it('keeps legacy AI_ROBOT_REVIEW environment aliases working', () => {
    const workdir = makeTempDir('airr-legacy-workdir-');
    const result = spawnSync('bash', [installerPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AI_ROBOT_REVIEW_NON_INTERACTIVE: '1',
        AI_ROBOT_REVIEW_LOCAL_ONLY: '1',
        AI_ROBOT_REVIEW_SKIP_GH_CHECK: '1',
        AI_ROBOT_REVIEW_REPO: 'test-owner/test-repo',
        AI_ROBOT_REVIEW_WORKDIR: workdir,
        AI_ROBOT_REVIEW_IDENTITY: 'actions',
        AI_ROBOT_REVIEW_AUTH: 'openrouter',
        AI_ROBOT_REVIEW_PRESET: 'minimal',
        AI_ROBOT_REVIEW_OPENROUTER_API_KEY: 'or-test-key',
        AI_ROBOT_REVIEW_ACTION_REF_MODE: 'main',
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(path.join(workdir, '.github/workflows/review-router.yml'));
    expect(workflow).toContain('uses: 777genius/multi-provider-code-review@main');
    expect(result.stdout).toContain('ReviewRouter setup complete');
  });

  it('generates GitHub App bot workflow for Codex OAuth auth', () => {
    const codexDir = makeTempDir('airr-codex-');
    const authFile = path.join(codexDir, 'auth.json');
    const configFile = path.join(codexDir, 'config.toml');
    fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'refresh-token' } }));
    fs.writeFileSync(configFile, 'model = "gpt-5.5"\n');

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_AUTH: 'codex',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_SKIP_APP_CREATE: '1',
      REVIEW_ROUTER_CODEX_AUTH_FILE: authFile,
      REVIEW_ROUTER_CODEX_CONFIG_FILE: configFile,
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
    expect(workflow).toContain('CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}');
    expect(workflow).not.toContain('REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}');
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '5'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: 'major'");
    expect(workflow).toContain("CODEX_REASONING_EFFORT: 'medium'");
    expect(workflow).toContain("CODEX_AGENTIC_CONTEXT: 'true'");
    expect(workflow).toContain('UPDATE_PR_DESCRIPTION:');
    expect(workflow).toContain("FAIL_ON_CRITICAL: 'true'");
    expect(workflow).toContain("FAIL_ON_MAJOR: 'false'");
    expect(workflow).not.toContain('FAIL_ON_SEVERITY:');
    expect(workflow).toContain("MIN_CONFIDENCE: '0.6'");
    expect(workflow).toContain("CONSENSUS_REQUIRED_FOR_CRITICAL: 'false'");
    expect(workflow).not.toContain('\\${{');
  });

  it('generates Codex CLI API-key workflow without requiring local OAuth auth', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openai',
      REVIEW_ROUTER_PRESET: 'strict',
      REVIEW_ROUTER_OPENAI_API_KEY: 'sk-test-key',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    expect(workflow).toContain('codex-api-ok');
    expect(workflow).toContain('CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}');
    expect(workflow).not.toContain('REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}');
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '10'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: 'minor'");
    expect(workflow).toContain("FAIL_ON_CRITICAL: 'true'");
    expect(workflow).toContain("FAIL_ON_MAJOR: 'true'");
    expect(workflow).not.toContain('FAIL_ON_SEVERITY:');
    expect(workflow).toContain("CODEX_REASONING_EFFORT: 'high'");
    expect(workflow).toContain("CODEX_AGENTIC_CONTEXT: 'true'");
    expect(workflow).toContain("GRAPH_ENABLED: 'true'");
    expect(workflow).not.toContain('CODEX_AUTH_JSON');
  });

  it('generates blocking preset workflow that fails on major findings', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openai',
      REVIEW_ROUTER_PRESET: 'blocking',
      REVIEW_ROUTER_OPENAI_API_KEY: 'sk-test-key',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '5'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: 'major'");
    expect(workflow).toContain("FAIL_ON_CRITICAL: 'true'");
    expect(workflow).toContain("FAIL_ON_MAJOR: 'true'");
    expect(workflow).toContain("CODEX_REASONING_EFFORT: 'medium'");
    expect(workflow).toContain("GRAPH_ENABLED: 'false'");
  });

  it('stores secrets and variables at org scope for selected repositories only', () => {
    const result = runInstaller({
      REVIEW_ROUTER_SECRET_SCOPE: 'org',
      REVIEW_ROUTER_ORG: 'test-owner',
      REVIEW_ROUTER_ORG_SECRET_REPOS: 'test-repo',
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Secret scope: org test-owner, selected repos: test-repo');
    expect(result.stdout).toContain('gh secret set OPENROUTER_API_KEY --org test-owner --repos test-repo');
    expect(result.stdout).toContain('gh variable set REVIEW_AUTH_MODE --org test-owner --repos test-repo');
    expect(result.stdout).toContain('gh variable set REVIEW_PROVIDERS --org test-owner --repos test-repo');

    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}');
    expect(workflow).toContain('REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}');
    expect(workflow).not.toContain('CODEX_MODEL');
  });

  it('does not open GitHub App manifest flow in dry-run mode', () => {
    const result = runInstaller({
      REVIEW_ROUTER_LOCAL_ONLY: '0',
      REVIEW_ROUTER_DRY_RUN: '1',
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping GitHub App creation in dry-run/local-only/test mode');
    expect(result.stdout).toContain('would clone test-owner/test-repo');
    expect(result.stdout).toContain('would commit .github/workflows/review-router.yml');
  });

  it('rejects invalid Codex OAuth files before writing workflow', () => {
    const codexDir = makeTempDir('airr-bad-codex-');
    const authFile = path.join(codexDir, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'codex',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_CODEX_AUTH_FILE: authFile,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('tokens.refresh_token is missing');
    expect(fs.existsSync(result.workflowPath)).toBe(false);
  });
});
