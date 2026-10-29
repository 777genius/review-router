'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const protocolManifest = require('../../src/control-plane/generated/review-action-v2/manifest.json');

const witnessPath = requireEnv('RR_ARTIFACT_SMOKE_WITNESS_PATH');
const expectedArtifactPath = fs.realpathSync(
  requireEnv('RR_ARTIFACT_SMOKE_EXPECTED_ARTIFACT')
);
const expectedArtifactSha256 = requireEnv(
  'RR_ARTIFACT_SMOKE_EXPECTED_ARTIFACT_SHA256'
);
const expectedActionVersion = requireEnv(
  'RR_ARTIFACT_SMOKE_EXPECTED_ACTION_VERSION'
);
const artifactPath = fs.realpathSync(process.argv[1]);
const artifactSha256 = crypto
  .createHash('sha256')
  .update(fs.readFileSync(artifactPath))
  .digest('hex');
const state = {
  artifactPath,
  artifactSha256,
  expectedActionVersion,
  networkGuardsInstalled: false,
  workflowSchemaVersion: null,
  terminalComment: null,
  terminalCommitStatus: null,
  calls: [],
};

process.once('exit', () => persist());

assertEqual(artifactPath, expectedArtifactPath, 'artifact_path_mismatch');
assertEqual(artifactSha256, expectedArtifactSha256, 'artifact_digest_mismatch');
assertEqual(
  process.env.REVIEWROUTER_ACTION_VERSION,
  expectedActionVersion,
  'action_version_mismatch'
);
if (!/^[a-f0-9]{40}$/.test(expectedActionVersion)) {
  fail('action_version_not_immutable');
}

installNetworkGuards();
globalThis.fetch = fakeFetch;
persist();

async function fakeFetch(resource, init = {}) {
  const url = new URL(requestUrl(resource));
  const method = requestMethod(resource, init);
  const headers = requestHeaders(resource, init);
  const call = { method, origin: url.origin, pathname: url.pathname };
  state.calls.push(call);
  persist();

  try {
    const key = `${method} ${url.origin}${url.pathname}`;
    switch (key) {
      case 'GET https://token.actions.githubusercontent.com/token':
        assertEqual(
          url.searchParams.get('audience'),
          'reviewrouter',
          'oidc_audience_mismatch'
        );
        return jsonResponse({ value: 'fake-oidc-token' });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/prelease': {
        const request = JSON.parse(String(init.body));
        assertEqual(
          request.workflowSchemaVersion,
          5,
          'workflow_schema_v5_mismatch'
        );
        state.workflowSchemaVersion = request.workflowSchemaVersion;
        persist();
        return jsonResponse({
          protocolVersion: 1,
          leaseId: 'lease:artifact-smoke',
          providerInstanceId: 'codex-rotating:artifact-smoke',
          repository: 'sandbox/repository',
          generationHashSalt: Buffer.from(
            'artifact-smoke-generation-salt-32'
          ).toString('base64url'),
          accountFingerprintSalt: Buffer.from(
            'artifact-smoke-account-salt-32'
          ).toString('base64url'),
          currentGeneration: 1,
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/finalize':
        return jsonResponse({
          protocolVersion: 1,
          leaseId: 'lease:artifact-smoke',
          nextGeneration: 2,
          status: 'finalized',
          repositoryOwner: 'sandbox',
          repositoryName: 'repository',
          publicKeyReadToken: 'fake-public-key-read-token',
          publicKeyReadTokenExpiresAt: '2099-01-01T00:00:00.000Z',
        });
      case 'GET https://api.github.com/repos/sandbox/repository/actions/secrets/public-key':
        return jsonResponse({
          key_id: 'artifact-smoke-key',
          key: requireEnv('RR_ARTIFACT_SMOKE_PUBLIC_KEY'),
        });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/writeback-preflight':
        return jsonResponse({ protocolVersion: 1, status: 'ready' });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/writeback': {
        const sodium = require('libsodium-wrappers');
        await sodium.ready;
        const request = JSON.parse(String(init.body));
        const auth = JSON.parse(
          Buffer.from(
            sodium.crypto_box_seal_open(
              Buffer.from(request.encryptedValue, 'base64'),
              Buffer.from(requireEnv('RR_ARTIFACT_SMOKE_PUBLIC_KEY'), 'base64'),
              Buffer.from(requireEnv('RR_ARTIFACT_SMOKE_PRIVATE_KEY'), 'base64')
            )
          ).toString('utf8')
        );
        assertEqual(
          auth.tokens.refresh_token,
          'synthetic-refreshed-token',
          'rotated_refresh_token_not_preserved'
        );
        state.authWriteback = { rotationPreserved: true };
        persist();
        return jsonResponse({ protocolVersion: 1, status: 'accepted' });
      }
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/checkout-token':
        return jsonResponse({
          protocolVersion: 1,
          token: 'fake-read-only-checkout-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          repository: 'sandbox/repository',
          permissions: { contents: 'read', pullRequests: 'read' },
        });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/session/exchange':
        return jsonResponse({ sessionToken: 'fake-action-session' });
      case 'POST https://control-plane.reviewrouter.test/api/action/v2/review-runs/authorize': {
        const request = JSON.parse(String(init.body));
        assertEqual(
          request.protocolVersion,
          protocolManifest.protocolVersion,
          'authorization_protocol_mismatch'
        );
        assertEqual(
          request.schemaDigest,
          protocolManifest.schemaDigest,
          'authorization_schema_mismatch'
        );
        assertEqual(
          request.oidcToken,
          'fake-oidc-token',
          'authorization_oidc_mismatch'
        );
        return jsonResponse({
          protocolVersion: protocolManifest.protocolVersion,
          schemaDigest: protocolManifest.schemaDigest,
          requestId: request.requestId,
          serverTime: new Date().toISOString(),
          result: authorizationResult(),
        });
      }
      case 'POST https://control-plane.reviewrouter.test/api/action/v2/model-route/checkout': {
        assertEqual(
          headers.get('authorization'),
          'Bearer synthetic-run-authorization',
          'model_route_authorization_mismatch'
        );
        const request = JSON.parse(String(init.body));
        assertEqual(
          JSON.stringify(request),
          JSON.stringify({
            transport: 'runner_local_responses',
            providerIndex: 0,
            workflowSchemaVersion: 2,
          }),
          'model_route_request_mismatch'
        );
        state.modelRoute = request;
        const profileJson = requireEnv('RR_ARTIFACT_SMOKE_APPROVED_AGENT_JSON');
        state.runtimeConfig = {
          configVersion: 4242,
          providerLimit: '987654321',
        };
        persist();
        return jsonResponse({
          protocolVersion: 1,
          repository: 'sandbox/repository',
          headSha: 'a'.repeat(40),
          token: 'synthetic-model-route-checkout-token',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          permissions: { contents: 'read', pullRequests: 'read' },
          runtimeConfig: {
            protocolVersion: 1,
            configVersion: 4242,
            runtimeEnv: {
              REVIEW_AUTH_MODE: 'codex-oauth',
              CODEX_MODEL: 'gpt-5.4',
              REVIEW_PROVIDERS: 'codex/gpt-5.4',
              CODEX_REASONING_EFFORT: 'high',
              RUN_TIMEOUT_SECONDS: '600',
              PROVIDER_LIMIT: '987654321',
              REVIEW_ROUTER_AGENT_PROFILE_JSON: profileJson,
              REVIEW_ROUTER_AGENT_PROFILE_DIGEST: crypto
                .createHash('sha256')
                .update(profileJson)
                .digest('hex'),
              REVIEW_ROUTER_MODEL_DISPATCH_CAPABILITY_JSON: JSON.stringify({
                extensionId: 'review-model-dispatch.v2',
                version: 2,
                routeIdentityHash: 'd'.repeat(64),
                transport: 'runner_local_responses',
                wireProtocol: 'codex-responses',
                outputTokenLimit: 'terminal_acceptance',
                providerIndex: 0,
                model: 'gpt-5.4',
                deadline: new Date(Date.now() + 600_000).toISOString(),
                maxRequests: 32,
                maxConcurrentRequests: 1,
                maxRequestBytes: 98304,
                maxResponseBytes: 32768,
                maxOutputTokens: 4096,
              }),
              REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: '1',
              REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: '1',
              REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: '1',
              REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: '1',
              REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED:
                '1',
              REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED:
                '1',
            },
          },
        });
      }
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/comment-token':
        return jsonResponse({
          protocolVersion: 1,
          token: 'fake-comment-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          repository: 'sandbox/repository',
        });
      case 'GET https://api.github.com/repos/sandbox/repository/issues/17/comments':
        return jsonResponse([]);
      case 'POST https://api.github.com/repos/sandbox/repository/issues/17/comments': {
        const request = JSON.parse(String(init.body));
        state.terminalComment = request.body;
        persist();
        return jsonResponse({ id: 7001 });
      }
      case 'POST https://api.github.com/repos/sandbox/repository/statuses/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
        const request = JSON.parse(String(init.body));
        state.terminalCommitStatus = request;
        persist();
        return jsonResponse({ id: 7002 });
      }
      default:
        fail(`unexpected_fetch:${key}`);
    }
  } catch (error) {
    if (!state.failure) {
      state.failure = error instanceof Error ? error.message : String(error);
      persist();
    }
    throw error;
  }
}

function installNetworkGuards() {
  const blocked = () => {
    fail('artifact_smoke_real_network_forbidden');
  };
  http.request = blocked;
  http.get = blocked;
  https.request = blocked;
  https.get = blocked;
  net.connect = blocked;
  net.createConnection = blocked;
  tls.connect = blocked;
  state.networkGuardsInstalled = true;
}

function authorizationResult() {
  return {
    status: 'authorized',
    authorizationId: 'artifact-smoke-authorization',
    authorizationToken: 'synthetic-run-authorization',
    producerReleaseId: 'artifact-smoke-release',
    protocolLimitsProfileId: 'artifact-smoke-limits',
    operationalSloProfileId: 'artifact-smoke-slo',
    mutationEpoch: '1',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    protocolLimitsCanonicalJson: canonicalJson({
      maxAttemptsPerSlot: 1,
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
      workspaceId: 'artifact-smoke-workspace',
      repositoryConnectionId: 'artifact-smoke-connection',
      scmRepositoryIdentityId: 'artifact-smoke-repository',
      pullRequestNumber: 17,
      sourceRunId: 'artifact-smoke-run',
      sourceRunAttempt: '1',
      baseSha: 'b'.repeat(40),
      mergeBaseSha: 'b'.repeat(40),
      headSha: 'a'.repeat(40),
      reviewRevisionHash: 'c'.repeat(64),
      trustDomain: 'github-actions',
      producerReleaseId: 'artifact-smoke-release',
      selectedProtocolVersion: protocolManifest.protocolVersion,
      schemaDigest: protocolManifest.schemaDigest,
      providerVoteLanes: [
        { providerKind: 'codex', providerVoteIdentityHash: 'e'.repeat(64) },
      ],
    }),
  };
}

function canonicalJson(value) {
  const canonicalize = (input) =>
    Array.isArray(input)
      ? input.map(canonicalize)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, canonicalize(input[key])])
          )
        : input;
  return JSON.stringify(canonicalize(value));
}

function requestUrl(resource) {
  if (typeof resource === 'string' || resource instanceof URL) {
    return String(resource);
  }
  return resource.url;
}

function requestMethod(resource, init) {
  if (init.method) return String(init.method).toUpperCase();
  if (typeof Request !== 'undefined' && resource instanceof Request) {
    return resource.method.toUpperCase();
  }
  return 'GET';
}

function requestHeaders(resource, init) {
  const headers = new Headers(
    typeof Request !== 'undefined' && resource instanceof Request
      ? resource.headers
      : undefined
  );
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function fail(message) {
  state.failure = message;
  persist();
  throw new Error(message);
}

function persist() {
  state.runnerProviderLimit = process.env.PROVIDER_LIMIT ?? null;
  state.investigationRollout = {
    recording:
      process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED ?? null,
    shadow:
      process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED ?? null,
    contextCritic:
      process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED ??
      null,
    verifiedClean:
      process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED ??
      null,
    crossRevisionReplay:
      process.env
        .REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED ??
      null,
    productionEffects:
      process.env
        .REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED ?? null,
  };
  fs.mkdirSync(path.dirname(witnessPath), { recursive: true });
  fs.writeFileSync(witnessPath, `${JSON.stringify(state, null, 2)}\n`);
}
