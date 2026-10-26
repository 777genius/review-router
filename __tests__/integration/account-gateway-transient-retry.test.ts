import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Readable } from 'node:stream';
import { test as nodeTest } from 'node:test';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import {
  AccountGatewayModelTransport,
  type GatewayTransportDiagnostic,
} from '../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import { OcrReviewInvocationAdapter } from '../../src/review-orchestration/infrastructure/ocr-review-invocation-adapter';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  type ProviderInvocationManifest,
  type ReviewInvocationLease,
} from '../../src/review-orchestration/application';

// Red: a fully accepted POST followed by lost headers or a bare proxy timeout
// was re-dispatched. Only positive closed not_dispatched denial permits replay.
const token = 'synthetic-transient-retry-token';
const body = JSON.stringify({
  model: 'fixture-model',
  input: 'synthetic',
  stream: true,
  store: false,
  service_tier: 'default',
});
const completed = (id: string) =>
  `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: {
      id,
      model: 'fixture-model',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: id }],
        },
      ],
    },
  })}\n\n`;

async function bounded<T>(work: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`synthetic_timeout:${phase}`)),
          15_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function drain(response: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  // A terminal mid-stream teardown surfaces as a stream error; the collected
  // bytes remain the observable body for the no-replay assertion.
  try {
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
  } catch {
    /* collected bytes so far are the observable body */
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Feed the real transport's lost-header failure into the real OCR adapter's
 * next granted attempt. The surrounding TLS fixture owns teardown even if a
 * red-baseline assertion fails; no network mock or replacement effect is used. */
async function assertAdapterKeepsUnknownTransport(
  transport: AccountGatewayModelTransport,
  root: string
): Promise<void> {
  const workSlot = {
    workSlotId: 'synthetic-slot',
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind: ReviewExecutionProviderKind.Ocr,
    providerVoteIdentityHash: 'f'.repeat(64),
    shardKey: 'all',
    required: true,
    attemptBudget: 3,
    retryPolicyVersion: 'fixture',
  };
  let processCalls = 0;
  let reopenCalls = 0;
  const adapter = new OcrReviewInvocationAdapter(
    [
      {
        workSlot,
        reviewRevisionHash: 'e'.repeat(64),
        mergeBaseSha: 'a'.repeat(40),
        lifecycleTargets: [],
        liveLifecycleStateHash: 'd'.repeat(64),
        context: {
          number: 1,
          title: 'synthetic',
          body: 'synthetic',
          author: 'fixture',
          draft: false,
          labels: [],
          files: [
            {
              filename: 'calc.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              changes: 2,
              patch: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
          diff: '',
          additions: 1,
          deletions: 1,
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
        },
      },
    ],
    {
      model: 'fixture-model',
      binaryPath: '/synthetic/not-dispatched',
      binarySha256: '1'.repeat(64),
      packageVersion: '1.2.3',
      profileRef: 'ocr-managed-v1',
      run: {
        runDirectory: root,
        homeDirectory: root,
        configPath: join(root, 'adapter-config.json'),
        rulePath: join(root, 'adapter-rule.json'),
        backgroundPath: null,
      },
      bridge: {
        baseUrl: 'http://127.0.0.1:41000',
        capabilityAuthorization: `Bearer ${'a'.repeat(64)}`,
        actualModel: () => transport.actualModel,
        requestCount: () => 1,
        effectFacts: () => ({
          effect: transport.lastFailure?.effect ?? 'none',
        }),
        releaseRetrySafeFailure: () => transport.releaseRetrySafeFailure(),
        reopenConsumer: () => {
          reopenCalls += 1;
          return transport.reopenConsumer();
        },
      },
      limits: { requestTimeoutSec: 10 },
      ocrEffort: 'medium',
      modelReasoningEffort: null,
      language: null,
      ruleText: 'synthetic',
      backgroundText: null,
      checkoutRoot: root,
      previewRunner: async (input) => {
        writeFileSync(
          input.outputPath,
          JSON.stringify({ files: [{ path: 'calc.ts', will_review: true }] })
        );
        return {
          closed: true,
          exitCode: 0,
          signal: null,
          stdoutTail: '',
          stderrTail: '',
        };
      },
      processRunner: async () => {
        processCalls += 1;
        throw new Error('unexpected_adapter_redispatch');
      },
    }
  );
  const invocation = await adapter.prepare({ workSlot, attemptOrdinal: 2 });
  await assert.rejects(
    adapter.execute({
      invocation,
      manifest: {
        manifestCanonicalJson: '{}',
        manifestKey: 'fixture',
        providerInvocationKey: 'fixture',
        providerVoteIdentityHash: 'f'.repeat(64),
      } as ProviderInvocationManifest,
      lease: {
        leaseId: 'fixture',
        attemptId: 'fixture',
        leaseCapability: 'fixture',
        fencingToken: 'fixture',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        resultReportUntil: new Date(Date.now() + 60000).toISOString(),
        renewalCeilingReached: false,
      } as ReviewInvocationLease,
      sourceExecutionId: 'synthetic-execution',
      sourceReviewRevisionHash: 'e'.repeat(64),
      signal: new AbortController().signal,
    }),
    /review_action_v2_ocr_gateway_effect_unknown/u
  );
  assert.equal(
    processCalls,
    0,
    'the adapter must not dispatch after real lost-header uncertainty'
  );
  assert.equal(
    reopenCalls,
    0,
    'the adapter never erases the real transport unknown fact'
  );
  assert.equal(transport.lastFailure?.effect, 'effect_unknown');
}

type ProbeMode =
  | 'positive-denial-recovery'
  | 'proven-denial-release'
  | 'unknown-effect-release-denied'
  | 'paid-then-denial-release-denied'
  | 'unclosed-denial-release-denied'
  | 'cancelled-denial-release-denied'
  | 'accepted-socket-loss-terminal'
  | 'poisoned-consumer-reopen'
  | 'reopen-after-close-denied'
  | 'unreferenced-timeout-terminal'
  | 'referenced-rejection-terminal'
  | 'mid-stream-terminal';

async function transientRetry(mode: ProbeMode): Promise<void> {
  const root = process.env.RR_TRANSIENT_RETRY_PROBE_ROOT;
  assert(root, 'disposable_probe_root_required');
  const diagnostics: GatewayTransportDiagnostic[] = [];
  let requests = 0;
  const server = createHttpsServer(
    {
      cert: readFileSync(join(root, 'cert.pem')),
      key: readFileSync(join(root, 'key.pem')),
    },
    (request, reply) => {
      void (async () => {
        if (request.url === '/api/action/v2/account-gateway/close') {
          reply.writeHead(200, { 'content-type': 'application/json' });
          reply.end('{"state":"closed"}');
          return;
        }
        requests++;
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/api/action/v2/account-gateway/responses');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        assert.equal(Buffer.concat(chunks).toString('utf8'), body);
        if (
          (mode === 'accepted-socket-loss-terminal' ||
            mode === 'poisoned-consumer-reopen' ||
            mode === 'unknown-effect-release-denied') &&
          requests === 1
        ) {
          request.socket.destroy();
          return;
        }
        if (mode === 'mid-stream-terminal') {
          reply.writeHead(200, {
            'content-type': 'text/event-stream',
            'x-reviewrouter-request-ref': 'synthetic-mid-stream',
          });
          reply.write(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'
          );
          // Destroy only after the started stream reached the consumer; a
          // request-stage death is also terminal without non-dispatch proof.
          await new Promise((resolve) => setTimeout(resolve, 150));
          reply.socket?.destroy();
          return;
        }
        if (mode === 'referenced-rejection-terminal') {
          reply.writeHead(502, {
            'content-type': 'text/plain',
            'x-reviewrouter-request-ref': 'synthetic-existing',
          });
          reply.end('synthetic edge rejection');
          return;
        }
        if (mode === 'paid-then-denial-release-denied') {
          if (requests === 1) {
            reply.writeHead(200, { 'content-type': 'text/event-stream' });
            reply.end(completed('paid-before-denial'));
            return;
          }
          // lane_saturated is never waited out, so the production transport
          // latches this closed denial without a synthetic wait budget.
          reply.writeHead(503, { 'content-type': 'application/json' });
          reply.end(
            '{"error":{"code":"lane_saturated","effect":"not_dispatched"}}'
          );
          return;
        }
        if (mode === 'unclosed-denial-release-denied') {
          reply.writeHead(503, { 'content-type': 'application/json' });
          reply.end(
            '{"error":{"code":"relay_saturated","effect":"not_dispatched","retryAfter":1}}'
          );
          return;
        }
        if (mode === 'unreferenced-timeout-terminal' && requests === 1) {
          reply.writeHead(504, { 'content-type': 'text/plain' });
          reply.end('synthetic proxy timeout after dispatch');
          return;
        }
        if (
          (mode === 'positive-denial-recovery' ||
            mode === 'proven-denial-release' ||
            mode === 'cancelled-denial-release-denied') &&
          requests === 1
        ) {
          reply.writeHead(503, { 'content-type': 'application/json' });
          reply.end(
            '{"error":{"code":"relay_saturated","effect":"not_dispatched"}}'
          );
          return;
        }
        reply.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-reviewrouter-request-ref': 'synthetic-recovered',
        });
        reply.end(completed('transient-recovered'));
      })().catch(() => reply.destroy());
    }
  );
  let transport: AccountGatewayModelTransport | undefined;
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }),
      'transient-listen'
    );
    const address = server.address();
    assert(address && typeof address !== 'string');
    transport = new AccountGatewayModelTransport(
      `https://127.0.0.1:${address.port}`,
      () => token,
      (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      undefined,
      mode === 'proven-denial-release' ||
        mode === 'cancelled-denial-release-denied'
    );
    if (mode === 'accepted-socket-loss-terminal') {
      await assert.rejects(
        bounded(transport.responses(Buffer.from(body)), 'accepted-post-loss')
      );
      assert.equal(
        requests,
        1,
        'a fully received POST must never be replayed after header loss'
      );
      assert.equal(transport.lastFailure?.effect, 'effect_unknown');
      return;
    }
    if (mode === 'poisoned-consumer-reopen') {
      await assert.rejects(
        bounded(transport.responses(Buffer.from(body)), 'poisoned-post-loss')
      );
      assert.equal(requests, 1);
      assert.equal(transport.lastFailure?.effect, 'effect_unknown');
      assert.equal(
        transport.releaseRetrySafeFailure(),
        false,
        'an unknown effect is never positively proven unpaid'
      );
      await assertAdapterKeepsUnknownTransport(transport, root);
      assert.equal(
        transport.reopenConsumer(),
        false,
        'an unknown effect stays fenced through every reopening entry point'
      );
      assert.equal(transport.lastFailure?.effect, 'effect_unknown');
      await assert.rejects(
        bounded(
          transport.responses(Buffer.from(body)),
          'poisoned-reopen-denied'
        ),
        /account_gateway_inference_denied/u
      );
      assert.equal(requests, 1, 'the accepted POST is never re-dispatched');
      transport.cancelInference();
      assert.equal(
        transport.reopenConsumer(),
        false,
        'a cancelled consumer never reopens'
      );
      return;
    }
    if (mode === 'reopen-after-close-denied') {
      await bounded(transport.close('completed'), 'reopen-close');
      assert.equal(
        transport.reopenConsumer(),
        false,
        'a closed consumer never reopens'
      );
      return;
    }
    if (mode === 'unknown-effect-release-denied') {
      await assert.rejects(
        bounded(transport.responses(Buffer.from(body)), 'unknown-effect-loss')
      );
      assert.equal(requests, 1);
      assert.equal(transport.lastFailure?.effect, 'effect_unknown');
      assert.equal(
        transport.releaseRetrySafeFailure(),
        false,
        'an unknown effect is never positively proven unpaid'
      );
      await assert.rejects(
        bounded(transport.responses(Buffer.from(body)), 'unknown-effect-deny'),
        /account_gateway_inference_denied/u
      );
      assert.equal(requests, 1, 'an unknown effect is never re-dispatched');
      return;
    }
    if (
      mode === 'paid-then-denial-release-denied' ||
      mode === 'unclosed-denial-release-denied' ||
      mode === 'cancelled-denial-release-denied'
    ) {
      const active = transport;
      if (mode === 'paid-then-denial-release-denied') {
        const paid = await bounded(
          active.responses(Buffer.from(body)),
          'paid-responses'
        );
        assert.equal(paid.httpStatus, 200);
        assert(
          (await bounded(drain(paid.body), 'paid-drain')).includes(
            '"type":"response.completed"'
          )
        );
      }
      const denied = await bounded(
        active.responses(Buffer.from(body)),
        'denied-responses'
      );
      assert.equal(denied.httpStatus, 503);
      await bounded(drain(denied.body), 'denied-drain');
      await bounded(
        (async () => {
          while (active.lastFailure === undefined)
            await new Promise((done) => setTimeout(done, 10));
        })(),
        'denied-failure-latch'
      );
      assert.equal(active.lastFailure?.effect, 'not_dispatched');
      assert.equal(active.lastFailure?.requestRef, undefined);
      if (mode === 'cancelled-denial-release-denied') active.cancelInference();
      assert.equal(
        active.releaseRetrySafeFailure(),
        false,
        mode === 'paid-then-denial-release-denied'
          ? 'a denial after a paid request never releases the consumer'
          : mode === 'cancelled-denial-release-denied'
            ? 'a release never reopens a cancelled consumer'
            : 'only the closed denial envelope proves nothing was dispatched'
      );
      await assert.rejects(
        bounded(active.responses(Buffer.from(body)), 'denied-redispatch'),
        /account_gateway_inference_denied/u
      );
      assert.equal(
        requests,
        mode === 'paid-then-denial-release-denied' ? 2 : 1,
        'an unreleased denial is never re-dispatched'
      );
      return;
    }
    const response = await bounded(
      transport.responses(Buffer.from(body)),
      'transient-responses'
    );
    const text = await bounded(drain(response.body), 'transient-drain');
    if (mode === 'proven-denial-release') {
      assert.equal(response.httpStatus, 503);
      assert.equal(requests, 1);
      assert.equal(
        text,
        '{"error":{"code":"relay_saturated","effect":"not_dispatched"}}'
      );
      const active = transport;
      // The final non-stream response latches its failure fact after the
      // bounded body drain completes.
      await bounded(
        (async () => {
          while (active.lastFailure === undefined)
            await new Promise((done) => setTimeout(done, 10));
        })(),
        'proven-failure-latch'
      );
      assert.equal(active.lastFailure?.effect, 'not_dispatched');
      assert.equal(active.lastFailure?.requestRef, undefined);
      assert.equal(
        active.releaseRetrySafeFailure(),
        true,
        'a proven pre-dispatch denial paid nothing and may be released'
      );
      const retried = await bounded(
        active.responses(Buffer.from(body)),
        'released-redispatch'
      );
      const retriedText = await bounded(
        drain(retried.body),
        'released-redispatch-drain'
      );
      assert.equal(
        requests,
        2,
        'a released proven denial permits exactly one fresh dispatch'
      );
      assert(retriedText.includes('"type":"response.completed"'));
      assert.equal(
        active.releaseRetrySafeFailure(),
        false,
        'nothing proven remains after a release'
      );
      return;
    }
    if (mode === 'unreferenced-timeout-terminal') {
      assert.equal(response.httpStatus, 504);
      assert.equal(
        requests,
        1,
        'missing proxy headers are not proof of non-dispatch'
      );
      assert.equal(text, 'synthetic proxy timeout after dispatch');
      assert.equal(transport.lastFailure?.effect, 'effect_unknown');
      return;
    }
    if (mode === 'referenced-rejection-terminal') {
      assert.equal(response.httpStatus, 502);
      assert.equal(response.requestRef, 'synthetic-existing');
      assert.equal(requests, 1, 'a request reference remains terminal');
      assert.equal(text, 'synthetic edge rejection');
      return;
    }
    if (mode === 'mid-stream-terminal') {
      assert.equal(response.httpStatus, 200);
      assert.equal(requests, 1, 'a started stream is never replayed');
      assert(text.includes('response.output_text.delta'));
      return;
    }
    assert.equal(
      response.httpStatus,
      200,
      'positive closed not_dispatched denial may retry'
    );
    assert.equal(requests, 2, 'exactly one bounded retry recovers the stream');
    assert(text.includes('"type":"response.completed"'));
    assert.equal(response.requestRef, 'synthetic-recovered');
    for (const privateValue of [token, '127.0.0.1', 'synthetic edge rejection'])
      assert(
        !JSON.stringify(diagnostics).includes(privateValue),
        'diagnostics must retain only closed fields'
      );
  } finally {
    transport?.cancelHeldStreams();
    server.closeAllConnections();
    await bounded(
      new Promise<void>((done) => server.close(() => done())),
      'transient-close'
    );
  }
}

// Same typed file becomes a compiled child observer; the isolated child's
// --probe marker travels in its env (see the jest shell below).
if (process.env.RR_TRANSIENT_RETRY_PROBE === '--probe') {
  nodeTest(
    'positive closed not-dispatched denial recovers the stream',
    { timeout: 20_000 },
    () => transientRetry('positive-denial-recovery')
  );
  nodeTest(
    'an accepted POST with lost headers is not re-dispatched',
    { timeout: 20_000 },
    () => transientRetry('accepted-socket-loss-terminal')
  );
  nodeTest(
    'a bare proxy timeout is not re-dispatched',
    { timeout: 20_000 },
    () => transientRetry('unreferenced-timeout-terminal')
  );
  nodeTest(
    'a referenced rejection stays terminal after one attempt',
    { timeout: 20_000 },
    () => transientRetry('referenced-rejection-terminal')
  );
  nodeTest(
    'a started stream stays terminal without replay',
    { timeout: 20_000 },
    () => transientRetry('mid-stream-terminal')
  );
  nodeTest(
    'a released proven not-dispatched denial permits one fresh dispatch',
    { timeout: 20_000 },
    () => transientRetry('proven-denial-release')
  );
  nodeTest(
    'an unknown effect is never released or re-dispatched',
    { timeout: 20_000 },
    () => transientRetry('unknown-effect-release-denied')
  );
  nodeTest(
    'a denial after a paid request is never released',
    { timeout: 20_000 },
    () => transientRetry('paid-then-denial-release-denied')
  );
  nodeTest(
    'an unclosed denial envelope is never released',
    { timeout: 20_000 },
    () => transientRetry('unclosed-denial-release-denied')
  );
  nodeTest('a cancelled consumer is never released', { timeout: 20_000 }, () =>
    transientRetry('cancelled-denial-release-denied')
  );
  nodeTest(
    'an unknown effect remains fenced through the compatibility reopen method',
    { timeout: 20_000 },
    () => transientRetry('poisoned-consumer-reopen')
  );
  nodeTest('a closed consumer never reopens', { timeout: 20_000 }, () =>
    transientRetry('reopen-after-close-denied')
  );
} else {
  test('real TLS transient retry recovers only provable not-dispatched failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reviewrouter-transient-retry-'));
    const certificate = join(root, 'cert.pem'),
      key = join(root, 'key.pem');
    const opensslConfig = join(root, 'openssl.cnf');
    const observer = join(root, 'transient-probe.cjs');
    const execute = promisify(execFile);
    try {
      writeFileSync(
        opensslConfig,
        '[req]\ndistinguished_name=req_distinguished_name\nprompt=no\n[req_distinguished_name]\nCN=localhost\n'
      );
      await execute(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          certificate,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=IP:127.0.0.1,DNS:localhost',
        ],
        {
          timeout: 10_000,
          env: { PATH: process.env.PATH, OPENSSL_CONF: opensslConfig },
        }
      );
      await Promise.all([chmod(certificate, 0o600), chmod(key, 0o600)]);
      buildSync({
        entryPoints: [__filename],
        outfile: observer,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        external: ['esbuild'],
      });
      const result = await execute(
        process.execPath,
        ['--test', '--test-reporter=tap', observer],
        {
          cwd: root,
          timeout: 120_000,
          killSignal: 'SIGKILL',
          maxBuffer: 1_048_576,
          env: {
            PATH: process.env.PATH,
            NODE_PATH: resolve('node_modules'),
            NODE_EXTRA_CA_CERTS: certificate,
            OPENSSL_CONF: opensslConfig,
            RR_TRANSIENT_RETRY_PROBE: '--probe',
            RR_TRANSIENT_RETRY_PROBE_ROOT: root,
          },
        }
      ).catch((error: Error & { stdout?: string; stderr?: string }) => {
        // execFile's default message hides the child TAP assertion in CI.
        throw new Error(
          [error.message, error.stdout, error.stderr].filter(Boolean).join('\n')
        );
      });
      expect(result.stdout).toMatch(/# tests 12\b/);
      expect(result.stdout).toMatch(/# pass 12\b/);
      expect(result.stdout).toMatch(/# fail 0\b/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
}
