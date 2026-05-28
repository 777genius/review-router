import * as fs from 'fs';
import * as path from 'path';
import * as core from '../actions/core';
import { ReviewOrchestrator } from '../core/orchestrator';
import { ConfigLoader } from '../config/loader';
import { createComponents } from '../setup';
import { GitHubClient } from '../github/client';
import { CommentPoster } from '../github/comment-poster';
import { formatBlockingFindingFailure } from '../output/severity-gate';
import { applyControlPlaneRuntimeConfig } from '../control-plane/runtime-config';
import { CodexOAuthControlPlaneClient, FetchLike } from './control-plane';
import { refreshCodexAuthWithOfficialCli } from './codex-bootstrap';
import { prepareCodexCliBeforeAuthRead } from './codex-cli';
import {
  applyCodexRotatingProviderSecretInputs,
  clearCodexRotatingOidcRequestEnv,
  clearCodexRotatingProviderSecretEnv,
  clearCodexRotatingProcessAuthEnv,
  readCodexRotatingProviderSecretInputs,
  type CodexRotatingProviderSecretInputs,
} from './auth-input';
import { fetchGitHubRepositoryPublicKey } from './github-secrets';
import { GitHubActionsOidcTokenProvider } from './github-actions-oidc';
import {
  runCodexOAuthRotatingRuntime,
  type CodexOAuthReviewResult,
} from './runtime';
import { safeCheckoutRepository } from './safe-checkout';

export const CODEX_OAUTH_ROTATING_MODE = 'codex-oauth-rotating';

export async function runCodexOAuthRotatingAction(
  options: {
    fetchImpl?: FetchLike;
  } = {}
): Promise<void> {
  const inputs = readCodexOAuthActionInputs();
  clearCodexRotatingProviderSecretEnv();
  const controlPlane = new CodexOAuthControlPlaneClient({
    apiUrl: inputs.apiUrl,
    fetchImpl: options.fetchImpl,
  });
  const runtime = await runCodexOAuthRotatingRuntime(inputs, {
    oidc: new GitHubActionsOidcTokenProvider({
      fetchImpl: options.fetchImpl,
    }),
    controlPlane,
    githubSecrets: {
      fetchPublicKey: (input) =>
        fetchGitHubRepositoryPublicKey({
          ...input,
          fetchImpl: options.fetchImpl,
        }),
    },
    codex: {
      prepareCli: () =>
        prepareCodexCliBeforeAuthRead({
          logger: {
            info: core.info,
            warn: (message) => core.warning(message),
          },
        }),
      refreshAuth: (input) =>
        refreshCodexAuthWithOfficialCli({
          authJsonBytes: input.authJsonBytes,
          codexBinaryPath: input.codexBinaryPath,
          logger: {
            info: core.info,
            warn: (message) => core.warning(message),
          },
        }),
    },
    checkout: {
      checkoutExactHead: safeCheckoutRepository,
    },
    review: {
      run: (input) =>
        runReviewComputation({
          apiUrl: inputs.apiUrl,
          audience: inputs.audience,
          checkoutToken: input.checkoutToken,
          codexHome: input.codexHome,
          codexBinaryPath: input.codexBinaryPath,
          fetchImpl: options.fetchImpl,
          providerSecrets: inputs.providerSecrets,
        }),
    },
    comments: {
      post: (input) =>
        postReviewAfterAuthClear({
          commentToken: input.commentToken,
          review: input.review,
        }),
    },
    lifecycle: {
      clearOidcEnv: () => clearCodexRotatingOidcRequestEnv(),
      clearProcessAuthEnv: () => clearCodexRotatingProcessAuthEnv(),
    },
  });

  core.setOutput('reviewrouter_state', runtime.status);
  if (runtime.status === 'skipped') {
    core.setOutput('reviewrouter_skipped_reason', runtime.reason);
    core.warning(`Codex OAuth rotating review skipped: ${runtime.reason}`);
    return;
  }
  if (runtime.review.blockingFailure) {
    core.setFailed(runtime.review.blockingFailure);
  }
}

function readCodexOAuthActionInputs() {
  const apiUrl = readInput('api-url') || readEnv('REVIEWROUTER_API_URL');
  const providerInstanceId = readInput('provider-instance-id');
  const workflowSchemaVersion = Number(readInput('workflow-schema-version'));
  const audience = readInput('audience') || 'reviewrouter';
  const event = readPullRequestEvent();
  if (!apiUrl) {
    throw new Error('codex_oauth_api_url_missing');
  }
  if (!providerInstanceId) {
    throw new Error('codex_oauth_provider_instance_id_missing');
  }
  if (!Number.isInteger(workflowSchemaVersion) || workflowSchemaVersion <= 0) {
    throw new Error('codex_oauth_workflow_schema_version_invalid');
  }
  return {
    apiUrl,
    audience,
    providerInstanceId,
    workflowSchemaVersion,
    providerSecrets: readCodexRotatingProviderSecretInputs(),
    repository: event.repository,
    headSha: event.headSha,
    workspacePath: process.env.GITHUB_WORKSPACE || process.cwd(),
  };
}

async function runReviewComputation(input: {
  apiUrl: string;
  audience: string;
  checkoutToken: string;
  codexHome: string;
  codexBinaryPath?: string;
  fetchImpl?: FetchLike;
  providerSecrets: CodexRotatingProviderSecretInputs;
}) {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCodexBinary = process.env.REVIEWROUTER_CODEX_BINARY;
  const previousPath = process.env.PATH;
  const previousProgress = process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
  try {
    process.env.CODEX_HOME = input.codexHome;
    if (input.codexBinaryPath) {
      process.env.REVIEWROUTER_CODEX_BINARY = input.codexBinaryPath;
      const codexBinDir = path.dirname(input.codexBinaryPath);
      process.env.PATH = previousPath
        ? `${codexBinDir}${path.delimiter}${previousPath}`
        : codexBinDir;
    }
    process.env.REVIEW_ROUTER_PROGRESS_COMMENTS = 'never';

    await applyCodexRotatingReviewRuntimeConfig({
      apiUrl: input.apiUrl,
      audience: input.audience,
      fetchImpl: input.fetchImpl,
    });
    applyCodexRotatingProviderSecretInputs(input.providerSecrets);

    const config = ConfigLoader.load();
    const userDryRun = config.dryRun;
    config.dryRun = true;
    const components = await createComponents(config, input.checkoutToken);
    const prNumber = readPullRequestEvent().number;
    const review = await new ReviewOrchestrator(components).execute(prNumber);

    if (review) {
      core.setOutput('findings_count', review.findings.length);
      core.setOutput(
        'critical_count',
        review.findings.filter((finding) => finding.severity === 'critical')
          .length
      );
      core.setOutput('cost_usd', review.metrics.totalCost.toFixed(4));
      core.setOutput('total_cost', review.metrics.totalCost.toFixed(4));
      if (review.aiAnalysis) {
        core.setOutput('ai_likelihood', review.aiAnalysis.averageLikelihood);
      }
    }

    return {
      skipped: !review,
      userDryRun,
      review,
      markdown: review ? components.formatter.format(review) : '',
      blockingFailure: review
        ? formatBlockingFindingFailure(
            review,
            ConfigLoader.load().failOnSeverity
          )
        : undefined,
    };
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousProgress === undefined) {
      delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    } else {
      process.env.REVIEW_ROUTER_PROGRESS_COMMENTS = previousProgress;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousCodexBinary === undefined) {
      delete process.env.REVIEWROUTER_CODEX_BINARY;
    } else {
      process.env.REVIEWROUTER_CODEX_BINARY = previousCodexBinary;
    }
    clearCodexRotatingProviderSecretEnv();
  }
}

export async function applyCodexRotatingReviewRuntimeConfig(input: {
  apiUrl: string;
  audience: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  process.env.REVIEWROUTER_RUNTIME_CONFIG_MODE = 'oidc';
  process.env.REVIEWROUTER_API_URL = input.apiUrl;
  process.env.REVIEWROUTER_OIDC_AUDIENCE = input.audience;
  process.env.REVIEWROUTER_STATIC_CONFIG_FALLBACK = 'false';

  await applyControlPlaneRuntimeConfig({
    fetchImpl: input.fetchImpl,
    logger: {
      info: core.info,
      warn: (message) => core.warning(message),
    },
  });
}

async function postReviewAfterAuthClear(input: {
  commentToken: string;
  review: CodexOAuthReviewResult;
}): Promise<void> {
  if (
    input.review.skipped ||
    input.review.userDryRun ||
    !input.review.markdown
  ) {
    return;
  }
  const prNumber = readPullRequestEvent().number;
  const config = ConfigLoader.load();
  const githubClient = new GitHubClient(input.commentToken);
  const poster = new CommentPoster(githubClient, false, config);
  await poster.postSummary(prNumber, input.review.markdown, false);
}

function readPullRequestEvent(): {
  repository: string;
  number: number;
  headSha: string;
} {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('codex_oauth_github_event_path_missing');
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
    repository?: { full_name?: unknown };
    pull_request?: {
      number?: unknown;
      head?: { sha?: unknown; repo?: { full_name?: unknown } };
    };
  };
  const repository = event.repository?.full_name;
  const prNumber = event.pull_request?.number;
  const headRepository = event.pull_request?.head?.repo?.full_name;
  const headSha = event.pull_request?.head?.sha;
  if (
    typeof repository !== 'string' ||
    typeof headRepository !== 'string' ||
    repository !== headRepository
  ) {
    throw new Error('codex_oauth_pull_request_must_be_same_repository');
  }
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber)) {
    throw new Error('codex_oauth_pr_number_invalid');
  }
  if (typeof headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(headSha)) {
    throw new Error('codex_oauth_head_sha_invalid');
  }
  return { repository, number: prNumber, headSha };
}

function readInput(name: string): string {
  const direct = core.getInput(name);
  if (direct) return direct;
  return (
    process.env[`INPUT_${name.toUpperCase()}`] ||
    process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ||
    ''
  );
}

function readEnv(name: string): string {
  return process.env[name]?.trim() || '';
}
