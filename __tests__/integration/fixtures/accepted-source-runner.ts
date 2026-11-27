import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { ReviewActionV2Client } from '../../../src/control-plane/review-action-v2-client';
import { ReviewActionV2ControlPlaneAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import {
  AccountGatewayModelTransport,
  startLocalGatewayModelTransport,
  LOCAL_MODEL_CAPABILITY_ENV,
  type GatewayCloseReason,
  type LocalGatewayModelTransport,
} from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import { PreparedModelDispatch } from '../../../src/review-orchestration/infrastructure/prepared-model-dispatch';
import { reviewModelDispatchContract } from '../../../src/control-plane/generated/review-action-v2/review-model-dispatch-contract';
import { validateAccountGatewayCheckout } from '../../../src/codex-oauth/account-gateway-runtime';
import {
  prepareOcrManagedRun,
  readApprovedOcrReviewAgent,
  type OcrManagedRunHandle,
} from '../../../src/codex-oauth/ocr-managed-bootstrap';
import type { createProductionT0ReviewRunner } from '../../../src/review-orchestration/infrastructure/production-t0-review-runner';
import { REVIEW_EXECUTION_DEADLINE_ENV_KEY } from '../../../src/review-execution/infrastructure/execution-deadline-from-environment';

const captureSchema = z.object({
  apiUrl: z.string().url(),
  audience: z.string().min(1),
  authorizationId: z.string().min(1),
  executionDeadlineEpochMs: z.number().int().positive(),
  providerInstanceId: z.string().min(1),
  repository: z.literal('reviewrouter-e2e/disposable-review-v2'),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  workspacePath: z.string().min(1),
  runnerBundle: z.string().min(1),
  runnerBundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ocrBinary: z.string().min(1),
  checkout: z.unknown(),
}).strict();

function isCompiledRunner(value: unknown): value is {
  createProductionT0ReviewRunner: typeof createProductionT0ReviewRunner;
} {
  return Boolean(
    value && typeof value === 'object' &&
    'createProductionT0ReviewRunner' in value &&
    typeof value.createProductionT0ReviewRunner === 'function'
  );
}

type FixtureStage = 'capture' | 'authorization' | 'bootstrap' | 'runner' | 'close';
let stage: FixtureStage = 'capture';
let failedStage: FixtureStage | undefined;

async function main(): Promise<void> {
  const captureFile = process.argv[2];
  if (!captureFile) throw new Error('accepted_source_capture_missing');
  const captureBytes = readFileSync(captureFile, 'utf8');
  if (Buffer.byteLength(captureBytes) > 262_144)
    throw new Error('accepted_source_capture_too_large');
  const rawCapture: unknown = JSON.parse(captureBytes);
  const capture = captureSchema.parse(rawCapture);
  if (capture.executionDeadlineEpochMs <= Date.now())
    throw new Error('accepted_source_original_deadline_expired');
  process.env[REVIEW_EXECUTION_DEADLINE_ENV_KEY] = String(capture.executionDeadlineEpochMs);
  const bundleBytes = readFileSync(capture.runnerBundle);
  if (createHash('sha256').update(bundleBytes).digest('hex') !==
      capture.runnerBundleSha256)
    throw new Error('accepted_source_runner_bundle_changed');
  const module: unknown = createRequire(__filename)(capture.runnerBundle);
  if (!isCompiledRunner(module))
    throw new Error('accepted_source_public_runner_export_missing');
  const nativeFetch = globalThis.fetch;
  const origin = new URL(capture.apiUrl).origin;
  const oidcUrl = `${origin}/_fixture/accepted-source/oidc`;
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = oidcUrl;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'accepted-source-fixture-only';
  const boundaryFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (target.origin === origin) return nativeFetch(request);
    if (target.origin !== 'https://api.github.com')
      throw new Error('accepted_source_external_network_forbidden');
    const response = await nativeFetch(
      `${origin}/_fixture/accepted-source/github`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: request.body ? await request.text() : null,
        }),
        signal: request.signal,
      }
    );
    return response;
  };
  globalThis.fetch = boundaryFetch;
  stage = 'authorization';
  const plane = new ReviewActionV2ControlPlaneAdapter(new ReviewActionV2Client({
    apiUrl: capture.apiUrl,
    allowInsecureLocalhost: true,
    maxAttempts: 1,
    fetchImpl: boundaryFetch,
  }));
  const oidcResponse = await boundaryFetch(oidcUrl);
  const oidc: unknown = await oidcResponse.json();
  const { value: oidcToken } = z.object({ value: z.string().min(1) }).parse(oidc);
  const authorization = await plane.authorize({ oidcToken });
  if (authorization.authorizationId !== capture.authorizationId ||
      authorization.facts.headSha !== capture.headSha)
    throw new Error('accepted_source_original_authority_changed');
  stage = 'bootstrap';
  const capability = validateAccountGatewayCheckout(
    { httpStatus: 200, value: capture.checkout },
    capture.repository,
    capture.headSha
  );
  const runtimeEnv = capability.runtimeConfig.runtimeEnv;
  const model = runtimeEnv.CODEX_MODEL;
  const dispatchJson = runtimeEnv[reviewModelDispatchContract.capabilityRuntimeEnvKey];
  if (!model || !dispatchJson)
    throw new Error('accepted_source_original_route_missing');
  const controller = new AbortController();
  const transport = new AccountGatewayModelTransport(
    capture.apiUrl,
    () => plane.currentAuthorization().authorizationToken
  );
  const dispatchCapability: unknown = JSON.parse(dispatchJson);
  transport.setModelDispatch(new PreparedModelDispatch({
    apiUrl: capture.apiUrl,
    capability: dispatchCapability,
    authorization: () => plane.currentAuthorization(),
    fetchImpl: boundaryFetch,
  }));
  let bridge: LocalGatewayModelTransport | undefined;
  let ocrRun: OcrManagedRunHandle | undefined;
  let closeReason: GatewayCloseReason = 'failed';
  try {
    bridge = await startLocalGatewayModelTransport(transport);
    ocrRun = await prepareOcrManagedRun({
      approvedAgent: readApprovedOcrReviewAgent(
        runtimeEnv.REVIEW_ROUTER_AGENT_PROFILE_JSON,
        runtimeEnv.REVIEW_ROUTER_AGENT_PROFILE_DIGEST
      ),
      baseUrl: bridge.baseUrl,
      rawCapability: bridge.environment[LOCAL_MODEL_CAPABILITY_ENV]!
        .slice('Bearer '.length),
      model,
      protocol: 'openai-responses',
      requestTimeoutSec: 60,
      modelReasoningEffort: runtimeEnv.CODEX_REASONING_EFFORT ?? null,
      admittedRuntimeConfig: capability.runtimeConfig,
      language: runtimeEnv.REVIEW_OUTPUT_LANGUAGE ?? null,
      signal: controller.signal,
      env: { ...process.env, REVIEWROUTER_OCR_BINARY: capture.ocrBinary },
    });
    const runner = module.createProductionT0ReviewRunner({ fetchImpl: boundaryFetch });
    stage = 'runner';
    const result = await runner.run({
      apiUrl: capture.apiUrl,
      audience: capture.audience,
      providerInstanceId: capture.providerInstanceId,
      workflowSchemaVersion: 2,
      repository: capture.repository,
      pullRequestNumber: 42,
      headSha: capture.headSha,
      workspacePath: capture.workspacePath,
      scmReadToken: capability.token,
      scmReadTokenExpiresAt: capability.expiresAt,
      refreshScmReadToken: async () => ({
        token: capability.token, expiresAt: capability.expiresAt,
      }),
      accountGateway: {
        runtimeConfig: capability.runtimeConfig,
        signal: controller.signal,
        controlPlane: plane,
        modelTransport: bridge,
      },
      ocr: { run: ocrRun, effectFacts: bridge.failureFact },
    });
    if (result.outcome === 'completed') closeReason = 'completed';
    if (result.outcome === 'cancelled' || result.outcome === 'superseded')
      closeReason = 'cancelled';
    process.stdout.write(`ACCEPTED_SOURCE_RESULT:${JSON.stringify({
      outcome: result.outcome,
      ...('reason' in result ? { reason: result.reason } : {}),
      ...('publicationReceipt' in result
        ? { publicationReceipt: result.publicationReceipt } : {}),
    })}\n`);
  } catch (error: unknown) {
    failedStage = stage;
    throw error;
  } finally {
    stage = 'close';
    transport.cancelInference();
    await transport.close(closeReason);
    controller.abort();
    await bridge?.dispose();
    await ocrRun?.cleanup();
    globalThis.fetch = nativeFetch;
  }
}

void main().catch(() => {
  // No captured authority, native output or transport error enters diagnostics.
  process.stderr.write(`accepted_source_child_failed:${failedStage ?? stage}\n`);
  process.exitCode = 1;
});
