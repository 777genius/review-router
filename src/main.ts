import * as core from './actions/core';
import * as fs from 'fs';
import { ConfigLoader } from './config/loader';
import { createComponents } from './setup';
import { ReviewOrchestrator } from './core/orchestrator';
import {
  validateRequired,
  validatePositiveInteger,
  ValidationError,
  formatValidationError,
} from './utils/validation';
import { Severity, Review } from './types';
import {
  clearReviewFailureSummaries,
  postReviewFailureSummary,
} from './github/failure-summary';
import {
  formatActionError,
  normalizeReviewError,
} from './errors/review-router-error';
import { GitHubClient } from './github/client';
import { ReviewLedger } from './github/ledger';
import { ReviewInteractionHandler } from './github/interaction';
import {
  loadDiscussionOptionsFromEnv,
  ReviewDiscussionHandler,
} from './github/discussion';
import { CodexDiscussionResponder } from './discussion/codex-responder';
import {
  applyControlPlaneRuntimeConfig,
  RuntimeConfigResult,
} from './control-plane/runtime-config';
import { resolveGitHubCommentToken } from './control-plane/comment-token';
import { reportControlPlaneActionHealth } from './control-plane/health-report';
import { resolveProviderCliPlan } from './control-plane/provider-cli-plan';
import {
  countPreviousStillValidBySeverity,
  isLinkedCurrentFinding,
} from './analysis/thread-lifecycle';

function syncEnvFromInputs(): void {
  const inputKeys = [
    'REVIEW_ROUTER_MODE',
    'REVIEW_ROUTER_LEDGER_KEY',
    'REVIEW_ROUTER_ALLOW_AUTHOR_SKIP',
    'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE',
    'REVIEW_ROUTER_DISCUSSION_MODE',
    'REVIEW_ROUTER_DISCUSSION_MAX_PER_PR',
    'REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD',
    'REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS',
    'REVIEW_PROVIDERS',
    'FALLBACK_PROVIDERS',
    'SYNTHESIS_MODEL',
    'CODEX_MODEL',
    'CLAUDE_MODEL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'INLINE_MAX_COMMENTS',
    'INLINE_MIN_SEVERITY',
    'INLINE_MIN_AGREEMENT',
    'MIN_CHANGED_LINES',
    'MAX_CHANGED_FILES',
    'SKIP_LABELS',
    'PROVIDER_LIMIT',
    'PROVIDER_RETRIES',
    'PROVIDER_MAX_PARALLEL',
    'CODEX_HEALTHCHECK_MODE',
    'CODEX_HEALTHCHECK_REASONING_EFFORT',
    'CODEX_REASONING_EFFORT',
    'CODEX_AGENTIC_CONTEXT',
    'CODEX_EVENT_AUDIT',
    'FAIL_ON_NO_HEALTHY_PROVIDERS',
    'QUIET_MODE_ENABLED',
    'QUIET_MIN_CONFIDENCE',
    'QUIET_USE_LEARNING',
    'LEARNING_ENABLED',
    'LEARNING_MIN_FEEDBACK_COUNT',
    'DIFF_MAX_BYTES',
    'SMART_DIFF_COMPACTION',
    'MAX_FULL_DIFF_FILE_BYTES',
    'MAX_FULL_DIFF_FILE_CHANGES',
    'ENABLE_TOKEN_AWARE_BATCHING',
    'TARGET_TOKENS_PER_BATCH',
    'RUN_TIMEOUT_SECONDS',
    'BUDGET_MAX_USD',
    'ENABLE_AST_ANALYSIS',
    'ENABLE_SECURITY',
    'ENABLE_CACHING',
    'ENABLE_TEST_HINTS',
    'ENABLE_AI_DETECTION',
    'INCREMENTAL_ENABLED',
    'INCREMENTAL_CACHE_TTL_DAYS',
    'GRAPH_ENABLED',
    'GRAPH_CACHE_ENABLED',
    'GRAPH_MAX_DEPTH',
    'GRAPH_TIMEOUT_SECONDS',
    'SKIP_TRIVIAL_CHANGES',
    'SKIP_DEPENDENCY_UPDATES',
    'SKIP_DOCUMENTATION_ONLY',
    'SKIP_FORMATTING_ONLY',
    'SKIP_TEST_FIXTURES',
    'SKIP_CONFIG_FILES',
    'SKIP_BUILD_ARTIFACTS',
    'TRIVIAL_PATTERNS',
    'PATH_BASED_INTENSITY',
    'PATH_INTENSITY_PATTERNS',
    'PATH_DEFAULT_INTENSITY',
    'MIN_CONFIDENCE',
    'CONSENSUS_REQUIRED_FOR_CRITICAL',
    'CONSENSUS_MIN_AGREEMENT',
    'SUGGESTION_SYNTAX_VALIDATION',
    'UPDATE_PR_DESCRIPTION',
    'FAIL_ON_CRITICAL',
    'FAIL_ON_MAJOR',
    'FAIL_ON_SEVERITY',
    'REPORT_BASENAME',
    'DRY_RUN',
    'REVIEWROUTER_COMMENT_TOKEN_MODE',
    'REVIEW_THREAD_LIFECYCLE',
    'REVIEW_THREAD_LIFECYCLE_MAX_TARGETS',
    'REVIEW_THREAD_LIFECYCLE_RESOLVE_CONFIDENCE',
    'REVIEW_THREAD_LIFECYCLE_TRUSTED_AUTHORS',
    'REVIEW_ROUTER_TRUSTED_BOT_AUTHORS',
    'REVIEW_APP_SLUG',
    'REVIEW_APP_BOT_LOGIN',
    'REVIEW_ROUTER_APP_SLUG',
    'REVIEW_ROUTER_APP_BOT_LOGIN',
  ];

  for (const key of inputKeys) {
    const value = core.getInput(key);
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function run(): Promise<void> {
  let token: string | undefined;
  let prNumber: number | undefined;
  let runtimeConfig: RuntimeConfigResult | undefined;
  const startedAt = new Date();

  try {
    syncEnvFromInputs();
    runtimeConfig = await applyControlPlaneRuntimeConfig({
      logger: {
        info: core.info,
        warn: (message) => core.warning(message),
      },
    });

    const mode =
      process.env.REVIEW_ROUTER_MODE || core.getInput('REVIEW_ROUTER_MODE');
    if (mode === 'runtime-preflight') {
      runRuntimePreflight(runtimeConfig);
      return;
    }

    token = core.getInput('GITHUB_TOKEN') || process.env.GITHUB_TOKEN;

    validateRequired(token, 'GITHUB_TOKEN');
    const commentToken = await resolveGitHubCommentToken({
      fallbackToken: token!,
      runtimeConfig,
      logger: {
        info: core.info,
        warn: (message) => core.warning(message),
      },
    });
    const fallbackToken = token;
    token = commentToken.token;
    process.env.REVIEW_ROUTER_COMMENT_TOKEN_STATUS = commentToken.status;

    if (
      mode === 'interaction'
    ) {
      await runInteraction(token!, fallbackToken);
      return;
    }
    if (mode === 'interaction-preflight') {
      await runInteractionPreflight(token!);
      return;
    }

    const config = ConfigLoader.load();
    const components = await createComponents(config, token!, {
      fallbackGithubToken: fallbackToken,
    });
    const orchestrator = new ReviewOrchestrator(components);

    const prInput = core.getInput('PR_NUMBER') || process.env.PR_NUMBER;
    validateRequired(prInput, 'PR_NUMBER');

    prNumber = validatePositiveInteger(prInput, 'PR_NUMBER');

    if (config.dryRun) {
      core.info(
        '🔍 DRY RUN MODE - Review will run but no comments will be posted'
      );
    }

    core.info(`Starting review for PR #${prNumber}`);
    const review = await orchestrator.execute(prNumber);

    if (!review) {
      core.info('Review skipped');
      await reportControlPlaneActionHealth({
        runtimeConfig,
        review,
        startedAt,
        logger: {
          info: core.info,
          warn: (message) => core.warning(message),
        },
      });
      return;
    }

    await clearReviewFailureSummaries(token, prNumber);

    const previousStillValidCounts = countPreviousStillValidBySeverity(
      review.threadLifecycle
    );
    const previousStillValidTotal =
      previousStillValidCounts.critical +
      previousStillValidCounts.major +
      previousStillValidCounts.minor;
    core.setOutput(
      'findings_count',
      review.findings.length + previousStillValidTotal
    );
    core.setOutput(
      'critical_count',
      review.findings.filter((f) => f.severity === 'critical').length +
        previousStillValidCounts.critical
    );
    core.setOutput('cost_usd', review.metrics.totalCost.toFixed(4));
    core.setOutput('total_cost', review.metrics.totalCost.toFixed(4));
    if (review.aiAnalysis) {
      core.setOutput('ai_likelihood', review.aiAnalysis.averageLikelihood);
    }

    const blockingFindings = getBlockingFindings(review, config.failOnSeverity);
    if (blockingFindings.length > 0) {
      await reportControlPlaneActionHealth({
        runtimeConfig,
        review,
        startedAt,
        logger: {
          info: core.info,
          warn: (message) => core.warning(message),
        },
      });
      core.setFailed(
        `ReviewRouter found ${blockingFindings.length} ${config.failOnSeverity}+ finding(s). ` +
          'Review comments were posted before failing this check.'
      );
      return;
    }

    await reportControlPlaneActionHealth({
      runtimeConfig,
      review,
      startedAt,
      logger: {
        info: core.info,
        warn: (message) => core.warning(message),
      },
    });
    core.info('Review completed successfully');
  } catch (error) {
    const presentableError =
      error instanceof ValidationError
        ? new Error(`Configuration error:\n${formatValidationError(error)}`)
        : error;
    const normalizedError = normalizeReviewError(presentableError);

    core.setFailed(formatActionError(normalizedError));

    await postReviewFailureSummary(normalizedError, token, prNumber);
    await reportControlPlaneActionHealth({
      runtimeConfig,
      error: normalizedError,
      startedAt,
      logger: {
        info: core.info,
        warn: (message) => core.warning(message),
      },
    });

    // core.setFailed() sets process.exitCode, so explicit process.exit() is unnecessary
    // Removed process.exit(1) to allow proper cleanup and resource disposal
  }
}

function runRuntimePreflight(
  runtimeConfig: RuntimeConfigResult | undefined
): void {
  const plan = resolveProviderCliPlan(process.env);
  core.setOutput('runtime_config_status', runtimeConfig?.status || 'unknown');
  core.setOutput('codex_cli_needed', plan.codexCliNeeded ? 'true' : 'false');
  core.setOutput('claude_cli_needed', plan.claudeCliNeeded ? 'true' : 'false');
  core.info(
    `ReviewRouter runtime preflight: status=${runtimeConfig?.status || 'unknown'}, codex_cli_needed=${plan.codexCliNeeded}, claude_cli_needed=${plan.claudeCliNeeded}.`
  );
}

function getBlockingFindings(
  review: Review,
  threshold: Severity | 'off' | undefined
) {
  if (!threshold || threshold === 'off') return [];

  const rank: Record<Severity, number> = {
    critical: 3,
    major: 2,
    minor: 1,
  };
  const minRank = rank[threshold];
  const currentBlocking = review.findings.filter(
    (finding) => rank[finding.severity] >= minRank
  );
  const previousBlocking = (review.threadLifecycle?.previousStillValid ?? [])
    .filter((record) => !isLinkedCurrentFinding(record))
    .filter((record) => {
      const severity = record.target.severity;
      return (
        (severity === 'critical' ||
          severity === 'major' ||
          severity === 'minor') &&
        rank[severity] >= minRank
      );
    });

  return [...currentBlocking, ...previousBlocking];
}

async function runInteraction(
  token: string,
  actionsToken?: string
): Promise<void> {
  const githubClient = new GitHubClient(token);
  const actionsClient =
    actionsToken && actionsToken !== token
      ? new GitHubClient(actionsToken)
      : githubClient;
  const ledger = new ReviewLedger(
    githubClient,
    process.env.REVIEW_ROUTER_LEDGER_KEY,
    /^true$/i.test(process.env.DRY_RUN || '')
  );
  const discussionHandler = createDiscussionHandler(githubClient);
  const handler = new ReviewInteractionHandler(
    githubClient,
    ledger,
    discussionHandler,
    actionsClient
  );
  await handler.execute();
}

async function runInteractionPreflight(token: string): Promise<void> {
  const githubClient = new GitHubClient(token);
  const discussionHandler = createDiscussionHandler(githubClient);
  const payload = JSON.parse(
    fs.readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8')
  );
  const command = String(payload?.comment?.body || '')
    .trim()
    .startsWith('/rr ');
  const result = command
    ? {
        shouldRun: true,
        needsDiscussion: false,
        reason: 'ReviewRouter command',
      }
    : await discussionHandler.preflight(payload);

  core.setOutput('should_run', result.shouldRun ? 'true' : 'false');
  core.setOutput('needs_discussion', result.needsDiscussion ? 'true' : 'false');
  core.setOutput('reason', result.reason);
  core.info(
    `Interaction preflight: should_run=${result.shouldRun}, needs_discussion=${result.needsDiscussion}, reason=${result.reason}`
  );
}

function createDiscussionHandler(
  githubClient: GitHubClient
): ReviewDiscussionHandler {
  const options = loadDiscussionOptionsFromEnv();
  const model = process.env.CODEX_MODEL || 'gpt-5.5';
  const timeoutSeconds = parsePositiveInteger(
    process.env.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS,
    60
  );
  const responder =
    options.mode === 'off'
      ? undefined
      : new CodexDiscussionResponder(model, timeoutSeconds * 1000);

  return new ReviewDiscussionHandler(githubClient, responder, options);
}

function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number
): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

// core.setFailed() in run() sets process.exitCode, so we don't need explicit process.exit()
// This allows proper cleanup and is the recommended pattern for GitHub Actions
run().catch((error) => {
  core.setFailed(`Unhandled error: ${error.message}`);
});
