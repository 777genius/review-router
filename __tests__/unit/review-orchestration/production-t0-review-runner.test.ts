import { execFileSync } from 'node:child_process';
import {
  RunT0ReviewOrchestration,
  type RunT0ReviewOrchestrationDependencies,
} from '../../../src/review-orchestration/application';
import {
  GitHubReviewRevisionGuard,
  FreshGitHubLifecycleInventory,
} from '../../../src/review-orchestration/infrastructure/github-review-state-adapter';
import { GitReviewRevisionMaterializer } from '../../../src/review-orchestration/infrastructure/git-review-revision-materializer';
import { PullRequestLoader } from '../../../src/github/pr-loader';
import { reviewMemoryBundle } from '../../helpers/review-memory-v2-fixture';
import {
  readAdmittedGatewayCodexModelSettings,
  GATEWAY_CODEX_MODEL_SETTINGS_ENV,
} from '../../../src/control-plane/admitted-gateway-codex-model-settings';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { PromptBuilder } from '../../../src/analysis/llm/prompt-builder';
import {
  createPreparedProviderInvocation,
  ProviderKind,
} from '../../../src/providers/prepared-invocation';
import {
  CodexReviewInvocationAdapter,
  GeneratedProviderInvocationManifestAssembler,
} from '../../../src/review-orchestration/infrastructure/codex-review-invocation-adapter';
import type { ContextGatewayInvocationSessionFactoryPort } from '../../../src/review-orchestration/infrastructure/context-gateway-invocation-session';
import { canonicalJson } from '../../../src/context-gateway/context-gateway-contract';
import {
  REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
  REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
} from '../../../src/review-investigation/domain/deterministic-context-probe-plan';
import { REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT_HASH } from '../../../src/review-investigation/application/review-investigation-turn-prompt';
import { logger } from '../../../src/utils/logger';
import { ConfigLoader } from '../../../src/config/loader';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import { ReviewActionV2Client } from '../../../src/control-plane/review-action-v2-client';
import {
  applyControlPlaneRuntimeConfig,
  parseAdmittedRuntimeConfig,
} from '../../../src/control-plane/runtime-config';
import { GitHubActionsOidcTokenProvider } from '../../../src/codex-oauth/github-actions-oidc';
import { ReviewActionV2ControlPlaneAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import { CodexProvider } from '../../../src/providers/codex';
import { NodeCodexAppServerTurnRunner } from '../../../src/review-investigation/infrastructure/codex-app-server-turn-runner';
import {
  REVIEW_INVESTIGATION_GATEWAY_TOOLS,
  ReviewAgentExecutionSessionKind,
  type ReviewTurnRequest,
} from '../../../src/review-investigation/application/review-agent-port';
import {
  createConfiguredProductionInvestigationAgents,
  ProductionT0ReviewRunner,
  LegacyFallbackBeforeInvestigationAuthorityControlPlane,
  createScmReadTokenProvider,
  mapOrchestrationResultToCodexOutcome,
  mapRevisionGuardErrorToCodexOutcome,
  planAssignments,
  assertLegacyReviewPlanRestorable,
  selectLegacyLifecycleTargets,
  resolveProductionContextGatewayPolicyVersion,
  resolveProductionContextGatewaySessionFactoryOptions,
  resolveT0AttemptBudget,
  resolveProductionInvestigationReasoningEffort,
  selectDirectOpenRouterProvider,
} from '../../../src/review-orchestration/infrastructure/production-t0-review-runner';
import { restoreProductionLifecycleVerification } from '../../../src/review-orchestration/infrastructure/restored-lifecycle-invocations';
import { CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION } from '../../../src/context-gateway/context-gateway-release-contract';
import {
  ReviewCapabilityKind,
  ReviewExecutionProviderKind,
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvestigationRecordingMode,
  ReviewInvestigationRolloutCapability,
  ReviewOrchestrationResultStatus,
  ReviewPublicationUnavailableFact,
  ReviewTaskKind,
  RestoredReviewExecutionState,
  RestoredReviewWorkSlotState,
  type RestoredReviewExecution,
  type ReviewRunAuthorization,
} from '../../../src/review-orchestration/application';
import {
  reviewInvestigationExtensionV1,
  reviewInvestigationRolloutAuthorizationV3Contract,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  CodexOAuthV2CancellationReason,
  CodexOAuthV2ReviewOutcome,
  CodexOAuthV2TerminalReason,
} from '../../../src/codex-oauth/runtime';
import { MergeGateConclusion } from '../../../src/review-projection/domain';
import {
  ReviewDepth,
  type PRContext,
  type LifecycleTarget,
  type ReviewConfig,
} from '../../../src/types';
import { compareCodeUnits } from '../../../src/review-orchestration/infrastructure/production-review-projection';
import {
  reviewInvestigationCoverageProfileHash,
  reviewInvestigationPolicyHash,
} from '../../../src/review-orchestration/infrastructure/review-investigation-recording-adapter';
import {
  ReviewAgentProviderKind,
  InvestigationContextGatewayRuntimeConfigurationError,
  InvestigationContextGatewayRuntimeConfigurationFailureReason,
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationLegacyFallbackSignal,
  ReviewTurnPurpose,
  type ReviewAgentPort,
} from '../../../src/review-investigation';
import {
  createProductionReviewInvestigationAgentSelector,
  createProductionReviewInvestigationGatewayFactory,
  createProductionReviewInvestigationInvocation,
  formatProductionReviewInvestigationRolloutTelemetry,
  productionReviewInvestigationRecordingMode,
  ProductionReviewInvestigationRolloutReason,
  readProductionReviewInvestigationRolloutFlags,
  resolveProductionReviewInvestigationRollout,
  resolveProductionReviewInvestigationRolloutResolution,
  type ProductionReviewInvestigationRolloutFlags,
} from '../../../src/review-orchestration/infrastructure/production-review-investigation-composition';

describe('ProductionT0ReviewRunner policy', () => {
  it.each([
    ['available', 'codex'],
    ['available', 'direct'],
    ['available', 'provider-api'],
    ['disabled', 'codex'],
    ['outage', 'codex'],
    ['restore', 'codex'],
    ['restore', 'ocr'],
  ] as const)(
    'composes the real T0 runner with %s memory on %s and preserves execution identity on restore',
    async (mode, engine) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 't0-memory-production-'))
      );
      const previousEnv = { ...process.env };
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      git('init', '--quiet');
      fs.writeFileSync(
        path.join(root, 'review.ts'),
        'export const timeout = 30;\n'
      );
      git('add', 'review.ts');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'base'
      );
      const baseSha = git('rev-parse', 'HEAD');
      fs.writeFileSync(
        path.join(root, 'review.ts'),
        'export const timeout = 60;\n'
      );
      git('add', 'review.ts');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'head'
      );
      const headSha = git('rev-parse', 'HEAD');
      const admitted = authorization(3);
      admitted.facts = {
        ...admitted.facts,
        ...(engine === 'ocr'
          ? {
              providerVoteLanes: admitted.facts.providerVoteLanes.map(
                (lane) => ({
                  ...lane,
                  providerKind: ReviewExecutionProviderKind.Ocr,
                })
              ),
            }
          : {}),
        baseSha,
        mergeBaseSha: baseSha,
        headSha,
      };
      const pr = { ...pullRequest(['review.ts']), baseSha, headSha };
      const providerName =
        engine === 'provider-api'
          ? 'openrouter/vendor/gpt-memory-test'
          : 'codex/gpt-memory-test';
      const config = {
        ...DEFAULT_CONFIG,
        providers: [providerName],
        synthesisModel: providerName,
        codexAgenticContext: false,
        updatePrDescription: false,
      };
      const boundary = new Error('production_memory_composition_verified');
      const fetchImpl = jest.fn().mockImplementation(async (url) => {
        if (String(url).endsWith('/session/exchange'))
          return new Response(
            JSON.stringify({ sessionToken: 'fixture-session' })
          );
        if (String(url).endsWith('/config'))
          return new Response(
            JSON.stringify({
              protocolVersion: 1,
              configVersion: 1,
              runtimeEnv: {
                CODEX_MODEL: 'gpt-memory-test',
                REVIEW_ROUTER_MEMORY_ENABLED:
                  mode === 'disabled' ? 'false' : 'true',
              },
            })
          );
        if (String(url).endsWith('/bundle')) {
          if (mode === 'outage') throw new Error('private engine diagnostic');
          return new Response(
            JSON.stringify(
              reviewMemoryBundle({
                authorizationId: admitted.authorizationId,
                repositoryConnectionId: admitted.facts.repositoryConnectionId,
                pullRequestNumber: pr.number,
                baseSha,
                headSha,
                reviewRevisionHash: admitted.facts.reviewRevisionHash,
              })
            ),
            { headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ protocolVersion: 2, eligible: true }),
          { headers: { 'content-type': 'application/json' } }
        );
      });
      const spies = [
        jest
          .spyOn(GitHubActionsOidcTokenProvider.prototype, 'requestToken')
          .mockResolvedValue('fixture-oidc'),
        jest
          .spyOn(ReviewActionV2ControlPlaneAdapter.prototype, 'authorize')
          .mockResolvedValue(admitted),
        jest
          .spyOn(
            ReviewActionV2ControlPlaneAdapter.prototype,
            'restoreExecution'
          )
          .mockResolvedValue(null),
        jest.spyOn(ConfigLoader, 'load').mockReturnValue(config),
        jest
          .spyOn(GitHubReviewRevisionGuard.prototype, 'loadCurrentRevision')
          .mockResolvedValue({ ...admitted.facts, pullRequestState: 'open' }),
        jest.spyOn(PullRequestLoader.prototype, 'load').mockResolvedValue(pr),
        jest
          .spyOn(GitReviewRevisionMaterializer.prototype, 'ensureAvailable')
          .mockResolvedValue(),
        jest
          .spyOn(FreshGitHubLifecycleInventory.prototype, 'loadForPrompt')
          .mockResolvedValue({
            promptTargets: [],
            inventory: { lifecycleStateHash: '8'.repeat(64) },
          } as never),
        jest
          .spyOn(CodexProvider.prototype, 'prepareInvocation')
          .mockImplementation(
            async (prompt) =>
              createPreparedProviderInvocation({
                providerKind: ProviderKind.CodexCli,
                providerName,
                requestedModel: 'gpt-memory-test',
                timeoutMs: 1_000,
                request: {
                  prompt,
                  outputSchema: { type: 'object' },
                  environment: {},
                },
              }) as never
          ),
        jest
          .spyOn(CodexProvider.prototype, 'describePreparedEnvironmentContract')
          .mockReturnValue({}),
      ];
      const prepared: { prompt: string; hash: string | null }[] = [];
      const commands: Parameters<
        RunT0ReviewOrchestration['executeAuthorized']
      >[0][] = [];
      let restored: RestoredReviewExecution | null = null;
      const execute = jest
        .spyOn(RunT0ReviewOrchestration.prototype, 'executeAuthorized')
        .mockImplementation(async function (
          this: RunT0ReviewOrchestration,
          command
        ) {
          commands.push(command);
          const dependencies = (
            this as unknown as {
              dependencies: RunT0ReviewOrchestrationDependencies;
            }
          ).dependencies;
          const workSlot = command.workSlots.find(
            (slot) => slot.taskKind === ReviewTaskKind.FindingDiscovery
          )!;
          for (let count = 0; engine !== 'ocr' && count < 2; count += 1) {
            const invocation = await dependencies.invocations.prepare({
              workSlot,
              attemptOrdinal: 1,
            });
            const manifest = JSON.parse(
              (
                await dependencies.invocationManifestAssembler.assemble(
                  invocation
                )
              ).manifestCanonicalJson
            ) as { memoryBundleHash: string | null };
            prepared.push({
              prompt: invocation.reviewPrompt,
              hash: manifest.memoryBundleHash,
            });
            expect(manifest.memoryBundleHash).toBe(
              invocation.manifestFacts.memoryBundleHash
            );
            if (manifest.memoryBundleHash)
              expect(
                await dependencies.memoryAdmission!.isEligible(
                  manifest.memoryBundleHash
                )
              ).toBe(true);
          }
          throw boundary;
        });
      try {
        const directProfile = JSON.stringify({
          ...JSON.parse(admittedAgentJson),
          modelTransports: ['provider_api'],
        });
        const runtimeConfig = parseAdmittedRuntimeConfig({
          protocolVersion: 1,
          configVersion: 1,
          runtimeEnv: {
            ...admittedAgentEnv,
            CODEX_MODEL: 'gpt-memory-test',
            REVIEW_ROUTER_MEMORY_ENABLED:
              mode === 'disabled' ? 'false' : 'true',
            UPDATE_PR_DESCRIPTION: 'false',
            ...(engine === 'provider-api'
              ? {
                  REVIEW_AUTH_MODE: 'openrouter-api',
                  REVIEW_PROVIDERS: providerName,
                  REQUIRED_HEALTHY_PROVIDERS: providerName,
                  SYNTHESIS_MODEL: providerName,
                  PROVIDER_LIMIT: '1',
                  PROVIDER_MAX_PARALLEL: '1',
                  INLINE_MIN_AGREEMENT: '1',
                  CODEX_AGENTIC_CONTEXT: 'false',
                  REVIEW_ROUTER_AGENT_PROFILE_JSON: directProfile,
                  REVIEW_ROUTER_AGENT_PROFILE_DIGEST: createHash('sha256')
                    .update(directProfile)
                    .digest('hex'),
                }
              : {}),
          },
        });
        const profile =
          engine === 'ocr'
            ? JSON.stringify({
                profileRef: 'ocr-managed-v1',
                agentKind: 'ocr',
                binarySha256: '1'.repeat(64),
                packageVersion: '1.2.3',
                modelTransports: ['account_gateway'],
                contextGateway: false,
                cancellation: true,
              })
            : null;
        const gatewayInput = {
          apiUrl: 'https://fixture.invalid',
          audience: 'reviewrouter',
          workflowSchemaVersion: 1,
          repository: 'fixture/repository',
          pullRequestNumber: 1,
          headSha,
          workspacePath: root,
          codexHome: path.join(root, 'home'),
          scmReadToken: 'fixture-scm',
          scmReadTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          refreshScmReadToken: async () => {
            throw new Error('unexpected refresh');
          },
          ...(engine === 'ocr'
            ? {
                ocr: {
                  run: {
                    binaryPath: '/never-run',
                    runDirectory: root,
                    homeDirectory: path.join(root, 'home'),
                    configPath: path.join(root, 'config'),
                    rulePath: path.join(root, 'rule'),
                    backgroundPath: null,
                    cleanup: async () => {},
                  },
                  effectFacts: () => ({ effect: 'not_dispatched' as const }),
                },
              }
            : {}),
          accountGateway: {
            runtimeConfig: profile
              ? parseAdmittedRuntimeConfig({
                  protocolVersion: 1,
                  configVersion: 1,
                  runtimeEnv: {
                    ...runtimeConfig.runtimeEnv,
                    REVIEW_ROUTER_AGENT_PROFILE_JSON: profile,
                    REVIEW_ROUTER_AGENT_PROFILE_DIGEST: createHash('sha256')
                      .update(profile)
                      .digest('hex'),
                  },
                })
              : runtimeConfig,
            controlPlane: {
              currentAuthorization: () => admitted,
              restoreExecution: async () => restored,
            } as never,
            modelTransport: {
              baseUrl: 'http://127.0.0.1:1/v1',
              configuration: [],
              environment: {
                REVIEWROUTER_LOCAL_MODEL_TOKEN: `Bearer ${'a'.repeat(64)}`,
              },
              actualModel: () => 'gpt-memory-test',
              failureFact: () => undefined,
              dispose: async () => {},
            },
          },
        } as Parameters<ProductionT0ReviewRunner['run']>[0];
        const gateway = gatewayInput.accountGateway!;
        const runnerInput =
          engine === 'direct'
            ? { ...gatewayInput, accountGateway: undefined }
            : engine === 'provider-api'
              ? {
                  ...gatewayInput,
                  accountGateway: undefined,
                  providerApi: {
                    runtimeConfig: gateway.runtimeConfig,
                    controlPlane: gateway.controlPlane,
                    modelTransport: gateway.modelTransport,
                    signal: new AbortController().signal,
                    credentialLease: () => ({ environment: {} }),
                  },
                }
              : gatewayInput;
        await expect(
          new ProductionT0ReviewRunner(fetchImpl).run(runnerInput)
        ).rejects.toBe(boundary);
        if (mode === 'restore') {
          const original = commands[0]!;
          restored = {
            executionId: original.executionId,
            version: '1',
            streamVersion: '1',
            generation: '1',
            state: RestoredReviewExecutionState.Running,
            authorizationId: admitted.authorizationId,
            reviewRevisionHash: original.reviewRevisionHash,
            planHash: original.planHash,
            workSlots: original.workSlots.map((slot) => ({
              ...slot,
              state: RestoredReviewWorkSlotState.Pending,
              activeLeaseId: null,
              acceptedObservationRefId: null,
            })),
            persistedPlan: {
              compatibilityKey: original.compatibilityKey,
              planHash: original.planHash,
              assignmentManifestVersion: 1,
              assignmentManifestHash: original.assignmentManifestHash,
              assignmentManifestCanonicalJson:
                original.assignmentManifestCanonicalJson,
              workSlots: original.workSlots.map((slot) => ({
                ...slot,
                nextAttemptOrdinal: 1,
              })),
              acceptedManifests: [],
              artifact: null,
            },
          };
          await expect(
            new ProductionT0ReviewRunner(fetchImpl).run(runnerInput)
          ).rejects.toBe(boundary);
          expect(commands).toHaveLength(2);
          expect(commands[1]).toMatchObject({
            executionId: original.executionId,
            compatibilityKey: original.compatibilityKey,
            planHash: original.planHash,
            workSlotsCanonicalJson: original.workSlotsCanonicalJson,
            restoredExecution: restored,
            restoreOnly: true,
          });
          if (engine === 'codex') {
            expect(prepared).toHaveLength(4);
            expect(prepared[0]!.hash).not.toBeNull();
            expect(prepared[2]!.hash).toBeNull();
            expect(prepared[2]!.prompt).not.toContain(
              'AUTHORIZED REVIEWROUTER MEMORY'
            );
          }
        } else {
          expect(prepared).toHaveLength(2);
          expect(prepared[0]).toEqual(prepared[1]);
        }
        if (mode === 'available') {
          expect(prepared[0].prompt).toContain(
            'All outbound calls require a bounded timeout.'
          );
          expect(prepared[0].hash).toMatch(/^[a-f0-9]{64}$/);
        } else if (mode !== 'restore') {
          expect(prepared[0].prompt).not.toContain(
            'AUTHORIZED REVIEWROUTER MEMORY'
          );
          expect(prepared[0].hash).toBeNull();
        }
        expect(
          fetchImpl.mock.calls.filter(([url]) =>
            String(url).endsWith('/bundle')
          )
        ).toHaveLength(mode === 'disabled' ? 0 : 1);
      } finally {
        execute.mockRestore();
        for (const spy of spies) spy.mockRestore();
        for (const key of Object.keys(process.env))
          if (!(key in previousEnv)) delete process.env[key];
        Object.assign(process.env, previousEnv);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('preserves one explicit OpenRouter model and refuses policy collapse', () => {
    const provider = 'openrouter/vendor/model';
    const config = {
      ...DEFAULT_CONFIG,
      providers: [provider],
      synthesisModel: provider,
      providerLimit: 1,
      providerMaxParallel: 1,
      inlineMinAgreement: 1,
      requiredHealthyProviders: [provider],
      fallbackProviders: [],
    };
    expect(selectDirectOpenRouterProvider(config)).toBe(provider);
    for (const mismatch of [
      { providers: [provider, 'openrouter/other/model'] },
      { providers: ['codex/model'] },
      { providers: ['openrouter/free'] },
      { providerLimit: 2 },
      { providerMaxParallel: 2 },
      { inlineMinAgreement: 2 },
      { synthesisModel: 'openrouter/other/model' },
      { fallbackProviders: ['openrouter/other/model'] },
      { requiredHealthyProviders: [] },
    ])
      expect(() =>
        selectDirectOpenRouterProvider({ ...config, ...mismatch })
      ).toThrow('review_action_v2_direct_provider_policy_invalid');
  });
  it.each([
    ['mimo-token-plan-api', 'mimo-v2.6-pro', undefined, 'high'],
    ['mimo-token-plan-api', 'mimo-v2.6-pro', 'low', 'low'],
    ['mimo-token-plan-api', 'mimo-v2.6-pro', 'medium', 'medium'],
    ['mimo-token-plan-api', 'mimo-v2.6-pro', 'high', 'high'],
    ['kimi-code-api', 'k3-256k', undefined, null],
  ] as const)(
    'preserves direct %s reasoning for %s with saved effort %s',
    (providerApiAuthMode, codexModel, serverReasoningEffort, expected) => {
      expect(
        resolveProductionInvestigationReasoningEffort({
          codexModel,
          accountGateway: false,
          providerApi: true,
          providerApiAuthMode,
          serverReasoningEffort,
        })
      ).toBe(expected);
    }
  );

  it.each([
    ['mimo-token-plan-api', 'mimo-v2.6-pro', 'xhigh'],
    ['mimo-token-plan-api', 'mimo-v2.6-pro', 'ultra'],
    ['kimi-code-api', 'k3-256k', 'low'],
    ['kimi-code-api', 'k3-256k', 'high'],
  ] as const)(
    'rejects unsupported direct %s reasoning for %s: %s',
    (providerApiAuthMode, codexModel, serverReasoningEffort) => {
      expect(() =>
        resolveProductionInvestigationReasoningEffort({
          codexModel,
          accountGateway: false,
          providerApi: true,
          providerApiAuthMode,
          serverReasoningEffort,
        })
      ).toThrow('provider_api_reasoning_effort_unsupported');
    }
  );

  const admittedAgentJson = JSON.stringify({
    profileRef: 'fixture-codex',
    agentKind: 'codex',
    binarySha256: 'a'.repeat(64),
    packageVersion: '0.147.0',
    modelTransports: ['account_gateway'],
    contextGateway: true,
    cancellation: true,
  });
  const admittedAgentEnv = {
    REVIEW_ROUTER_AGENT_PROFILE_JSON: admittedAgentJson,
    REVIEW_ROUTER_AGENT_PROFILE_DIGEST: createHash('sha256')
      .update(admittedAgentJson)
      .digest('hex'),
  };
  it('rejects an approved alternative agent instead of constructing Codex from its model', () => {
    const resolve = jest.fn();
    expect(() =>
      createConfiguredProductionInvestigationAgents({
        approvedAgent: {
          profileRef: 'approved-claude',
          agentKind: 'claude',
          binarySha256: 'a'.repeat(64),
          packageVersion: '1.0.0',
          modelTransports: ['account_gateway'],
          contextGateway: true,
          cancellation: true,
        },
        codexModel: 'mimo-v2.6-pro',
        codexBinaryPath: '/mock/codex',
        executionSessions: { resolve },
        reasoningEffort: 'high',
      })
    ).toThrow('review_investigation_approved_agent_unavailable');
    expect(resolve).not.toHaveBeenCalled();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['mimo-v2.6-pro', 'gpt-caller', true, 'high', 'mimo-v2.6-pro'],
    ['mimo-v2.6-pro', 'gpt-caller', true, 'high', undefined],
    ['mimo-v2.6-pro', 'gpt-caller', true, 'high', 'gpt-admitted'],
    [
      'mimo-v2.6-pro-unknown',
      'mimo-v2.6-pro',
      false,
      undefined,
      'mimo-v2.6-pro-unknown',
    ],
    ['mimo-v2.6-pro', 'gpt-caller', true, undefined, 'mimo-v2.6-pro'],
    ['mimo-v2.6-pro', 'gpt-caller', true, 'medium', 'mimo-v2.6-pro'],
    ['mimo-v2.6-pro', 'gpt-caller', true, 'low', 'mimo-v2.6-pro'],
    ['gpt-selected', 'mimo-v2.6-pro', false, undefined, 'mimo-v2.6-pro'],
    ['gpt-selected', 'mimo-v2.6-pro', false, 'high', 'mimo-v2.6-pro'],
    [
      'gpt-unseen-minimal',
      'gpt-caller',
      false,
      'minimal',
      'gpt-unseen-minimal',
    ],
    [
      'gpt-unseen-high-only',
      'gpt-caller',
      false,
      'high',
      'gpt-unseen-high-only',
    ],
    [
      'gpt-unseen-default',
      'gpt-caller',
      false,
      undefined,
      'gpt-unseen-default',
    ],
    ['gpt-unseen-max', 'gpt-caller', false, 'max', 'gpt-unseen-max'],
    ['gpt-unseen-ultra', 'gpt-caller', false, 'ultra', 'gpt-unseen-ultra'],
    [
      'gpt-5.4-future-default',
      'gpt-caller',
      false,
      undefined,
      'gpt-5.4-future-default',
    ],
    [
      'gpt-5.4-future-disabled',
      'gpt-caller',
      false,
      undefined,
      'gpt-5.4-future-disabled',
    ],
    [
      'gpt-5.4-future-ultra',
      'gpt-caller',
      false,
      'ultra',
      'gpt-5.4-future-ultra',
    ],
  ] as const)(
    'pins AppServer catalog and effort from selected %s independently of caller %s (gateway %s, effort %s)',
    async (
      selectedModel,
      callerModel,
      enabled,
      reasoningEffort,
      admittedGatewayModel
    ) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'mimo-appserver-test-')
      );
      const home = path.join(root, 'fresh-home');
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(root, '.codex'));
      const callerConfig = 'model_catalog_json="/caller/untrusted.json"\n';
      fs.writeFileSync(path.join(root, '.codex/config.toml'), callerConfig);
      const stoppedAtBoundary = new Error('mock subprocess boundary');
      const previousEnv = { ...process.env };
      process.env.CODEX_REASONING_EFFORT = 'xhigh';
      process.env.CODEX_MODEL = 'mimo-v2.6-pro';
      const execute = jest
        .spyOn(NodeCodexAppServerTurnRunner.prototype, 'executeTurn')
        .mockRejectedValue(stoppedAtBoundary);
      try {
        const configuration = ['model_provider="reviewrouter_account_gateway"'];
        const runtimeResult = await applyControlPlaneRuntimeConfig({
          env: {
            REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
            REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
            REVIEWROUTER_API_URL: 'https://fixture.invalid',
            CODEX_REASONING_EFFORT: 'xhigh',
          },
          oidc: { requestToken: async () => 'fixture-oidc' },
          fetchImpl: jest
            .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
            .mockResolvedValueOnce(
              new Response(JSON.stringify({ sessionToken: 'fixture-session' }))
            )
            .mockResolvedValueOnce(
              new Response(
                JSON.stringify({
                  protocolVersion: 1,
                  configVersion: 7,
                  runtimeEnv:
                    reasoningEffort === undefined
                      ? {}
                      : { CODEX_REASONING_EFFORT: reasoningEffort },
                })
              )
            ),
        });
        if (runtimeResult.status !== 'applied')
          throw new Error('expected applied runtime config');
        const gatewayModelSettings = selectedModel.startsWith('gpt-5.4-future')
          ? readAdmittedGatewayCodexModelSettings(
              {
                protocolVersion: 1,
                configVersion: 7,
                runtimeEnv: {
                  [GATEWAY_CODEX_MODEL_SETTINGS_ENV]: JSON.stringify({
                    model: selectedModel,
                    reasoning: selectedModel.endsWith('disabled')
                      ? null
                      : {
                          allowed: ['minimal', 'high', 'max'],
                          default: 'minimal',
                        },
                  }),
                },
              },
              selectedModel
            )
          : undefined;
        const effectiveEffort = resolveProductionInvestigationReasoningEffort({
          gatewayModelSettings,
          codexModel: selectedModel,
          accountGateway: true,
          serverReasoningEffort: runtimeResult.reasoningEffort,
        });
        const agents = createConfiguredProductionInvestigationAgents({
          codexModel: selectedModel,
          ...{ admittedGatewayModel },
          reasoningEffort: effectiveEffort,
          gatewayModelSettings,
          codexBinaryPath: '/mock/codex',
          modelTransport: {
            baseUrl: 'http://127.0.0.1:1/v1',
            configuration,
            environment: {
              CODEX_HOME: home,
              REVIEWROUTER_LOCAL_MODEL_TOKEN: 'fixture-capability',
            },
            actualModel: () => selectedModel,
            failureFact: () => undefined,
            dispose: async () => {},
          },
          executionSessions: {
            resolve: () => ({
              policyVersion: 'context-gateway-v4',
              binaryHash: 'a'.repeat(64),
              command: process.execPath,
              args: [path.join(root, 'mock-context-gateway.cjs')],
              cwd: root,
              enabledTools: REVIEW_INVESTIGATION_GATEWAY_TOOLS,
              runtimeEnvironment: {
                REVIEWROUTER_CONTEXT_SESSION_ID: 'session-fixture',
              },
              credentialEnvironment: {
                REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'fixture-gateway',
              },
            }),
          },
        });
        const request: ReviewTurnRequest = {
          invocationId: 'invocation-fixture',
          fencingToken: 'fence-fixture',
          turnId: 'turn-fixture',
          dossierVersion: 1,
          dossierDigest: 'b'.repeat(64),
          purpose: ReviewTurnPurpose.Discovery,
          allowedObligationIds: ['c'.repeat(64)],
          prompt: 'Review fixture',
          workspaceRoot: root,
          requestedModel: callerModel,
          timeoutMs: 1_000,
          maxTurns: 1,
          executionSession: {
            kind: ReviewAgentExecutionSessionKind.ContextGatewayV4,
          },
        };
        const digest = (value: string) =>
          createHash('sha256').update(value).digest('hex');
        const workSlot = Object.freeze({
          workSlotId: 'slot-fixture',
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Codex,
          providerVoteIdentityHash: '6'.repeat(64),
          shardKey: 'batch-fixture',
          required: true,
          attemptBudget: 1,
          retryPolicyVersion: 'retry-fixture',
        });
        const planningConfig = {
          command: process.execPath,
          args: [path.join(root, 'mock-context-gateway.cjs')],
          cwd: root,
          gatewayBinaryHash: 'a'.repeat(64),
          gatewayPolicyVersion: 'context-gateway-v4',
          enabledTools: REVIEW_INVESTIGATION_GATEWAY_TOOLS,
          runtimeEnvironment: {
            REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID: '4'.repeat(40),
          },
        };
        const inventory = {
          inventoryVersion: 2 as const,
          mergeBaseTreeOid: '2'.repeat(40),
          headTreeOid: '4'.repeat(40),
          entries: [],
        };
        const invocation = await new CodexReviewInvocationAdapter(
          {
            prepareInvocation: async (prompt: string) =>
              createPreparedProviderInvocation({
                providerKind: ProviderKind.CodexCli,
                providerName: `codex/${selectedModel}`,
                requestedModel: selectedModel,
                timeoutMs: 1_000,
                request: { prompt },
                observableRequest: { prompt },
              }),
          } as unknown as CodexProvider,
          new PromptBuilder(DEFAULT_CONFIG),
          [
            {
              workSlot,
              reviewRevisionHash: '4'.repeat(64),
              mergeBaseSha: '2'.repeat(40),
              context: pullRequest([]),
              lifecycleTargets: [],
              liveLifecycleStateHash: '8'.repeat(64),
            },
          ],
          1_000,
          true,
          {
            planningConfig: async () => planningConfig,
            canonicalInventory: async () => ({
              ...inventory,
              itemCount: 0,
              inventoryHash: digest(canonicalJson(inventory)),
            }),
          } as unknown as ContextGatewayInvocationSessionFactoryPort,
          true,
          effectiveEffort,
          undefined,
          gatewayModelSettings
        ).prepare({ workSlot, attemptOrdinal: 1 });
        const manifest = await new GeneratedProviderInvocationManifestAssembler(
          authorization(1),
          DEFAULT_CONFIG,
          '7'.repeat(64)
        ).assemble(invocation);
        // Ambient effort changes after preparation cannot change the launch.
        process.env.CODEX_REASONING_EFFORT = 'xhigh';
        // Real adapter/session/config preparation, stopped before any subprocess.
        await expect(agents[0].agent.executeTurn(request)).rejects.toBe(
          stoppedAtBoundary
        );
        await expect(
          agents[0].agent.executeTurn({
            ...request,
            requestedModel: invocation.requestedModel,
          })
        ).rejects.toBe(stoppedAtBoundary);
        expect(execute).toHaveBeenCalledTimes(2);
        const launch = execute.mock.calls[0][0];
        const localSchema = enabled && admittedGatewayModel === selectedModel;
        if (localSchema) {
          expect(launch.protocol).not.toHaveProperty('outputSchema');
          expect(launch.protocol.prompt).toContain('OUTPUT JSON SCHEMA:');
        } else {
          expect(launch.protocol).toHaveProperty('outputSchema');
          expect(launch.protocol.prompt).toBe(request.prompt);
        }
        const investigationLaunch = execute.mock.calls[1][0];
        expect(launch.protocol.reasoningEffort).toBe(
          gatewayModelSettings
            ? selectedModel.endsWith('disabled')
              ? null
              : reasoningEffort === 'ultra'
                ? 'max'
                : 'minimal'
            : enabled
              ? (reasoningEffort ?? 'high')
              : (reasoningEffort ?? 'xhigh')
        );
        expect(investigationLaunch.protocol.requestedModel).toBe(
          invocation.requestedModel
        );
        expect(investigationLaunch.protocol.reasoningEffort).toBe(
          launch.protocol.reasoningEffort
        );
        expect(
          JSON.parse(manifest.manifestCanonicalJson).providerCapabilityHash
        ).toBe(
          digest(
            canonicalJson({
              adapterVersion: 'review-investigation-codex.v3',
              actualModelAttribution: 'observed',
              confinement: 'gateway_only',
              continuation: 'durable_dossier',
              gatewayBinaryHash: planningConfig.gatewayBinaryHash,
              gatewayPolicyVersion: planningConfig.gatewayPolicyVersion,
              enabledTools: [...planningConfig.enabledTools].sort(),
              probeLimits: invocation.investigationProbePlan!.limits,
              probePolicyVersion: REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
              reasoningEffort: investigationLaunch.protocol.reasoningEffort,
              ...(gatewayModelSettings ? { gatewayModelSettings } : {}),
              requestedModel: investigationLaunch.protocol.requestedModel,
              searchPolicyVersion: REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
              turnPromptContractHash:
                REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT_HASH,
            })
          )
        );
        expect(launch.environment.CODEX_HOME).toBe(home);
        expect(launch.environment.REVIEWROUTER_LOCAL_MODEL_TOKEN).toBe(
          'fixture-capability'
        );
        expect(launch.args).toContain('app-server');
        expect(launch.args).toContain(configuration[0]);
        const catalogSettings = launch.args.filter((arg) =>
          arg.startsWith('model_catalog_json=')
        );
        if (enabled || gatewayModelSettings) {
          const catalogPath = path.join(
            home,
            'reviewrouter-model-catalog.json'
          );
          const setting = `model_catalog_json=${JSON.stringify(catalogPath)}`;
          expect(catalogSettings).toEqual([setting]);
          expect(launch.args.slice(-2)).toEqual(['-c', setting]);
          expect(
            JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models[0]
          ).toMatchObject({
            slug: selectedModel,
            use_responses_lite: !gatewayModelSettings,
            apply_patch_tool_type: 'freeform',
            ...(gatewayModelSettings
              ? {
                  default_reasoning_level:
                    gatewayModelSettings.reasoning?.default ?? null,
                }
              : {}),
          });
          expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(
            [...configuration, setting].join('\n') + '\n'
          );
          expect(fs.statSync(catalogPath).mode & 0o777).toBe(0o600);
        } else {
          expect(catalogSettings).toEqual([]);
          expect(fs.readdirSync(home)).toEqual([]);
        }
        expect(execute.mock.calls[1][0].args).toEqual(launch.args);
        expect(
          fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8')
        ).toBe(callerConfig);
      } finally {
        process.env = previousEnv;
        execute.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['none', 'unsupported'])(
    'rejects a Gateway Codex effort outside saved policy: %s',
    (serverReasoningEffort) => {
      expect(() =>
        resolveProductionInvestigationReasoningEffort({
          codexModel: 'gpt-unseen',
          accountGateway: true,
          serverReasoningEffort,
        })
      ).toThrow('account_gateway_codex_reasoning_effort_unsupported');
    }
  );

  it.each([undefined, 'medium'] as const)(
    'uses only captured direct policy and effort=%s despite hostile checkout/ambient settings',
    async (capturedEffort) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'direct-policy-'))
      );
      const previousEnv = { ...process.env };
      const stoppedAtBoundary = new Error('mock authorization boundary');
      const profile = JSON.stringify({
        ...JSON.parse(admittedAgentJson),
        modelTransports: ['provider_api'],
      });
      const runtimeEnv = {
        REVIEW_AUTH_MODE: 'openrouter-api',
        REVIEW_PROVIDERS: 'openrouter/vendor/captured-model',
        REQUIRED_HEALTHY_PROVIDERS: 'openrouter/vendor/captured-model',
        SYNTHESIS_MODEL: 'openrouter/vendor/captured-model',
        PROVIDER_LIMIT: '1',
        PROVIDER_MAX_PARALLEL: '1',
        INLINE_MIN_AGREEMENT: '1',
        CODEX_AGENTIC_CONTEXT: 'true',
        ...(capturedEffort === undefined
          ? {}
          : { CODEX_REASONING_EFFORT: capturedEffort }),
        REVIEW_ROUTER_AGENT_PROFILE_JSON: profile,
        REVIEW_ROUTER_AGENT_PROFILE_DIGEST: createHash('sha256')
          .update(profile)
          .digest('hex'),
      };
      const configuration = jest.spyOn(ConfigLoader, 'load');
      const captured = jest.spyOn(ConfigLoader, 'loadRuntimeEnvironment');
      const current = jest
        .spyOn(
          ReviewActionV2ControlPlaneAdapter.prototype,
          'currentAuthorization'
        )
        .mockImplementation(() => {
          throw stoppedAtBoundary;
        });
      const review = jest.spyOn(CodexProvider.prototype, 'review');
      const execute = jest.spyOn(
        NodeCodexAppServerTurnRunner.prototype,
        'executeTurn'
      );
      const fetchImpl = jest.fn<
        Promise<Response>,
        [RequestInfo | URL, RequestInit?]
      >();
      const credentialLease = jest.fn(() => ({
        environment: { OPENROUTER_API_KEY: 'never-read' },
      }));
      try {
        fs.mkdirSync(path.join(root, '.github'));
        fs.writeFileSync(
          path.join(root, '.github/multi-review.yml'),
          [
            'providers: [openrouter/attacker/model]',
            'fallback_providers: [openrouter/attacker/fallback]',
            'codex_agentic_context: false',
            'budget_max_usd: 999',
            'run_timeout_seconds: 9999',
          ].join('\n')
        );
        process.env.REVIEW_PROVIDERS = 'openrouter/ambient/model';
        process.env.BUDGET_MAX_USD = '888';
        process.env.RUN_TIMEOUT_SECONDS = '8888';
        process.env.CODEX_AGENTIC_CONTEXT = 'false';
        process.env.CODEX_REASONING_EFFORT = 'low';
        await expect(
          new ProductionT0ReviewRunner(fetchImpl).run({
            apiUrl: 'https://fixture.invalid',
            audience: 'reviewrouter',
            workflowSchemaVersion: 2,
            repository: 'fixture/repository',
            pullRequestNumber: 1,
            headSha: 'a'.repeat(40),
            workspacePath: root,
            codexHome: path.join(root, 'home'),
            scmReadToken: 'fixture-scm',
            scmReadTokenExpiresAt: new Date(
              Date.now() + 3_600_000
            ).toISOString(),
            refreshScmReadToken: async () => {
              throw new Error('unexpected refresh');
            },
            providerApi: {
              modelTransport: {
                baseUrl: 'http://127.0.0.1:1234',
                environment: {},
                configuration: [],
                actualModel: () => undefined,
                failureFact: () => undefined,
                dispose: async () => undefined,
              },
              runtimeConfig: parseAdmittedRuntimeConfig({
                protocolVersion: 1,
                configVersion: 7,
                runtimeEnv,
              }),
              signal: new AbortController().signal,
              controlPlane: new ReviewActionV2ControlPlaneAdapter(
                new ReviewActionV2Client({
                  apiUrl: 'https://fixture.invalid',
                  fetchImpl,
                })
              ),
              credentialLease,
            },
          })
        ).rejects.toBe(stoppedAtBoundary);
        expect(configuration).not.toHaveBeenCalled();
        expect(captured).toHaveBeenCalledWith(runtimeEnv, {
          modelTransport: true,
        });
        const resolved = captured.mock.results[0].value as ReviewConfig;
        expect(resolved.providers).toEqual([
          'openrouter/vendor/captured-model',
        ]);
        expect(resolved.fallbackProviders).toEqual([]);
        expect(resolved.codexAgenticContext).toBe(true);
        expect(resolved.budgetMaxUsd).toBe(DEFAULT_CONFIG.budgetMaxUsd);
        expect(resolved.runTimeoutSeconds).toBe(
          DEFAULT_CONFIG.runTimeoutSeconds
        );
        expect(current).toHaveBeenCalledTimes(1);
        expect(review).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(credentialLease).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        const expectedEffort = capturedEffort ?? 'xhigh';
        expect(process.env.CODEX_REASONING_EFFORT).toBe(expectedEffort);
        const primary = new CodexProvider('vendor/captured-model', {
          modelProvider: 'openrouter',
          providerNamePrefix: 'openrouter',
          agenticContext: false,
          disableBuiltinTools: true,
          waitForProcessClose: true,
        });
        Object.defineProperty(primary, 'resolveBinary', {
          value: async () => '/qualified/codex',
        });
        const prepared = await primary.prepareInvocation(
          'Review captured patch',
          1000
        );
        expect(prepared.request.argsTemplate).toContain(
          `model_reasoning_effort="${expectedEffort}"`
        );
        const effectiveEffort = resolveProductionInvestigationReasoningEffort({
          codexModel: 'vendor/captured-model',
          accountGateway: false,
          providerApi: true,
          serverReasoningEffort: runtimeEnv.CODEX_REASONING_EFFORT,
        });
        execute.mockRejectedValue(stoppedAtBoundary);
        const agents = createConfiguredProductionInvestigationAgents({
          codexModel: 'vendor/captured-model',
          codexBinaryPath: '/qualified/codex',
          reasoningEffort: effectiveEffort,
          directCredentialLease: credentialLease,
          executionSessions: {
            resolve: () => ({
              policyVersion: 'context-gateway-v4',
              binaryHash: 'a'.repeat(64),
              command: process.execPath,
              args: ['/fixture/gateway.js'],
              cwd: root,
              enabledTools: REVIEW_INVESTIGATION_GATEWAY_TOOLS,
              runtimeEnvironment: {
                REVIEWROUTER_CONTEXT_SESSION_ID: 'fixture-session',
              },
              credentialEnvironment: {
                REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'fixture-capability',
              },
            }),
          },
        });
        await expect(
          agents[0]!.agent.executeTurn({
            invocationId: 'fixture-invocation',
            fencingToken: 'fixture-fence',
            turnId: 'fixture-turn',
            dossierVersion: 1,
            dossierDigest: 'b'.repeat(64),
            purpose: ReviewTurnPurpose.Discovery,
            allowedObligationIds: ['c'.repeat(64)],
            prompt: 'Review captured patch',
            workspaceRoot: root,
            requestedModel: 'vendor/captured-model',
            timeoutMs: 1000,
            maxTurns: 1,
            executionSession: {
              kind: ReviewAgentExecutionSessionKind.ContextGatewayV4,
            },
          })
        ).rejects.toBe(stoppedAtBoundary);
        expect(execute.mock.calls[0][0].protocol.reasoningEffort).toBe(
          expectedEffort
        );
      } finally {
        process.env = previousEnv;
        configuration.mockRestore();
        captured.mockRestore();
        current.mockRestore();
        review.mockRestore();
        execute.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['mimo-v2.6-pro', true, 'high', 'high', false, 'xhigh', undefined],
    ['mimo-v2.6-pro', true, undefined, 'high', false, 'xhigh', undefined],
    ['mimo-v2.6-pro', true, 'low', 'low', false, 'xhigh', undefined],
    ['mimo-v2.6-pro', true, 'medium', 'medium', false, 'xhigh', undefined],
    ['mimo-v2.6-pro', true, 'xhigh', 'xhigh', true, 'xhigh', undefined],
    ['mimo-v2.6-pro', true, 'ultra', 'ultra', true, 'xhigh', undefined],
    ['mimo-v2.6-pro', true, 'arbitrary', 'arbitrary', true, 'xhigh', undefined],
    ['mimo-v2.6-pro', true, '', '', true, 'xhigh', undefined],
    ['mimo-v2.6-pro', true, 'none', 'none', true, 'xhigh', undefined],
    ['gpt-selected', true, undefined, 'xhigh', false, 'xhigh', 'bare'],
    ['gpt-selected', true, 'ultra', 'ultra', false, 'xhigh', 'absolute'],
    ['mimo-v2.6-pro', false, undefined, 'xhigh', false, 'xhigh', undefined],
    ['gpt-selected', true, undefined, undefined, false, undefined, 'relative'],
    ['mimo-v2.6-pro', false, undefined, undefined, false, undefined, undefined],
    [
      'gpt-selected',
      true,
      undefined,
      'custom-caller-effort',
      false,
      'custom-caller-effort',
      undefined,
    ],
    ['mimo-v2.6-pro', true, undefined, 'high', false, undefined, undefined],
  ] as const)(
    'resolves effort for selected %s, gateway %s, server %s (expected %s, denied %s, caller %s) before effects',
    async (
      model,
      accountGateway,
      serverEffort,
      expectedEffort,
      denied,
      callerEffort,
      binaryKind?: 'bare' | 'absolute' | 'relative'
    ) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-runner-effort-'))
      );
      const previousEnv = { ...process.env };
      const previousCwd = process.cwd();
      const toolPath = ['/fixture/trusted-tools', '/fixture/system-tools'];
      const expectedBinary =
        binaryKind === 'bare'
          ? 'codex'
          : binaryKind === 'absolute'
            ? path.join(os.tmpdir(), 'trusted-host-cli', 'codex')
            : path.join(previousCwd, 'trusted-host-cli', 'codex');
      const codexBinaryPath =
        binaryKind === 'relative' ? './trusted-host-cli/codex' : expectedBinary;
      let observedEnvironment:
        | {
            cwd: string;
            path: string | undefined;
            binary: string | undefined;
          }
        | undefined;
      const stoppedAtBoundary = new Error('mock authorization boundary');
      const configuration = jest
        .spyOn(ConfigLoader, 'load')
        .mockImplementation(() => {
          observedEnvironment = {
            cwd: process.cwd(),
            path: process.env.PATH,
            binary: process.env.REVIEWROUTER_CODEX_BINARY,
          };
          return {
            ...DEFAULT_CONFIG,
            providers: [`codex/${process.env.CODEX_MODEL}`],
          };
        });
      const oidc = jest
        .spyOn(GitHubActionsOidcTokenProvider.prototype, 'requestToken')
        .mockResolvedValue('fixture-oidc');
      const authorize = jest
        .spyOn(ReviewActionV2ControlPlaneAdapter.prototype, 'authorize')
        .mockRejectedValue(stoppedAtBoundary);
      const current = jest
        .spyOn(
          ReviewActionV2ControlPlaneAdapter.prototype,
          'currentAuthorization'
        )
        .mockImplementation(() => {
          throw stoppedAtBoundary;
        });
      const execute = jest
        .spyOn(NodeCodexAppServerTurnRunner.prototype, 'executeTurn')
        .mockRejectedValue(new Error('unexpected AppServer call'));
      const review = jest
        .spyOn(CodexProvider.prototype, 'review')
        .mockRejectedValue(new Error('unexpected provider call'));
      const fetchImpl = jest
        .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ sessionToken: 'fixture-session' }))
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              configVersion: 7,
              runtimeEnv: {
                CODEX_MODEL: model,
                ...(serverEffort === undefined
                  ? {}
                  : { CODEX_REASONING_EFFORT: serverEffort }),
              },
            })
          )
        );
      try {
        if (binaryKind) {
          process.env.PATH = toolPath.join(path.delimiter);
          process.env.REVIEWROUTER_CODEX_BINARY = 'fixture-previous-codex';
        }
        process.env.CODEX_MODEL = 'caller-model';
        if (callerEffort === undefined) {
          delete process.env.CODEX_REASONING_EFFORT;
        } else {
          process.env.CODEX_REASONING_EFFORT = callerEffort;
        }
        const controlPlane = new ReviewActionV2ControlPlaneAdapter(
          new ReviewActionV2Client({
            apiUrl: 'https://fixture.invalid',
            fetchImpl,
          })
        );
        const operation = new ProductionT0ReviewRunner(fetchImpl).run({
          apiUrl: 'https://fixture.invalid',
          audience: 'reviewrouter',
          providerInstanceId: 'fixture-provider',
          workflowSchemaVersion: 1,
          repository: 'fixture/repository',
          pullRequestNumber: 1,
          headSha: 'a'.repeat(40),
          workspacePath: root,
          codexHome: path.join(root, 'home'),
          ...(binaryKind ? { codexBinaryPath } : {}),
          scmReadToken: 'fixture-scm',
          scmReadTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          refreshScmReadToken: async () => {
            throw new Error('unexpected refresh');
          },
          ...(accountGateway
            ? {
                accountGateway: {
                  runtimeConfig: parseAdmittedRuntimeConfig({
                    protocolVersion: 1,
                    configVersion: 7,
                    runtimeEnv: {
                      ...admittedAgentEnv,
                      CODEX_MODEL: model,
                      ...(serverEffort === undefined
                        ? {}
                        : { CODEX_REASONING_EFFORT: serverEffort }),
                    },
                  }),
                  controlPlane,
                  modelTransport: {
                    baseUrl: 'http://127.0.0.1:1/v1',
                    configuration: [],
                    environment: { CODEX_HOME: path.join(root, 'home') },
                    actualModel: () => model,
                    failureFact: () => undefined,
                    dispose: async () => {},
                  },
                },
              }
            : {}),
        });
        if (denied) {
          await expect(operation).rejects.toThrow(
            'account_gateway_mimo_reasoning_effort_unsupported'
          );
          expect(current).not.toHaveBeenCalled();
          expect(authorize).not.toHaveBeenCalled();
        } else {
          await expect(operation).rejects.toBe(stoppedAtBoundary);
          expect(accountGateway ? current : authorize).toHaveBeenCalledTimes(1);
        }
        expect(process.env.CODEX_MODEL).toBe(model);
        expect(process.env.CODEX_REASONING_EFFORT).toBe(expectedEffort);
        expect(fetchImpl).toHaveBeenCalledTimes(accountGateway ? 0 : 2);
        expect(oidc).toHaveBeenCalledTimes(accountGateway ? 0 : 2);
        expect(execute).not.toHaveBeenCalled();
        expect(review).not.toHaveBeenCalled();
        if (binaryKind) {
          expect(observedEnvironment?.cwd).toBe(root);
          expect(observedEnvironment?.binary).toBe(expectedBinary);
          const searchPath = observedEnvironment?.path?.split(path.delimiter);
          expect(searchPath).toEqual(
            binaryKind === 'bare'
              ? toolPath
              : [path.dirname(expectedBinary), ...toolPath]
          );
          expect(searchPath).not.toContain('.');
          expect(searchPath).not.toContain(root);
          expect(process.cwd()).toBe(previousCwd);
          expect(process.env.PATH).toBe(toolPath.join(path.delimiter));
          expect(process.env.REVIEWROUTER_CODEX_BINARY).toBe(
            'fixture-previous-codex'
          );
        }
      } finally {
        process.env = previousEnv;
        configuration.mockRestore();
        oidc.mockRestore();
        authorize.mockRestore();
        current.mockRestore();
        execute.mockRestore();
        review.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([true, false])(
    'reports one safe subprocess failure through the configured gateway=%s runner',
    async (gateway) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'appserver-observer-')
      );
      const home = path.join(root, 'home');
      const binary = path.join(root, 'codex-fixture');
      fs.mkdirSync(home);
      fs.writeFileSync(
        binary,
        `#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.147.0');
  process.exit(0);
}
process.stdin.once('data', () => {
  process.stderr.write('panic private-stderr-sentinel');
  process.exit(17);
});
`,
        { mode: 0o700 }
      );
      const warning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const agents = createConfiguredProductionInvestigationAgents({
          codexModel: 'gpt-fixture',
          codexBinaryPath: binary,
          reasoningEffort: 'high',
          ...(gateway
            ? {
                modelTransport: {
                  baseUrl: 'http://127.0.0.1:1/v1',
                  configuration: [],
                  environment: { CODEX_HOME: home },
                  actualModel: () => 'gpt-fixture',
                  failureFact: () => undefined,
                  dispose: async () => {},
                },
              }
            : {}),
          executionSessions: {
            resolve: () => ({
              policyVersion: 'context-gateway-v4',
              binaryHash: 'a'.repeat(64),
              command: process.execPath,
              args: [path.join(root, 'unused-context-gateway.cjs')],
              cwd: root,
              enabledTools: REVIEW_INVESTIGATION_GATEWAY_TOOLS,
              runtimeEnvironment: {},
              credentialEnvironment: {},
            }),
          },
        });
        await expect(
          agents[0].agent.executeTurn({
            invocationId: 'observer-invocation',
            fencingToken: 'observer-fence',
            turnId: 'observer-turn',
            dossierVersion: 1,
            dossierDigest: 'b'.repeat(64),
            purpose: ReviewTurnPurpose.Discovery,
            allowedObligationIds: ['c'.repeat(64)],
            prompt: 'Review fixture',
            workspaceRoot: root,
            requestedModel: 'gpt-fixture',
            timeoutMs: 5_000,
            maxTurns: 1,
            executionSession: {
              kind: ReviewAgentExecutionSessionKind.ContextGatewayV4,
            },
          })
        ).rejects.toMatchObject({ message: 'review_agent_process_failure' });
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          'Review investigation app-server process failed',
          expect.objectContaining({
            termination: 'exited',
            exitCode: 17,
            diagnosticKinds: ['internal'],
            stderrByteCount: Buffer.byteLength('panic private-stderr-sentinel'),
          })
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain(
          'private-stderr-sentinel'
        );
      } finally {
        warning.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    15_000
  );

  it('treats providerRetries as the total provider attempt budget', () => {
    expect(resolveT0AttemptBudget(3, 10)).toBe(3);
    expect(resolveT0AttemptBudget(0, 10)).toBe(1);
  });

  it('caps the configured total attempts at the protocol maximum', () => {
    expect(resolveT0AttemptBudget(5, 2)).toBe(2);
  });

  it.each([
    ['off', undefined, 0],
    ['off', '{invalid', 0],
    ['report', undefined, 1],
    ['resolve', undefined, 1],
    ['resolve', '{invalid', 0],
    ['resolve', '', 0],
  ] as const)(
    'selects legacy lifecycle targets with mode=%s and captured profile=%s',
    (mode, capabilityJson, count) => {
      const target = { targetId: 'old-target' } as LifecycleTarget;
      expect(
        selectLegacyLifecycleTargets(mode, capabilityJson, [target])
      ).toEqual(count ? [target] : []);
    }
  );

  it('continues exact legacy discovery with a present invalid cap and no frozen metadata', () => {
    const admitted = authorization(1);
    const planned = planAssignments({
      authorization: admitted,
      pr: pullRequest(['src/a.ts']),
      config: DEFAULT_CONFIG,
      providerName: 'codex/gpt-test',
      compatibilityKey: '7'.repeat(64),
      lifecycleTargets: selectLegacyLifecycleTargets('resolve', '{invalid', [
        { targetId: 'old-target' } as LifecycleTarget,
      ]),
      liveLifecycleStateHash: '8'.repeat(64),
    });
    const restored: RestoredReviewExecution = {
      executionId: 'existing-native-execution',
      version: '9',
      streamVersion: '8',
      generation: '3',
      state: RestoredReviewExecutionState.Running,
      authorizationId: admitted.authorizationId,
      reviewRevisionHash: admitted.facts.reviewRevisionHash,
      planHash: planned.plan.planHash,
      workSlots: planned.plan.assignments.map(({ workSlot }) => ({
        workSlotId: workSlot.workSlotId,
        required: workSlot.required,
        providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        state: RestoredReviewWorkSlotState.Pending,
        activeLeaseId: null,
        acceptedObservationRefId: null,
      })),
    };
    const restoredLifecycle = restoreProductionLifecycleVerification(
      restored,
      planned.plan,
      DEFAULT_CONFIG
    );
    expect(restoredLifecycle.plan).toBe(planned.plan);
    expect(restoredLifecycle.packetsByWorkSlotId.size).toBe(0);
    expect(restoredLifecycle.lifecycleVerification).toBeUndefined();
    expect(planned.assignments[0].lifecycleTargets).toEqual([]);
    const original = canonicalJson(restored);
    expect(() =>
      assertLegacyReviewPlanRestorable(restored, planned.plan)
    ).not.toThrow();
    expect(canonicalJson(restored)).toBe(original);
    for (const incompatible of [
      { ...restored, planHash: '9'.repeat(64) },
      { ...restored, workSlots: [] },
      {
        ...restored,
        workSlots: [
          ...restored.workSlots,
          { ...restored.workSlots[0], workSlotId: 'original-lifecycle-slot' },
        ],
      },
      {
        ...restored,
        workSlots: [...restored.workSlots, restored.workSlots[0]],
      },
      ...[
        { workSlotId: 'different-slot' },
        { required: false },
        { providerVoteIdentityHash: '9'.repeat(64) },
      ].map((change) => ({
        ...restored,
        workSlots: [{ ...restored.workSlots[0], ...change }],
      })),
    ]) {
      expect(() =>
        assertLegacyReviewPlanRestorable(incompatible, planned.plan)
      ).toThrow('review_restore_legacy_plan_unavailable');
    }
    expect(() =>
      assertLegacyReviewPlanRestorable(null, planned.plan)
    ).not.toThrow();
    expect(() =>
      assertLegacyReviewPlanRestorable(
        {
          ...restored,
          persistedPlan: {
            planHash: restored.planHash,
            assignmentManifestVersion: 1,
            assignmentManifestHash: planned.plan.assignmentManifestHash,
            assignmentManifestCanonicalJson:
              planned.plan.assignmentManifestCanonicalJson,
            workSlots: planned.plan.assignments.map(({ workSlot }) => workSlot),
            artifact: null,
          },
        },
        planned.plan
      )
    ).not.toThrow();
  });

  it('pins agentic reviews to the release gateway policy independently of investigation rollout', () => {
    expect(
      resolveProductionContextGatewayPolicyVersion({ agenticContext: true })
    ).toBe(CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION);
    expect(
      resolveProductionContextGatewayPolicyVersion({ agenticContext: false })
    ).toBeNull();

    const baseOptions = {
      agenticContext: true,
      checkoutRoot: '/tmp/review',
      gatewayBundlePath: '/tmp/context-gateway.js',
    } as const;
    expect(
      resolveProductionContextGatewaySessionFactoryOptions({
        ...baseOptions,
        investigationRecordingEnabled: false,
      })
    ).toEqual({
      checkoutRoot: baseOptions.checkoutRoot,
      gatewayBundlePath: baseOptions.gatewayBundlePath,
      policyVersion: CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION,
    });
    expect(
      resolveProductionContextGatewaySessionFactoryOptions({
        ...baseOptions,
        investigationRecordingEnabled: true,
      })
    ).toEqual({
      checkoutRoot: baseOptions.checkoutRoot,
      gatewayBundlePath: baseOptions.gatewayBundlePath,
      policyVersion: CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION,
    });
  });

  it('translates orchestration gateway drift at the investigation runtime boundary', async () => {
    const delegate = {
      open: jest
        .fn()
        .mockRejectedValue(
          new ReviewInvocationConfigurationMismatchError(
            ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch
          )
        ),
    };
    const factory = createProductionReviewInvestigationGatewayFactory(
      delegate as never
    );

    await expect(factory.open({} as never)).rejects.toMatchObject({
      name: InvestigationContextGatewayRuntimeConfigurationError.name,
      reason:
        InvestigationContextGatewayRuntimeConfigurationFailureReason.ContextGatewayPolicyMismatch,
    });
    expect(delegate.open).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps genuinely off-diff history outside required coverage (empty=%s)',
    (empty) => {
      const pr = pullRequest(empty ? [] : ['src/a.ts', 'src/b.ts']);
      const historical = {
        targetId: 'historical',
        threadId: 'thread-old',
        fingerprint: 'old-fingerprint',
        severity: 'major' as const,
        title: 'Old caller defect',
        message: 'Historical finding',
        originalPath: '.github/workflows/reviewrouter-codex.yml',
        parentCommentId: 'comment-old',
        parentCommentUpdatedAt: '2026-07-22T00:00:00Z',
        threadCommentCount: 1,
        viewerCanResolve: true,
        hasHumanReply: false,
        trustedAuthor: true,
      };
      const changed = {
        ...historical,
        targetId: 'changed',
        originalPath: 'src/b.ts',
      };
      const options = {
        authorization: authorization(1),
        pr,
        config: {
          providers: ['codex/gpt-test'],
          batchMaxFiles: 1,
          enableTokenAwareBatching: false,
          providerRetries: 1,
        } as ReviewConfig,
        providerName: 'codex/gpt-test',
        compatibilityKey: '7'.repeat(64),
        lifecycleTargets: empty ? [historical] : [historical, changed],
        liveLifecycleStateHash: '8'.repeat(64),
      };
      const planned = planAssignments(options);
      // Old inventory is prompt input, not a member of the legacy frozen plan.
      expect(
        planAssignments({ ...options, lifecycleTargets: [] }).plan.planHash
      ).toBe(planned.plan.planHash);
      expect(planned.assignments).toHaveLength(1);
      expect(
        planned.assignments.flatMap((a) => a.lifecycleTargets)
      ).not.toContain(historical);
      expect(
        planned.assignments.flatMap((a) =>
          a.context.files.map((f) => f.filename)
        )
      ).not.toContain(historical.originalPath);
      expect(planned.uncoveredLifecycleTargetIds).toEqual(
        empty ? [] : ['changed']
      );
      expect(
        planAssignments({
          ...options,
          lifecycleTargets: [...options.lifecycleTargets].reverse(),
        })
      ).toEqual(planned);
    }
  );

  it('keeps a renamed changed-path target assigned rather than classifying it as historical', () => {
    const pr = pullRequest(['src/new.ts']);
    pr.files[0].previousFilename = 'src/old.ts';
    const target = {
      targetId: 'renamed',
      threadId: 'thread-old',
      fingerprint: 'old-fingerprint',
      severity: 'major' as const,
      title: 'Old defect',
      message: 'Historical finding',
      originalPath: 'src/old.ts',
      parentCommentId: 'comment-old',
      parentCommentUpdatedAt: '2026-07-22T00:00:00Z',
      threadCommentCount: 1,
      viewerCanResolve: true,
      hasHumanReply: false,
      trustedAuthor: true,
    };
    const planned = planAssignments({
      authorization: authorization(1),
      pr,
      config: DEFAULT_CONFIG,
      providerName: 'codex/gpt-test',
      compatibilityKey: '7'.repeat(64),
      lifecycleTargets: [target],
      liveLifecycleStateHash: '8'.repeat(64),
    });
    expect(planned.assignments[0].lifecycleTargets).toEqual([target]);
    expect(planned.uncoveredLifecycleTargetIds).toEqual([]);
  });

  it('never re-merges token-safe groups after max work slots', () => {
    const pr = pullRequest(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const planned = planAssignments({
      authorization: authorization(1),
      pr,
      config: {
        providers: ['codex/gpt-test'],
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
        providerRetries: 1,
      } as ReviewConfig,
      providerName: 'codex/gpt-test',
      compatibilityKey: '7'.repeat(64),
      lifecycleTargets: [],
      liveLifecycleStateHash: '8'.repeat(64),
    });

    expect(planned.assignments).toHaveLength(1);
    expect(planned.assignments[0].context.files).toHaveLength(1);
    expect(planned.uncoveredPaths).toHaveLength(2);
    expect(JSON.parse(planned.plan.assignmentManifestCanonicalJson)).toEqual({
      assignments: [
        {
          paths: planned.assignments[0].context.files.map(
            (file) => file.filename
          ),
          workSlotId: planned.assignments[0].workSlot.workSlotId,
        },
      ],
      eligiblePaths: [...pr.files.map((file) => file.filename)].sort(),
      excludedPaths: [],
      manifestVersion: 1,
      uncoveredPaths: [...planned.uncoveredPaths],
    });
    expect(
      new Set([
        planned.assignments[0].context.files[0].filename,
        ...planned.uncoveredPaths,
      ])
    ).toEqual(new Set(pr.files.map((file) => file.filename)));
  });

  it('reserves one optional description without displacing review or feeding owned body blocks back', () => {
    const pr = pullRequest(['src/a.ts', 'src/b.ts']);
    const author = '  Author requirement.\n';
    pr.body = `${author}<!-- review-router-summary:start -->generated requirement<!-- review-router-summary:end -->\n<!-- ai-robot-review-summary:start -->legacy generated<!-- ai-robot-review-summary:end -->Author footer. `;
    const options = {
      prDescriptionEnabled: true,
      pr,
      config: {
        ...DEFAULT_CONFIG,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
      },
      providerName: 'codex/gpt-test',
      compatibilityKey: '7'.repeat(64),
      lifecycleTargets: [],
      liveLifecycleStateHash: '8'.repeat(64),
    };
    const planned = planAssignments({
      ...options,
      authorization: authorization(3),
    });
    expect(planned.assignments).toHaveLength(2);
    expect(
      planned.assignments.map((assignment) => assignment.context.body)
    ).toEqual([`${author}\nAuthor footer. `, `${author}\nAuthor footer. `]);
    const optional = planned.plan.assignments.filter(
      (assignment) =>
        assignment.workSlot.taskKind === ReviewTaskKind.PrDescription
    );
    expect(optional).toHaveLength(1);
    expect(optional[0].workSlot).toMatchObject({
      required: false,
      attemptBudget: 1,
    });
    const full = planAssignments({
      ...options,
      authorization: authorization(2),
    });
    expect(full.plan.assignments).toHaveLength(2);
    expect(
      full.plan.assignments.every((assignment) => assignment.workSlot.required)
    ).toBe(true);
    expect(full.uncoveredPaths).toEqual([]);
    expect(pr.body).toContain('generated requirement');
  });

  it('uses locale-independent code-unit ordering for v2 projection inputs', () => {
    expect(['ä', 'z', 'A'].sort(compareCodeUnits)).toEqual(['A', 'z', 'ä']);
  });

  it.each([
    [
      ReviewOrchestrationResultStatus.PublicationNotApplied,
      CodexOAuthV2ReviewOutcome.PublicationNotApplied,
      CodexOAuthV2TerminalReason.PublicationConflict,
      'review_action_v2_publication_not_applied',
    ],
    [
      ReviewOrchestrationResultStatus.PublicationStale,
      CodexOAuthV2ReviewOutcome.PublicationStale,
      CodexOAuthV2TerminalReason.PublicationStale,
      'review_action_v2_publication_stale',
    ],
  ])(
    'never maps %s to a completed review',
    (status, outcome, reason, blockingFailure) => {
      expect(mapOrchestrationResultToCodexOutcome({ status })).toEqual({
        outcome,
        reason,
        blockingFailure,
      });
    }
  );

  it('marks only a closed pull request as an intentional cancellation', () => {
    expect(
      mapOrchestrationResultToCodexOutcome({
        status: ReviewOrchestrationResultStatus.Cancelled,
      })
    ).toEqual({
      outcome: CodexOAuthV2ReviewOutcome.Cancelled,
      reason: CodexOAuthV2CancellationReason.PullRequestClosed,
    });
  });

  it('maps unavailable publication facts without collapsing them into execution failure', () => {
    expect(
      mapOrchestrationResultToCodexOutcome({
        status: ReviewOrchestrationResultStatus.PublicationUnavailable,
        failureCode: 'publication_facts_unavailable',
        unavailablePublicationFacts: [
          ReviewPublicationUnavailableFact.Lifecycle,
        ],
      })
    ).toEqual({
      outcome: CodexOAuthV2ReviewOutcome.PublicationUnavailable,
      reason: CodexOAuthV2TerminalReason.PublicationFactsUnavailable,
      unavailableFacts: [ReviewPublicationUnavailableFact.Lifecycle],
      blockingFailure: 'publication_facts_unavailable',
    });
  });

  it.each([
    [
      'required_provider_lane_busy',
      CodexOAuthV2TerminalReason.RequiredProviderLaneBusy,
    ],
    [
      'required_investigation_deferred',
      CodexOAuthV2TerminalReason.RequiredInvestigationDeferred,
    ],
    [
      'required_execution_deadline_reached',
      CodexOAuthV2TerminalReason.RequiredWorkExhausted,
    ],
  ])(
    'keeps incomplete required partial coverage blocking for %s',
    (failureCode, reason) => {
      expect(
        mapOrchestrationResultToCodexOutcome({
          status: ReviewOrchestrationResultStatus.PartialCompleted,
          failureCode,
        })
      ).toEqual({
        outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
        reason,
        blockingFailure: failureCode,
      });
    }
  );

  it('keeps real orchestration failures blocking', () => {
    expect(
      mapOrchestrationResultToCodexOutcome({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'provider_failed',
      })
    ).toEqual({
      outcome: CodexOAuthV2ReviewOutcome.Failed,
      reason: CodexOAuthV2TerminalReason.ExecutionFailed,
      blockingFailure: 'provider_failed',
    });
  });

  it('preserves the authoritative publication receipt for gateway terminal reporting', () => {
    const orchestration = {
      status: ReviewOrchestrationResultStatus.Completed,
      mergeGateConclusion: MergeGateConclusion.Fail,
      publicationAttemptId: 'publication-fixture-1',
      canonicalReceiptSetHash: 'c'.repeat(64),
    };
    expect(mapOrchestrationResultToCodexOutcome(orchestration)).toEqual({
      outcome: CodexOAuthV2ReviewOutcome.Completed,
      mergeGateConclusion: MergeGateConclusion.Fail,
      publicationReceipt: {
        publicationAttemptId: 'publication-fixture-1',
        canonicalReceiptSetHash: 'c'.repeat(64),
      },
    });
  });

  it('preserves the completed projection merge gate conclusion', () => {
    expect(
      mapOrchestrationResultToCodexOutcome({
        status: ReviewOrchestrationResultStatus.Completed,
        mergeGateConclusion: MergeGateConclusion.Fail,
      })
    ).toEqual({
      outcome: CodexOAuthV2ReviewOutcome.Completed,
      mergeGateConclusion: MergeGateConclusion.Fail,
    });
  });

  it('keeps a locally requested investigation on legacy with old authorization facts', () => {
    expect(
      resolveProductionReviewInvestigationRollout({
        flags: rolloutFlags({ recordingEnabled: true }),
        agenticContext: true,
        authorization: authorization(1),
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      }).recordingEnabled
    ).toBe(false);
  });

  it('keeps all rollout flags disabled by default', () => {
    expect(readProductionReviewInvestigationRolloutFlags({})).toEqual(
      rolloutFlags()
    );
  });

  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['1', true],
  ])('parses the strict recording flag value %p', (value, expected) => {
    expect(
      readProductionReviewInvestigationRolloutFlags({
        REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: value,
      }).recordingEnabled
    ).toBe(expected);
  });

  it.each(['true', 'false', '2', ' ', '01'])(
    'rejects non-canonical rollout flag value %p',
    (value) => {
      expect(() =>
        readProductionReviewInvestigationRolloutFlags({
          REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: value,
        })
      ).toThrow('review_investigation_rollout_flag_invalid:recording');
    }
  );

  it('enables record-only execution without shadow or critic', () => {
    const rollout = resolveProductionReviewInvestigationRollout({
      flags: rolloutFlags({ recordingEnabled: true }),
      agenticContext: true,
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    });

    expect(rollout).toEqual(
      rolloutFlags({
        recordingEnabled: true,
      })
    );
    expect(productionReviewInvestigationRecordingMode(rollout)).toBe(
      ReviewInvestigationRecordingMode.RecordOnly
    );
  });

  it('disables all investigation work in economy and reports the depth reason', () => {
    const resolution = resolveProductionReviewInvestigationRolloutResolution({
      flags: rolloutFlags({
        recordingEnabled: true,
        contextCriticEnabled: true,
      }),
      agenticContext: true,
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
      reviewDepth: ReviewDepth.Economy,
    });
    const create = jest.fn();

    expect(
      createProductionReviewInvestigationInvocation({
        rollout: resolution.rollout,
        create,
      })
    ).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(resolution.rollout).toEqual(rolloutFlags());
    expect(resolution.reason).toBe(
      ProductionReviewInvestigationRolloutReason.ReviewDepthEconomy
    );
    expect(
      formatProductionReviewInvestigationRolloutTelemetry(resolution)
    ).toContain('reason=review_depth_economy');
  });

  it('creates the investigation invocation dependency for accepted config and authorization', async () => {
    const resolution = resolveProductionReviewInvestigationRolloutResolution({
      flags: readProductionReviewInvestigationRolloutFlags({
        REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: '1',
        REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: '1',
      }),
      agenticContext: true,
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    });
    const prepare = jest.fn().mockResolvedValue('prepared-investigation');
    const create = jest.fn(() => ({ prepare }));

    const invocation = createProductionReviewInvestigationInvocation({
      rollout: resolution.rollout,
      create,
    });

    await expect(invocation?.prepare()).resolves.toBe('prepared-investigation');
    expect(create).toHaveBeenCalledTimes(1);
    expect(resolution.reason).toBe(
      ProductionReviewInvestigationRolloutReason.Enabled
    );
    expect(
      formatProductionReviewInvestigationRolloutTelemetry(resolution)
    ).toBe(
      'Review investigation rollout: recording=true reason=enabled shadow=true contextCritic=false verifiedClean=false crossRevisionReplay=false productionEffects=false'
    );
  });

  it.each([
    {
      name: 'disabled config',
      recordingEnabled: false,
      descriptorAccepted: true,
      reason: ProductionReviewInvestigationRolloutReason.RecordingFlagDisabled,
    },
    {
      name: 'fail-closed authorization',
      recordingEnabled: true,
      descriptorAccepted: false,
      reason:
        ProductionReviewInvestigationRolloutReason.AuthorizationDescriptorMissing,
    },
  ])(
    'does not create investigation dependencies for $name',
    ({ recordingEnabled, descriptorAccepted, reason }) => {
      const resolution = resolveProductionReviewInvestigationRolloutResolution({
        flags: rolloutFlags({ recordingEnabled }),
        agenticContext: true,
        authorization: descriptorAccepted
          ? authorizationWithInvestigation()
          : authorization(1),
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      });
      const create = jest.fn(() => ({ prepare: jest.fn() }));

      expect(
        createProductionReviewInvestigationInvocation({
          rollout: resolution.rollout,
          create,
        })
      ).toBeUndefined();
      expect(create).not.toHaveBeenCalled();
      expect(resolution.reason).toBe(reason);
    }
  );

  it.each([
    {
      capability: ReviewInvestigationRolloutCapability.Recording,
      grants: [ReviewInvestigationRolloutCapability.Recording],
      expected: rolloutFlags({ recordingEnabled: true }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.Shadow,
      grants: [
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
      }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.ContextCritic,
      grants: [
        ReviewInvestigationRolloutCapability.ContextCritic,
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
      }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.CrossRevisionReplay,
      grants: [
        ReviewInvestigationRolloutCapability.CrossRevisionReplay,
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        crossRevisionReplayEnabled: true,
      }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.ProductionEffects,
      grants: [
        ReviewInvestigationRolloutCapability.ContextCritic,
        ReviewInvestigationRolloutCapability.ProductionEffects,
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        productionEffectsEnabled: true,
      }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.VerifiedClean,
      grants: [
        ReviewInvestigationRolloutCapability.ContextCritic,
        ReviewInvestigationRolloutCapability.ProductionEffects,
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
        ReviewInvestigationRolloutCapability.VerifiedClean,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        productionEffectsEnabled: true,
        verifiedCleanEnabled: true,
      }),
    },
  ])(
    'isolates the $capability server grant from locally enabled capabilities',
    ({ grants, expected }) => {
      const rollout = resolveProductionReviewInvestigationRollout({
        flags: rolloutFlags({
          recordingEnabled: true,
          shadowEnabled: true,
          contextCriticEnabled: true,
          verifiedCleanEnabled: true,
          crossRevisionReplayEnabled: true,
          productionEffectsEnabled: true,
        }),
        agenticContext: true,
        authorization: authorizationWithInvestigationCapabilities([
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: grants,
          },
        ]),
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      });

      expect(rollout).toEqual(expected);
    }
  );

  it('keeps all investigation capabilities disabled for legacy V2 authorization', () => {
    const rollout = resolveProductionReviewInvestigationRollout({
      flags: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        verifiedCleanEnabled: true,
        crossRevisionReplayEnabled: true,
        productionEffectsEnabled: true,
      }),
      agenticContext: true,
      authorization: authorizationWithLegacyInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    });

    expect(rollout).toEqual(rolloutFlags());
  });

  it('applies provider-specific grants independently', () => {
    const authorization = authorizationWithInvestigationCapabilities([
      {
        providerKind: ReviewExecutionProviderKind.Codex,
        capabilities: allInvestigationCapabilities,
      },
      {
        providerKind: ReviewExecutionProviderKind.ClaudeCode,
        capabilities: [ReviewInvestigationRolloutCapability.Recording],
      },
    ]);
    const flags = rolloutFlags({
      recordingEnabled: true,
      shadowEnabled: true,
      contextCriticEnabled: true,
      verifiedCleanEnabled: true,
      crossRevisionReplayEnabled: true,
      productionEffectsEnabled: true,
    });

    expect(
      resolveProductionReviewInvestigationRollout({
        flags,
        agenticContext: true,
        authorization,
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      })
    ).toEqual(flags);
    expect(
      resolveProductionReviewInvestigationRollout({
        flags,
        agenticContext: true,
        authorization,
        primaryProviderKind: ReviewExecutionProviderKind.ClaudeCode,
      })
    ).toEqual(rolloutFlags({ recordingEnabled: true }));
  });

  it('allows cross-revision replay in shadow without production effects', () => {
    const rollout = resolveProductionReviewInvestigationRollout({
      flags: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        crossRevisionReplayEnabled: true,
      }),
      agenticContext: true,
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    });

    expect(rollout.crossRevisionReplayEnabled).toBe(true);
    expect(rollout.productionEffectsEnabled).toBe(false);
    expect(productionReviewInvestigationRecordingMode(rollout)).toBe(
      ReviewInvestigationRecordingMode.RecordOnly
    );
  });

  it('keeps authoritative effects separate from shadow execution', () => {
    const base = {
      agenticContext: true,
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    } as const;
    const shadow = resolveProductionReviewInvestigationRollout({
      ...base,
      flags: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
      }),
    });
    const authoritative = resolveProductionReviewInvestigationRollout({
      ...base,
      flags: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        productionEffectsEnabled: true,
      }),
    });

    expect(productionReviewInvestigationRecordingMode(shadow)).toBe(
      ReviewInvestigationRecordingMode.RecordOnly
    );
    expect(productionReviewInvestigationRecordingMode(authoritative)).toBe(
      ReviewInvestigationRecordingMode.Authoritative
    );
  });

  it('rejects shadow without independently enabled recording', () => {
    expect(() =>
      resolveProductionReviewInvestigationRollout({
        flags: rolloutFlags({ shadowEnabled: true }),
        agenticContext: true,
        authorization: authorizationWithInvestigation(),
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      })
    ).toThrow('rollout_dependency_missing:shadow:recording');
  });

  it('enables investigation only for the exact V3 contract and allowed provider', () => {
    const negotiated = authorizationWithInvestigation();
    const descriptor = negotiated.facts.reviewInvestigation as unknown as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (descriptor === undefined) {
      throw new Error('expected V3 investigation descriptor');
    }
    const withDescriptor = (
      overrides: Readonly<Record<string, unknown>>
    ): ReviewRunAuthorization =>
      ({
        ...negotiated,
        facts: {
          ...negotiated.facts,
          reviewInvestigation: { ...descriptor, ...overrides },
        },
      }) as unknown as ReviewRunAuthorization;
    const enabled = (
      authorizationOverride: ReviewRunAuthorization = negotiated
    ) =>
      resolveProductionReviewInvestigationRollout({
        flags: rolloutFlags({ recordingEnabled: true }),
        agenticContext: true,
        authorization: authorizationOverride,
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      }).recordingEnabled;

    expect(enabled()).toBe(true);
    expect(
      enabled(withDescriptor({ coverageProfileHash: 'e'.repeat(64) }))
    ).toBe(false);
    expect(
      resolveProductionReviewInvestigationRolloutResolution({
        flags: rolloutFlags({ recordingEnabled: true }),
        agenticContext: true,
        authorization: withDescriptor({
          coverageProfileHash: 'e'.repeat(64),
        }),
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      }).reason
    ).toBe(
      ProductionReviewInvestigationRolloutReason.CoverageProfileHashMismatch
    );
    expect(enabled(withDescriptor({ policyHash: 'f'.repeat(64) }))).toBe(false);
    for (const [field, value] of [
      ['extensionId', 'review-investigation-shadow.future'],
      ['extensionSchemaDigest', 'a'.repeat(64)],
      ['extensionCanonicalizerDigest', 'b'.repeat(64)],
    ] as const) {
      expect(enabled(withDescriptor({ [field]: value }))).toBe(false);
    }
    expect(
      enabled(
        withDescriptor({
          providerCapabilities: [
            {
              providerKind: ReviewExecutionProviderKind.ClaudeCode,
              capabilities: allInvestigationCapabilities,
            },
          ],
        })
      )
    ).toBe(false);
  });

  it('reports every rollout reason with deterministic fail-closed precedence', () => {
    const negotiated = authorizationWithInvestigation();
    const descriptor = negotiated.facts.reviewInvestigation as unknown as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (!descriptor) throw new Error('expected V3 investigation descriptor');
    const withDescriptor = (
      overrides: Readonly<Record<string, unknown>>
    ): ReviewRunAuthorization =>
      ({
        ...negotiated,
        facts: {
          ...negotiated.facts,
          reviewInvestigation: { ...descriptor, ...overrides },
        },
      }) as unknown as ReviewRunAuthorization;
    const withFacts = (
      overrides: Readonly<Record<string, unknown>>
    ): ReviewRunAuthorization =>
      ({
        ...negotiated,
        facts: { ...negotiated.facts, ...overrides },
      }) as unknown as ReviewRunAuthorization;
    const enabledFlags = rolloutFlags({ recordingEnabled: true });
    const cases = [
      {
        reason: ProductionReviewInvestigationRolloutReason.ReviewDepthEconomy,
        flags: enabledFlags,
        agenticContext: true,
        authorization: negotiated,
        reviewDepth: ReviewDepth.Economy,
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.Enabled,
        flags: enabledFlags,
        agenticContext: true,
        authorization: negotiated,
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.RecordingFlagDisabled,
        flags: rolloutFlags(),
        agenticContext: true,
        authorization: negotiated,
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.AgenticContextDisabled,
        flags: enabledFlags,
        agenticContext: false,
        authorization: negotiated,
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.AuthorizationDescriptorMissing,
        flags: enabledFlags,
        agenticContext: true,
        authorization: authorization(1),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.AuthorizationDescriptorVersionMismatch,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({ authorizationDescriptorVersion: 2 }),
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.CapabilityMismatch,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({ capability: 'future_capability' }),
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.ExtensionIdMismatch,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({ extensionId: 'future-extension' }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.ExtensionSchemaDigestMismatch,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({
          extensionSchemaDigest: '0'.repeat(64),
        }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.ExtensionCanonicalizerDigestMismatch,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({
          extensionCanonicalizerDigest: '0'.repeat(64),
        }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.CoverageProfileHashMismatch,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({ coverageProfileHash: '0'.repeat(64) }),
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.PolicyHashMismatch,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({ policyHash: '0'.repeat(64) }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.ProviderVoteLaneMissing,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withFacts({ providerVoteLanes: [] }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.ProviderCapabilitiesMissing,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({ providerCapabilities: undefined }),
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.ProviderGrantMissing,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({
          providerCapabilities: [
            {
              providerKind: ReviewExecutionProviderKind.ClaudeCode,
              capabilities: [ReviewInvestigationRolloutCapability.Recording],
            },
          ],
        }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.RecordingGrantMissing,
        flags: enabledFlags,
        agenticContext: true,
        authorization: withDescriptor({
          providerCapabilities: [
            {
              providerKind: ReviewExecutionProviderKind.Codex,
              capabilities: [],
            },
          ],
        }),
      },
    ] as const;

    expect(new Set(cases.map(({ reason }) => reason))).toEqual(
      new Set(Object.values(ProductionReviewInvestigationRolloutReason))
    );
    for (const testCase of cases) {
      expect(
        resolveProductionReviewInvestigationRolloutResolution({
          flags: testCase.flags,
          agenticContext: testCase.agenticContext,
          authorization: testCase.authorization,
          primaryProviderKind: ReviewExecutionProviderKind.Codex,
          reviewDepth:
            'reviewDepth' in testCase
              ? testCase.reviewDepth
              : ReviewDepth.Balanced,
        }).reason
      ).toBe(testCase.reason);
    }

    type RolloutState = Readonly<{
      flags: ProductionReviewInvestigationRolloutFlags;
      agenticContext: boolean;
      authorization: ReviewRunAuthorization;
    }>;
    const replaceDescriptor = (
      state: RolloutState,
      overrides: Readonly<Record<string, unknown>>
    ): RolloutState => {
      const current =
        (state.authorization.facts.reviewInvestigation as unknown as
          | Readonly<Record<string, unknown>>
          | undefined) ?? descriptor;
      return {
        ...state,
        authorization: {
          ...state.authorization,
          facts: {
            ...state.authorization.facts,
            reviewInvestigation: { ...current, ...overrides },
          },
        } as unknown as ReviewRunAuthorization,
      };
    };
    const replaceFacts = (
      state: RolloutState,
      overrides: Readonly<Record<string, unknown>>
    ): RolloutState => ({
      ...state,
      authorization: {
        ...state.authorization,
        facts: { ...state.authorization.facts, ...overrides },
      } as unknown as ReviewRunAuthorization,
    });
    const faults: readonly Readonly<{
      reason: Exclude<
        ProductionReviewInvestigationRolloutReason,
        ProductionReviewInvestigationRolloutReason.Enabled
      >;
      apply: (state: RolloutState) => RolloutState;
    }>[] = [
      {
        reason:
          ProductionReviewInvestigationRolloutReason.RecordingFlagDisabled,
        apply: (state) => ({ ...state, flags: rolloutFlags() }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.AgenticContextDisabled,
        apply: (state) => ({ ...state, agenticContext: false }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.AuthorizationDescriptorMissing,
        apply: (state) =>
          replaceFacts(state, { reviewInvestigation: undefined }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.AuthorizationDescriptorVersionMismatch,
        apply: (state) =>
          replaceDescriptor(state, { authorizationDescriptorVersion: 2 }),
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.CapabilityMismatch,
        apply: (state) =>
          replaceDescriptor(state, { capability: 'future_capability' }),
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.ExtensionIdMismatch,
        apply: (state) =>
          replaceDescriptor(state, { extensionId: 'future-extension' }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.ExtensionSchemaDigestMismatch,
        apply: (state) =>
          replaceDescriptor(state, { extensionSchemaDigest: '0'.repeat(64) }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.ExtensionCanonicalizerDigestMismatch,
        apply: (state) =>
          replaceDescriptor(state, {
            extensionCanonicalizerDigest: '0'.repeat(64),
          }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.CoverageProfileHashMismatch,
        apply: (state) =>
          replaceDescriptor(state, { coverageProfileHash: '0'.repeat(64) }),
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.PolicyHashMismatch,
        apply: (state) =>
          replaceDescriptor(state, { policyHash: '0'.repeat(64) }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.ProviderVoteLaneMissing,
        apply: (state) => replaceFacts(state, { providerVoteLanes: [] }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.ProviderCapabilitiesMissing,
        apply: (state) =>
          replaceDescriptor(state, { providerCapabilities: undefined }),
      },
      {
        reason: ProductionReviewInvestigationRolloutReason.ProviderGrantMissing,
        apply: (state) =>
          replaceDescriptor(state, {
            providerCapabilities: [
              {
                providerKind: ReviewExecutionProviderKind.ClaudeCode,
                capabilities: [ReviewInvestigationRolloutCapability.Recording],
              },
            ],
          }),
      },
      {
        reason:
          ProductionReviewInvestigationRolloutReason.RecordingGrantMissing,
        apply: (state) =>
          replaceDescriptor(state, {
            providerCapabilities: [
              {
                providerKind: ReviewExecutionProviderKind.Codex,
                capabilities: [],
              },
            ],
          }),
      },
    ];
    for (const [index, fault] of faults.entries()) {
      let state: RolloutState = {
        flags: enabledFlags,
        agenticContext: true,
        authorization: negotiated,
      };
      for (let later = faults.length - 1; later >= index; later -= 1) {
        state = faults[later].apply(state);
      }
      expect(
        resolveProductionReviewInvestigationRolloutResolution({
          ...state,
          primaryProviderKind: ReviewExecutionProviderKind.Codex,
        }).reason
      ).toBe(fault.reason);
    }
  });

  it('selects a configured and authorized Claude critic', () => {
    const codex = agent();
    const claude = agent();
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigation([
        ReviewExecutionProviderKind.Codex,
        ReviewExecutionProviderKind.ClaudeCode,
      ]),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: true,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: codex,
        },
        {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
          agent: claude,
        },
      ],
    });

    expect(
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toEqual({
      agent: claude,
      providerKind: ReviewAgentProviderKind.ClaudeCode,
      requestedModel: 'claude-sonnet-4-5',
    });
  });

  it('does not let recording authority imply critic authority for another provider', () => {
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigationCapabilities([
        {
          providerKind: ReviewExecutionProviderKind.Codex,
          capabilities: [
            ReviewInvestigationRolloutCapability.ContextCritic,
            ReviewInvestigationRolloutCapability.Recording,
            ReviewInvestigationRolloutCapability.Shadow,
          ],
        },
        {
          providerKind: ReviewExecutionProviderKind.ClaudeCode,
          capabilities: [ReviewInvestigationRolloutCapability.Recording],
        },
      ]),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: true,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: agent(),
        },
        {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
          agent: agent(),
        },
      ],
    });

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toThrow('review_agent_independent_critic_unavailable');
  });

  it('allows an authorized same-provider critic for high-risk review', () => {
    const codex = agent();
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: true,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: codex,
        },
      ],
    });

    expect(
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toEqual({
      agent: codex,
      providerKind: ReviewAgentProviderKind.Codex,
      requestedModel: 'gpt-5.6-terra',
    });
  });

  it('fails closed when authorized independent critic capacity is unavailable', () => {
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigation([
        ReviewExecutionProviderKind.Codex,
        ReviewExecutionProviderKind.ClaudeCode,
      ]),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: true,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: agent(),
        },
      ],
    });

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toThrow('review_agent_independent_critic_unavailable');
  });

  it('rejects critic turns when the critic rollout is disabled', () => {
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: false,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: agent(),
        },
      ],
    });

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 500_000,
      })
    ).toThrow('review_agent_context_critic_disabled');
  });

  it('falls back only when capability is disabled before investigation admission', async () => {
    const preOpenError = new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      'investigation_rollout_disabled_before_open'
    );
    const postOpenError = new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      'investigation_rollout_disabled_after_open'
    );
    const delegate = {
      open: jest
        .fn()
        .mockRejectedValueOnce(preOpenError)
        .mockResolvedValueOnce({
          investigationId: 'investigation-1',
        }),
      planTurn: jest.fn().mockRejectedValue(postOpenError),
    } as never;
    const controlPlane =
      new LegacyFallbackBeforeInvestigationAuthorityControlPlane(delegate);

    await expect(controlPlane.open({} as never)).rejects.toBeInstanceOf(
      ReviewInvestigationLegacyFallbackSignal
    );
    await expect(controlPlane.open({} as never)).resolves.toMatchObject({
      investigationId: 'investigation-1',
    });
    await expect(controlPlane.planTurn({} as never)).rejects.toBe(
      postOpenError
    );
  });

  it('maps initial revision guard failures into terminal v2 outcomes', () => {
    for (const blockingFailure of [
      'review_action_v2_revision_guard_unavailable',
      'review_action_v2_revision_guard_failed',
    ]) {
      expect(
        mapRevisionGuardErrorToCodexOutcome(new Error(blockingFailure))
      ).toEqual({
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason:
          blockingFailure === 'review_action_v2_revision_guard_unavailable'
            ? CodexOAuthV2TerminalReason.RevisionGuardUnavailable
            : CodexOAuthV2TerminalReason.RevisionGuardFailed,
        blockingFailure,
      });
    }
    expect(
      mapRevisionGuardErrorToCodexOutcome(new Error('unexpected_failure'))
    ).toBeUndefined();
  });

  it('refreshes an expiring SCM read capability before the next read', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const refresh = jest.fn(async () => ({
      token: 'ghs_refreshed',
      expiresAt: '2026-08-03T13:00:00.000Z',
    }));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh,
    });

    await expect(provider.getToken()).resolves.toBe('ghs_refreshed');
    await expect(provider.getToken()).resolves.toBe('ghs_refreshed');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent SCM token refreshes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const refresh = jest.fn(async () => ({
      token: 'ghs_refreshed',
      expiresAt: '2026-08-03T13:00:00.000Z',
    }));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh,
    });

    await expect(
      Promise.all([provider.getToken(), provider.getToken()])
    ).resolves.toEqual(['ghs_refreshed', 'ghs_refreshed']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('rejects stale refreshed SCM capabilities as temporarily unavailable', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const refresh = jest.fn(async () => ({
      token: 'ghs_still_expiring',
      expiresAt: '2026-08-03T12:00:25.000Z',
    }));
    const provider = createScmReadTokenProvider({
      token: 'ghs_initial',
      expiresAt: '2026-08-03T13:00:00.000Z',
      refresh,
    });

    await expect(provider.refreshToken()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
    await expect(provider.getToken()).resolves.toBe('ghs_initial');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('normalizes SCM token refresh errors for terminal reporting', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh: jest.fn(async () => {
        throw new Error('control_plane_unavailable');
      }),
    });

    await expect(provider.getToken()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
  });

  it('distinguishes permanent and transient SCM token endpoint failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const providerFor = (message: string) =>
      createScmReadTokenProvider({
        token: 'ghs_expiring',
        expiresAt: '2026-08-03T12:00:20.000Z',
        refresh: jest.fn(async () => {
          throw new Error(message);
        }),
      });

    await expect(
      providerFor(
        'codex_oauth_control_plane_error:403:permission_required'
      ).getToken()
    ).rejects.toThrow('review_action_v2_revision_guard_failed');
    for (const status of [429, 503]) {
      await expect(
        providerFor(
          `codex_oauth_control_plane_error:${status}:temporarily_unavailable`
        ).getToken()
      ).rejects.toThrow('review_action_v2_revision_guard_unavailable');
    }
  });
});

function authorizationWithInvestigation(
  providerKinds: readonly (
    | ReviewExecutionProviderKind.Codex
    | ReviewExecutionProviderKind.ClaudeCode
  )[] = [ReviewExecutionProviderKind.Codex]
): ReviewRunAuthorization {
  return authorizationWithInvestigationCapabilities(
    providerKinds.map((providerKind) => ({
      providerKind,
      capabilities: allInvestigationCapabilities,
    }))
  );
}

function authorizationWithInvestigationCapabilities(
  providerCapabilities: readonly {
    readonly providerKind:
      | ReviewExecutionProviderKind.Codex
      | ReviewExecutionProviderKind.ClaudeCode;
    readonly capabilities: readonly ReviewInvestigationRolloutCapability[];
  }[]
): ReviewRunAuthorization {
  const base = authorization(1);
  const canonicalProviderCapabilities = [...providerCapabilities]
    .sort((left, right) =>
      left.providerKind < right.providerKind
        ? -1
        : left.providerKind > right.providerKind
          ? 1
          : 0
    )
    .map((row) => ({
      providerKind: row.providerKind,
      capabilities: [...row.capabilities].sort(),
    }));
  return {
    ...base,
    facts: {
      ...base.facts,
      providerVoteLanes: canonicalProviderCapabilities.map(
        ({ providerKind }, index) => ({
          providerKind,
          providerVoteIdentityHash: `${index + 6}`.repeat(64),
        })
      ),
      reviewInvestigation: {
        extensionId: reviewInvestigationExtensionV1.extensionId,
        extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
        extensionCanonicalizerDigest:
          reviewInvestigationExtensionV1.canonicalizerDigest,
        authorizationDescriptorVersion:
          reviewInvestigationRolloutAuthorizationV3Contract.authorizationDescriptorVersion,
        capability: ReviewCapabilityKind.ReviewInvestigationV1,
        coverageProfileHash: reviewInvestigationCoverageProfileHash(),
        policyHash: reviewInvestigationPolicyHash(),
        providerCapabilities: canonicalProviderCapabilities,
      },
    },
  } as unknown as ReviewRunAuthorization;
}

function authorizationWithLegacyInvestigation(
  providerKinds: readonly (
    | ReviewExecutionProviderKind.Codex
    | ReviewExecutionProviderKind.ClaudeCode
  )[] = [ReviewExecutionProviderKind.Codex]
): ReviewRunAuthorization {
  const base = authorization(1);
  return {
    ...base,
    facts: {
      ...base.facts,
      providerVoteLanes: providerKinds.map((providerKind, index) => ({
        providerKind,
        providerVoteIdentityHash: `${index + 6}`.repeat(64),
      })),
      reviewInvestigation: {
        authorizationDescriptorVersion: 2,
        capability: ReviewCapabilityKind.ReviewInvestigationV1,
        coverageProfileHash: reviewInvestigationCoverageProfileHash(),
        policyHash: reviewInvestigationPolicyHash(),
        providerCapabilities: providerKinds.map((providerKind) => ({
          providerKind,
          capabilities: allInvestigationCapabilities,
        })),
      },
    },
  } as unknown as ReviewRunAuthorization;
}

const allInvestigationCapabilities = Object.freeze([
  ReviewInvestigationRolloutCapability.ContextCritic,
  ReviewInvestigationRolloutCapability.CrossRevisionReplay,
  ReviewInvestigationRolloutCapability.ProductionEffects,
  ReviewInvestigationRolloutCapability.Recording,
  ReviewInvestigationRolloutCapability.Shadow,
  ReviewInvestigationRolloutCapability.VerifiedClean,
]);

function rolloutFlags(
  overrides: Partial<ProductionReviewInvestigationRolloutFlags> = {}
): ProductionReviewInvestigationRolloutFlags {
  return {
    recordingEnabled: false,
    shadowEnabled: false,
    contextCriticEnabled: false,
    verifiedCleanEnabled: false,
    crossRevisionReplayEnabled: false,
    productionEffectsEnabled: false,
    ...overrides,
  };
}

function agent(): ReviewAgentPort {
  return {
    negotiate: jest.fn(),
    executeTurn: jest.fn(),
    cancel: jest.fn(),
  };
}

function authorization(maxWorkSlots: number) {
  return {
    authorizationId: 'authorization-1',
    authorizationToken: 'token',
    producerReleaseId: 'release-1',
    protocolLimitsProfileId: 'limits-1',
    operationalSloProfileId: 'slo-1',
    mutationEpoch: '1',
    expiresAt: '2026-07-24T00:00:00.000Z',
    limits: {
      maxWorkSlots,
      maxAttemptsPerSlot: 3,
      maxObservationBytes: 100_000,
      maxObservationFindings: 100,
      maxProjectionBytes: 100_000,
      maxProjectionFindings: 100,
      maxPublicationOperations: 100,
      maxPublicationChunks: 10,
      maxPublicationBodyBytes: 100_000,
      maxRequestBatchSize: 10,
      maxLeaseDurationMs: 60_000,
      maxResultReportDurationMs: 60_000,
      maxReconciliationDurationMs: 60_000,
    },
    facts: {
      workspaceId: 'workspace-1',
      repositoryConnectionId: 'connection-1',
      scmRepositoryIdentityId: 'repo-1',
      pullRequestNumber: 1,
      sourceRunId: 'run-1',
      sourceRunAttempt: '1',
      baseSha: '1'.repeat(40),
      mergeBaseSha: '2'.repeat(40),
      headSha: '3'.repeat(40),
      reviewRevisionHash: '4'.repeat(64),
      trustDomain: 'github-actions',
      producerReleaseId: 'release-1',
      selectedProtocolVersion: '2',
      schemaDigest: '5'.repeat(64),
      providerVoteLanes: [
        {
          providerKind: ReviewExecutionProviderKind.Codex,
          providerVoteIdentityHash: '6'.repeat(64),
        },
      ],
    },
  };
}

function pullRequest(paths: string[]): PRContext {
  const files = paths.map((filename) => ({
    filename,
    status: 'modified' as const,
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -1 +1 @@\n+changed',
  }));
  return {
    number: 1,
    title: 'Bounded batches',
    body: '',
    author: 'reviewer',
    draft: false,
    labels: [],
    files,
    diff: files
      .map(
        (file) =>
          `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ -1 +1 @@\n+changed`
      )
      .join('\n'),
    additions: files.length,
    deletions: 0,
    baseSha: '1'.repeat(40),
    headSha: '3'.repeat(40),
  };
}
