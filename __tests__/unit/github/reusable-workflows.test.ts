import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../../..');

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
}

type WorkflowJob = {
  name?: string;
  env?: Record<string, unknown>;
  permissions?: Record<string, string>;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  steps?: Array<{
    name?: string;
    env?: Record<string, unknown>;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  }>;
};

type WorkflowDocument = {
  permissions?: Record<string, string>;
  on?: {
    issue_comment?: { types?: string[] };
    pull_request_review_comment?: { types?: string[] };
    workflow_dispatch?: unknown;
    workflow_call?: {
      inputs?: Record<string, { default?: unknown }>;
      secrets?: Record<string, { required?: boolean }>;
    };
  };
  jobs?: Record<string, WorkflowJob>;
};

function parseWorkflow(filePath: string): WorkflowDocument {
  return yaml.load(readRepoFile(filePath), {
    schema: yaml.JSON_SCHEMA,
  }) as WorkflowDocument;
}

function traceSecretEnvBindings(
  workflow: WorkflowDocument,
  secretName: string
): Array<{
  job: string;
  step: string;
  environmentVariable: string;
  value: string;
}> {
  const secretReference = `secrets.${secretName}`;
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobName, job]) =>
    (job.steps ?? []).flatMap((step) =>
      Object.entries(step.env ?? {})
        .filter(
          (binding): binding is [string, string] =>
            typeof binding[1] === 'string' &&
            binding[1].includes(secretReference)
        )
        .map(([environmentVariable, value]) => ({
          job: jobName,
          step: step.name ?? '<unnamed>',
          environmentVariable,
          value,
        }))
    )
  );
}

function permissionEscalations(
  callerPermissions: Record<string, string>,
  calledPermissions: Record<string, string>
): string[] {
  const ranks: Record<string, number> = { none: 0, read: 1, write: 2 };
  return Object.entries(calledPermissions).flatMap(([scope, requested]) => {
    const granted = callerPermissions[scope] ?? 'none';
    return (ranks[requested] ?? Number.POSITIVE_INFINITY) >
      (ranks[granted] ?? Number.NEGATIVE_INFINITY)
      ? [`${scope}: ${granted} -> ${requested}`]
      : [];
  });
}

function runInteractionRuntimePreparation(
  reviewWorkflowFile: string,
  discussionAuthMode = ''
) {
  const workflow = readRepoFile(
    '.github/workflows/reviewrouter-interaction-reusable.yml'
  );
  const scriptMatch = workflow.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/u);
  if (!scriptMatch) {
    throw new Error('Interaction runtime preparation script not found');
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'reviewrouter-interaction-workflow-')
  );
  try {
    const githubEnv = path.join(tempDir, 'github-env');
    const githubOutput = path.join(tempDir, 'github-output');
    fs.writeFileSync(githubEnv, '');
    fs.writeFileSync(githubOutput, '');

    const result = spawnSync(process.execPath, ['-e', scriptMatch[1]], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RR_RUNTIME_REF: '0123456789abcdef0123456789abcdef01234567',
        RR_REVIEW_WORKFLOW_FILE: reviewWorkflowFile,
        RR_DISCUSSION_AUTH_MODE: discussionAuthMode,
        REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
        REVIEW_APP_PRIVATE_KEY_PRESENT: '0',
        RR_REVIEW_APP_CLIENT_ID: '',
        GITHUB_ENV: githubEnv,
        GITHUB_OUTPUT: githubOutput,
      },
    });

    const githubEnvContents = fs.readFileSync(githubEnv, 'utf8');
    return { ...result, githubEnvContents };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('production reusable workflows', () => {
  it.each(['', 'codex-oauth', 'openai-api', 'mimo-token-plan-api'])(
    'validates the explicit discussion backend %s before checkout',
    (authMode) => {
      const result = runInteractionRuntimePreparation(
        'reviewrouter.yml',
        authMode
      );
      expect(result.status).toBe(0);
      const workflow = parseWorkflow(
        '.github/workflows/reviewrouter-interaction-reusable.yml'
      );
      expect(
        workflow.on?.workflow_call?.inputs?.discussion_auth_mode?.default
      ).toBe('');
      const runStep = workflow.jobs?.interaction?.steps?.find(
        (step) => step.name === 'Run ReviewRouter interaction'
      );
      expect(runStep?.env?.REVIEW_AUTH_MODE).toBe(
        '${{ inputs.discussion_auth_mode }}'
      );
      const restoreStep = workflow.jobs?.interaction?.steps?.find(
        (step) =>
          step.name === 'Restore Codex subscription auth for discussion replies'
      );
      expect(restoreStep?.if).toContain(
        "steps.preflight.outputs.discussion_auth_mode == 'codex-oauth'"
      );
      expect(
        workflow.on?.workflow_call?.inputs?.discussion_model?.default
      ).toBe('');
      const preflightStep = workflow.jobs?.interaction?.steps?.find(
        (step) => step.name === 'Preflight ReviewRouter interaction'
      );
      expect(preflightStep?.env?.REVIEW_AUTH_MODE).toBe(
        '${{ inputs.discussion_auth_mode }}'
      );
    }
  );

  it.each([
    'fallback-anywhere',
    ' mimo-token-plan-api ',
    'mimo-token-plan-api\nINJECTED=true',
  ])(
    'rejects an unknown discussion backend %j before runtime checkout',
    (authMode) => {
      const result = runInteractionRuntimePreparation(
        'reviewrouter.yml',
        authMode
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid discussion_auth_mode');
      expect(result.githubEnvContents).toBe('');
    }
  );

  it('distinguishes same-repository PRs when the repository itself is a fork', () => {
    const workflowSource = readRepoFile('.github/workflows/reviewrouter.yml');

    expect(workflowSource).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository'
    );
    expect(workflowSource).not.toContain(
      'github.event.pull_request.head.repo.fork'
    );
  });

  it('ships every runtime bundle required by the immutable action checkout', () => {
    const contextGatewayBundle = 'dist/context-gateway.js';

    expect(fs.existsSync(path.join(repoRoot, contextGatewayBundle))).toBe(true);
    expect(
      execFileSync(
        'git',
        ['ls-files', '--error-unmatch', contextGatewayBundle],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        }
      ).trim()
    ).toBe(contextGatewayBundle);
  });

  it('exposes a dedicated read-only T0 reusable entrypoint', () => {
    const workflowPath = '.github/workflows/reviewrouter-t0-reusable.yml';
    const workflowSource = readRepoFile(workflowPath);
    const workflow = parseWorkflow(workflowPath);
    const review = workflow.jobs?.['repository-secret-review'];
    const hostedPoolReview = workflow.jobs?.['review-hosted-pool'];
    const inputs = workflow.on?.workflow_call?.inputs;

    expect(review?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(review?.uses).toBe(
      './.github/workflows/reviewrouter-execution-reusable.yml'
    );
    expect(review?.with?.review_action_lane).toBe('t0');
    expect(review?.with).toHaveProperty('runtime_ref');
    expect(review?.with?.api_url).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(review?.with?.control_plane_url).toBe(
      '${{ inputs.control_plane_url }}'
    );
    expect(review?.with).toHaveProperty('review_head_sha');
    expect(review?.with).toHaveProperty('provider_instance_id');
    expect(inputs?.codex_session_mode?.default).toBe('');
    expect(inputs?.session_binding_id?.default).toBe('');
    expect(inputs?.session_binding_version?.default).toBe(0);
    expect(review?.if).toContain(
      "inputs.codex_session_mode != 'codex_subscription_oauth_hosted_pool'"
    );
    expect(review?.with).toMatchObject({
      codex_session_mode: '${{ inputs.codex_session_mode }}',
      session_binding_id: '${{ inputs.session_binding_id }}',
      session_binding_version: '${{ inputs.session_binding_version }}',
    });
    expect(review?.secrets).toHaveProperty('CODEX_AUTH_JSON');
    expect(hostedPoolReview?.if).toContain(
      "inputs.codex_session_mode == 'codex_subscription_oauth_hosted_pool'"
    );
    expect(hostedPoolReview?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(hostedPoolReview?.with).toMatchObject({
      review_action_lane: 't0',
      codex_session_mode: '${{ inputs.codex_session_mode }}',
      session_binding_id: '${{ inputs.session_binding_id }}',
      session_binding_version: '${{ inputs.session_binding_version }}',
    });
    expect(hostedPoolReview?.secrets).toBeUndefined();
    expect(review?.name).toBe('repository-secret-review');
    expect(hostedPoolReview?.name).toBe('review');
    expect(workflowSource).not.toContain('pull-requests: write');
    expect(workflowSource).not.toContain('issues: write');
    expect(workflowSource).not.toContain('REVIEW_APP_PRIVATE_KEY');
    expect(workflowSource).not.toContain(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
  });

  it('routes T0 through a read-only job without SCM mutation secrets', () => {
    const workflow = parseWorkflow(
      '.github/workflows/reviewrouter-reusable.yml'
    );
    const inputs = workflow.on?.workflow_call?.inputs;
    const t0 = workflow.jobs?.['review-t0'];
    const legacy = workflow.jobs?.['review-legacy'];

    expect(inputs?.review_action_v2_mode?.default).toBe('disabled');
    expect(inputs?.control_plane_url?.default).toBe('');
    expect(inputs?.workflow_schema_version?.default).toBe(1);
    expect(inputs?.review_drafts?.default).toBe(false);
    expect(inputs?.max_changed_lines?.default).toBe('0');
    expect(t0?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(t0?.uses).toBe(
      './.github/workflows/reviewrouter-execution-reusable.yml'
    );
    expect(t0?.with?.review_action_lane).toBe('t0');
    expect(t0?.with?.api_url).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(t0?.with?.control_plane_url).toBe('${{ inputs.control_plane_url }}');
    expect(t0?.with).toHaveProperty('provider_instance_id');
    expect(t0?.with).toHaveProperty('workflow_schema_version');
    expect(t0?.with).toHaveProperty('max_changed_lines');
    expect(t0?.if).toContain("inputs.review_action_v2_mode == 't0'");
    expect(t0?.secrets).not.toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
    expect(t0?.secrets).not.toHaveProperty('REVIEW_APP_PRIVATE_KEY');
    expect(t0?.secrets).not.toHaveProperty('GITHUB_TOKEN');

    expect(legacy?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
      'id-token': 'write',
    });
    expect(legacy?.with?.review_action_lane).toBe('legacy');
    expect(legacy?.with?.api_url).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(legacy?.with?.control_plane_url).toBe(
      '${{ inputs.control_plane_url }}'
    );
    expect(legacy?.if).toContain("inputs.review_action_v2_mode == 'disabled'");
    expect(legacy?.secrets).toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
    expect(legacy?.secrets).toHaveProperty('REVIEW_APP_PRIVATE_KEY');
  });

  it.each([
    [
      'interaction',
      'Run ReviewRouter interaction',
      'Install Codex CLI for discussion replies',
    ],
    ['conflict', 'Run conflict review runtime', 'Install Codex CLI'],
  ])(
    'passes the MiMo secret only to the %s execution boundary',
    (kind, runStepName, installStepName) => {
      const workflow = parseWorkflow(
        `.github/workflows/reviewrouter-${kind}-reusable.yml`
      );
      const secretName = 'MIMO_TOKEN_PLAN_API_KEY';
      const jobName =
        kind === 'interaction' ? 'interaction' : 'conflict-review';
      const job = workflow.jobs?.[jobName];
      expect(workflow.on?.workflow_call?.secrets?.[secretName]).toEqual({
        required: false,
      });
      expect(workflow.on?.workflow_call?.inputs).not.toHaveProperty(secretName);
      expect(job?.env).not.toHaveProperty(secretName);
      expect(traceSecretEnvBindings(workflow, secretName)).toEqual([
        {
          job: jobName,
          step: runStepName,
          environmentVariable: secretName,
          value: '${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}',
        },
      ]);
      expect(job?.env?.MIMO_TOKEN_PLAN_API_KEY_PRESENT).toBe(
        "${{ secrets.MIMO_TOKEN_PLAN_API_KEY != '' && '1' || '0' }}"
      );
      expect(
        job?.steps?.find((step) => step.name === installStepName)?.if
      ).toContain("env.MIMO_TOKEN_PLAN_API_KEY_PRESENT == '1'");
    }
  );

  it('traces the MiMo token secret through the legacy-only workflow contract', () => {
    const secretName = 'MIMO_TOKEN_PLAN_API_KEY';
    const secretExpression = '${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}';
    const parentWorkflow = parseWorkflow(
      '.github/workflows/reviewrouter-reusable.yml'
    );
    const childWorkflow = parseWorkflow(
      '.github/workflows/reviewrouter-execution-reusable.yml'
    );
    const parentInputs = parentWorkflow.jobs?.['review-legacy']?.with ?? {};
    const childSteps = childWorkflow.jobs?.review?.steps ?? [];
    const legacyRun = childSteps.find(
      (step) => step.name === 'Run ReviewRouter legacy'
    );
    const t0Run = childSteps.find(
      (step) => step.name === 'Run ReviewRouter T0'
    );
    const hostedPoolRun = childSteps.find(
      (step) => step.name === 'Run ReviewRouter T0 hosted pool'
    );

    expect(parentWorkflow.on?.workflow_call?.secrets?.[secretName]).toEqual({
      required: false,
    });
    expect(childWorkflow.on?.workflow_call?.secrets?.[secretName]).toEqual({
      required: false,
    });
    expect(parentWorkflow.jobs?.['review-legacy']?.secrets?.[secretName]).toBe(
      secretExpression
    );
    expect(parentWorkflow.jobs?.['review-t0']?.secrets).not.toHaveProperty(
      secretName
    );
    expect(
      Object.values(parentInputs).some((value) =>
        String(value).includes(secretName)
      )
    ).toBe(false);
    expect(parentWorkflow.on?.workflow_call?.inputs).not.toHaveProperty(
      secretName
    );
    expect(childWorkflow.on?.workflow_call?.inputs).not.toHaveProperty(
      secretName
    );
    expect(childWorkflow.jobs?.review?.env).not.toHaveProperty(secretName);
    expect(traceSecretEnvBindings(childWorkflow, secretName)).toEqual([
      {
        job: 'review',
        step: 'Run ReviewRouter legacy',
        environmentVariable: secretName,
        value: secretExpression,
      },
    ]);
    expect(legacyRun?.env?.[secretName]).toBe(secretExpression);
    expect(t0Run?.env).not.toHaveProperty(secretName);
    expect(hostedPoolRun?.env).not.toHaveProperty(secretName);
  });

  it('uses only the provider preflight for the parsed Codex install condition', () => {
    const workflowPath =
      '.github/workflows/reviewrouter-execution-reusable.yml';
    const workflowSource = readRepoFile(workflowPath);
    const workflow = parseWorkflow(workflowPath);
    const codexInstall = workflow.jobs?.review?.steps?.find(
      (step) => step.name === 'Install Codex CLI'
    );

    expect(codexInstall?.if).toBe(
      "${{ steps.runtime.outputs.can_run == 'true' && steps.provider-tooling.outputs.codex_cli_needed == 'true' }}"
    );
    expect(workflow.jobs?.review?.env).not.toHaveProperty(
      'MIMO_TOKEN_PLAN_API_KEY_PRESENT'
    );
    expect(workflowSource).not.toContain('MIMO_TOKEN_PLAN_API_KEY_PRESENT');
  });

  it('keeps the shared execution workflow sandbox-safe in both lanes', () => {
    const workflowPath =
      '.github/workflows/reviewrouter-execution-reusable.yml';
    const workflowSource = readRepoFile(workflowPath);
    const workflow = parseWorkflow(workflowPath);
    const inputs = workflow.on?.workflow_call?.inputs;
    const steps = workflow.jobs?.review?.steps ?? [];
    const runtimePreparation = steps.find(
      (step) => step.name === 'Prepare ReviewRouter runtime settings'
    );
    const t0Run = steps.find((step) => step.name === 'Run ReviewRouter T0');
    const hostedPoolRun = steps.find(
      (step) => step.name === 'Run ReviewRouter T0 hosted pool'
    );
    const hostedPoolCheckout = steps.find(
      (step) => step.name === 'Checkout exact hosted pool review revision'
    );
    const legacyRun = steps.find(
      (step) => step.name === 'Run ReviewRouter legacy'
    );
    const codexInstall = steps.find(
      (step) => step.name === 'Install Codex CLI'
    );
    const codexAuthRestore = steps.find(
      (step) => step.name === 'Restore Codex subscription auth'
    );
    const externalActionUses = steps
      .map((step) => step.uses)
      .filter((value): value is string =>
        Boolean(value && !value.startsWith('./'))
      );

    expect(workflowSource).toContain('workflow_call:');
    expect(workflowSource).toContain('runtime_ref:');
    expect(inputs?.control_plane_url?.default).toBe('');
    expect(inputs?.codex_session_mode?.default).toBe('');
    expect(inputs?.session_binding_id?.default).toBe('');
    expect(inputs?.session_binding_version?.default).toBe(0);
    expect(workflow.jobs?.review?.env?.REVIEWROUTER_API_URL).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(workflow.jobs?.review?.env?.REVIEWROUTER_CONTROL_PLANE_URL).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(workflowSource).toContain(
      'repository: ${{ steps.runtime.outputs.runtime_repository }}'
    );
    expect(workflowSource).toContain(
      'ref: ${{ steps.runtime.outputs.runtime_ref }}'
    );
    expect(workflowSource).toContain(
      'RR_WORKFLOW_REPOSITORY: ${{ job.workflow_repository }}'
    );
    expect(workflowSource).toContain(
      'RR_WORKFLOW_SHA: ${{ job.workflow_sha }}'
    );
    expect(workflow.jobs?.review?.env).not.toHaveProperty(
      'RR_WORKFLOW_REPOSITORY'
    );
    expect(workflow.jobs?.review?.env).not.toHaveProperty('RR_WORKFLOW_SHA');
    expect(runtimePreparation?.env).toMatchObject({
      GITHUB_HEAD_REPO_FULL_NAME:
        "${{ github.event.pull_request.head.repo.full_name || '' }}",
      GITHUB_REPOSITORY_PRIVATE:
        "${{ github.event.repository.private == true && 'true' || 'false' }}",
      RR_WORKFLOW_REPOSITORY: '${{ job.workflow_repository }}',
      RR_WORKFLOW_SHA: '${{ job.workflow_sha }}',
      RR_REVIEW_TIMEOUT_MINUTES: '${{ inputs.review_timeout_minutes }}',
    });
    expect(workflowSource).toContain("eventName === 'merge_group'");
    expect(workflowSource).toContain("isMergeGroup ? 'merge_group'");
    expect(workflowSource).toContain('ReviewRouter merge queue check passed');
    expect(workflowSource).toContain('path: .reviewrouter-runtime');
    expect(workflowSource).toContain('persist-credentials: false');
    expect(
      externalActionUses.some((value) =>
        value.startsWith('actions/setup-node@')
      )
    ).toBe(true);
    expect(workflowSource).toContain("node-version: '24'");
    expect(workflowSource).toContain(
      'Resolve ReviewRouter runtime provider tooling'
    );
    expect(workflow.jobs?.review?.env).toMatchObject({
      RR_CODEX_SESSION_MODE: '${{ inputs.codex_session_mode }}',
      RR_SESSION_BINDING_ID: '${{ inputs.session_binding_id }}',
      RR_SESSION_BINDING_VERSION: '${{ inputs.session_binding_version }}',
    });
    expect(workflowSource).toContain("fail('Invalid codex_session_mode.');");
    expect(workflowSource).toContain(
      "fail('session_binding_id is required for hosted pool execution.');"
    );
    expect(workflowSource).toContain(
      "fail('session_binding_version must be a positive integer for hosted pool execution.');"
    );
    expect(workflowSource).toContain(
      "fail('Hosted pool execution requires pull_request.');"
    );
    expect(workflowSource).not.toContain(
      "fail('Hosted pool execution requires a private repository.');"
    );
    expect(workflowSource).toContain(
      "fail('Hosted pool execution requires a same-repository pull request.');"
    );
    expect(workflowSource).toContain('REVIEW_ROUTER_MODE: runtime-preflight');
    expect(workflowSource).toContain(
      "steps.provider-tooling.outputs.codex_cli_needed == 'true'"
    );
    expect(workflowSource).toContain(
      "steps.provider-tooling.outputs.codex_oauth_needed == 'true'"
    );
    expect(workflowSource).toContain(
      "steps.provider-tooling.outputs.claude_cli_needed == 'true'"
    );
    expect(workflowSource).toContain('review_app_client_id:');
    expect(workflowSource).toContain('REVIEW_APP_PRIVATE_KEY:');
    expect(
      externalActionUses.some((value) =>
        value.startsWith('actions/create-github-app-token@')
      )
    ).toBe(true);
    for (const actionUses of externalActionUses) {
      expect(actionUses).toMatch(/@[0-9a-f]{40}$/u);
    }
    expect(workflowSource).toContain("const crypto = require('node:crypto');");
    expect(workflowSource).toContain(
      "staticEnv.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';"
    );
    expect(workflowSource).toContain('staticRuntimeEnvAllowlist');
    expect(workflowSource).toContain("['TARGET_TOKENS_PER_BATCH']");
    expect(workflowSource).toContain('isSecretLikeStaticRuntimeEnvKey(key)');
    expect(workflowSource).toContain("key === 'REVIEWROUTER_ACTION_V2_MODE'");
    expect(workflowSource).toContain(
      "key === 'REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS'"
    );
    expect(workflowSource).toContain(
      "appendEnv(\n            'REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS'"
    );
    expect(workflowSource).toContain('npm install -g @openai/codex@0.147.0');
    expect(workflowSource).toContain(
      'curl -fsSL https://claude.ai/install.sh | bash'
    );
    expect(workflowSource).toContain(
      'node .reviewrouter-runtime/dist/index.js'
    );
    expect(workflowSource).toContain('REVIEW_ROUTER_LEDGER_KEY');
    expect(workflowSource).toContain('CODEX_AUTH_JSON');
    expect(workflowSource).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(workflowSource).toContain('OPENROUTER_API_KEY');
    expect(workflowSource).toContain('REVIEW_ROUTER_MEMORY_ENABLED');
    expect(workflowSource).toContain('REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT');
    expect(workflowSource).toContain('reseed auth.json');
    expect(workflowSource).toContain(
      'ReviewRouter skipped this fork pull request'
    );
    expect(workflow.on).not.toHaveProperty('pull_request_target');
    expect(workflowSource).not.toContain('REVIEW_ROUTER_THREAD_RESOLVE_TOKEN');

    expect(t0Run?.if).toContain("inputs.review_action_lane == 't0'");
    expect(t0Run?.if).toContain("inputs.codex_session_mode == ''");
    expect(codexInstall?.if).toBe(
      "${{ steps.runtime.outputs.can_run == 'true' && steps.provider-tooling.outputs.codex_cli_needed == 'true' }}"
    );
    expect(codexInstall?.if).not.toContain(
      "inputs.review_action_lane == 'legacy'"
    );
    expect(codexAuthRestore?.if).toContain(
      "inputs.review_action_lane == 'legacy'"
    );
    expect(t0Run?.env?.REVIEWROUTER_ACTION_V2_MODE).toBe('t0');
    expect(t0Run?.env?.REVIEW_ROUTER_MODE).toBe('codex-oauth-rotating');
    expect(t0Run?.env).toHaveProperty('INPUT_CONTROL_PLANE_URL');
    expect(t0Run?.env).toHaveProperty('INPUT_PROVIDER_INSTANCE_ID');
    expect(t0Run?.env).toHaveProperty('INPUT_WORKFLOW_SCHEMA_VERSION');
    expect(t0Run?.env).toHaveProperty('INPUT_MAX_CHANGED_LINES');
    expect(t0Run?.env).toHaveProperty('INPUT_AUTH_JSON');
    expect(t0Run?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(t0Run?.env).not.toHaveProperty('GH_TOKEN');
    expect(t0Run?.env).not.toHaveProperty('INPUT_GITHUB_TOKEN');
    expect(t0Run?.env).not.toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
    expect(t0Run?.env).not.toHaveProperty('REVIEW_APP_PRIVATE_KEY');

    expect(hostedPoolCheckout?.if).toContain(
      "inputs.codex_session_mode == 'codex_subscription_oauth_hosted_pool'"
    );
    expect(hostedPoolCheckout?.with).toMatchObject({
      ref: '${{ inputs.review_head_sha }}',
      path: '.reviewrouter-pr',
      'persist-credentials': false,
    });
    expect(hostedPoolRun?.if).toContain(
      "inputs.codex_session_mode == 'codex_subscription_oauth_hosted_pool'"
    );
    expect(hostedPoolRun?.env).toMatchObject({
      REVIEWROUTER_ACTION_V2_MODE: 'disabled',
      INPUT_MODE: 'fork-agentic-sandbox-hosted-pool',
      INPUT_API_URL: '${{ inputs.api_url }}',
      INPUT_CONTROL_PLANE_URL: '${{ inputs.control_plane_url }}',
      INPUT_PROVIDER_INSTANCE_ID: '${{ inputs.provider_instance_id }}',
      INPUT_WORKFLOW_SCHEMA_VERSION: '${{ inputs.workflow_schema_version }}',
      INPUT_SESSION_BINDING_ID: '${{ inputs.session_binding_id }}',
      INPUT_SESSION_BINDING_VERSION: '${{ inputs.session_binding_version }}',
      REVIEW_ROUTER_PR_WORKSPACE: '${{ github.workspace }}/.reviewrouter-pr',
    });
    expect(hostedPoolRun?.env).not.toHaveProperty('INPUT_AUTH_JSON');
    expect(hostedPoolRun?.env).not.toHaveProperty('CODEX_AUTH_JSON');
    expect(hostedPoolRun?.env).not.toHaveProperty('CODEX_CONFIG_TOML');
    expect(workflowSource).toContain(
      'run: node .reviewrouter-runtime/action-dist/index.cjs'
    );
    expect(codexInstall?.if).not.toContain(
      "inputs.review_action_lane == 'legacy'"
    );
    expect(
      steps.find(
        (step) => step.name === 'Resolve ReviewRouter runtime provider tooling'
      )?.if
    ).toContain(
      "inputs.codex_session_mode != 'codex_subscription_oauth_hosted_pool'"
    );

    expect(legacyRun?.if).toContain("inputs.review_action_lane == 'legacy'");
    expect(legacyRun?.env?.REVIEWROUTER_ACTION_V2_MODE).toBe('disabled');
    expect(legacyRun?.env).toHaveProperty('GITHUB_TOKEN');
    expect(legacyRun?.env).toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
  });

  it('keeps the interaction reusable workflow focused on /rr handling', () => {
    const workflowPath =
      '.github/workflows/reviewrouter-interaction-reusable.yml';
    const workflow = readRepoFile(workflowPath);
    const parsedWorkflow = parseWorkflow(workflowPath);
    const interaction = parsedWorkflow.jobs?.interaction;
    const externalActionUses = (interaction?.steps ?? [])
      .map((step) => step.uses)
      .filter((value): value is string => Boolean(value));

    expect(workflow).toContain('workflow_call:');
    expect(workflow).toContain('control_plane_url:');
    expect(workflow).toContain(
      'REVIEWROUTER_API_URL: ${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(workflow).toContain(
      'REVIEWROUTER_CONTROL_PLANE_URL: ${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(workflow).toContain('review_app_client_id:');
    expect(workflow).toContain('REVIEW_APP_PRIVATE_KEY:');
    expect(externalActionUses).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
    ]);
    for (const actionUses of externalActionUses) {
      expect(actionUses).toMatch(/@[0-9a-f]{40}$/u);
    }
    expect(workflow).toContain('REVIEW_ROUTER_LEDGER_KEY');
    expect(workflow).toContain('actions: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('Preflight ReviewRouter interaction');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: interaction-preflight');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: interaction');
    expect(workflow).toContain('discussion_mode:');
    expect(workflow).toContain('CODEX_AUTH_JSON:');
    expect(workflow).toContain('OPENAI_API_KEY:');
    expect(workflow).toContain('Install Codex CLI for discussion replies');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_ENABLED');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_CANDIDATE_ENDPOINT');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT');
    expect(workflow).toContain('review_workflow_file:');
    expect(workflow).toContain(
      'RR_REVIEW_WORKFLOW_FILE: ${{ inputs.review_workflow_file }}'
    );
    expect(workflow).toContain('Invalid review_workflow_file');
    expect(workflow).toContain('allowedReviewWorkflowFiles');
    expect(workflow).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE=${reviewWorkflowFile}'
    );
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('REVIEW_ROUTER_THREAD_RESOLVE_TOKEN');
  });

  it('supports a pinned read-token agent-teams interaction caller', () => {
    const caller = parseWorkflow(
      '__tests__/fixtures/github/reviewrouter-codex-interaction-caller.yml'
    );
    const interaction = caller.jobs?.interaction;
    const pinnedRuntimeRef = '0123456789abcdef0123456789abcdef01234567';

    expect(caller.on?.pull_request_review_comment?.types).toEqual([
      'created',
      'edited',
    ]);
    expect(caller.on?.issue_comment?.types).toEqual(['created', 'edited']);
    expect(caller.on).toHaveProperty('workflow_dispatch');
    expect(caller.permissions).toEqual({});
    expect(interaction?.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot') }}"
    );
    expect(interaction?.permissions).toEqual({
      actions: 'write',
      contents: 'read',
      issues: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(interaction?.uses).toBe(
      `777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@${pinnedRuntimeRef}`
    );
    expect(interaction?.with).toMatchObject({
      runtime_ref: pinnedRuntimeRef,
      runtime_config_mode: 'oidc',
      review_workflow_file: 'reviewrouter-codex.yml',
      discussion_mode: "${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'off' }}",
      discussion_model: "${{ vars.REVIEW_CODEX_MODEL || 'gpt-5.5' }}",
      discussion_reasoning_effort: "${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}",
      discussion_max_per_pr:
        "${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR || '20' }}",
      discussion_max_per_thread:
        "${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD || '5' }}",
      discussion_timeout_seconds:
        "${{ vars.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS || '60' }}",
    });
    expect(interaction?.secrets).toEqual({
      CODEX_AUTH_JSON: '${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}',
    });
    expect(interaction?.secrets).not.toHaveProperty('REVIEW_ROUTER_LEDGER_KEY');
  });

  it('keeps reusable permissions executable by the secured thin caller', () => {
    const caller = parseWorkflow(
      '__tests__/fixtures/github/reviewrouter-codex-interaction-caller.yml'
    ).jobs?.interaction;
    const reusable = parseWorkflow(
      '.github/workflows/reviewrouter-interaction-reusable.yml'
    ).jobs?.interaction;

    expect(reusable?.permissions).toEqual({
      actions: 'write',
      contents: 'read',
      'pull-requests': 'read',
      issues: 'read',
      'id-token': 'write',
    });
    expect(
      permissionEscalations(
        caller?.permissions ?? {},
        reusable?.permissions ?? {}
      )
    ).toEqual([]);
  });

  it.each([
    'reviewrouter.yml',
    'reviewrouter.yaml',
    'reviewrouter-codex.yml',
    'reviewrouter-codex.yaml',
  ])('accepts the safe review workflow filename %s', (reviewWorkflowFile) => {
    const result = runInteractionRuntimePreparation(reviewWorkflowFile);

    expect(result.status).toBe(0);
    expect(result.githubEnvContents).toContain(
      `REVIEW_ROUTER_REVIEW_WORKFLOW_FILE=${reviewWorkflowFile}\n`
    );
    expect(result.githubEnvContents).toContain(
      'REVIEWROUTER_COMMENT_TOKEN_MODE=app-oidc\n'
    );
  });

  it.each([
    '../reviewrouter-codex.yml',
    'reviewrouter-codex.yml/../../reviewrouter.yml',
    'reviewrouter-other.yml',
    'ReviewRouter-codex.yml',
    'reviewrouter.yml\nINJECTED=true',
  ])('rejects the unsafe review workflow filename %j', (reviewWorkflowFile) => {
    const result = runInteractionRuntimePreparation(reviewWorkflowFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Invalid review_workflow_file. Use reviewrouter.yml or reviewrouter-codex.yml.'
    );
    expect(result.githubEnvContents).toBe('');
  });

  it('does not expose the removed resolve-conversation token in public surfaces', () => {
    expect(readRepoFile('action.yml')).not.toContain(
      'REVIEW_ROUTER_THREAD_RESOLVE_TOKEN'
    );
    expect(readRepoFile('README.md')).not.toContain(
      'REVIEW_ROUTER_THREAD_RESOLVE_TOKEN'
    );
  });

  it('keeps the conflict reusable workflow on the selected control plane', () => {
    const workflow = parseWorkflow(
      '.github/workflows/reviewrouter-conflict-reusable.yml'
    );
    const steps = workflow.jobs?.['conflict-review']?.steps ?? [];
    expect(
      steps.find(
        (step) => step.name === 'Checkout trusted ReviewRouter runtime'
      )?.with
    ).toMatchObject({
      repository: '777genius/review-router',
      ref: '${{ inputs.runtime_ref }}',
      'persist-credentials': false,
    });
    expect(
      steps.find((step) => step.name === 'Validate bundled conflict runtime')
        ?.run
    ).toContain('node --check action-dist/conflict-runtime.cjs');
    expect(
      steps.find(
        (step) => step.name === 'Preflight conflict runtime before PR checkout'
      )?.run
    ).toContain('node action-dist/conflict-runtime.cjs preflight');
    expect(
      steps.find((step) => step.name === 'Run conflict review runtime')?.run
    ).toContain('node action-dist/conflict-runtime.cjs run');

    expect(workflow.on?.workflow_call?.inputs?.control_plane_url?.default).toBe(
      ''
    );
    expect(workflow.jobs?.['conflict-review']?.env?.REVIEWROUTER_API_URL).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(
      workflow.jobs?.['conflict-review']?.env?.REVIEWROUTER_CONTROL_PLANE_URL
    ).toBe('${{ inputs.control_plane_url || inputs.api_url }}');
  });
});
