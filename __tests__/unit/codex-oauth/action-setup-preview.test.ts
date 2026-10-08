import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import https, { type RequestOptions as HttpsRequestOptions } from 'node:https';
import * as safeCheckout from '../../../src/codex-oauth/safe-checkout';
import * as terminalPublication from '../../../src/codex-oauth/terminal-outcome-publication';
import { canonicalJson } from '../../../src/context-gateway/context-gateway-contract';
import { mapOrchestrationResultToCodexOutcome } from '../../../src/review-orchestration/infrastructure/production-t0-review-runner';
import {
  ReviewOrchestrationResultStatus,
  ReviewPublicationState,
} from '../../../src/review-orchestration/application';
import {
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  ReviewPublicationStatusResultStatus,
  ReviewRunAuthorizationResultStatus,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import * as core from '../../../src/actions/core';
import { runCodexOAuthRotatingRuntime } from '../../../src/codex-oauth/runtime';
import {
  runCodexOAuthRotatingAction,
  type CodexOAuthTerminalOutcomeReport,
} from '../../../src/codex-oauth/action';
import {
  TerminalOutcomePublicationUseCase,
  type TerminalOutcomePublicationGitHubPort,
} from '../../../src/codex-oauth/terminal-outcome-publication';
import {
  CodexOAuthReviewRuntimeMode,
  CodexOAuthV2CancellationReason,
  CodexOAuthV2MergeGateFailureCode,
  CodexOAuthV2ReviewOutcome,
  CodexOAuthV2TerminalReason,
  type CodexOAuthV2ReviewResult,
  type CodexOAuthV2ReviewRunnerPort,
} from '../../../src/codex-oauth/runtime';
import { MergeGateConclusion } from '../../../src/review-projection/domain';
import {
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../../src/control-plane/review-action-v2-client';
import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import { ReviewPublicationUnavailableFact } from '../../../src/review-orchestration/application';
import {
  ReviewActionV2RuntimeMode,
  type ReviewActionV2Activation,
} from '../../../src/control-plane/review-action-v2-contract';

jest.mock('../../../src/codex-oauth/runtime', () => ({
  ...jest.requireActual('../../../src/codex-oauth/runtime'),
  runCodexOAuthRotatingRuntime: jest.fn(),
}));

const mockedRuntime = runCodexOAuthRotatingRuntime as jest.MockedFunction<
  typeof runCodexOAuthRotatingRuntime
>;

describe('Codex OAuth rotating setup PR preview', () => {
  const originalEnv = process.env;
  let tempDir: string;
  let eventPath: string;
  let outputPath: string;
  let stepSummaryPath: string;

  beforeEach(() => {
    process.exitCode = undefined;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-codex-preview-'));
    eventPath = path.join(tempDir, 'event.json');
    outputPath = path.join(tempDir, 'output');
    stepSummaryPath = path.join(tempDir, 'step-summary.md');
    mockedRuntime.mockReset();
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'stale_queued_secret',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    process.exitCode = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips setup PR preview before the Codex auth secret is configured', async () => {
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'reviewrouter/setup',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).not.toHaveBeenCalled();
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'reviewrouter_skipped_reason'
    );
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'setup_pr_waiting_for_codex_auth'
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('does not skip ordinary pull requests when the Codex auth secret is missing', async () => {
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    const [runtimeInput, runtimePorts] = mockedRuntime.mock.calls[0];
    expect(runtimeInput.workspacePath).toBe(process.env.GITHUB_WORKSPACE);
    expect(runtimeInput).not.toHaveProperty('reviewMode');
    expect(runtimePorts.controlPlane).toHaveProperty('commentToken');
    expect(runtimePorts).toHaveProperty('comments');
    expect(runtimePorts).toHaveProperty('review');
    expect(runtimePorts).not.toHaveProperty('v2Review');
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'stale_queued_secret'
    );
  });

  it('does not skip setup PR preview when Codex auth is already configured', async () => {
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'reviewrouter/setup',
      }),
      INPUT_AUTH_JSON: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-token' },
      }),
    };

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('fails closed when runtime skips after setup because review did not run', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'permission_required',
    });
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'permission_required'
    );
  });

  it('reports a server-authoritative size skip and fails the workflow', async () => {
    mockedRuntime.mockImplementation(async () => {
      expect(process.env['INPUT_OPENROUTER-API-KEY']).toBe(
        'provider-secret-not-read-before-admission'
      );
      return {
        status: 'skipped',
        reason: 'max_changed_lines_exceeded',
        changedLines: 346_978,
        maxChangedLines: 250_000,
        decisionHash: 'a'.repeat(64),
      };
    });
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      'INPUT_OPENROUTER-API-KEY': 'provider-secret-not-read-before-admission',
    };
    const terminalOutcomeReporter = {
      post: jest.fn(
        async (_report: CodexOAuthTerminalOutcomeReport) => undefined
      ),
    };

    await runCodexOAuthRotatingAction({ terminalOutcomeReporter });

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(mockedRuntime.mock.calls[0]![0]).toMatchObject({
      pullRequestNumber: 1,
    });
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'max_changed_lines_exceeded'
    );
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review skipped'
    );
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain('346,978');
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:max-changed-lines-exceeded -->',
        dedupeKey: 'max_changed_lines_exceeded',
        body: expect.stringContaining(
          'ReviewRouter did not start a model review'
        ),
        stepSummary: expect.not.stringContaining('reviewrouter:codex-oauth'),
        commitStatus: {
          state: 'failure',
          description: 'Review skipped: PR exceeds configured safety limit.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('fails closed when size-skip comment lookup and failure-status publication both fail', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'max_changed_lines_exceeded',
      changedLines: 346_978,
      maxChangedLines: 250_000,
      decisionHash: 'a'.repeat(64),
    });
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });
    const listPullRequestComments = jest.fn(
      async (
        _input: Parameters<
          TerminalOutcomePublicationGitHubPort['listPullRequestComments']
        >[0]
      ) => {
        throw new Error('comment lookup unavailable');
      }
    );
    const createCommitStatus = jest.fn(
      async (
        _input: Parameters<
          TerminalOutcomePublicationGitHubPort['createCommitStatus']
        >[0]
      ) => {
        throw new Error('failure status unavailable');
      }
    );
    const terminalOutcomeReporter = terminalPublicationReporter({
      listPullRequestComments,
      createCommitStatus,
    });

    await runCodexOAuthRotatingAction({ terminalOutcomeReporter });

    expect(listPullRequestComments).toHaveBeenCalledTimes(1);
    expect(createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({ state: 'failure' }),
      })
    );
    expect(process.exitCode).toBe(1);
  });

  it('fails closed when size-skip comment creation fails after publishing the failure status', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'max_changed_lines_exceeded',
      changedLines: 346_978,
      maxChangedLines: 250_000,
      decisionHash: 'a'.repeat(64),
    });
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });
    const createPullRequestComment = jest.fn(
      async (
        _input: Parameters<
          TerminalOutcomePublicationGitHubPort['createPullRequestComment']
        >[0]
      ) => {
        throw new Error('comment creation unavailable');
      }
    );
    const createCommitStatus = jest.fn(
      async (
        _input: Parameters<
          TerminalOutcomePublicationGitHubPort['createCommitStatus']
        >[0]
      ) => undefined
    );
    const terminalOutcomeReporter = terminalPublicationReporter({
      createPullRequestComment,
      createCommitStatus,
    });

    await runCodexOAuthRotatingAction({ terminalOutcomeReporter });

    expect(createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({ state: 'failure' }),
      })
    );
    expect(process.exitCode).toBe(1);
  });

  it('uses an OIDC request snapshot for terminal outcome reports after runtime cleanup', async () => {
    mockedRuntime.mockImplementation(async (_input, ports) => {
      expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
        'runner-oidc-request-token'
      );
      if (!ports.lifecycle?.clearOidcEnv) {
        throw new Error('expected lifecycle OIDC cleanup port');
      }
      ports.lifecycle.clearOidcEnv();
      expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(process.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
      return {
        status: 'skipped',
        reason: 'max_changed_lines_exceeded',
        changedLines: 346_978,
        maxChangedLines: 250_000,
        decisionHash: 'a'.repeat(64),
      };
    });
    const fetchImpl = jest.fn(async (url, init) => {
      const urlText = String(url);
      if (
        urlText.startsWith(
          'https://token.actions.githubusercontent.com/request'
        )
      ) {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer runner-oidc-request-token'
        );
        return jsonResponse({ value: 'runner-oidc-token' });
      }
      if (
        urlText ===
        'https://api.reviewrouter.site/api/action/v1/session/exchange'
      ) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          oidcToken: 'runner-oidc-token',
          audience: 'reviewrouter',
        });
        return jsonResponse({
          protocolVersion: 1,
          sessionToken: 'action-session-token',
        });
      }
      if (
        urlText === 'https://api.reviewrouter.site/api/action/v1/comment-token'
      ) {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer action-session-token'
        );
        return jsonResponse({ protocolVersion: 1 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL:
        'https://token.actions.githubusercontent.com/request',
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };

    await runCodexOAuthRotatingAction({ fetchImpl });

    expect(process.exitCode).toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://token.actions.githubusercontent.com/request'
      ),
      expect.any(Object)
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.reviewrouter.site/api/action/v1/session/exchange',
      expect.any(Object)
    );
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review skipped'
    );
  });

  it('reports lane-busy partial v2 reviews without duplicating the server summary', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
        reason: CodexOAuthV2TerminalReason.RequiredProviderLaneBusy,
        blockingFailure: 'required_provider_lane_busy',
      },
    });
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      status: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: {
        mode: ReviewActionV2RuntimeMode.T0,
        handoff: {
          saasSourceCommit: 'a'.repeat(40),
          expectedPublicActionBaseCommit: 'b'.repeat(40),
          schemaDigest: 'c'.repeat(64),
          canonicalizerDigest: 'd'.repeat(64),
          goldenFixtureDigest: 'e'.repeat(64),
          generatedFileCount: 8,
        },
      },
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review delayed'
    );
    expect(terminalOutcomeReporter.post).not.toHaveBeenCalled();
    expect(terminalOutcomeReporter.clear).toHaveBeenCalledWith({
      reason: 'server_summary_published',
    });
    expect(terminalOutcomeReporter.status).toHaveBeenCalledWith({
      state: 'failure',
      description: 'Review delayed: provider lanes are busy.',
      context: 'ReviewRouter',
    });
  });

  it('reports unavailable revision reads as a retryable delayed outcome', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason: CodexOAuthV2TerminalReason.RevisionGuardUnavailable,
        blockingFailure: 'review_action_v2_revision_guard_unavailable',
      },
    });
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: {
        mode: ReviewActionV2RuntimeMode.T0,
        handoff: {
          saasSourceCommit: 'a'.repeat(40),
          expectedPublicActionBaseCommit: 'b'.repeat(40),
          schemaDigest: 'c'.repeat(64),
          canonicalizerDigest: 'd'.repeat(64),
          goldenFixtureDigest: 'e'.repeat(64),
          generatedFileCount: 8,
        },
      },
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:revision-unavailable -->',
        body: expect.stringContaining(
          'repository state temporarily unavailable'
        ),
        commitStatus: {
          state: 'failure',
          description:
            'Review delayed: repository state is temporarily unavailable.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('reports rejected revision reads as a repository verification failure', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason: CodexOAuthV2TerminalReason.RevisionGuardFailed,
        blockingFailure: 'review_action_v2_revision_guard_failed',
      },
    });
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: {
        mode: ReviewActionV2RuntimeMode.T0,
        handoff: {
          saasSourceCommit: 'a'.repeat(40),
          expectedPublicActionBaseCommit: 'b'.repeat(40),
          schemaDigest: 'c'.repeat(64),
          canonicalizerDigest: 'd'.repeat(64),
          goldenFixtureDigest: 'e'.repeat(64),
          generatedFileCount: 8,
        },
      },
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:revision-failed -->',
        body: expect.stringContaining('repository revision validation failed'),
        commitStatus: {
          state: 'error',
          description:
            'Review failed: repository revision could not be verified.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('reports exhausted provider capacity without disguising it as generic partial coverage', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason: CodexOAuthV2TerminalReason.ProviderCapacityUnavailable,
        blockingFailure: 'provider_capacity_unavailable',
      },
    });
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review unavailable'
    );
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:provider-capacity -->',
        body: expect.stringContaining(
          'provider capacity is temporarily unavailable'
        ),
        commitStatus: {
          state: 'failure',
          description: 'Review unavailable: provider capacity is exhausted.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('reports generic partial coverage without duplicating the server summary', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
        reason: CodexOAuthV2TerminalReason.RequiredReviewCoverageIncomplete,
        blockingFailure: 'required_review_coverage_incomplete',
      },
    });
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(
        async (_report: CodexOAuthTerminalOutcomeReport) => undefined
      ),
      clear: jest.fn(async () => undefined),
      status: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(terminalOutcomeReporter.post).not.toHaveBeenCalled();
    expect(terminalOutcomeReporter.clear).toHaveBeenCalledWith({
      reason: 'server_summary_published',
    });
    expect(terminalOutcomeReporter.status).toHaveBeenCalledWith({
      state: 'failure',
      description: 'Review incomplete: required coverage did not finish.',
      context: 'ReviewRouter',
    });
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review incomplete'
    );
  });

  it('reports superseded revisions as stale without publishing approval evidence', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: { outcome: CodexOAuthV2ReviewOutcome.Superseded },
    });
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:stale -->',
        body: expect.stringContaining('newer PR revision exists'),
        commitStatus: {
          state: 'failure',
          description: 'Review superseded by a newer PR revision.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it.each([
    [
      Object.assign(new Error('provider aborted before terminal output'), {
        name: 'AbortError',
      }),
      'review_action_v2_terminal_result_missing',
      'did not obtain a terminal review result from the provider',
    ],
    [
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          httpStatus: 403,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.Forbidden,
          issues: ['diagnostic-sensitive-sentinel'],
          cause: new Error('diagnostic-sensitive-sentinel'),
        }
      ),
      'review_action_v2_protocol_error operation=review_run_authorize http_status=403 error_code=forbidden',
      'ReviewRouter stopped without a terminal review result.',
    ],
    [
      new Error('diagnostic-sensitive-sentinel', {
        cause: new ReviewActionV2ClientError(
          ReviewActionV2ClientFailureCode.ProtocolError,
          ReviewActionV2OperationId.ReviewExecutionStart,
          {
            httpStatus: 403,
            protocolErrorCode: ReviewActionV2ProtocolErrorCode.Forbidden,
            issues: ['diagnostic-sensitive-sentinel'],
            cause: new Error('diagnostic-sensitive-sentinel'),
          }
        ),
      }),
      'review_action_v2_protocol_error operation=review_execution_start http_status=403 error_code=forbidden',
      'ReviewRouter stopped without a terminal review result.',
    ],
    [
      new Error('account_gateway_git_failed'),
      'account_gateway_git_failed',
      'ReviewRouter stopped without a terminal review result.',
    ],
    [
      new Error('diagnostic-sensitive-sentinel', {
        cause: new Error('diagnostic-sensitive-sentinel'),
      }),
      'review_action_v2_terminal_result_missing',
      'did not obtain a terminal review result from the provider',
    ],
    [
      new Error('review_action_v2_codex_provider_missing'),
      'review_action_v2_codex_provider_missing',
      'ReviewRouter stopped without a terminal review result.',
    ],
  ] as const)(
    'fails closed and safely diagnoses runtime failure %s',
    async (failure, code, summary) => {
      mockedRuntime.mockRejectedValue(failure);
      const setFailed = jest.spyOn(core, 'setFailed');
      process.env = {
        ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
        GITHUB_STEP_SUMMARY: stepSummaryPath,
        REVIEW_ROUTER_CI_PROGRESS_WRITES: 'true',
      };
      const terminalOutcomeReporter = {
        post: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
        status: jest.fn(async () => undefined),
      };

      await runCodexOAuthRotatingAction({
        reviewActionV2Activation: v2Activation(),
        terminalOutcomeReporter,
      });

      expect(process.exitCode).toBe(1);
      expect(setFailed).toHaveBeenCalledWith(code);
      expect(
        JSON.stringify(terminalOutcomeReporter.post.mock.calls)
      ).not.toContain('diagnostic-sensitive-sentinel');
      expect(fs.readFileSync(stepSummaryPath, 'utf8')).not.toContain(
        'diagnostic-sensitive-sentinel'
      );
      expect(terminalOutcomeReporter.clear).not.toHaveBeenCalled();
      expect(terminalOutcomeReporter.status).not.toHaveBeenCalled();
      expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(summary),
          commitStatus: expect.objectContaining({ state: 'error' }),
        })
      );
      expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
        '**Phase:** Review failed'
      );
      expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
        'Review units: 0 of 0 complete (0%)'
      );
      expect(fs.readFileSync(stepSummaryPath, 'utf8')).not.toContain(
        'Review completed'
      );
    }
  );

  it('fails closed when the v2 runtime returns no terminal review result', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: undefined,
    } as never);
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      status: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(terminalOutcomeReporter.clear).not.toHaveBeenCalled();
    expect(terminalOutcomeReporter.status).not.toHaveBeenCalled();
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:failed -->',
        commitStatus: {
          state: 'error',
          description: 'Review failed: no terminal provider result.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('finishes a closed pull request without a failure comment or failed job', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Cancelled,
        reason: CodexOAuthV2CancellationReason.PullRequestClosed,
      },
    });
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBeUndefined();
    expect(terminalOutcomeReporter.post).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        outcome: CodexOAuthV2ReviewOutcome.PublicationStale,
        reason: CodexOAuthV2TerminalReason.PublicationStale,
        blockingFailure: 'publication_request_revision_mismatch',
      } satisfies CodexOAuthV2ReviewResult,
      'publication-stale',
      'Review result stale',
    ],
    [
      {
        outcome: CodexOAuthV2ReviewOutcome.PublicationNotApplied,
        reason: CodexOAuthV2TerminalReason.PublicationConflict,
        blockingFailure: 'publication_request_conflict',
      } satisfies CodexOAuthV2ReviewResult,
      'publication-not-applied',
      'Review not published',
    ],
    [
      {
        outcome: CodexOAuthV2ReviewOutcome.PublicationUnavailable,
        reason: CodexOAuthV2TerminalReason.PublicationFactsUnavailable,
        unavailableFacts: [ReviewPublicationUnavailableFact.Lifecycle],
        blockingFailure: 'publication_facts_unavailable',
      } satisfies CodexOAuthV2ReviewResult,
      'publication-unavailable',
      'Review publication delayed',
    ],
  ] as const)(
    'never clears warnings or publishes success for %s',
    async (v2Review, markerKind, expectedTitle) => {
      mockedRuntime.mockResolvedValue({
        status: 'completed',
        publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
        v2Review,
      });
      process.env = {
        ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
        GITHUB_STEP_SUMMARY: stepSummaryPath,
      };
      const terminalOutcomeReporter = {
        post: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
        status: jest.fn(async () => undefined),
      };

      await runCodexOAuthRotatingAction({
        reviewActionV2Activation: v2Activation(),
        terminalOutcomeReporter,
      });

      expect(process.exitCode).toBe(1);
      expect(terminalOutcomeReporter.clear).not.toHaveBeenCalled();
      expect(terminalOutcomeReporter.status).not.toHaveBeenCalled();
      expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
        expect.objectContaining({
          marker: `<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${markerKind} -->`,
          body: expect.stringContaining(expectedTitle),
          commitStatus: expect.objectContaining({ state: 'failure' }),
        })
      );
      if (
        v2Review.outcome === CodexOAuthV2ReviewOutcome.PublicationUnavailable
      ) {
        expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.stringContaining(
              '| Unavailable publication fact | lifecycle |'
            ),
            commitStatus: expect.objectContaining({
              description:
                'Review publication delayed: current facts unavailable.',
            }),
          })
        );
      }
    }
  );

  it('wires verified v2 without exposing legacy comment capabilities', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: MergeGateConclusion.Pass,
      },
    });
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      GITHUB_RUN_ID: '123456789',
      GITHUB_SERVER_URL: 'https://github.example.com',
    };
    const v2ReviewRunner: CodexOAuthV2ReviewRunnerPort = {
      run: jest.fn(
        async (): Promise<CodexOAuthV2ReviewResult> => ({
          outcome: CodexOAuthV2ReviewOutcome.Completed,
          mergeGateConclusion: MergeGateConclusion.Pass,
        })
      ),
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      status: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: {
        mode: ReviewActionV2RuntimeMode.T0,
        handoff: {
          saasSourceCommit: 'a'.repeat(40),
          expectedPublicActionBaseCommit: 'b'.repeat(40),
          schemaDigest: 'c'.repeat(64),
          canonicalizerDigest: 'd'.repeat(64),
          goldenFixtureDigest: 'e'.repeat(64),
          generatedFileCount: 8,
        },
      },
      v2ReviewRunner,
      terminalOutcomeReporter,
    });

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    const [runtimeInput, runtimePorts] = mockedRuntime.mock.calls[0];
    expect(runtimeInput.reviewMode).toBe(
      CodexOAuthReviewRuntimeMode.ServerPublishedV2
    );
    expect(runtimeInput.workspacePath).not.toBe(process.env.GITHUB_WORKSPACE);
    expect(path.dirname(runtimeInput.workspacePath)).toBe(
      fs.realpathSync(process.env.RUNNER_TEMP!)
    );
    expect(fs.existsSync(runtimeInput.workspacePath)).toBe(false);
    expect(runtimePorts.controlPlane).not.toHaveProperty('commentToken');
    expect(runtimePorts).not.toHaveProperty('comments');
    expect(runtimePorts).not.toHaveProperty('review');
    expect(runtimePorts).toHaveProperty('v2Review', v2ReviewRunner);
    expect(terminalOutcomeReporter.post).not.toHaveBeenCalled();
    expect(terminalOutcomeReporter.clear).toHaveBeenCalledWith({
      reason: 'review_completed',
    });
    expect(terminalOutcomeReporter.status).toHaveBeenCalledWith({
      state: 'success',
      description: 'Review completed.',
      context: 'ReviewRouter',
      targetUrl:
        'https://github.example.com/Padelapp-Club/monitoring-service/actions/runs/123456789',
    });
    expect(
      terminalOutcomeReporter.status.mock.invocationCallOrder[0]
    ).toBeLessThan(terminalOutcomeReporter.clear.mock.invocationCallOrder[0]);
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'reviewrouter_v2_outcome'
    );
  });

  it('fails closed without clearing a prior failure when success status publication fails', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: MergeGateConclusion.Pass,
      },
    });
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      REVIEW_ROUTER_CI_PROGRESS_WRITES: 'true',
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      status: jest.fn(async () => {
        throw new Error('status service unavailable');
      }),
    };
    const setFailed = jest.spyOn(core, 'setFailed');

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(terminalOutcomeReporter.status).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success' })
    );
    expect(terminalOutcomeReporter.clear).not.toHaveBeenCalled();
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          'could not durably publish the terminal success status'
        ),
        commitStatus: expect.objectContaining({
          state: 'error',
          description: 'Review failed: success status publication failed.',
        }),
      })
    );
    expect(setFailed).toHaveBeenCalledWith(
      'review_action_v2_success_status_publication_failed'
    );
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      '**Phase:** Review failed'
    );
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).not.toContain(
      '**Phase:** Review complete'
    );
  });

  it.each([undefined, null, 'approved', {}, 42])(
    'rejects malformed completed merge gate conclusion %p',
    async (mergeGateConclusion) => {
      mockedRuntime.mockResolvedValue({
        status: 'completed',
        publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
        v2Review: {
          outcome: CodexOAuthV2ReviewOutcome.Completed,
          mergeGateConclusion,
        },
      } as never);
      process.env = {
        ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
        GITHUB_STEP_SUMMARY: stepSummaryPath,
      };
      const terminalOutcomeReporter = {
        post: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
        status: jest.fn(async () => undefined),
      };
      const setFailed = jest.spyOn(core, 'setFailed');

      await runCodexOAuthRotatingAction({
        reviewActionV2Activation: v2Activation(),
        terminalOutcomeReporter,
      });

      expect(terminalOutcomeReporter.status).not.toHaveBeenCalled();
      expect(terminalOutcomeReporter.clear).not.toHaveBeenCalled();
      expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('invalid merge gate conclusion'),
          commitStatus: expect.objectContaining({ state: 'error' }),
        })
      );
      expect(setFailed).toHaveBeenCalledWith(
        'review_action_v2_merge_gate_conclusion_invalid'
      );
      expect(process.exitCode).toBe(1);
    }
  );

  it.each([
    [
      MergeGateConclusion.Fail,
      CodexOAuthV2MergeGateFailureCode.Failed,
      'Review completed with blocking findings.',
    ],
    [
      MergeGateConclusion.Inconclusive,
      CodexOAuthV2MergeGateFailureCode.Inconclusive,
      'Review completed with an inconclusive merge gate.',
    ],
  ])(
    'fails the workflow after completed publication for merge gate %s',
    async (mergeGateConclusion, failureCode, description) => {
      const v2Review = {
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion,
      } as CodexOAuthV2ReviewResult;
      mockedRuntime.mockResolvedValue({
        status: 'completed',
        publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
        v2Review,
      });
      process.env = {
        ...actionEnv({
          eventPath,
          outputPath,
          headRef: 'feature/change',
        }),
        GITHUB_RUN_ID: '123456789',
        GITHUB_SERVER_URL: 'https://github.example.com',
      };
      const terminalOutcomeReporter = {
        post: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
        status: jest.fn(async () => undefined),
      };
      const setFailed = jest.spyOn(core, 'setFailed');

      await runCodexOAuthRotatingAction({
        reviewActionV2Activation: {
          mode: ReviewActionV2RuntimeMode.T0,
          handoff: {
            saasSourceCommit: 'a'.repeat(40),
            expectedPublicActionBaseCommit: 'b'.repeat(40),
            schemaDigest: 'c'.repeat(64),
            canonicalizerDigest: 'd'.repeat(64),
            goldenFixtureDigest: 'e'.repeat(64),
            generatedFileCount: 8,
          },
        },
        terminalOutcomeReporter,
      });

      expect(terminalOutcomeReporter.clear).toHaveBeenCalledWith({
        reason: 'review_completed',
      });
      expect(terminalOutcomeReporter.status).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'failure', description })
      );
      expect(process.exitCode).toBe(1);
      expect(setFailed).toHaveBeenCalledWith(failureCode);
      expect(fs.readFileSync(outputPath, 'utf8')).toContain(
        'reviewrouter_v2_outcome'
      );
    }
  );

  // These cases run the actual gateway Action/runtime and HTTP adapters. Only
  // source checkout and provider work are replaced at their existing boundaries.
  it.each([
    'completed',
    'blocking',
    'missing receipt',
    'opaque checkout failure',
    'admission denied',
    'admission denied with reporter',
  ] as const)(
    'keeps gateway terminal reporting within V2 authority: %s',
    async (scenario) => {
      const requests: {
        route: string;
        method: string;
        body: Record<string, unknown>;
      }[] = [];
      const fixtureErrors: unknown[] = [];
      const receiptHash = 'c'.repeat(64);
      const publicationAttemptId = 'publication-fixture-1';
      const denied = scenario.startsWith('admission denied');
      const opaqueFailure = scenario === 'opaque checkout failure';
      const secret = 'opaque-checkout-secret-sentinel';
      const server = createServer((request, response) => {
        void (async () => {
          const route = new URL(request.url ?? '/', 'http://fixture.invalid')
            .pathname;
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
          requests.push({ route, method: request.method ?? '', body });
          const reply = (value: unknown, status = 200) => {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(value));
          };
          if (route === '/oidc') return reply({ value: 'fixture.oidc.token' });
          if (route.startsWith('/api/action/v1/')) {
            return reply(
              { error: 'legacy_review_mutation_blocked:v2_only' },
              403
            );
          }
          const envelope = {
            protocolVersion: reviewActionV2PublishedProtocolVersion,
            schemaDigest: reviewActionV2PublishedSchemaDigest,
            requestId: body.requestId,
            serverTime: new Date().toISOString(),
          };
          if (route === '/api/action/v2/review-runs/authorize') {
            return denied
              ? reply(
                  {
                    ...envelope,
                    error: {
                      errorCode: 'forbidden',
                      retryClass: 'never',
                      details: { issues: ['fixture_admission_denied'] },
                    },
                  },
                  403
                )
              : reply({ ...envelope, result: gatewayFixtureAuthorization() });
          }
          if (route === '/api/action/v2/account-gateway/checkout') {
            expect(request.headers.authorization).toBe(
              'Bearer fixture.authorization'
            );
            return reply({
              protocolVersion: 1,
              repository: 'fixture/disposable-terminal-review',
              headSha: 'a'.repeat(40),
              token: 'fixture.read.token',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              permissions: { contents: 'read', pullRequests: 'read' },
              runtimeConfig: {
                protocolVersion: 1,
                configVersion: 1,
                runtimeEnv: {},
              },
            });
          }
          if (route === '/api/action/v2/review-publication/status') {
            expect(body.authorizationToken).toBe('fixture.authorization');
            expect(body.publicationAttemptId).toBe(publicationAttemptId);
            return reply({
              ...envelope,
              result: {
                status: ReviewPublicationStatusResultStatus.Terminal,
                publicationAttemptId,
                terminalOutcome: ReviewPublicationState.Succeeded,
                canonicalReceiptSetHash:
                  scenario === 'missing receipt' ? null : receiptHash,
                pollAfterMs: null,
              },
            });
          }
          if (route === '/api/action/v2/account-gateway/close') {
            expect(request.headers.authorization).toBe(
              'Bearer fixture.authorization'
            );
            return reply({ state: 'closed' });
          }
          // If a gateway progress comment regresses, observe the real Octokit
          // request here instead of sending it to GitHub.
          if (route.startsWith('/repos/')) {
            return reply(request.method === 'GET' ? [] : {});
          }
          throw new Error(`unexpected_fixture_route:${route}`);
        })().catch((error: unknown) => {
          fixtureErrors.push(error);
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{}');
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('fixture_address');
        const origin = `http://127.0.0.1:${address.port}`;
        const trustedOrigin = 'https://fixture.reviewrouter.invalid';
        const redirectGatewayRequest: typeof https.request = (
          url: string | URL | HttpsRequestOptions,
          options?: HttpsRequestOptions | ((response: IncomingMessage) => void),
          callback?: (response: IncomingMessage) => void
        ) => {
          if (
            !(url instanceof URL) ||
            url.origin !== trustedOrigin ||
            !options ||
            typeof options === 'function' ||
            !callback
          ) {
            throw new Error('fixture_external_https_request_denied');
          }
          return httpRequest(
            new URL(url.pathname + url.search, origin),
            options,
            callback
          );
        };
        jest.spyOn(https, 'request').mockImplementation(redirectGatewayRequest);
        const binary = path.join(tempDir, 'synthetic-codex.sh');
        fs.writeFileSync(binary, '#!/bin/sh\nprintf "codex-cli 0.147.0\\n"\n', {
          mode: 0o700,
        });
        const checkout = jest
          .spyOn(safeCheckout, 'safeCheckoutRepository')
          .mockImplementation(async () => {
            if (opaqueFailure) throw new Error(secret);
          });
        const actualPublicationClient =
          terminalPublication.createPublicationGitHubClient;
        const publicationClient = jest
          .spyOn(terminalPublication, 'createPublicationGitHubClient')
          .mockImplementation((token, options) => {
            const client = actualPublicationClient(token, options);
            client.octokit.hook.before('request', (request) => {
              request.baseUrl = origin;
              request.url = String(request.url).replace(
                /^https:\/\/api\.github\.com/,
                origin
              );
            });
            return client;
          });
        const setFailed = jest.spyOn(core, 'setFailed');
        const info = jest.spyOn(core, 'info');
        const warning = jest.spyOn(core, 'warning');
        const error = jest.spyOn(core, 'error');
        const fetchImpl: typeof fetch = (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input)
          );
          if (url.hostname === 'fixture.actions.githubusercontent.com') {
            return fetch(`${origin}/oidc${url.search}`, init);
          }
          if (url.origin !== trustedOrigin)
            throw new Error('fixture_external_fetch_denied');
          return fetch(new URL(url.pathname + url.search, origin), init);
        };
        process.env = {
          ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
          PATH: originalEnv.PATH,
          GITHUB_REPOSITORY: 'fixture/disposable-terminal-review',
          GITHUB_STEP_SUMMARY: stepSummaryPath,
          GITHUB_TOKEN: 'fixture.progress.token',
          REVIEW_ROUTER_MODE: 'account-gateway',
          REVIEW_ROUTER_CI_PROGRESS_WRITES: 'true',
          REVIEWROUTER_CODEX_BINARY: binary,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture.oidc.request',
          ACTIONS_ID_TOKEN_REQUEST_URL:
            'https://fixture.actions.githubusercontent.com/oidc',
          'INPUT_API-URL': trustedOrigin,
        };
        fs.writeFileSync(
          eventPath,
          JSON.stringify({
            repository: { full_name: process.env.GITHUB_REPOSITORY },
            pull_request: {
              number: 1,
              head: {
                ref: 'feature/change',
                repo: { full_name: process.env.GITHUB_REPOSITORY, fork: false },
                sha: 'a'.repeat(40),
              },
            },
          })
        );
        const review = jest.fn(
          async (input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]) => {
            const gateway = input.accountGateway;
            if (!gateway) throw new Error('gateway_context_missing');
            const status = await gateway.controlPlane.readPublicationStatus({
              authorization: gateway.controlPlane.currentAuthorization(),
              publicationAttemptId,
              timeoutMs: 5_000,
            });
            if (
              !status.terminal ||
              status.outcome.state !== ReviewPublicationState.Succeeded
            ) {
              throw new Error('fixture_publication_not_succeeded');
            }
            const orchestration = {
              status: ReviewOrchestrationResultStatus.Completed,
              publicationAttemptId,
              canonicalReceiptSetHash: status.outcome.canonicalReceiptSetHash,
              mergeGateConclusion:
                scenario === 'blocking'
                  ? MergeGateConclusion.Fail
                  : MergeGateConclusion.Pass,
            };
            return mapOrchestrationResultToCodexOutcome(orchestration);
          }
        );
        const reporter = {
          post: jest.fn(async () => undefined),
          clear: jest.fn(async () => undefined),
          status: jest.fn(async () => undefined),
        };
        await runCodexOAuthRotatingAction({
          fetchImpl,
          reviewActionV2Activation: v2Activation(),
          v2ReviewRunner: { run: review },
          ...(scenario === 'admission denied with reporter'
            ? { terminalOutcomeReporter: reporter }
            : {}),
        });

        expect(fixtureErrors).toEqual([]);
        expect(
          requests.filter(({ route }) => route.startsWith('/api/action/v1/'))
        ).toEqual([]);
        expect(
          requests.filter(
            ({ route }) =>
              route.startsWith('/repos/') || route.endsWith('/responses')
          )
        ).toEqual([]);
        expect(publicationClient).not.toHaveBeenCalled();
        expect(reporter.post).not.toHaveBeenCalled();
        expect(reporter.clear).not.toHaveBeenCalled();
        expect(reporter.status).not.toHaveBeenCalled();
        const output = fs.readFileSync(outputPath, 'utf8');
        const summary = fs.readFileSync(stepSummaryPath, 'utf8');
        const closes = requests.filter(({ route }) =>
          route.endsWith('/account-gateway/close')
        );
        if (denied) {
          expect(review).not.toHaveBeenCalled();
          expect(checkout).not.toHaveBeenCalled();
          expect(requests.map(({ route }) => route)).toEqual([
            '/oidc',
            '/api/action/v2/review-runs/authorize',
          ]);
          expect(closes).toEqual([]);
          expect(process.exitCode).toBe(1);
          expect(output).toContain('reviewrouter_state');
          expect(output).toContain('failed');
          expect(summary).toContain('operation=review_run_authorize');
        } else if (opaqueFailure) {
          expect(checkout).toHaveBeenCalledTimes(1);
          expect(review).not.toHaveBeenCalled();
          expect(requests.map(({ route }) => route)).toEqual([
            '/oidc',
            '/api/action/v2/review-runs/authorize',
            '/api/action/v2/account-gateway/checkout',
            '/api/action/v2/account-gateway/close',
          ]);
          expect(closes).toHaveLength(1);
          expect(closes[0].body).toEqual({ reason: 'failed' });
          expect(process.exitCode).toBe(1);
          expect(summary).toContain('Review failed');
          expect(warning).toHaveBeenCalledWith(
            'Account gateway runtime failed: phase=checkout'
          );
          const diagnostics = [
            output,
            summary,
            ...warning.mock.calls.flat(),
            ...error.mock.calls.flat(),
            ...info.mock.calls.flat(),
            ...setFailed.mock.calls.flat(),
          ].join('\n');
          expect(diagnostics).not.toContain(secret);
        } else {
          expect(review).toHaveBeenCalledTimes(1);
          expect(checkout).toHaveBeenCalledTimes(1);
          expect(
            requests.filter(({ route }) =>
              route.endsWith('/review-publication/status')
            )
          ).toHaveLength(1);
          expect(closes).toHaveLength(1);
          if (scenario === 'missing receipt') {
            expect(closes[0].body).toEqual({ reason: 'failed' });
            expect(process.exitCode).toBe(1);
            expect(output).toContain('failed');
            expect(summary).toContain('Review failed');
            expect(info.mock.calls.flat().join('\n')).not.toContain(
              'App publication completed:'
            );
          } else {
            expect(closes[0].body).toEqual({ reason: 'completed' });
            expect(
              requests.findIndex(({ route }) =>
                route.endsWith('/review-publication/status')
              )
            ).toBeLessThan(
              requests.findIndex(({ route }) =>
                route.endsWith('/account-gateway/close')
              )
            );
            expect(output).toContain('completed');
            expect(summary).toContain('**Phase:** Review complete');
            expect(info.mock.calls.flat().join('\n')).toContain(receiptHash);
            if (scenario === 'blocking') {
              expect(process.exitCode).toBe(1);
              expect(setFailed).toHaveBeenCalledWith(
                CodexOAuthV2MergeGateFailureCode.Failed
              );
            } else {
              expect(process.exitCode).toBeUndefined();
              expect(setFailed).not.toHaveBeenCalled();
            }
          }
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    15_000
  );

  it('uses the production T0 runner when no test runner is injected', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: MergeGateConclusion.Pass,
      },
    });
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: {
        mode: ReviewActionV2RuntimeMode.T0,
        handoff: {
          saasSourceCommit: 'a'.repeat(40),
          expectedPublicActionBaseCommit: 'b'.repeat(40),
          schemaDigest: 'c'.repeat(64),
          canonicalizerDigest: 'd'.repeat(64),
          goldenFixtureDigest: 'e'.repeat(64),
          generatedFileCount: 8,
        },
      },
    });

    const [, runtimePorts] = mockedRuntime.mock.calls[0];
    expect('v2Review' in runtimePorts).toBe(true);
    if (!('v2Review' in runtimePorts)) {
      throw new Error('expected production v2 review runner');
    }
    expect(runtimePorts.v2Review).toEqual(
      expect.objectContaining({ run: expect.any(Function) })
    );
    expect(runtimePorts.controlPlane).not.toHaveProperty('commentToken');
    expect(runtimePorts).not.toHaveProperty('comments');
    expect(runtimePorts).not.toHaveProperty('review');
  });
});

function actionEnv(input: {
  readonly eventPath: string;
  readonly outputPath: string;
  readonly headRef: string;
}): NodeJS.ProcessEnv {
  fs.writeFileSync(
    input.eventPath,
    JSON.stringify({
      repository: { full_name: 'Padelapp-Club/monitoring-service' },
      pull_request: {
        number: 1,
        head: {
          ref: input.headRef,
          repo: { full_name: 'Padelapp-Club/monitoring-service' },
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    })
  );

  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: input.eventPath,
    GITHUB_OUTPUT: input.outputPath,
    GITHUB_REPOSITORY: 'Padelapp-Club/monitoring-service',
    GITHUB_WORKSPACE: ensureDirectory(
      path.join(path.dirname(input.eventPath), 'github-workspace')
    ),
    RUNNER_TEMP: ensureDirectory(
      path.join(path.dirname(input.eventPath), 'runner-temp')
    ),
    'INPUT_API-URL': 'https://api.reviewrouter.site',
    'INPUT_PROVIDER-INSTANCE-ID': 'codex-rotating:1196598615',
    'INPUT_WORKFLOW-SCHEMA-VERSION': '1',
  };
}

function v2Activation(): ReviewActionV2Activation {
  return {
    mode: ReviewActionV2RuntimeMode.T0,
    handoff: {
      saasSourceCommit: 'a'.repeat(40),
      expectedPublicActionBaseCommit: 'b'.repeat(40),
      schemaDigest: 'c'.repeat(64),
      canonicalizerDigest: 'd'.repeat(64),
      goldenFixtureDigest: 'e'.repeat(64),
      generatedFileCount: 8,
    },
  };
}

function ensureDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function terminalPublicationReporter(
  overrides: Partial<jest.Mocked<TerminalOutcomePublicationGitHubPort>> = {}
): TerminalOutcomePublicationUseCase {
  const github = {
    listPullRequestComments: jest.fn(async () => []),
    createPullRequestComment: jest.fn(async () => undefined),
    updatePullRequestComment: jest.fn(async () => undefined),
    deletePullRequestComment: jest.fn(async () => undefined),
    createCommitStatus: jest.fn(async () => undefined),
    ...overrides,
  } as jest.Mocked<TerminalOutcomePublicationGitHubPort>;
  return new TerminalOutcomePublicationUseCase({
    context: {
      repository: 'Padelapp-Club/monitoring-service',
      pullRequestNumber: 1,
      headSha: 'a'.repeat(40),
    },
    github,
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function gatewayFixtureAuthorization() {
  return {
    status: ReviewRunAuthorizationResultStatus.Authorized,
    authorizationId: 'authorization-fixture',
    authorizationToken: 'fixture.authorization',
    producerReleaseId: 'release-fixture',
    protocolLimitsProfileId: 'limits-fixture',
    operationalSloProfileId: 'slo-fixture',
    mutationEpoch: '1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    protocolLimitsCanonicalJson: canonicalJson({
      maxAttemptsPerSlot: 3,
      maxLeaseDurationMs: 60_000,
      maxObservationBytes: 100_000,
      maxObservationFindings: 100,
      maxProjectionBytes: 200_000,
      maxProjectionFindings: 100,
      maxPublicationBodyBytes: 200_000,
      maxPublicationChunks: 20,
      maxPublicationOperations: 100,
      maxReconciliationDurationMs: 60_000,
      maxRequestBatchSize: 20,
      maxResultReportDurationMs: 60_000,
      maxWorkSlots: 10,
    }),
    authorizationFactsCanonicalJson: canonicalJson({
      workspaceId: 'workspace-fixture',
      repositoryConnectionId: 'connection-fixture',
      scmRepositoryIdentityId: 'repository-fixture',
      pullRequestNumber: 1,
      sourceRunId: 'run-fixture',
      sourceRunAttempt: '1',
      baseSha: '1'.repeat(40),
      mergeBaseSha: '2'.repeat(40),
      headSha: 'a'.repeat(40),
      reviewRevisionHash: '4'.repeat(64),
      trustDomain: 'github-actions',
      producerReleaseId: 'release-fixture',
      selectedProtocolVersion: 'review-action-v2',
      schemaDigest: reviewActionV2PublishedSchemaDigest,
      providerVoteLanes: [
        { providerKind: 'codex', providerVoteIdentityHash: '6'.repeat(64) },
      ],
    }),
  };
}
