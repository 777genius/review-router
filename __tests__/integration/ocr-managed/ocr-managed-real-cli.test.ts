/**
 * Plan 56 §12 real-CLI harness: the pinned managed OCR binary
 * (tools/ocr/out/opencodereview) runs against a synthetic Git repository and a
 * deterministic stub Responses server on loopback. Proves the wire contract:
 * exactly POST /responses with one Bearer prefix and no sampling params, the
 * managed run emits reviewrouter_outcome, and the result is accepted only
 * after process close.
 *
 * Skips gracefully when the pinned binary is not present (it is a build
 * artifact, not a repo source file).
 */

import { execFileSync } from 'child_process';
import { createServer, type Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildOcrControlledRuleText,
  OcrReviewInvocationAdapter,
  planOcrReviewAssignments,
  runOcrReviewProcess,
  type OcrLoopbackBridge,
  type OcrManagedRunLayout,
} from '../../../src/review-orchestration/infrastructure/ocr-review-invocation-adapter';
import {
  buildOcrChildEnvironment,
  buildOcrManagedConfigJson,
} from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';
import { parseOcrNativeReviewResult } from '../../../src/review-orchestration/infrastructure/ocr-review-outcome-contract';
import {
  ReviewExecutionProviderKind,
  type PreparedReviewInvocation,
  type ProviderInvocationManifest,
  type ReviewInvocationLease,
  type ReviewRunAuthorization,
} from '../../../src/review-orchestration/application';
import type { PRContext, ReviewConfig } from '../../../src/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BINARY_PATH =
  process.env.REVIEWROUTER_OCR_BINARY ??
  path.join(REPO_ROOT, 'tools', 'ocr', 'out', 'opencodereview');
const CAPABILITY = '0123456789abcdef'.repeat(4);
const BEARER = `Bearer ${CAPABILITY}`;

function binaryAvailable(): boolean {
  try {
    if (!fs.existsSync(BINARY_PATH)) return false;
    execFileSync(BINARY_PATH, ['--version'], {
      timeout: 60_000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const available = binaryAvailable();
const describeHarness = available ? describe : describe.skip;

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  bodyKeys: readonly string[];
}

function startStubResponsesServer(): Promise<{
  server: Server;
  baseUrl: string;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      let bodyKeys: readonly string[] = [];
      try {
        bodyKeys = Object.keys(JSON.parse(body) as Record<string, unknown>);
      } catch {
        bodyKeys = [];
      }
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        bodyKeys,
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      // Deterministic completed response with a task_done tool call: the
      // native loop ends naturally after one round with zero findings.
      const payload = {
        type: 'response.completed',
        response: {
          id: `resp_${requests.length}`,
          object: 'response',
          status: 'completed',
          model: 'stub-model',
          output: [
            {
              type: 'function_call',
              id: `fc_${requests.length}`,
              call_id: `call_${requests.length}`,
              name: 'task_done',
              arguments: '{}',
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      };
      response.write(
        `event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`
      );
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('stub server address unavailable');
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
      });
    });
  });
}

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=rr-harness',
      '-c',
      'user.email=rr-harness@test.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }
  );
}

describeHarness('managed OCR real-CLI harness (tools/ocr/out/opencodereview)', () => {
  let workspace: string;
  let checkoutRoot: string;
  let server: Server;
  let baseUrl: string;
  let requests: RecordedRequest[];

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ocr-harness-'));
    checkoutRoot = path.join(workspace, 'repo');
    fs.mkdirSync(checkoutRoot);
    git(checkoutRoot, 'init', '-q');
    fs.writeFileSync(
      path.join(checkoutRoot, 'calc.ts'),
      'function add(a, b) { return a + b }'
    );
    git(checkoutRoot, 'add', 'calc.ts');
    git(checkoutRoot, 'commit', '-qm', 'base');
    fs.writeFileSync(
      path.join(checkoutRoot, 'calc.ts'),
      'function add(a, b) { return a - b }'
    );
    git(checkoutRoot, 'commit', '-qam', 'head');
    const stub = await startStubResponsesServer();
    server = stub.server;
    baseUrl = stub.baseUrl;
    requests = stub.requests;
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(() => resolve(undefined)));
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('runs one managed review through the stubbed loopback bridge end to end', async () => {
    const mergeBaseSha = git(checkoutRoot, 'rev-parse', 'HEAD~1').trim();
    const headSha = git(checkoutRoot, 'rev-parse', 'HEAD').trim();

    const runDirectory = fs.mkdtempSync(
      path.join(workspace, 'run-')
    );
    fs.chmodSync(runDirectory, 0o700);
    const homeDirectory = path.join(runDirectory, 'home');
    fs.mkdirSync(path.join(homeDirectory, '.opencodereview'), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(homeDirectory, 0o700);
    const configPath = path.join(homeDirectory, '.opencodereview', 'config.json');
    fs.writeFileSync(
      configPath,
      buildOcrManagedConfigJson({
        baseUrl,
        rawCapability: CAPABILITY,
        model: 'stub-model',
        limits: { requestTimeoutSec: 600 },
        modelReasoningEffort: 'medium',
        language: 'en',
      }),
      { mode: 0o600 }
    );
    const run: OcrManagedRunLayout = {
      runDirectory,
      homeDirectory,
      configPath,
      rulePath: path.join(runDirectory, 'rule.json'),
      backgroundPath: path.join(runDirectory, 'background.md'),
    };

    const pr: PRContext = {
      number: 1,
      title: 'Break add()',
      body: 'Accidental subtraction.',
      author: 'tester',
      draft: false,
      labels: [],
      files: [
        {
          filename: 'calc.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: git(checkoutRoot, 'diff', `${mergeBaseSha}..${headSha}`, '--', 'calc.ts'),
        },
      ],
      diff: '',
      additions: 1,
      deletions: 1,
      baseSha: mergeBaseSha,
      headSha,
    };
    const authorization = {
      authorizationId: 'auth-harness',
      authorizationToken: 'token',
      producerReleaseId: 'release-1',
      protocolLimitsProfileId: 'limits-1',
      operationalSloProfileId: 'slo-1',
      mutationEpoch: 'epoch-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      limits: {
        maxWorkSlots: 2,
        maxAttemptsPerSlot: 1,
        maxObservationBytes: 512 * 1024,
        maxObservationFindings: 200,
        maxProjectionBytes: 512 * 1024,
        maxProjectionFindings: 200,
        maxPublicationOperations: 50,
        maxPublicationChunks: 20,
        maxPublicationBodyBytes: 60_000,
        maxRequestBatchSize: 10,
        maxLeaseDurationMs: 600_000,
        maxResultReportDurationMs: 600_000,
        maxReconciliationDurationMs: 600_000,
      },
      facts: {
        workspaceId: 'ws-1',
        repositoryConnectionId: 'conn-1',
        scmRepositoryIdentityId: 'scm-1',
        pullRequestNumber: 1,
        sourceRunId: 'run-1',
        sourceRunAttempt: '1',
        baseSha: mergeBaseSha,
        mergeBaseSha,
        headSha,
        reviewRevisionHash: 'e'.repeat(64),
        trustDomain: 'github:test/repo',
        producerReleaseId: 'release-1',
        selectedProtocolVersion: 'v2',
        schemaDigest: 'd'.repeat(64),
        providerVoteLanes: [
          {
            providerKind: ReviewExecutionProviderKind.Ocr,
            providerVoteIdentityHash: 'f'.repeat(64),
          },
        ],
      },
    } as ReviewRunAuthorization;

    const planned = planOcrReviewAssignments({
      authorization,
      pr,
      config: {} as ReviewConfig,
      compatibilityKey: '9'.repeat(64),
      lifecycleTargets: [],
      liveLifecycleStateHash: '8'.repeat(64),
    });

    // The bridge reports exactly what the stub server observed.
    const bridge: OcrLoopbackBridge = {
      baseUrl,
      capabilityAuthorization: BEARER,
      actualModel: () => (requests.length > 0 ? 'stub-model' : undefined),
      requestCount: () => requests.length,
      effectFacts: () => ({ effect: 'none' }),
    };
    let observedClosedBeforeRead: boolean | undefined;
    const adapter = new OcrReviewInvocationAdapter(planned.assignments, {
      model: 'stub-model',
      binaryPath: BINARY_PATH,
      binarySha256: '1'.repeat(64),
      packageVersion: '1.2.3',
      profileRef: 'ocr-managed-v1',
      run,
      bridge,
      limits: { requestTimeoutSec: 600 },
      ocrEffort: 'medium',
      modelReasoningEffort: 'medium',
      language: 'en',
      ruleText: buildOcrControlledRuleText({
        language: 'en',
        assignedPaths: ['calc.ts'],
      }),
      backgroundText: 'Accidental subtraction in add().',
      checkoutRoot,
      processRunner: async (input) => {
        const childEnv = buildOcrChildEnvironment({
          homeDirectory,
          capabilityAuthorization: BEARER,
          path: process.env.PATH,
        });
        // Minimal child environment with exactly one Bearer-prefixed token.
        expect(input.env.REVIEWROUTER_LOCAL_MODEL_TOKEN).toBe(BEARER);
        expect(input.env.REVIEWROUTER_LOCAL_MODEL_TOKEN!.match(/Bearer /g)).toHaveLength(1);
        expect(input.env.GITHUB_TOKEN).toBeUndefined();
        expect({ ...input.env }).toEqual({ ...childEnv });
        const result = await runOcrReviewProcess(input);
        // Read-after-close evidence: the output file is complete and parseable
        // at the moment the process is reported closed.
        if (result.closed && result.exitCode === 0) {
          try {
            JSON.parse(
              fs.readFileSync(path.join(runDirectory, 'result.json'), 'utf8')
            );
            observedClosedBeforeRead = true;
          } catch {
            observedClosedBeforeRead = false;
          }
        }
        return result;
      },
      previewRunner: runOcrReviewProcess,
    });

    const prepared = await adapter.prepare({
      workSlot: planned.assignments[0].workSlot,
      attemptOrdinal: 1,
    });
    const observation = await adapter.execute({
      invocation: prepared as PreparedReviewInvocation,
      manifest: {
        manifestCanonicalJson: '{}',
        manifestKey: 'k',
        providerInvocationKey: 'pk',
        providerVoteIdentityHash: 'f'.repeat(64),
      } as ProviderInvocationManifest,
      lease: {
        leaseId: 'lease-1',
        attemptId: 'attempt-1',
        leaseCapability: 'cap',
        fencingToken: 'fence-1',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        resultReportUntil: new Date(Date.now() + 3_600_000).toISOString(),
        renewalCeilingReached: false,
      } as ReviewInvocationLease,
      sourceExecutionId: 'execution-1',
      sourceReviewRevisionHash: 'e'.repeat(64),
      signal: new AbortController().signal,
    });

    // Wire contract: exactly POST /responses, one Bearer prefix, no sampling
    // parameters, and the captured loopback model in the request body.
    expect(requests.length).toBeGreaterThanOrEqual(1);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/responses');
      expect(request.authorization).toMatch(/^Bearer [0-9a-f]{64}$/u);
      expect(request.authorization).not.toMatch(/^Bearer Bearer /u);
      expect(request.bodyKeys).not.toContain('temperature');
      expect(request.bodyKeys).not.toContain('top_p');
      expect(request.bodyKeys).not.toContain('max_tokens');
    }

    // Managed outcome is emitted and parses under the frozen contract.
    const resultRaw = JSON.parse(
      fs.readFileSync(path.join(runDirectory, 'result.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(resultRaw.reviewrouter_outcome).toBeDefined();
    const native = parseOcrNativeReviewResult(resultRaw, {
      baseSha: mergeBaseSha,
      mergeBaseSha,
      headSha,
    });
    expect(native.outcome.groups[0].paths).toEqual(['calc.ts']);
    expect(native.outcome.groups[0].mainCompleted).toBe(true);
    expect(native.outcome.groups[0].filterDecisionValid).toBeNull();

    // Acceptance facts from the closed run.
    expect(observedClosedBeforeRead).toBe(true);
    expect(observation.actualModel).toBe('stub-model');
    expect(observation.transportAttemptCount).toBe(1);
    expect(observation.qualityFlags).toEqual([]);
  }, 120_000);
});
