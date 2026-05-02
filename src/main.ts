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
import { GitHubClient } from './github/client';
import { ReviewLedger } from './github/ledger';
import { ReviewInteractionHandler } from './github/interaction';
import {
  loadDiscussionOptionsFromEnv,
  ReviewDiscussionHandler,
} from './github/discussion';
import { CodexDiscussionResponder } from './discussion/codex-responder';

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

  try {
    syncEnvFromInputs();
    token = core.getInput('GITHUB_TOKEN') || process.env.GITHUB_TOKEN;

    validateRequired(token, 'GITHUB_TOKEN');

    if (
      (process.env.REVIEW_ROUTER_MODE ||
        core.getInput('REVIEW_ROUTER_MODE')) === 'interaction'
    ) {
      await runInteraction(token!);
      return;
    }
    if (
      (process.env.REVIEW_ROUTER_MODE ||
        core.getInput('REVIEW_ROUTER_MODE')) === 'interaction-preflight'
    ) {
      await runInteractionPreflight(token!);
      return;
    }

    const config = ConfigLoader.load();
    const components = await createComponents(config, token!);
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
      return;
    }

    await clearReviewFailureSummaries(token, prNumber);

    core.setOutput('findings_count', review.findings.length);
    core.setOutput(
      'critical_count',
      review.findings.filter((f) => f.severity === 'critical').length
    );
    core.setOutput('cost_usd', review.metrics.totalCost.toFixed(4));
    core.setOutput('total_cost', review.metrics.totalCost.toFixed(4));
    if (review.aiAnalysis) {
      core.setOutput('ai_likelihood', review.aiAnalysis.averageLikelihood);
    }

    const blockingFindings = getBlockingFindings(review, config.failOnSeverity);
    if (blockingFindings.length > 0) {
      core.setFailed(
        `ReviewRouter found ${blockingFindings.length} ${config.failOnSeverity}+ finding(s). ` +
          'Review comments were posted before failing this check.'
      );
      return;
    }

    core.info('Review completed successfully');
  } catch (error) {
    const err = error as Error;

    if (error instanceof ValidationError) {
      const formatted = formatValidationError(error);
      core.setFailed(`Configuration error:\n${formatted}`);
    } else {
      core.setFailed(`Review failed: ${err.message}`);

      // Add helpful context for common errors
      if (err.message.includes('ENOENT')) {
        core.error('File not found. Check that all file paths are correct.');
      } else if (err.message.includes('EACCES')) {
        core.error('Permission denied. Check file permissions.');
      } else if (err.message.includes('rate limit')) {
        core.error(
          'API rate limit exceeded. Consider using caching or reducing provider count.'
        );
      } else if (err.message.includes('timeout')) {
        core.error(
          'Operation timed out. Consider increasing the timeout value.'
        );
      }
    }

    await postReviewFailureSummary(err, token, prNumber);

    // core.setFailed() sets process.exitCode, so explicit process.exit() is unnecessary
    // Removed process.exit(1) to allow proper cleanup and resource disposal
  }
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
  return review.findings.filter((finding) => rank[finding.severity] >= minRank);
}

async function runInteraction(token: string): Promise<void> {
  const githubClient = new GitHubClient(token);
  const ledger = new ReviewLedger(
    githubClient,
    process.env.REVIEW_ROUTER_LEDGER_KEY,
    /^true$/i.test(process.env.DRY_RUN || '')
  );
  const discussionHandler = createDiscussionHandler(githubClient);
  const handler = new ReviewInteractionHandler(
    githubClient,
    ledger,
    discussionHandler
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
