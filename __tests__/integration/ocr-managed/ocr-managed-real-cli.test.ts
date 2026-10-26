import { createCapturedReviewSkills } from '../../../src/control-plane/generated/review-action-v2/review-skills-contract';
import { type ReviewSkillsExecutionInput } from '../../../src/review-skills/review-skills';
import {
  materializeReviewSkillsWithDiagnostics,
  type ReviewSkillsGitRootDiagnostic,
} from '../../../src/review-skills/materialize-review-skills';
import { ReviewSkillsReceiptCollector } from '../../../src/review-skills/review-skills-receipt';
import { createProductionReviewProjectionBuilder } from '../../../src/review-orchestration/infrastructure/production-review-projection';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
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
  buildOcrSkillsControlledRuleText,
  OcrReviewInvocationAdapter,
  planOcrReviewAssignments,
  runOcrReviewProcess,
  type OcrLoopbackBridge,
  type OcrManagedRunLayout,
} from '../../../src/review-orchestration/infrastructure/ocr-review-invocation-adapter';
import {
  buildOcrChildEnvironment,
  buildOcrManagedConfigJson,
  OcrReviewAcceptanceError,
} from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';
import {
  classifyOcrReviewOutcome,
  parseOcrNativeReviewResult,
} from '../../../src/review-orchestration/infrastructure/ocr-review-outcome-contract';
import {
  ReviewExecutionProviderKind,
  type PreparedReviewInvocation,
  type ProviderInvocationManifest,
  type ReviewInvocationLease,
  type ReviewObservationPayload,
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
if (!available && process.env.REVIEWROUTER_OCR_REQUIRED === '1')
  throw new Error('required_managed_ocr_binary_unavailable');
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
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    }
  );
}

/* ------------------------------------------------------------------ */
/* §12 scripted variants (real-CLI level)                              */
/* ------------------------------------------------------------------ */

type ScriptedRequestKind =
  | 'main'
  | 'plan'
  | 'filter'
  | 'relocation'
  | 'compression';

interface ScriptedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  bodyKeys: readonly string[];
  kind: ScriptedRequestKind;
  inputText: string;
  /** Request arrival -> response end; used for §7.2 serialization evidence. */
  startedAt: number;
  endedAt: number;
}

interface ScriptedStubScript {
  /** Findings returned by the first main-task turn (0 = task_done at once). */
  readonly nComments: number;
  readonly contentLen: number;
  readonly filterMode:
    | 'approve'
    | 'badargs'
    | 'empty'
    | 'nullargs'
    | 'empty-selection';
  /** Truncate the terminal SSE event mid-JSON on the first request. */
  readonly truncateFirst?: boolean;
  /** Records the transport failure fact when the truncation happens. */
  readonly onTruncated?: () => void;
}

/** Fixed reply for tool-less tasks (relocation and memory compression). */
const TOOLLESS_REPLY =
  'Previous review summary: the change swaps addition for subtraction in add().';

/**
 * Deterministic finding text. The exact bytes calibrate the prompt-token
 * windows used by the round-2 overflow and compression variants (the engine
 * counts BPE tokens over this rendered text).
 */
function harnessCommentContent(index: number, length: number): string {
  const base =
    `Issue ${index}: the accumulator overflows when the retry counter crosses threshold ${index * 7 + 3}. ` +
    `The handler segment index ${index} double counts batches under concurrent dispatch pressure and ` +
    `must clamp the window before publishing the partial total for comment ${index}.`;
  let out = base;
  while (out.length < length) out += ' ' + base;
  return out.slice(0, length);
}

function scriptedFunctionCall(
  name: string,
  args: string | Record<string, unknown>,
  index: number
): Record<string, unknown> {
  return {
    type: 'function_call',
    id: `fc_${index}`,
    call_id: `call_${index}`,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

function scriptedMessageItem(
  text: string,
  index: number
): Record<string, unknown> {
  return {
    type: 'message',
    id: `msg_${index}`,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function scriptedCompletedEvent(
  output: readonly Record<string, unknown>[],
  index: number
): string {
  const payload = {
    type: 'response.completed',
    response: {
      id: `resp_${index}`,
      object: 'response',
      status: 'completed',
      model: 'stub-model',
      output: [...output],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };
  return `event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`;
}

function startScriptedStub(script: ScriptedStubScript): Promise<{
  server: Server;
  baseUrl: string;
  requests: ScriptedRequest[];
  maxInFlight: number;
}> {
  const requests: ScriptedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let mainTurn = 0;
  const server = createServer((request, response) => {
    // In-flight window is request arrival -> response end (a superset of the
    // body-complete window), so any overlap is always observed.
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    const startedAt = Date.now();
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const toolNames = Array.isArray(parsed.tools)
        ? (parsed.tools as Array<{ name?: string }>).map(
            (tool) => tool.name ?? ''
          )
        : [];
      const inputText = JSON.stringify({
        instructions: parsed.instructions ?? '',
        input: parsed.input ?? '',
      });
      let kind: ScriptedRequestKind;
      if (
        toolNames.includes('task_done') ||
        toolNames.includes('code_comment')
      ) {
        kind = 'main';
      } else if (
        toolNames.includes('approve_all_comments') ||
        toolNames.includes('report_incorrect_comments')
      ) {
        kind = 'filter';
      } else if (inputText.includes('expert in code review task planning')) {
        kind = 'plan';
      } else if (inputText.includes('minimal contiguous code range')) {
        kind = 'relocation';
      } else {
        kind = 'compression';
      }
      const index = requests.length;
      const recorded: ScriptedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        bodyKeys: Object.keys(parsed),
        kind,
        inputText,
        startedAt,
        endedAt: startedAt,
      };
      requests.push(recorded);
      const end = (text: string) => {
        recorded.endedAt = Date.now();
        inFlight -= 1;
        response.end(text);
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (script.truncateFirst && index === 0) {
        // Terminal event cut mid-JSON: a transport failure, never a partial
        // response body.
        response.write(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_trunc","object":"response","status":"comp'
        );
        script.onTruncated?.();
        end('');
        return;
      }
      let output: Array<Record<string, unknown>>;
      if (kind === 'main') {
        mainTurn += 1;
        output =
          mainTurn === 1 && script.nComments > 0
            ? [
                scriptedFunctionCall(
                  'code_comment',
                  {
                    comments: Array.from(
                      { length: script.nComments },
                      (_unused, i) => ({
                        path: 'calc.ts',
                        content: harnessCommentContent(i, script.contentLen),
                        severity: 'high',
                      })
                    ),
                  },
                  index
                ),
              ]
            : [scriptedFunctionCall('task_done', {}, index)];
      } else if (kind === 'filter') {
        output =
          script.filterMode === 'approve'
            ? [scriptedFunctionCall('approve_all_comments', {}, index)]
            : script.filterMode === 'badargs'
              ? // Decision material that cannot parse: the degraded decision.
                [
                  scriptedFunctionCall(
                    'report_incorrect_comments',
                    'not json',
                    index
                  ),
                ]
              : script.filterMode === 'nullargs'
                ? [
                    scriptedFunctionCall(
                      'report_incorrect_comments',
                      'null',
                      index
                    ),
                  ]
                : script.filterMode === 'empty-selection'
                  ? [
                      scriptedFunctionCall(
                        'report_incorrect_comments',
                        { comment_ids: [] },
                        index
                      ),
                    ]
                  : // No decision material at all.
                    [];
      } else {
        // Relocation and memory-compression tasks: fence-free text so the
        // native relocator never rewrites spans and the summary is non-empty.
        output = [scriptedMessageItem(TOOLLESS_REPLY, index)];
      }
      end(scriptedCompletedEvent(output, index));
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
        get maxInFlight() {
          return maxInFlight;
        },
      });
    });
  });
}

interface ScriptedScenarioResult {
  projection?: import('../../../src/review-orchestration/application').CurrentReviewProjection;
  replayProjection?: import('../../../src/review-orchestration/application').CurrentReviewProjection;
  observation?: ReviewObservationPayload;
  rejection?: unknown;
  /** Rejection of the first attempt when reopenRetry ran a second one. */
  firstRejection?: unknown;
  reopened: number;
  requests: ScriptedRequest[];
  maxInFlight: number;
  resultRaw: Record<string, unknown> | undefined;
  admission: {
    baseSha: string;
    mergeBaseSha: string;
    headSha: string;
  };
}

/**
 * One full managed invocation through the real binary against a scripted
 * loopback stub. prepare (preview) and execute share the scenario's run
 * directory; only execute talks to the model.
 */
async function runScriptedScenario(input: {
  readonly workspace: string;
  readonly checkoutRoot: string;
  readonly script: ScriptedStubScript;
  readonly maxTokens?: number;
  readonly reviewSkills?: ReviewSkillsExecutionInput;
  readonly skillsGitRoots?: readonly ReviewSkillsGitRootDiagnostic[];
  readonly projectSkills?: boolean;
  readonly assignedPaths?: readonly string[];
  /** Offer an unsafe reopen seam after truncation; the adapter must ignore it. */
  readonly reopenRetry?: boolean;
}): Promise<ScriptedScenarioResult> {
  let poisoned = false;
  let reopened = 0;
  const stub = await startScriptedStub({
    ...input.script,
    ...(input.reopenRetry === true
      ? { onTruncated: () => (poisoned = true) }
      : {}),
  });
  try {
    const mergeBaseSha = git(input.checkoutRoot, 'rev-parse', 'HEAD~1').trim();
    const headSha = git(input.checkoutRoot, 'rev-parse', 'HEAD').trim();

    const runDirectory = fs.mkdtempSync(path.join(input.workspace, 'run-'));
    fs.chmodSync(runDirectory, 0o700);
    const homeDirectory = path.join(runDirectory, 'home');
    fs.mkdirSync(path.join(homeDirectory, '.opencodereview'), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(homeDirectory, 0o700);
    const configPath = path.join(
      homeDirectory,
      '.opencodereview',
      'config.json'
    );
    fs.writeFileSync(
      configPath,
      buildOcrManagedConfigJson({
        baseUrl: stub.baseUrl,
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
      files: (input.assignedPaths ?? ['calc.ts']).map((filename) => ({
        filename,
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: git(
          input.checkoutRoot,
          'diff',
          `${mergeBaseSha}..${headSha}`,
          '--',
          filename
        ),
      })),
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

    // The truncated terminal event records an unknown effect. Even an offered
    // unsafe reopen implementation must never be consulted by the adapter.
    const bridge: OcrLoopbackBridge = {
      baseUrl: stub.baseUrl,
      capabilityAuthorization: BEARER,
      actualModel: () => (stub.requests.length > 0 ? 'stub-model' : undefined),
      requestCount: () => stub.requests.length,
      effectFacts: () =>
        poisoned ? { effect: 'effect_unknown' } : { effect: 'none' },
      ...(input.reopenRetry === true
        ? {
            reopenConsumer: (): boolean => {
              if (!poisoned) return false;
              poisoned = false;
              reopened += 1;
              return true;
            },
          }
        : {}),
    };
    const collector = new ReviewSkillsReceiptCollector();
    const adapter = new OcrReviewInvocationAdapter(planned.assignments, {
      model: 'stub-model',
      binaryPath: BINARY_PATH,
      binarySha256: '1'.repeat(64),
      packageVersion: '1.2.3',
      profileRef: 'ocr-managed-v1',
      run,
      bridge,
      limits: {
        requestTimeoutSec: 600,
        ...(input.maxTokens !== undefined
          ? { maxTokens: input.maxTokens }
          : {}),
      },
      ocrEffort: 'medium',
      modelReasoningEffort: 'medium',
      language: 'en',
      reviewSkills: input.reviewSkills,
      freshReviewSkillsSupply: (supply) => collector.record(supply),
      ruleText:
        input.reviewSkills?.kind === 'captured'
          ? buildOcrSkillsControlledRuleText({
              language: 'en',
              assignedPaths: input.assignedPaths ?? ['calc.ts'],
              reviewSkills: input.reviewSkills,
            })
          : buildOcrControlledRuleText({
              language: 'en',
              assignedPaths: input.assignedPaths ?? ['calc.ts'],
            }),
      backgroundText: 'Accidental subtraction in add().',
      checkoutRoot: input.checkoutRoot,
      processRunner: runOcrReviewProcess,
      previewRunner: runOcrReviewProcess,
    });

    const executeInvocation = (invocation: PreparedReviewInvocation) =>
      adapter.execute({
        invocation,
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

    const prepared = await adapter.prepare({
      workSlot: planned.assignments[0].workSlot,
      attemptOrdinal: 1,
    });
    let observation: ReviewObservationPayload | undefined;
    let rejection: unknown;
    try {
      observation = await executeInvocation(
        prepared as PreparedReviewInvocation
      );
    } catch (error) {
      rejection = error;
    }
    let firstRejection: unknown;
    if (input.reopenRetry === true && rejection !== undefined) {
      firstRejection = rejection;
      rejection = undefined;
      const retried = await adapter.prepare({
        workSlot: planned.assignments[0].workSlot,
        attemptOrdinal: 2,
      });
      try {
        observation = await executeInvocation(
          retried as PreparedReviewInvocation
        );
      } catch (error) {
        rejection = error;
      }
    }

    const resultPath = path.join(runDirectory, 'result.json');
    const resultRaw = fs.existsSync(resultPath)
      ? (JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<
          string,
          unknown
        >)
      : undefined;
    let projection:
      | import('../../../src/review-orchestration/application').CurrentReviewProjection
      | undefined;
    let replayProjection: typeof projection;
    if (observation && input.reviewSkills && input.projectSkills) {
      const evidence = [
        {
          workSlotId: prepared.workSlotId,
          coverageManifest: prepared.coverageManifest,
          observation: {
            ...observation,
            observationId: 'accepted-real-ocr',
            eligibilityPolicyVersion: 'fixture',
            providerKind: ReviewExecutionProviderKind.Ocr,
            providerInvocationKey: 'pk',
            providerVoteIdentityHash: 'f'.repeat(64),
          },
        },
      ];
      const project = (receipt: ReviewSkillsReceiptCollector) =>
        createProductionReviewProjectionBuilder({
          authorizationFacts: authorization.facts,
          pr,
          config: DEFAULT_CONFIG,
          protocolLimits: authorization.limits,
          assignments: planned.assignments.map(({ workSlot, context }) => ({
            workSlotId: workSlot.workSlotId,
            taskKind: workSlot.taskKind,
            providerKind: workSlot.providerKind,
            required: workSlot.required,
            filePaths: context.files.map((file) => file.filename),
          })),
          uncoveredPaths: planned.uncoveredPaths,
          uncoveredLifecycleTargetIds: planned.uncoveredLifecycleTargetIds,
          lifecycleInventory: {
            loadCurrent: async () => ({
              inventoryVersion: 'review_lifecycle_inventory.v1',
              loadedForHeadSha: headSha,
              lifecycleStateHash: 'fixture-state',
              commandLedgerWatermark: 'fixture-ledger',
              complete: true,
              warnings: [],
              targets: [],
            }),
          },
          skillsReceipt: {
            render: (acceptedEvidence) =>
              receipt.render({
                skills: input.reviewSkills!,
                changedPaths: pr.files.map((file) => file.filename),
                gitRoots: input.skillsGitRoots,
                acceptedEvidence,
              }),
            unavailable: () => {
              throw new Error('fixture_receipt_did_not_fit');
            },
          },
        }).build({
          acceptedEvidence: evidence,
          exhaustedWorkSlotIds: [],
          reviewRevisionHash: authorization.facts.reviewRevisionHash,
        });
      projection = await project(collector);
      // A new local collector models a restored/cache evidence path: no fresh witness is invented.
      replayProjection = await project(new ReviewSkillsReceiptCollector());
    }
    return {
      ...(projection ? { projection, replayProjection } : {}),
      ...(observation !== undefined ? { observation } : {}),
      ...(rejection !== undefined ? { rejection } : {}),
      ...(firstRejection !== undefined ? { firstRejection } : {}),
      reopened,
      requests: stub.requests,
      maxInFlight: stub.maxInFlight,
      resultRaw,
      admission: { baseSha: mergeBaseSha, mergeBaseSha, headSha },
    };
  } finally {
    await new Promise((resolve) => stub.server.close(() => resolve(undefined)));
  }
}

describeHarness(
  'managed OCR real-CLI harness (tools/ocr/out/opencodereview)',
  () => {
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

      const runDirectory = fs.mkdtempSync(path.join(workspace, 'run-'));
      fs.chmodSync(runDirectory, 0o700);
      const homeDirectory = path.join(runDirectory, 'home');
      fs.mkdirSync(path.join(homeDirectory, '.opencodereview'), {
        recursive: true,
        mode: 0o700,
      });
      fs.chmodSync(homeDirectory, 0o700);
      const configPath = path.join(
        homeDirectory,
        '.opencodereview',
        'config.json'
      );
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
            patch: git(
              checkoutRoot,
              'diff',
              `${mergeBaseSha}..${headSha}`,
              '--',
              'calc.ts'
            ),
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
          expect(
            input.env.REVIEWROUTER_LOCAL_MODEL_TOKEN!.match(/Bearer /g)
          ).toHaveLength(1);
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

    it('supplies composed skills and built-ins to real main/plan prompts with exact assigned inventory', async () => {
      const repo = path.join(workspace, 'skills-repo');
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      git(repo, 'init', '-q');
      fs.writeFileSync(
        path.join(repo, 'calc.ts'),
        'export const oldValue = 1;\n'
      );
      fs.mkdirSync(path.join(repo, '.agents/skills/review'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(repo, '.agents/skills/review/SKILL.md'),
        '---\nname: review\ndescription: Repository review rules\n---\nGIT_SKILL_PRIVATE_BODY_MARKER'
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'base');
      const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
      fs.writeFileSync(
        path.join(repo, 'calc.ts'),
        Array.from(
          { length: 80 },
          (_, i) => `export const value${i} = ${i};`
        ).join('\n')
      );
      fs.writeFileSync(
        path.join(repo, 'src/Foo.ts'),
        'export const upper = true;\n'
      );
      fs.writeFileSync(
        path.join(repo, 'src/foo.ts'),
        'export const lower = true;\n'
      );
      fs.writeFileSync(
        path.join(repo, 'unassigned.ts'),
        'UNASSIGNED_SOURCE_MARKER'
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'head');
      const skill = (
        skillId: string,
        instructions: string,
        includePaths: string[]
      ) => ({
        skillId,
        revisionId: 'revision-1',
        sourceWorkspaceId: 'source',
        name: skillId,
        description: 'custom review invariant',
        instructions,
        includePaths,
        excludePaths: [],
      });
      const materialized = await materializeReviewSkillsWithDiagnostics({
        capture: createCapturedReviewSkills({
          baseSha,
          webSkills: [
            skill('global-one', 'GLOBAL_ONE_MARKER', ['**']),
            skill('global-two', 'GLOBAL_TWO_MARKER', ['**']),
            skill('upper', 'UPPER_ONLY_MARKER', ['src/Foo.ts']),
            skill('lower', 'LOWER_ONLY_MARKER', ['src/foo.ts']),
            skill('other', 'UNRELATED_POLICY_MARKER', ['other/**']),
          ],
          gitSources: [{ root: '.agents/skills' }],
        }),
        baseSha,
        checkoutRoot: repo,
      });
      const reviewSkills = materialized.executionInput;
      const scenario = await runScriptedScenario({
        workspace,
        checkoutRoot: repo,
        script: { nComments: 0, contentLen: 0, filterMode: 'approve' },
        assignedPaths: ['calc.ts', 'src/Foo.ts', 'src/foo.ts'],
        reviewSkills,
        skillsGitRoots: materialized.gitRoots,
      });
      expect(scenario.rejection).toBeUndefined();
      // Projection currently enforces case-folded unique revision paths. Preserve
      // the case-distinct engine proof above and qualify publication on a second
      // real invocation whose assigned paths satisfy that existing invariant.
      const publishedScenario = await runScriptedScenario({
        workspace,
        checkoutRoot: repo,
        script: { nComments: 0, contentLen: 0, filterMode: 'approve' },
        assignedPaths: ['calc.ts', 'src/Foo.ts'],
        reviewSkills,
        skillsGitRoots: materialized.gitRoots,
        projectSkills: true,
      });
      expect(publishedScenario.rejection).toBeUndefined();
      const publication = publishedScenario.projection!.operationsCanonicalJson;
      expect(publication).toContain(
        'Fresh accepted OCR invocations received the controlled Skills rules: 1'
      );
      expect(publication).toContain('.agents/skills/review/SKILL.md');
      expect(publication).toContain(baseSha);
      expect(publication).toContain('Captured identity:');
      expect(publication).not.toMatch(
        /GLOBAL_ONE_MARKER|GLOBAL_TWO_MARKER|UPPER_ONLY_MARKER|LOWER_ONLY_MARKER|GIT_SKILL_PRIVATE_BODY_MARKER|global-one|revision-1|sourceWorkspaceId/
      );
      expect(
        publishedScenario.replayProjection!.operationsCanonicalJson
      ).toContain('fresh instruction supply unconfirmed');
      expect(
        publishedScenario.replayProjection!.operationsCanonicalJson
      ).not.toContain('Fresh accepted OCR invocations received');
      expect(publishedScenario.projection!.projectionHash).not.toBe(
        publishedScenario.replayProjection!.projectionHash
      );
      expect(scenario.requests.some((request) => request.kind === 'plan')).toBe(
        true
      );
      expect(scenario.requests.some((request) => request.kind === 'main')).toBe(
        true
      );
      for (const request of scenario.requests.filter(
        (item) => item.kind === 'main' || item.kind === 'plan'
      )) {
        expect(request.inputText).toContain('GLOBAL_ONE_MARKER');
        expect(request.inputText).toContain('GLOBAL_TWO_MARKER');
        expect(request.inputText).toContain('UPPER_ONLY_MARKER');
        expect(request.inputText).toContain('LOWER_ONLY_MARKER');
        expect(request.inputText).toContain(
          'System-Specific Rules (Mandatory)'
        );
        expect(request.inputText).toContain('introduced or aggravated');
        expect(request.inputText).not.toContain('UNRELATED_POLICY_MARKER');
      }
      expect(JSON.stringify(scenario.requests)).not.toContain(
        'UNASSIGNED_SOURCE_MARKER'
      );
      const groups = (
        scenario.resultRaw?.reviewrouter_outcome as {
          groups: { paths: string[] }[];
        }
      ).groups;
      expect(groups.flatMap((group) => group.paths).sort()).toEqual([
        'calc.ts',
        'src/Foo.ts',
        'src/foo.ts',
      ]);
    }, 120_000);

    // ------------------------------------------------------------------
    // §12 variant 1: round-2 prompt overflow.
    //
    // Discrimination: before the plan-56 §7.4 outcome contract and the §8.4
    // partial model (feature + review fixes) a budget-truncated run was
    // all-or-nothing — there was no stop_cause/rounds accounting and no way to
    // accept usable findings with context_inspection_incomplete +
    // provider_warning. The assertions below could not pass against that state.
    // ------------------------------------------------------------------
    it('round-2 prompt overflow stops locally: partial findings preserved with no inference past the overflow', async () => {
      // --max-tokens 3000 puts the second-round prompt (base ~1313 tokens +
      // confirmed-findings block ~1640 tokens = ~2950) over the 80% budget while
      // round 1 (~1313) stays under it; managed compression engages on the way.
      const scenario = await runScriptedScenario({
        workspace,
        checkoutRoot,
        script: { nComments: 24, contentLen: 300, filterMode: 'approve' },
        maxTokens: 3000,
      });

      // Degradation is semantic and local: the run still yields an accepted
      // partial observation — this is not a transport failure.
      const observation = scenario.observation;
      expect(observation).toBeDefined();
      expect(observation!.findingCount).toBe(24);
      expect(observation!.transportAttemptCount).toBe(1);
      expect(observation!.qualityFlags).toEqual([
        'context_inspection_incomplete',
        'provider_warning',
      ]);

      const native = parseOcrNativeReviewResult(
        scenario.resultRaw,
        scenario.admission
      );
      const group = native.outcome.groups[0];
      expect(group.paths).toEqual(['calc.ts']);
      expect(group.mainCompleted).toBe(false);
      expect(group.stopCause).toBe('prompt_budget');
      expect(group.rounds).toEqual({ configured: 2, started: 2, completed: 1 });
      // The round-1 filter decision was valid; only the round-2 drop degrades.
      expect(group.filterDecisionValid).toBe(true);
      expect(group.phases.compression.state).toBe('completed');
      const classification = classifyOcrReviewOutcome(native.outcome);
      expect(classification.partial).toBe(true);
      expect(classification.reasons).toContain('late_round_stop');
      // The stop is diagnosed in-run on round 2 preparation only.
      expect(
        native.warnings.some((warning) => /\[round 2\]/u.test(warning))
      ).toBe(true);
      expect(
        native.warnings.some((warning) => /\[round 1\]/u.test(warning))
      ).toBe(false);

      // No new inference after the overflow stop: round 2 never reached the
      // model (2 main turns = round-1 code_comment + task_done, nothing more).
      expect(scenario.requests.filter((r) => r.kind === 'main')).toHaveLength(
        2
      );
      expect(scenario.requests.filter((r) => r.kind === 'filter')).toHaveLength(
        1
      );
      expect(
        scenario.requests.filter((r) => r.kind === 'relocation')
      ).toHaveLength(24);
      expect(
        scenario.requests.filter((r) => r.kind === 'compression')
      ).toHaveLength(1);
      expect(scenario.requests).toHaveLength(28);
    }, 120_000);

    // ------------------------------------------------------------------
    // §12 variant 2(a): unparsable filter decision.
    //
    // Discrimination: filterDecisionValid and its degradation semantics exist
    // only in the plan-56 managed outcome contract consumed through the §8.4
    // acceptance (post-review-fixes). Before it, a filter HTTP success read as
    // valid filtering and there was no partial-flag pair to assert.
    // ------------------------------------------------------------------
    it.each(['badargs', 'nullargs'] as const)(
      'invalid %s filter decision preserves findings as partial',
      async (filterMode) => {
        const scenario = await runScriptedScenario({
          workspace,
          checkoutRoot,
          script: { nComments: 3, contentLen: 80, filterMode },
        });

        const observation = scenario.observation;
        expect(observation).toBeDefined();
        // Usable findings survive the malformed decision (native removal skips it).
        expect(observation!.findingCount).toBe(3);
        // §7.3 preserved-comments degradation: inspection and path coverage
        // are intact, so the advisory provider_warning alone is truthful and
        // must not claim context inspection was incomplete.
        expect(observation!.qualityFlags).toEqual(['provider_warning']);

        const native = parseOcrNativeReviewResult(
          scenario.resultRaw,
          scenario.admission
        );
        const group = native.outcome.groups[0];
        // The main review itself completed: the degradation is the filter verdict.
        expect(group.mainCompleted).toBe(true);
        expect(group.stopCause).toBeNull();
        expect(group.filterDecisionValid).toBe(false);
        expect(group.phases.filter).toEqual({
          state: 'failed',
          reason: 'malformed',
        });
        const classification = classifyOcrReviewOutcome(native.outcome);
        expect(classification.partial).toBe(true);
        expect(classification.filterCommentsPreserved).toBe(true);
        expect(classification.reasons).toEqual(
          expect.arrayContaining(['invalid_filter_decision', 'phase_failed'])
        );
      },
      120_000
    );

    // §12 variant 2(a-null): no decision material at all keeps the strict null.
    it('no filter decision material: filterDecisionValid stays null and findings stay partial', async () => {
      const scenario = await runScriptedScenario({
        workspace,
        checkoutRoot,
        script: { nComments: 3, contentLen: 80, filterMode: 'empty' },
      });

      const observation = scenario.observation;
      expect(observation).toBeDefined();
      expect(observation!.findingCount).toBe(3);
      expect(observation!.qualityFlags).toEqual([
        'context_inspection_incomplete',
        'provider_warning',
      ]);

      const native = parseOcrNativeReviewResult(
        scenario.resultRaw,
        scenario.admission
      );
      const group = native.outcome.groups[0];
      expect(group.filterDecisionValid).toBeNull();
      expect(group.phases.filter).toEqual({
        state: 'failed',
        reason: 'malformed',
      });
      const classification = classifyOcrReviewOutcome(native.outcome);
      expect(classification.partial).toBe(true);
      expect(classification.reasons).toContain('phase_failed');
      // Null is not a false decision: no invalid_filter_decision degradation,
      // and no preserved-comments proof either, so the full flag pair stays.
      expect(classification.reasons).not.toContain('invalid_filter_decision');
      expect(classification.filterCommentsPreserved).toBe(false);
    }, 120_000);

    // ------------------------------------------------------------------
    // §12 variant 2(b): valid approve-all — the discriminating counterpart of
    // the two tests above. Identical run shape, only the filter decision
    // differs, and the outcome is clean: filterDecisionValid=true and no
    // degradation flags at all.
    // ------------------------------------------------------------------
    it.each(['approve', 'empty-selection'] as const)(
      'valid %s filter decision carries no degradation flags',
      async (filterMode) => {
        const scenario = await runScriptedScenario({
          workspace,
          checkoutRoot,
          script: { nComments: 3, contentLen: 80, filterMode },
        });

        const observation = scenario.observation;
        expect(observation).toBeDefined();
        expect(observation!.findingCount).toBe(3);
        expect(observation!.qualityFlags).toEqual([]);

        const native = parseOcrNativeReviewResult(
          scenario.resultRaw,
          scenario.admission
        );
        const group = native.outcome.groups[0];
        expect(group.mainCompleted).toBe(true);
        expect(group.stopCause).toBeNull();
        expect(group.filterDecisionValid).toBe(true);
        expect(group.phases.filter).toEqual({
          state: 'completed',
          reason: null,
        });
        const classification = classifyOcrReviewOutcome(native.outcome);
        expect(classification.partial).toBe(false);
        expect(classification.reasons).toEqual([]);
      },
      120_000
    );

    // ------------------------------------------------------------------
    // §12 variant 3: truncated SSE stream.
    //
    // Discrimination: the §8.4 step-3 gate (no readable-JSON rescue of a failed
    // process, no partial acceptance) exists only in the post-review-fix
    // acceptance. Before it there was no terminal process_failed class to
    // distinguish from the retry-safe not_dispatched failure, and nothing kept
    // a truncated run from leaking partial findings.
    // ------------------------------------------------------------------
    it('truncated SSE stream is a terminal transport failure: zero findings accepted and no rerun', async () => {
      const scenario = await runScriptedScenario({
        workspace,
        checkoutRoot,
        script: {
          nComments: 3,
          contentLen: 80,
          filterMode: 'approve',
          truncateFirst: true,
        },
      });

      // No observation is ever produced: the failure is terminal, not
      // retry-safe (that class is review_agent_not_dispatched).
      expect(scenario.observation).toBeUndefined();
      expect(scenario.rejection).toBeInstanceOf(OcrReviewAcceptanceError);
      expect((scenario.rejection as OcrReviewAcceptanceError).code).toBe(
        'process_failed'
      );

      // One transport attempt only — no retry or rerun after the truncation.
      expect(scenario.requests).toHaveLength(1);

      // Zero accepted findings and a terminal failure story in the emitted
      // result (the reconciliation classification above the adapter is the
      // process_failed rejection asserted above).
      expect(scenario.resultRaw).toBeDefined();
      const native = parseOcrNativeReviewResult(
        scenario.resultRaw,
        scenario.admission
      );
      expect(native.comments).toEqual([]);
      expect(native.manifest.terminalState).toBe('failed');
      const group = native.outcome.groups[0];
      expect(group.mainCompleted).toBe(false);
      expect(group.stopCause).toBe('provider_error');
      expect(group.rounds).toEqual({ configured: 2, started: 1, completed: 0 });
      expect(group.phases.filter).toEqual({
        state: 'cancelled',
        reason: 'not_dispatched',
      });
      expect(group.filterDecisionValid).toBeNull();
    }, 120_000);

    it('a truncated real-CLI response keeps the unknown effect fenced on a later attempt', async () => {
      const scenario = await runScriptedScenario({
        workspace,
        checkoutRoot,
        script: {
          nComments: 3,
          contentLen: 80,
          filterMode: 'approve',
          truncateFirst: true,
        },
        reopenRetry: true,
      });

      // Attempt 1 fails closed on the recorded unknown-effect fact.
      expect(scenario.firstRejection).toBeInstanceOf(OcrReviewAcceptanceError);
      expect((scenario.firstRejection as OcrReviewAcceptanceError).code).toBe(
        'gateway_effect_unknown'
      );

      expect(scenario.reopened).toBe(0);
      expect(scenario.rejection).toBeInstanceOf(Error);
      expect((scenario.rejection as Error).message).toMatch(
        /gateway_effect_unknown/u
      );
      expect(scenario.observation).toBeUndefined();
      expect(
        scenario.requests.filter((request) => request.kind === 'main').length
      ).toBe(1);
    }, 120_000);

    // ------------------------------------------------------------------
    // §12 variant 4: §7.2 compression/filter serialization.
    //
    // The stub records arrival->end windows for every model request (main,
    // relocation, compression and filter). Managed mode must keep at most one
    // in flight and the run must stay coherent after compression rewrites the
    // conversation.
    // ------------------------------------------------------------------
    it('managed compression engages alongside filtering: at most one in-flight model request', async () => {
      // --max-tokens 8000 with 12 x 1500-char findings pushes the round-1
      // conversation over the 60% soft threshold (compression engages) while
      // the second-round prompt stays far under the 80% budget.
      const scenario = await runScriptedScenario({
        workspace,
        checkoutRoot,
        script: { nComments: 12, contentLen: 1500, filterMode: 'approve' },
        maxTokens: 8000,
      });

      // §7.2: no two model requests were ever in flight together.
      expect(scenario.maxInFlight).toBe(1);
      const ordered = [...scenario.requests].sort(
        (a, b) => a.startedAt - b.startedAt
      );
      for (let i = 1; i < ordered.length; i++) {
        expect(ordered[i].startedAt).toBeGreaterThanOrEqual(
          ordered[i - 1].endedAt
        );
      }
      expect(
        scenario.requests.some((request) => request.kind === 'compression')
      ).toBe(true);
      expect(
        scenario.requests.filter((request) => request.kind === 'filter')
      ).toHaveLength(1);

      const observation = scenario.observation;
      expect(observation).toBeDefined();
      expect(observation!.findingCount).toBe(12);
      expect(observation!.qualityFlags).toEqual([]);

      // Serialized outcome is coherent: one group over the exact inventory, no
      // interleaved or duplicated findings or groups.
      const native = parseOcrNativeReviewResult(
        scenario.resultRaw,
        scenario.admission
      );
      expect(native.outcome.groups).toHaveLength(1);
      const group = native.outcome.groups[0];
      expect(group.paths).toEqual(['calc.ts']);
      expect(group.mainCompleted).toBe(true);
      expect(group.stopCause).toBeNull();
      expect(group.rounds).toEqual({ configured: 2, started: 2, completed: 2 });
      expect(group.phases.compression.state).toBe('completed');
      expect(group.phases.filter).toEqual({ state: 'completed', reason: null });
      expect(group.filterDecisionValid).toBe(true);
      const contents = native.comments.map((comment) => comment.content);
      expect(new Set(contents).size).toBe(12);
      expect(classifyOcrReviewOutcome(native.outcome).reasons).toEqual([]);
    }, 120_000);
  }
);
