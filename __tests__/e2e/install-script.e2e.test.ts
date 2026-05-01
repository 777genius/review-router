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
      REVIEW_ROUTER_APP_PROFILE_DIR: path.join(workdir, '.review-router-apps'),
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

function writePrivateKeyFixture(dir: string, name = 'app.private-key.pem'): string {
  const keyFile = path.join(dir, name);
  fs.writeFileSync(
    keyFile,
    [
      '-----BEGIN PRIVATE KEY-----',
      'test-private-key',
      '-----END PRIVATE KEY-----',
      '',
    ].join('\n')
  );
  return keyFile;
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
    expect(workflow).toContain('uses: 777genius/review-router@v1');
    expect(result.stdout).toContain('Action ref: 777genius/review-router@v1');
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
    expect(workflow).toContain('uses: 777genius/review-router@main');
    expect(result.stdout).toContain('Action ref: 777genius/review-router@main');
  });

  it('can generate an exact pinned release workflow when requested', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_ACTION_REF_MODE: 'release',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: 777genius/review-router@v1.0.2');
    expect(result.stdout).toContain('Action ref: 777genius/review-router@v1.0.2');
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
    expect(workflow).toContain('uses: 777genius/review-router@main');
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

  it('imports existing GitHub App credentials manually and saves a local profile', () => {
    const appDir = makeTempDir('airr-manual-app-');
    const privateKeyFile = writePrivateKeyFixture(appDir);
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_APP_SETUP: 'manual',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_APP_CLIENT_ID: 'Iv1.manual-client-id',
      REVIEW_ROUTER_APP_ID: '12345',
      REVIEW_ROUTER_APP_SLUG: 'review-router-manual',
      REVIEW_ROUTER_APP_PRIVATE_KEY_FILE: privateKeyFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Saved GitHub App profile:');
    expect(result.stdout).toContain('Loaded GitHub App profile:');
    expect(result.stdout).toContain('gh secret set REVIEW_APP_PRIVATE_KEY --repo test-owner/test-repo');
    const profilePath = path.join(result.workdir, '.review-router-apps', 'review-router-manual.env');
    const savedKeyPath = path.join(result.workdir, '.review-router-apps', 'review-router-manual.private-key.pem');
    expect(fs.existsSync(profilePath)).toBe(true);
    expect(fs.existsSync(savedKeyPath)).toBe(true);
    expect(fs.readFileSync(profilePath, 'utf-8')).toContain('APP_SLUG=review-router-manual');
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}');
  });

  it('keeps existing GitHub App credential env vars working without explicit app setup mode', () => {
    const appDir = makeTempDir('airr-compat-app-');
    const privateKeyFile = writePrivateKeyFixture(appDir);
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_APP_CLIENT_ID: 'Iv1.compat-client-id',
      REVIEW_ROUTER_APP_ID: '22222',
      REVIEW_ROUTER_APP_SLUG: 'review-router-compat',
      REVIEW_ROUTER_APP_PRIVATE_KEY_FILE: privateKeyFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Saved GitHub App profile:');
    expect(result.stdout).not.toContain('Skipping GitHub App creation in dry-run/local-only/test mode');
    expect(fs.existsSync(path.join(result.workdir, '.review-router-apps', 'review-router-compat.env'))).toBe(true);
  });

  it('reuses a saved GitHub App profile', () => {
    const workdir = makeTempDir('airr-saved-app-workdir-');
    const profileDir = path.join(workdir, '.review-router-apps');
    fs.mkdirSync(profileDir, { recursive: true });
    const privateKeyFile = writePrivateKeyFixture(profileDir, 'saved-router.private-key.pem');
    fs.writeFileSync(
      path.join(profileDir, 'saved-router.env'),
      [
        'APP_ID=98765',
        'APP_CLIENT_ID=Iv1.saved-client-id',
        'APP_SLUG=saved-router',
        'APP_NAME=saved-router',
        `APP_PRIVATE_KEY_FILE=${privateKeyFile}`,
        '',
      ].join('\n')
    );

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_APP_SETUP: 'saved',
      REVIEW_ROUTER_APP_PROFILE: 'saved-router',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    }, workdir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Loaded GitHub App profile: saved-router (saved-router)');
    expect(result.stdout).toContain('gh secret set REVIEW_APP_PRIVATE_KEY --repo test-owner/test-repo');
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain('repositories: test-repo');
  });

  it('requires an explicit saved profile in non-interactive mode when multiple profiles exist', () => {
    const workdir = makeTempDir('airr-multiple-app-workdir-');
    const profileDir = path.join(workdir, '.review-router-apps');
    fs.mkdirSync(profileDir, { recursive: true });
    for (const slug of ['first-router', 'second-router']) {
      const privateKeyFile = writePrivateKeyFixture(profileDir, `${slug}.private-key.pem`);
      fs.writeFileSync(
        path.join(profileDir, `${slug}.env`),
        [
          'APP_ID=98765',
          `APP_CLIENT_ID=Iv1.${slug}`,
          `APP_SLUG=${slug}`,
          `APP_NAME=${slug}`,
          `APP_PRIVATE_KEY_FILE=${privateKeyFile}`,
          '',
        ].join('\n')
      );
    }

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_APP_SETUP: 'saved',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    }, workdir);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('Multiple saved GitHub App profiles found');
    expect(fs.existsSync(result.workflowPath)).toBe(false);
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

  it('fails clearly when saved GitHub App profiles are missing', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_APP_SETUP: 'saved',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('No saved GitHub App profiles found');
    expect(fs.existsSync(result.workflowPath)).toBe(false);
  });

  it('rejects invalid GitHub App private key before writing workflow', () => {
    const appDir = makeTempDir('airr-bad-app-');
    const badKeyFile = path.join(appDir, 'bad.pem');
    fs.writeFileSync(badKeyFile, 'not a pem key');

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_APP_SETUP: 'manual',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_APP_CLIENT_ID: 'Iv1.bad-client-id',
      REVIEW_ROUTER_APP_ID: '12345',
      REVIEW_ROUTER_APP_SLUG: 'bad-router',
      REVIEW_ROUTER_APP_PRIVATE_KEY_FILE: badKeyFile,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('does not look like a PEM private key');
    expect(fs.existsSync(result.workflowPath)).toBe(false);
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
