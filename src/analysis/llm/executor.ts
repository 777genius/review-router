import { Provider, ProviderExecutionPolicy } from '../../providers/base';
import { RateLimitError } from '../../providers/base';
import { ReviewConfig, ProviderResult } from '../../types';
import { withRetry } from '../../utils/retry';
import { logger } from '../../utils/logger';
import { withTimeout } from '../../utils/timeout';
import {
  buildProviderReviewPromptForAttempt,
  getProviderReviewTotalAttempts,
  shouldRetryProviderReviewError,
} from './retry-policy';
import { ExecutionDeadline } from '../../review-execution/domain/execution-deadline';
import { ProviderCallLimiter } from '../../review-execution/application/provider-call-limiter';

export interface LLMExecutionPolicy {
  readonly deadline?: ExecutionDeadline;
  readonly maxParallelCalls?: number;
}

type ErrorWithCode = Error & { code?: string };

export class LLMExecutor {
  private readonly callLimiter: ProviderCallLimiter;
  private readonly providerExecutionPolicy?: ProviderExecutionPolicy;

  constructor(
    private readonly config: ReviewConfig,
    private readonly policy: LLMExecutionPolicy = {}
  ) {
    const maxParallelCalls = Math.max(
      1,
      Math.min(
        3,
        Math.floor(policy.maxParallelCalls ?? config.providerMaxParallel)
      )
    );
    this.callLimiter = new ProviderCallLimiter(maxParallelCalls);
    if (policy.deadline) {
      this.providerExecutionPolicy = {
        canStartOptionalRetry: () => policy.deadline!.canStartOptionalRetry(),
        clampTimeoutMs: (requestedTimeoutMs) =>
          policy.deadline!.clampProviderTimeout(requestedTimeoutMs),
      };
    }
  }

  private resolveProviderTimeoutMs(
    provider: Provider,
    timeoutMs?: number
  ): number {
    const baseTimeoutMs = timeoutMs ?? this.config.runTimeoutSeconds * 1000;
    if (
      provider.name.startsWith('openrouter/') ||
      provider.name.startsWith('codex-openrouter/')
    ) {
      return Math.min(
        baseTimeoutMs,
        this.config.openrouterTimeoutSeconds * 1000
      );
    }
    return baseTimeoutMs;
  }

  canStartProviderDiscovery(): boolean {
    return this.policy.deadline?.canStartBatch() ?? true;
  }

  clampProviderDiscoveryTimeout(requestedTimeoutMs: number): number {
    return (
      this.policy.deadline?.clampProviderTimeout(requestedTimeoutMs) ??
      requestedTimeoutMs
    );
  }

  async runProviderDiscoveryWave<T>(
    operation: () => Promise<T>,
    requestedTimeoutMs: number
  ): Promise<T | undefined> {
    if (!this.canStartProviderDiscovery()) {
      logger.info(
        'Skipping provider discovery because the review execution deadline reserve was reached'
      );
      return undefined;
    }

    const actualTimeoutMs =
      this.clampProviderDiscoveryTimeout(requestedTimeoutMs);
    if (actualTimeoutMs <= 0) return undefined;

    try {
      return await withTimeout(
        operation(),
        actualTimeoutMs,
        `Provider discovery timed out after ${actualTimeoutMs}ms`
      );
    } catch (error) {
      logger.warn(
        `Provider discovery wave failed within its deadline: ${(error as Error).message}`
      );
      return undefined;
    }
  }

  /**
   * Filter providers by running health checks to identify responsive providers
   * Providers that don't respond within healthCheckTimeoutMs are filtered out
   * @param providers - Array of providers to check
   * @param healthCheckTimeoutMs - Timeout for health check (default 30s)
   * @returns Object with healthy providers and health check results for all providers
   */
  async filterHealthyProviders(
    providers: Provider[],
    healthCheckTimeoutMs: number = 30000
  ): Promise<{ healthy: Provider[]; healthCheckResults: ProviderResult[] }> {
    if (providers.length === 0) return { healthy: [], healthCheckResults: [] };

    logger.info(
      `Running health checks on ${providers.length} provider(s) with ${healthCheckTimeoutMs}ms timeout...`
    );

    const healthyProviders: Provider[] = [];
    const healthCheckResults: ProviderResult[] = [];
    const tasks: Array<Promise<void>> = [];

    for (const provider of providers) {
      tasks.push(
        this.callLimiter.run(async () => {
          const started = Date.now();
          try {
            if (provider.name.startsWith('codex/')) {
              healthyProviders.push(provider);
              healthCheckResults.push({
                name: provider.name,
                status: 'success',
                durationSeconds: 0,
              });
              logger.info(
                `✓ Provider ${provider.name} health check skipped for Codex CLI runtime`
              );
              return;
            }

            if (!this.canStartProviderDiscovery()) {
              const deadlineError = new Error(
                'Health check skipped because there is not enough time to start a review batch'
              ) as ErrorWithCode;
              deadlineError.name = 'TimeoutError';
              deadlineError.code = 'REVIEW_DEADLINE_REACHED';
              throw deadlineError;
            }

            const actualTimeoutMs =
              this.clampProviderDiscoveryTimeout(healthCheckTimeoutMs);
            if (actualTimeoutMs <= 0) {
              const deadlineError = new Error(
                'Health check skipped because the review execution deadline reserve was reached'
              ) as ErrorWithCode;
              deadlineError.name = 'TimeoutError';
              deadlineError.code = 'REVIEW_DEADLINE_REACHED';
              throw deadlineError;
            }

            const isHealthy = await withTimeout(
              provider.healthCheck(actualTimeoutMs),
              actualTimeoutMs,
              `Provider ${provider.name} health check timed out after ${actualTimeoutMs}ms`
            );
            // Duration is measured immediately after health check completes
            const duration = Date.now() - started;

            if (isHealthy) {
              healthyProviders.push(provider);
              healthCheckResults.push({
                name: provider.name,
                status: 'success',
                durationSeconds: duration / 1000,
              });
              logger.info(
                `✓ Provider ${provider.name} health check passed (${duration}ms)`
              );
            } else {
              // Health check returned false - likely timed out
              const result: ProviderResult = {
                name: provider.name,
                status: 'timeout',
                error: new Error(
                  `Health check timed out after ${duration}ms - provider did not respond within timeout`
                ),
                durationSeconds: duration / 1000,
              };
              healthCheckResults.push(result);
              logger.warn(
                `✗ Provider ${provider.name} health check timed out (${duration}ms)`
              );
            }
          } catch (error) {
            const duration = Date.now() - started;
            const err = error as ErrorWithCode;

            // Determine if this is a timeout error
            let status: ProviderResult['status'] = 'error';
            if (
              err.name === 'TimeoutError' ||
              err.message.toLowerCase().includes('timed out') ||
              err.message.toLowerCase().includes('timeout') ||
              err.code === 'ETIMEDOUT' ||
              err.code === 'REVIEW_DEADLINE_REACHED'
            ) {
              status = 'timeout';
            }

            const result: ProviderResult = {
              name: provider.name,
              status,
              error: err,
              durationSeconds: duration / 1000,
            };
            healthCheckResults.push(result);
            logger.warn(
              `✗ Provider ${provider.name} health check error (${duration}ms): ${err.message}`
            );
          }
        }) as Promise<void>
      );
    }

    await Promise.all(tasks);

    logger.info(
      `Health checks complete: ${healthyProviders.length}/${providers.length} provider(s) are responsive`
    );

    return { healthy: healthyProviders, healthCheckResults };
  }

  async execute(
    providers: Provider[],
    prompt: string,
    timeoutMs?: number
  ): Promise<ProviderResult[]> {
    const results: ProviderResult[] = [];
    const tasks: Array<Promise<void>> = [];

    for (const provider of providers) {
      tasks.push(
        this.callLimiter.run(async () => {
          const started = Date.now();
          const requestedTimeoutMs = this.resolveProviderTimeoutMs(
            provider,
            timeoutMs
          );

          const totalAttempts = getProviderReviewTotalAttempts(
            this.config.providerRetries
          );
          let attempt = 0;
          let previousError: Error | undefined;
          const runner = async () => {
            attempt += 1;
            const actualTimeoutMs =
              this.providerExecutionPolicy?.clampTimeoutMs(
                requestedTimeoutMs
              ) ?? requestedTimeoutMs;
            if (actualTimeoutMs <= 0) {
              const deadlineError = new Error(
                'Review execution deadline reached before provider invocation'
              ) as ErrorWithCode;
              deadlineError.name = 'TimeoutError';
              deadlineError.code = 'REVIEW_DEADLINE_REACHED';
              throw deadlineError;
            }
            return provider.review(
              buildProviderReviewPromptForAttempt(
                prompt,
                attempt,
                previousError
              ),
              actualTimeoutMs,
              this.providerExecutionPolicy
            );
          };

          try {
            const result = await withRetry(runner, {
              retries: totalAttempts - 1,
              minTimeout: 0,
              maxTimeout: 0,
              retryOn: (error) => {
                previousError = error;
                return (
                  shouldRetryProviderReviewError(error) &&
                  (this.providerExecutionPolicy?.canStartOptionalRetry() ??
                    true)
                );
              },
            });
            results.push({
              name: provider.name,
              status: 'success',
              result,
              durationSeconds: (Date.now() - started) / 1000,
            });
          } catch (error) {
            const err = error as ErrorWithCode;
            let status: ProviderResult['status'] = 'error';
            if (err instanceof RateLimitError) {
              status = 'rate-limited';
            } else if (
              err.name === 'TimeoutError' ||
              err.message.toLowerCase().includes('timed out') ||
              err.code === 'ETIMEDOUT'
            ) {
              status = 'timeout';
            }
            const structuredFailure = shouldRetryProviderReviewError(err);
            if (structuredFailure) {
              logger.warn(
                `Provider ${provider.name} failed structured output after ${totalAttempts} attempt(s): ${err.message}`
              );
            } else {
              logger.warn(`Provider ${provider.name} failed: ${err.message}`);
            }
            results.push({
              name: provider.name,
              status,
              error: err,
              durationSeconds: (Date.now() - started) / 1000,
            });
          }
        }) as Promise<void>
      );
    }

    await Promise.all(tasks);
    return results;
  }
}
