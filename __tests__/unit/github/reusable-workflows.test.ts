import { execFileSync, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { REVIEW_ROUTER_API_ORIGIN } from '../../../src/config/review-router-endpoints';
import {
  providerApiAuthModes,
  providerApiDescriptors,
} from '../../../src/control-plane/generated/review-action-v2/companion-contracts';

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

function runExecutionPreparation(env: NodeJS.ProcessEnv) {
  const step = parseWorkflow(
    '.github/workflows/reviewrouter-execution-reusable.yml'
  ).jobs?.review?.steps?.find(
    (item) => item.name === 'Prepare ReviewRouter runtime settings'
  );
  const script = step?.run?.match(/<<'NODE'\n([\s\S]*?)\nNODE/u)?.[1];
  if (!script) throw new Error('Execution preparation script missing');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-entry-'));
  try {
    const output = path.join(tempDir, 'output');
    const githubEnv = path.join(tempDir, 'env');
    fs.writeFileSync(output, '');
    fs.writeFileSync(githubEnv, '');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module-typescript'],
      {
        input: script,
        encoding: 'utf8',
        env: { ...env, GITHUB_ENV: githubEnv, GITHUB_OUTPUT: output },
      }
    );
    return {
      ...result,
      output: fs.readFileSync(output, 'utf8'),
      githubEnv: fs.readFileSync(githubEnv, 'utf8'),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  it('promotes the ABI channel only through an explicit exact-tag CAS dispatch', () => {
    const source = readRepoFile(
      '.github/workflows/promote-workflow-channel.yml'
    );
    const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA }) as {
      on: {
        workflow_dispatch: { inputs: Record<string, { required: boolean }> };
      };
    };
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.version.required).toBe(true);
    expect(
      workflow.on.workflow_dispatch.inputs.expected_current_sha.required
    ).toBe(true);
    const helper = readRepoFile('scripts/promote-workflow-channel.mts');
    expect(helper).toContain('`refs/tags/${version}`');
    expect(helper).toContain(
      '`--force-with-lease=refs/tags/workflow-v1:${expected}`'
    );
    expect(helper).not.toContain('git tag');
  });

  it('accepts the installed ABI and rejects incompatible input or permission changes', () => {
    const original = readRepoFile('.github/workflows/reviewrouter-runtime.yml');
    const runtimeStep = parseWorkflow(
      '.github/workflows/reviewrouter-runtime.yml'
    ).jobs?.review?.steps?.find((step) => step.name === 'Run ReviewRouter');
    expect(runtimeStep?.env).toMatchObject({
      REVIEW_ROUTER_MODE: 'account-gateway',
    });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-channel-abi-'));
    try {
      const candidate = path.join(temp, 'workflow.yml');
      for (const [source, expected] of [
        [original, 0],
        [original.replace('contents: read', 'contents: write'), 1],
        [original.replace('mcp_secrets_json:', 'unexpected_secret:'), 1],
        [
          original.replace(
            /(mcp_secrets_json:[\s\S]*?required:) false/,
            '$1 true'
          ),
          1,
        ],
        [original.replace('required: false', 'required: true'), 1],
        [
          original.replace(
            `        default: ${REVIEW_ROUTER_API_ORIGIN}\n`,
            ''
          ),
          1,
        ],
        [
          original.replace(REVIEW_ROUTER_API_ORIGIN, 'https://other.invalid'),
          1,
        ],
      ] as const) {
        fs.writeFileSync(candidate, source);
        const result = spawnSync(
          process.execPath,
          [
            path.join(repoRoot, 'scripts/promote-workflow-channel.mts'),
            '--validate',
            candidate,
          ],
          { encoding: 'utf8', cwd: repoRoot }
        );
        expect(result.status).toBe(expected);
        if (expected !== 0)
          expect(JSON.parse(result.stderr)).toEqual({
            code: 'workflow_channel_promotion_rejected',
            phase: 'validate',
            pushIssued: false,
            pushCompleted: false,
            outcome: 'not_issued',
          });
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('executes gateway fork eligibility, immutable source, static denial and queue skip', () => {
    const env: NodeJS.ProcessEnv = {
      RR_REVIEW_ACTION_LANE: 't0',
      RR_CODEX_SESSION_MODE: 'account-gateway',
      RR_RUNTIME_REF: 'main',
      RR_WORKFLOW_REPOSITORY: '777genius/review-router',
      RR_WORKFLOW_SHA: '0123456789abcdef0123456789abcdef01234567',
      RR_REVIEW_TIMEOUT_MINUTES: '240',
      REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_HEAD_REPO_FULL_NAME: 'fork/repo',
    };
    const fork = runExecutionPreparation(env);
    expect(fork.status).toBe(0);
    expect(fork.output).toContain('can_run=true\n');
    expect(fork.output).toContain(`runtime_ref=${env.RR_WORKFLOW_SHA}\n`);
    expect(fork.githubEnv).toMatch(
      /REVIEWROUTER_STATIC_CONFIG_FALLBACK<<[^\n]+\nfalse\n/u
    );
    const steps =
      parseWorkflow('.github/workflows/reviewrouter-execution-reusable.yml')
        .jobs?.review?.steps ?? [];
    const selectedCheckouts = steps.filter(
      (step) =>
        step.uses?.startsWith('actions/checkout@') &&
        runInNewContext((step.if ?? '${{ true }}').slice(3, -2), {
          inputs: {
            review_action_lane: 't0',
            codex_session_mode: 'account-gateway',
          },
          steps: { runtime: { outputs: { can_run: 'true' } } },
        })
    );
    expect(selectedCheckouts.map((step) => step.name)).toEqual([
      'Checkout ReviewRouter runtime',
    ]);
    expect(steps[0]?.name).toBe('Setup Node.js');
    expect(
      runExecutionPreparation({ ...env, GITHUB_EVENT_NAME: 'merge_group' })
        .output
    ).toContain('can_run=false\nskip_reason=merge_group\n');
    expect(
      runExecutionPreparation({ ...env, RR_CODEX_SESSION_MODE: '' }).output
    ).toContain('can_run=false\nskip_reason=fork\n');
    expect(
      runExecutionPreparation({
        ...env,
        REVIEWROUTER_RUNTIME_CONFIG_MODE: 'static',
      }).status
    ).toBe(1);
  });

  it.each(providerApiAuthModes)(
    'isolates direct %s T0 from OAuth preparation and rejects alternate authority',
    (mode) => {
      for (const source of [
        '.github/workflows/reviewrouter-reusable.yml',
        '.github/workflows/reviewrouter-execution-reusable.yml',
      ]) {
        expect(
          parseWorkflow(source).on?.workflow_call?.inputs
            ?.provider_api_auth_mode?.default
        ).toBe('');
      }
      const env: NodeJS.ProcessEnv = {
        RR_REVIEW_ACTION_LANE: 't0',
        RR_PROVIDER_API_AUTH_MODE: mode,
        RR_REVIEW_REQUEST_ID: 'review-request-1',
        RR_RUNTIME_REF: '0123456789abcdef0123456789abcdef01234567',
        RR_WORKFLOW_REPOSITORY: '777genius/review-router',
        RR_WORKFLOW_SHA: '0123456789abcdef0123456789abcdef01234567',
        RR_REVIEW_TIMEOUT_MINUTES: '240',
        REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
        REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY: 'owner/repo',
      };
      const admitted = runExecutionPreparation(env);
      expect(admitted.status).toBe(0);
      expect(admitted.output).toContain('can_run=true\n');
      const steps =
        parseWorkflow('.github/workflows/reviewrouter-execution-reusable.yml')
          .jobs?.review?.steps ?? [];
      const selected = steps.filter((step) =>
        runInNewContext(
          (step.if ?? '${{ true }}')
            .slice(3, -2)
            .replaceAll('steps.provider-tooling', 'steps["provider-tooling"]'),
          {
            inputs: {
              review_action_lane: 't0',
              codex_session_mode: '',
              provider_api_auth_mode: mode,
              subscription_auth_mode: '',
            },
            steps: {
              runtime: {
                outputs: { can_run: 'true', app_token_needed: 'false' },
              },
              'provider-tooling': { outputs: {} },
            },
            env: {},
          }
        )
      );
      expect(
        selected
          .filter((step) => step.uses?.startsWith('actions/checkout@'))
          .map((step) => step.name)
      ).toEqual(['Checkout ReviewRouter runtime']);
      expect(
        selected
          .filter((step) => step.name?.startsWith('Run ReviewRouter'))
          .map((step) => step.name)
      ).toEqual(['Run ReviewRouter T0 provider API']);
      expect(
        selected.some(
          (step) =>
            step.name === 'Resolve ReviewRouter runtime provider tooling'
        )
      ).toBe(false);
      expect(
        selected.find(
          (step) => step.name === 'Run ReviewRouter T0 provider API'
        )?.env
      ).toMatchObject({
        REVIEW_ROUTER_MODE: 'provider-api',
        [`INPUT_${providerApiDescriptors[mode].secretName}`]: `\${{ secrets.${providerApiDescriptors[mode].secretName} }}`,
      });
      for (const mismatch of [
        { RR_PROVIDER_INSTANCE_ID: 'codex-rotating:1' },
        { RR_CODEX_SESSION_MODE: 'account-gateway' },
        { CODEX_AUTH_JSON_PRESENT: '1' },
        { CODEX_CONFIG_TOML_PRESENT: '1' },
        { OPENAI_API_KEY_PRESENT: '1' },
        { REVIEW_APP_PRIVATE_KEY_PRESENT: '1' },
        { RR_STATIC_RUNTIME_ENV_JSON: '{"CODEX_MODEL":"other"}' },
        { REVIEWROUTER_RUNTIME_CONFIG_MODE: 'static' },
        { RR_REVIEW_REQUEST_ID: '' },
      ])
        expect(runExecutionPreparation({ ...env, ...mismatch }).status).toBe(1);
    }
  );

  it('executes exactly the native Claude prepared route and rejects credential or authority substitution', () => {
    const workflow = parseWorkflow(
      '.github/workflows/reviewrouter-execution-reusable.yml'
    );
    expect(
      workflow.on?.workflow_call?.inputs?.subscription_auth_mode?.default
    ).toBe('');
    const env: NodeJS.ProcessEnv = {
      RR_REVIEW_ACTION_LANE: 't0',
      RR_SUBSCRIPTION_AUTH_MODE: 'claude-oauth',
      RR_REVIEW_REQUEST_ID: 'review-request-claude',
      RR_RUNTIME_REF: '0123456789abcdef0123456789abcdef01234567',
      RR_WORKFLOW_REPOSITORY: '777genius/review-router',
      RR_WORKFLOW_SHA: '0123456789abcdef0123456789abcdef01234567',
      RR_REVIEW_TIMEOUT_MINUTES: '240',
      REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
      CLAUDE_CODE_OAUTH_TOKEN_PRESENT: '1',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY: 'owner/repo',
    };
    expect(runExecutionPreparation(env).status).toBe(0);
    const selected = (workflow.jobs?.review?.steps ?? []).filter((step) =>
      runInNewContext(
        (step.if ?? '${{ true }}')
          .slice(3, -2)
          .replaceAll('steps.provider-tooling', 'steps["provider-tooling"]'),
        {
          inputs: {
            review_action_lane: 't0',
            codex_session_mode: '',
            provider_api_auth_mode: '',
            subscription_auth_mode: 'claude-oauth',
          },
          steps: {
            runtime: {
              outputs: { can_run: 'true', app_token_needed: 'false' },
            },
            'provider-tooling': { outputs: {} },
          },
          env: {},
        }
      )
    );
    expect(
      selected
        .filter((step) => step.uses?.startsWith('actions/checkout@'))
        .map((step) => step.name)
    ).toEqual(['Checkout ReviewRouter runtime']);
    expect(
      selected
        .filter((step) => step.name?.startsWith('Run ReviewRouter'))
        .map((step) => step.name)
    ).toEqual(['Run ReviewRouter T0 Claude subscription']);
    expect(
      selected.some((step) =>
        /Install .*CLI|runtime provider tooling/.test(step.name ?? '')
      )
    ).toBe(false);
    const run = selected.find(
      (step) => step.name === 'Run ReviewRouter T0 Claude subscription'
    )!;
    expect(run.env).toMatchObject({
      REVIEWROUTER_ACTION_V2_MODE: 't0',
      REVIEW_ROUTER_MODE: 'prepared-subscription',
      REVIEWROUTER_PREPARED_MODEL_TRANSPORT: 'runner_local_anthropic',
      INPUT_CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
    });
    expect(
      Object.keys(run.env!).filter((name) => /TOKEN|KEY|AUTH_JSON/.test(name))
    ).toEqual(['INPUT_CLAUDE_CODE_OAUTH_TOKEN']);
    for (const mismatch of [
      { RR_REVIEW_ACTION_LANE: 'legacy' },
      { RR_SUBSCRIPTION_AUTH_MODE: 'codex-oauth' },
      { RR_PROVIDER_API_AUTH_MODE: 'openrouter-api' },
      { RR_CODEX_SESSION_MODE: 'account-gateway' },
      { RR_PROVIDER_INSTANCE_ID: 'codex-rotating:1' },
      { RR_SESSION_BINDING_ID: 'hosted-binding' },
      { CLAUDE_CODE_OAUTH_TOKEN_PRESENT: '0' },
      { CODEX_AUTH_JSON_PRESENT: '1' },
      { OPENROUTER_API_KEY_PRESENT: '1' },
      { MIMO_TOKEN_PLAN_API_KEY_PRESENT: '1' },
      { KIMI_CODE_API_KEY_PRESENT: '1' },
      { REVIEW_APP_PRIVATE_KEY_PRESENT: '1' },
      { RR_STATIC_RUNTIME_ENV_JSON: '{"REVIEW_AUTH_MODE":"codex-oauth"}' },
      { REVIEWROUTER_RUNTIME_CONFIG_MODE: 'static' },
      { GITHUB_EVENT_NAME: 'pull_request' },
      { RR_REVIEW_REQUEST_ID: '' },
    ])
      expect(runExecutionPreparation({ ...env, ...mismatch }).status).toBe(1);
  });

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
      expect(runStep?.env?.DISCUSSION_MODEL).toBe(
        '${{ inputs.discussion_model }}'
      );
      expect(runStep?.env).not.toHaveProperty('CODEX_MODEL');
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
    const gatewayReview = workflow.jobs?.['review-account-gateway'];
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
    expect(review?.if).toContain(
      "inputs.codex_session_mode != 'account-gateway'"
    );
    expect(gatewayReview?.if).toContain(
      "inputs.codex_session_mode == 'account-gateway'"
    );
    expect(gatewayReview?.with?.codex_session_mode).toBe(
      '${{ inputs.codex_session_mode }}'
    );
    expect(gatewayReview?.with?.static_runtime_env_json).toBe('{}');
    expect(gatewayReview?.permissions).toEqual(review?.permissions);
    expect(gatewayReview?.secrets).toBeUndefined();
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

  it('confines the MiMo token secret to direct provider API and legacy execution', () => {
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
        step: 'Run ReviewRouter T0 provider API',
        environmentVariable: `INPUT_${secretName}`,
        value: secretExpression,
      },
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

  it('leaves T0 checkout and approved tooling to the prepared route and preserves legacy preflight', () => {
    const workflowPath =
      '.github/workflows/reviewrouter-execution-reusable.yml';
    const workflow = parseWorkflow(workflowPath);
    const codexInstall = workflow.jobs?.review?.steps?.find(
      (step) => step.name === 'Install Codex CLI'
    );

    expect(codexInstall?.if).toBe(
      "${{ inputs.review_action_lane == 'legacy' && steps.runtime.outputs.can_run == 'true' && steps.provider-tooling.outputs.codex_cli_needed == 'true' }}"
    );
    const steps = workflow.jobs?.review?.steps ?? [];
    expect(
      steps.find((step) => step.name === 'Checkout exact T0 review revision')
    ).toBeUndefined();
    const preflight = steps.find(
      (step) => step.name === 'Resolve ReviewRouter runtime provider tooling'
    );
    const gatewayRun = steps.find(
      (step) => step.name === 'Run ReviewRouter T0 account gateway'
    );
    const cases: Array<[string, string, string, string, boolean[]]> = [
      ['t0', 'account-gateway', 'true', '', [false, false, true]],
      ['t0', 'account-gateway', 'false', 'true', [false, false, false]],
      ['t0', '', 'true', 'true', [false, false, false]],
      ['t0', '', 'true', '', [false, false, false]],
      ['legacy', '', 'true', 'true', [true, true, false]],
      ['legacy', '', 'true', '', [true, false, false]],
      ['legacy', '', 'false', 'true', [false, false, false]],
      [
        't0',
        'codex_subscription_oauth_hosted_pool',
        'true',
        '',
        [false, false, false],
      ],
    ];
    for (const [lane, mode, canRun, codexNeeded, expected] of cases) {
      const selected = [preflight, codexInstall, gatewayRun].map((step) => {
        if (!step?.if) throw new Error('Tooling selection condition missing');
        return runInNewContext(
          step.if
            .slice(3, -2)
            .replaceAll('steps.provider-tooling', 'steps["provider-tooling"]'),
          {
            inputs: {
              review_action_lane: lane,
              codex_session_mode: mode,
              provider_api_auth_mode: '',
              subscription_auth_mode: '',
            },
            steps: {
              runtime: { outputs: { can_run: canRun } },
              'provider-tooling': {
                outputs: { codex_cli_needed: codexNeeded },
              },
            },
          }
        );
      });
      expect({ lane, mode, canRun, codexNeeded, selected }).toEqual({
        lane,
        mode,
        canRun,
        codexNeeded,
        selected: expected,
      });
    }
    expect(workflow.jobs?.review?.env?.MIMO_TOKEN_PLAN_API_KEY_PRESENT).toBe(
      "${{ secrets.MIMO_TOKEN_PLAN_API_KEY != '' && '1' || '0' }}"
    );
    expect(preflight?.if).not.toContain('MIMO_TOKEN_PLAN_API_KEY_PRESENT');
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
    const gatewayRun = steps.find(
      (step) => step.name === 'Run ReviewRouter T0 account gateway'
    );
    expect(gatewayRun?.run).toBe('node .reviewrouter-runtime/dist/index.js');
    expect(gatewayRun?.if).toBe(
      "${{ inputs.review_action_lane == 't0' && inputs.codex_session_mode == 'account-gateway' && steps.runtime.outputs.can_run == 'true' }}"
    );
    expect(gatewayRun?.env).toMatchObject({
      REVIEW_ROUTER_MODE: 'account-gateway',
      REVIEWROUTER_ACTION_V2_MODE: 't0',
    });
    expect(
      Object.keys(gatewayRun?.env ?? {}).filter((key) =>
        /AUTH|TOKEN|KEY|CONFIG_TOML/u.test(key)
      )
    ).toEqual([]);
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
    expect(workflowSource).toContain("import crypto from 'node:crypto';");
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
    expect(workflowSource).not.toContain('/api/action/v1/memory');
    expect(workflowSource).toContain('reseed auth.json');
    expect(workflowSource).toContain(
      'ReviewRouter skipped this fork pull request'
    );
    expect(workflow.on).not.toHaveProperty('pull_request_target');
    expect(workflowSource).not.toContain('REVIEW_ROUTER_THREAD_RESOLVE_TOKEN');

    expect(t0Run?.if).toContain("inputs.review_action_lane == 't0'");
    expect(t0Run?.if).toContain("inputs.codex_session_mode == ''");
    expect(codexInstall?.if).toBe(
      "${{ inputs.review_action_lane == 'legacy' && steps.runtime.outputs.can_run == 'true' && steps.provider-tooling.outputs.codex_cli_needed == 'true' }}"
    );
    expect(codexInstall?.if).toContain("inputs.review_action_lane == 'legacy'");
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

    // The prepared route materializes its admitted exact head in isolation.
    expect(hostedPoolCheckout).toBeUndefined();
    expect(hostedPoolRun?.if).toContain(
      "inputs.codex_session_mode == 'codex_subscription_oauth_hosted_pool'"
    );
    expect(hostedPoolRun?.env).toMatchObject({
      REVIEWROUTER_ACTION_V2_MODE: 't0',
      INPUT_MODE: 'fork-agentic-sandbox-hosted-pool',
      INPUT_API_URL: '${{ inputs.api_url }}',
      INPUT_CONTROL_PLANE_URL: '${{ inputs.control_plane_url }}',
      INPUT_PROVIDER_INSTANCE_ID: '${{ inputs.provider_instance_id }}',
      INPUT_WORKFLOW_SCHEMA_VERSION: '${{ inputs.workflow_schema_version }}',
      INPUT_SESSION_BINDING_ID: '${{ inputs.session_binding_id }}',
      INPUT_SESSION_BINDING_VERSION: '${{ inputs.session_binding_version }}',
    });
    expect(hostedPoolRun?.env).not.toHaveProperty('REVIEW_ROUTER_PR_WORKSPACE');
    expect(hostedPoolRun?.env).not.toHaveProperty('INPUT_AUTH_JSON');
    expect(hostedPoolRun?.env).not.toHaveProperty('CODEX_AUTH_JSON');
    expect(hostedPoolRun?.env).not.toHaveProperty('CODEX_CONFIG_TOML');
    expect(workflowSource).toContain(
      'run: node .reviewrouter-runtime/action-dist/index.cjs'
    );
    expect(codexInstall?.if).toContain("inputs.review_action_lane == 'legacy'");
    expect(
      steps.find(
        (step) => step.name === 'Resolve ReviewRouter runtime provider tooling'
      )?.if
    ).toContain("inputs.review_action_lane == 'legacy'");

    expect(legacyRun?.if).toContain("inputs.review_action_lane == 'legacy'");
    expect(legacyRun?.env?.REVIEWROUTER_ACTION_V2_MODE).toBe('disabled');
    expect(legacyRun?.env).toHaveProperty('GITHUB_TOKEN');
    expect(legacyRun?.env).toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
  });

  it('enables memory capture in each trusted T0 execution lane', () => {
    const workflow = parseWorkflow(
      '.github/workflows/reviewrouter-execution-reusable.yml'
    );
    const steps = workflow.jobs?.review?.steps;
    for (const name of [
      'Run ReviewRouter T0',
      'Run ReviewRouter T0 provider API',
      'Run ReviewRouter T0 account gateway',
    ]) {
      const step = steps?.find((candidate) => candidate.name === name);
      expect(step).toBeDefined();
      expect(step?.env?.REVIEWROUTER_ACTION_V2_MODE).toBe('t0');
      expect(step?.env?.REVIEW_ROUTER_MEMORY_ENABLED).toBe('true');
      expect(step?.env).not.toHaveProperty(
        'REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT'
      );
    }
    const standalone = parseWorkflow(
      '.github/workflows/reviewrouter-runtime.yml'
    );
    const run = standalone.jobs?.review?.steps?.find(
      (step) => step.name === 'Run ReviewRouter'
    );
    expect(run?.env?.REVIEWROUTER_ACTION_V2_MODE).toBe('t0');
    expect(run?.env?.REVIEWROUTER_RUNTIME_CONFIG_MODE).toBe('oidc');
    expect(run?.env?.REVIEWROUTER_STATIC_CONFIG_FALLBACK).toBe('false');
    expect(run?.env?.REVIEW_ROUTER_MEMORY_ENABLED).toBe('true');
  });

  it('isolates the managed interaction job from local model setup and publication fallback', () => {
    const workflow = parseWorkflow(
      '.github/workflows/reviewrouter-interaction-reusable.yml'
    );
    const managed = workflow.jobs?.['gateway-interaction'];
    expect(managed?.if).toBe(
      "${{ inputs.interaction_backend == 'account-gateway' }}"
    );
    expect(workflow.jobs?.interaction?.if).toBe(
      "${{ inputs.interaction_backend == 'legacy' }}"
    );
    expect(managed?.env).toMatchObject({
      REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
      REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc',
      REVIEW_ROUTER_INTERACTION_BACKEND: 'account-gateway',
    });
    expect(managed?.permissions?.['pull-requests']).toBe('read');
    expect(managed?.permissions?.issues).toBe('read');
    expect(JSON.stringify(managed)).not.toMatch(
      /CODEX_AUTH_JSON|DISCUSSION_MODEL|OPENAI_API_KEY|MIMO_TOKEN_PLAN_API_KEY|npm install/
    );
    expect(
      managed?.steps?.find(
        (step) => step.name === 'Validate immutable managed interaction'
      )?.run
    ).toContain('created|edited|deleted');
    expect(
      managed?.steps?.find(
        (step) => step.name === 'Process managed conversation'
      )?.run
    ).toBe('node .reviewrouter-runtime/dist/index.js');
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
    expect(workflow).not.toContain('/api/action/v1/memory');
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

  it('rejects an older accepted ref without a conflict bundle before preflight', () => {
    const steps =
      parseWorkflow('.github/workflows/reviewrouter-conflict-reusable.yml')
        .jobs?.['conflict-review']?.steps ?? [];
    const validateRef = steps.find(
      (step) => step.name === 'Validate conflict runtime ref'
    );
    const validateBundle = steps.find(
      (step) => step.name === 'Validate bundled conflict runtime'
    );
    expect(validateRef?.run).toBeDefined();
    expect(validateBundle?.run).toBeDefined();
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rr-conflict-ref-NEWTEST-')
    );
    try {
      const options = {
        cwd,
        encoding: 'utf8' as const,
        env: {
          PATH: process.env.PATH,
          REVIEWROUTER_RUNTIME_REF: 'v1',
        },
      };
      expect(spawnSync('bash', ['-c', validateRef!.run!], options).status).toBe(
        0
      );
      const missingBundle = spawnSync(
        'bash',
        ['-c', validateBundle!.run!],
        options
      );
      expect(missingBundle.status).toBe(1);
      expect(missingBundle.stdout).toContain(
        'Selected runtime_ref does not provide the bundled conflict runtime'
      );
      fs.mkdirSync(path.join(cwd, 'action-dist'));
      fs.copyFileSync(
        path.join(repoRoot, 'action-dist/conflict-runtime.cjs'),
        path.join(cwd, 'action-dist/conflict-runtime.cjs')
      );
      expect(
        spawnSync('bash', ['-c', validateBundle!.run!], options).status
      ).toBe(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('immutable Secrets runtime producer', () => {
  it('binds checkout to the owning workflow SHA and runs the existing OIDC engine', () => {
    const document = yaml.load(
      readRepoFile('.github/workflows/reviewrouter-secrets-runtime.yml')
    ) as WorkflowDocument;
    const review = document.jobs!.review!;
    const steps = review.steps!;
    const checkout = steps.find(
      (step) => step.name === 'Checkout immutable producer runtime'
    )!;
    expect(checkout.with).toMatchObject({
      repository: '777genius/review-router',
      ref: '${{ job.workflow_sha }}',
      path: '.reviewrouter-runtime',
      'persist-credentials': false,
    });
    expect(review.env).toMatchObject({
      REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
    });
    expect(
      steps.some(
        (step) =>
          step.run === 'node .reviewrouter-runtime/dist/index.js' &&
          step.env?.REVIEW_ROUTER_MODE === 'review'
      )
    ).toBe(true);
    const guard = steps.find(
      (step) => step.name === 'Validate immutable producer identity'
    )!.run!;
    const script = guard.split("<<'NODE'\n")[1]!.replace(/\nNODE\s*$/, '');
    const run = (sha: string, repository = '777genius/review-router') =>
      runInNewContext(script, {
        process: {
          env: {
            RR_WORKFLOW_SHA: sha,
            RR_WORKFLOW_REPOSITORY: repository,
            GITHUB_REPOSITORY_ID: '123',
          },
        },
      });
    expect(() => run('a'.repeat(40))).not.toThrow();
    expect(() => run('main')).toThrow('producer_identity_invalid');
    expect(() => run('a'.repeat(40), 'foreign/producer')).toThrow(
      'producer_identity_invalid'
    );
  });
});

test('forwards only the explicitly named MCP secret to the trusted parent runner entrypoints', () => {
  const runtime = parseWorkflow('.github/workflows/reviewrouter-runtime.yml');
  const t0 = parseWorkflow('.github/workflows/reviewrouter-t0-reusable.yml');
  const execution = parseWorkflow(
    '.github/workflows/reviewrouter-execution-reusable.yml'
  );
  for (const workflow of [runtime, t0, execution])
    expect(workflow.on?.workflow_call?.secrets?.mcp_secrets_json).toEqual(
      expect.objectContaining({ required: false })
    );
  expect(
    Object.values(t0.jobs ?? {}).some(
      (job) =>
        job.secrets?.mcp_secrets_json === '${{ secrets.mcp_secrets_json }}'
    )
  ).toBe(true);
  expect(
    traceSecretEnvBindings(runtime, 'mcp_secrets_json').map((binding) => [
      binding.step,
      binding.environmentVariable,
    ])
  ).toEqual([['Run ReviewRouter', 'REVIEWROUTER_MCP_CREDENTIALS_JSON']]);
  expect(
    traceSecretEnvBindings(execution, 'mcp_secrets_json').map((binding) => [
      binding.step,
      binding.environmentVariable,
    ])
  ).toEqual([
    [
      'Run ReviewRouter T0 account gateway',
      'REVIEWROUTER_MCP_CREDENTIALS_JSON',
    ],
  ]);
});
