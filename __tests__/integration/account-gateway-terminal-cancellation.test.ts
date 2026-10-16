import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { mock, test as nodeTest } from 'node:test';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import {
  AccountGatewayModelTransport,
  LOCAL_MODEL_CAPABILITY_ENV,
  startLocalGatewayModelTransport,
  type LocalGatewayModelTransport,
  type GatewayTransportDiagnostic,
} from '../../src/review-orchestration/infrastructure/account-gateway-model-transport';

// Red: audited completed output followed by client cancellation poisons the
// next sequential request. Adjacent cases retain denial on incomplete/upstream loss.
const token = 'synthetic-transport-run-token';
const body = JSON.stringify({
  model: 'fixture-model',
  input: 'synthetic',
  stream: true,
  store: false,
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
const partial =
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';

async function bounded<T>(work: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`synthetic_timeout:${phase}`)),
          4000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function post(
  local: LocalGatewayModelTransport,
  idleTimeoutMs = 4000
): Promise<IncomingMessage> {
  const authorization = local.environment[LOCAL_MODEL_CAPABILITY_ENV];
  assert.equal(typeof authorization, 'string');
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL('/responses', local.baseUrl),
      {
        method: 'POST',
        agent: false,
        headers: { authorization, 'content-type': 'application/json' },
      },
      resolve
    );
    request.once('error', reject);
    request.setTimeout(idleTimeoutMs, () =>
      request.destroy(new Error('synthetic_client_timeout'))
    );
    request.end(body);
  });
}
function firstFrame(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    response.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (text.length > 4096) {
        reject(new Error('synthetic_frame_bound'));
        return;
      }
      if (text.includes('\n\n'))
        resolve(text.slice(0, text.indexOf('\n\n') + 2));
    });
    response.once('error', reject);
    response.once('aborted', () =>
      reject(new Error('synthetic_first_frame_aborted'))
    );
    response.once('end', () =>
      reject(new Error('synthetic_first_frame_missing'))
    );
  });
}
async function terminalFollowup(
  completeFirst: boolean,
  upstreamReset = false
): Promise<void> {
  const root = process.env.RR_TERMINAL_CANCELLATION_PROBE_ROOT;
  assert(root, 'disposable_probe_root_required');
  const tls = {
    cert: readFileSync(join(root, 'cert.pem')),
    key: readFileSync(join(root, 'key.pem')),
  };
  let nativePosts = 0,
    firstCloses = 0,
    firstEnded = false;
  let resetFirstUpstream: (() => void) | undefined;
  const fixtureFailures: unknown[] = [];
  const diagnostics: GatewayTransportDiagnostic[] = [];
  let resolveFirstClose!: () => void;
  const firstClosed = new Promise<void>((resolve) => {
    resolveFirstClose = resolve;
  });
  const native = createHttpsServer(tls, (request, reply) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/action/v2/account-gateway/responses');
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.headers.accept, 'text/event-stream');
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      assert.equal(Buffer.concat(chunks).toString('utf8'), body);
      nativePosts++;
      assert(nativePosts <= 2, 'unexpected_native_dispatch');
      reply.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-reviewrouter-request-ref': `synthetic-${nativePosts}`,
      });
      if (nativePosts === 1) {
        reply.once('close', () => {
          firstCloses++;
          firstEnded = reply.writableEnded;
          resolveFirstClose();
        });
        resetFirstUpstream = () => reply.destroy();
        reply.write(completeFirst ? completed('first-final') : partial);
        // Hold HTTP EOF open; the scenario coordinates the chosen TCP teardown.
      } else reply.end(completed('second-final'));
    })().catch((error: unknown) => {
      fixtureFailures.push(error);
      reply.destroy();
    });
  });
  let local: LocalGatewayModelTransport | undefined;
  let first: IncomingMessage | undefined, second: IncomingMessage | undefined;
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        native.once('error', reject);
        native.listen(0, '127.0.0.1', resolve);
      }),
      'native-listen'
    );
    const address = native.address();
    assert(address && typeof address !== 'string');
    const transport = new AccountGatewayModelTransport(
      `https://127.0.0.1:${address.port}`,
      () => token,
      (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    );
    local = await bounded(
      startLocalGatewayModelTransport(transport),
      'local-start'
    );
    first = await bounded(post(local), 'first-headers');
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['content-type'], 'text/event-stream');
    assert.equal(
      await bounded(firstFrame(first), 'first-frame'),
      completeFirst ? completed('first-final') : partial
    );
    assert.equal(
      first.complete,
      false,
      'HTTP EOF must still be open before teardown'
    );
    const firstResponse = first;
    const localFirstClosed = new Promise<void>((resolve) =>
      firstResponse.once('close', resolve)
    );
    if (upstreamReset) {
      assert.equal(firstResponse.destroyed, false);
      assert(
        resetFirstUpstream,
        'first upstream fixture reset latch must exist'
      );
      const failureReceived = new Promise<void>((resolve, reject) => {
        firstResponse.once('aborted', resolve);
        firstResponse.once('end', () =>
          reject(new Error('synthetic_reset_became_clean_EOF'))
        );
      });
      resetFirstUpstream(); // No caller abort: provider-side TCP loss after completion.
      await bounded(failureReceived, 'upstream-reset-client-failure');
      assert.equal(firstResponse.aborted, true);
    } else first.destroy(); // Codex-like client stops after its audited terminal frame.
    await bounded(
      Promise.all([localFirstClosed, firstClosed]),
      'first-TCP-teardown'
    );
    assert.equal(firstCloses, 1);
    assert.equal(firstEnded, false, 'fixture did not close upstream HTTP EOF');
    assert.equal(nativePosts, 1);
    second = await bounded(post(local), 'followup-headers');
    const secondResponse = second;
    const chunks: Buffer[] = [];
    await bounded(
      (async () => {
        for await (const chunk of secondResponse) {
          assert(Buffer.isBuffer(chunk));
          chunks.push(chunk);
        }
      })(),
      'followup-body'
    );
    const text = Buffer.concat(chunks).toString('utf8');
    if (completeFirst && !upstreamReset) {
      assert.equal(second.statusCode, 200);
      assert.equal(second.headers['content-type'], 'text/event-stream');
      assert.equal(text, completed('second-final'));
      assert.equal(
        nativePosts,
        2,
        'exactly one native dispatch per sequential local POST'
      );
      assert.equal(transport.lastFailure, undefined);
      assert.equal(local.actualModel(), 'fixture-model');
    } else {
      assert.equal(second.statusCode, 502);
      assert.deepEqual(JSON.parse(text), {
        error: { code: 'relay_unknown', effect: 'effect_unknown' },
      });
      assert.equal(
        nativePosts,
        1,
        'an incomplete abort or upstream loss must not permit another native dispatch'
      );
      assert.deepEqual(transport.lastFailure, {
        code: 'transport',
        effect: 'effect_unknown',
        requestRef: 'synthetic-1',
      });
      assert.equal(local.actualModel(), undefined);
    }
    assert.equal(firstCloses, 1);
    assert.deepEqual(fixtureFailures, []);
    if (upstreamReset)
      assert.equal(
        diagnostics.filter(
          (diagnostic) => diagnostic.stage === 'upstream_stream'
        ).length,
        1,
        'one failed upstream stream must produce exactly one diagnostic'
      );
    if (upstreamReset)
      assert.deepEqual(
        diagnostics.find((diagnostic) => diagnostic.stage === 'upstream_stream')
          ?.streamFacts,
        {
          callerAborted: false,
          upstreamIdleExpired: false,
          completedObserved: true,
        },
        'a provider reset after completion must remain distinct from caller or idle cancellation'
      );
  } finally {
    first?.destroy();
    second?.destroy();
    try {
      if (local) await bounded(local.dispose(), 'local-dispose');
    } finally {
      native.closeAllConnections();
      if (native.listening)
        await bounded(
          new Promise<void>((resolve, reject) => {
            native.close((error) => (error ? reject(error) : resolve()));
          }),
          'native-close'
        );
    }
  }
  assert.equal(native.listening, false);
}

// The consumer timeout is for parsed SSE events, so valid comments must keep
// the native socket alive without resetting that event wait. The fixture sends
// comments every 20s and its first meaningful event after 60s.
const expectedStreamIdleMs = 300_000;
async function parsedEventIdleRegression(): Promise<void> {
  const root = process.env.RR_TERMINAL_CANCELLATION_PROBE_ROOT;
  assert(root, 'disposable_probe_root_required');
  const tls = {
    cert: readFileSync(join(root, 'cert.pem')),
    key: readFileSync(join(root, 'key.pem')),
  };
  const startedAt = Date.now();
  const commentTimes: number[] = [];
  let nativePosts = 0;
  const fixtureFailures: unknown[] = [];
  const native = createHttpsServer(tls, (request, reply) => {
    void (async () => {
      nativePosts++;
      assert.equal(
        nativePosts,
        1,
        'parsed-event regression must make one POST'
      );
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/action/v2/account-gateway/responses');
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      assert.equal(Buffer.concat(chunks).toString('utf8'), body);
      reply.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-reviewrouter-request-ref': 'synthetic-parsed-idle',
      });
      const sendComment = (id: number) => {
        commentTimes.push(Date.now() - startedAt);
        reply.write(`: synthetic comment ${id}\n\n`);
        if (id < 3) setTimeout(() => sendComment(id + 1), 20_000);
      };
      sendComment(1);
      setTimeout(() => {
        assert.equal(nativePosts, 1);
        reply.end(completed('parsed-idle-final'));
      }, 65_000);
    })().catch((error: unknown) => {
      fixtureFailures.push(error);
      reply.destroy();
    });
  });
  let local: LocalGatewayModelTransport | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      native.once('error', reject);
      native.listen(0, '127.0.0.1', resolve);
    });
    const address = native.address();
    assert(address && typeof address !== 'string');
    const transport = new AccountGatewayModelTransport(
      `https://127.0.0.1:${address.port}`,
      () => token
    );
    local = await startLocalGatewayModelTransport(transport);
    const idleSetting = local.configuration.find((line) =>
      line.includes('stream_idle_timeout_ms=')
    );
    assert(idleSetting, 'generated consumer idle configuration is required');
    const idleMatch = idleSetting.match(
      /\bstream_idle_timeout_ms=(\d+)(?=[,}])/u
    );
    assert(idleMatch, 'generated consumer idle value is required');
    const configuredIdleMs = Number(idleMatch[1]);
    assert(Number.isSafeInteger(configuredIdleMs) && configuredIdleMs > 0);
    const response = await post(local, 120_000);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream');
    let raw = '';
    await new Promise<void>((resolve, reject) => {
      // Independently model the consumer wait: comments are ignored, while the
      // first meaningful event satisfies this 300s event timer.
      let eventTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        clearTimeout(eventTimer);
        eventTimer = undefined;
        if (error) reject(error);
        else resolve();
      };
      eventTimer = setTimeout(
        () => finish(new Error('synthetic_parsed_event_idle_timeout')),
        configuredIdleMs
      );
      const onData = (chunk: Buffer) => {
        raw += chunk.toString('utf8');
        if (raw.includes('event: response.completed')) finish();
      };
      response.on('data', onData);
      response.once('error', (error) => finish(error));
      response.once('aborted', () =>
        finish(new Error('synthetic_parsed_event_aborted'))
      );
      response.once('end', () => {
        if (raw.includes('event: response.completed')) finish();
        else finish(new Error('synthetic_parsed_event_missing'));
      });
    });
    const completedAt = Date.now() - startedAt;
    assert.equal(configuredIdleMs, expectedStreamIdleMs);
    assert(completedAt >= 60_000, 'first meaningful event arrived too early');
    assert(
      completedAt < expectedStreamIdleMs,
      'first meaningful event arrived outside the confirmed parsed-event bound'
    );
    assert.equal((raw.match(/: synthetic comment /g) ?? []).length, 3);
    assert.equal(commentTimes.length, 3);
    assert(commentTimes[0] < 30_000);
    for (let index = 1; index < commentTimes.length; index++)
      assert(commentTimes[index] - commentTimes[index - 1] < 30_000);
    assert.equal(nativePosts, 1);
    assert.equal(transport.lastFailure, undefined);
    assert.equal(local.actualModel(), 'fixture-model');
    assert.deepEqual(fixtureFailures, []);
  } finally {
    try {
      if (local) await local.dispose();
    } finally {
      native.closeAllConnections();
      await new Promise<void>((resolve) => native.close(() => resolve()));
    }
  }
  assert.equal(native.listening, false);
}
async function failedResponseDiagnostic(upstream502: boolean): Promise<void> {
  const root = process.env.RR_TERMINAL_CANCELLATION_PROBE_ROOT;
  assert(root);
  const diagnostics: GatewayTransportDiagnostic[] = [];
  let requests = 0;
  const upstreamBody = 'synthetic private body: error code: 502';
  const server = createHttpsServer(
    {
      cert: readFileSync(join(root, 'cert.pem')),
      key: readFileSync(join(root, 'key.pem')),
    },
    (_request, reply) => {
      requests++;
      if (!upstream502) reply.destroy();
      else {
        reply.writeHead(502, { 'content-type': 'text/plain' });
        reply.end(upstreamBody);
      }
    }
  );
  let local: LocalGatewayModelTransport | undefined;
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }),
      'diagnostic-listen'
    );
    const address = server.address();
    assert(address && typeof address !== 'string');
    const observe = (diagnostic: GatewayTransportDiagnostic) => {
      diagnostics.push(diagnostic);
      // Even a failing log sink must not alter the original status/body.
      if (upstream502)
        return Promise.reject(new Error('synthetic private observer error'));
      throw new Error('synthetic private observer error');
    };
    const transport = new AccountGatewayModelTransport(
      `https://127.0.0.1:${address.port}`,
      () => token,
      observe
    );
    local = await bounded(
      startLocalGatewayModelTransport(transport, observe),
      'diagnostic-local'
    );
    const response = await bounded(post(local), 'diagnostic-headers');
    const chunks: Buffer[] = [];
    await bounded(
      (async () => {
        for await (const chunk of response) chunks.push(Buffer.from(chunk));
      })(),
      'diagnostic-body'
    );
    assert.equal(response.statusCode, 502);
    assert.equal(
      Buffer.concat(chunks).toString('utf8'),
      upstream502
        ? upstreamBody
        : '{"error":{"code":"relay_unknown","effect":"effect_unknown"}}'
    );
    assert.equal(requests, 1, 'failed Responses must never be retried');
    if (upstream502)
      assert.deepEqual(diagnostics, [
        {
          stage: 'upstream_headers',
          responseReceived: true,
          httpStatus: 502,
          errorCategory: 'none',
        },
      ]);
    else {
      assert.equal(diagnostics.length, 1);
      for (const diagnostic of diagnostics)
        assert.deepEqual(diagnostic, {
          stage: 'upstream_request',
          responseReceived: false,
          httpStatus: null,
          errorCategory: 'Error',
        });
    }
    for (const privateValue of [
      token,
      upstreamBody,
      '127.0.0.1',
      'synthetic private observer error',
    ])
      assert(
        !JSON.stringify(diagnostics).includes(privateValue),
        'diagnostics must retain only closed fields'
      );
  } finally {
    await local?.dispose();
    await bounded(
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
      'diagnostic-close'
    );
  }
}

async function relaySaturation(
  mode:
    | 'success'
    | 'abort'
    | 'exhausted'
    | 'unknown'
    | 'other'
    | 'malformed'
    | 'referenced'
    | 'headers'
    | 'truncated'
    | 'overbound'
): Promise<void> {
  const root = process.env.RR_TERMINAL_CANCELLATION_PROBE_ROOT;
  assert(root);
  const diagnostics: GatewayTransportDiagnostic[] = [];
  const fixtureFailures: unknown[] = [];
  let requests = 0,
    authorizations = 0,
    forwards = 0,
    now = 0;
  let timersMocked = false;
  let resolveDenied!: () => void;
  const firstDenied = new Promise<void>((resolve) => {
    resolveDenied = resolve;
  });
  let releaseHeaders!: () => void;
  const heldHeaders = new Promise<void>((resolve) => {
    releaseHeaders = resolve;
  });
  const clock =
    mode === 'exhausted'
      ? mock.method(performance, 'now', () => now)
      : undefined;
  const denial =
    mode === 'unknown'
      ? '{"error":{"code":"relay_saturated","effect":"effect_unknown"}}'
      : mode === 'other'
        ? '{"error":{"code":"admission_limited","effect":"not_dispatched"}}'
        : mode === 'malformed'
          ? '{"error":{"code":"relay_saturated","effect":"not_dispatched"}'
          : '{"error":{"code":"relay_saturated","effect":"not_dispatched"}}';
  const server = createHttpsServer(
    {
      cert: readFileSync(join(root, 'cert.pem')),
      key: readFileSync(join(root, 'key.pem')),
    },
    (request, reply) => {
      void (async () => {
        requests++;
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/api/action/v2/account-gateway/responses');
        assert.equal(
          request.headers.authorization,
          `Bearer ${token}-${requests}`
        );
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        assert.equal(
          Buffer.concat(chunks).toString('utf8'),
          body,
          'every POST must retain identical Responses bytes and scope'
        );
        if (mode === 'headers') {
          resolveDenied(); // Real HTTPS request/body barrier; no response headers yet.
          await heldHeaders;
        }
        if (mode === 'headers' || (mode === 'success' && requests === 2)) {
          forwards++;
          reply.writeHead(200, {
            'content-type': 'text/event-stream',
            'x-reviewrouter-request-ref': 'synthetic-after-saturation',
          });
          reply.end(completed('after-saturation'));
        } else {
          if (mode === 'exhausted' && requests === 2) now = 120_000;
          reply.writeHead(503, {
            'content-type': 'application/json',
            ...(['referenced', 'truncated', 'overbound'].includes(mode)
              ? { 'x-reviewrouter-request-ref': 'synthetic-existing' }
              : {}),
            ...(mode === 'truncated'
              ? { 'content-length': String(Buffer.byteLength(denial) + 1) }
              : {}),
          });
          reply.once('finish', resolveDenied);
          reply.end(mode === 'overbound' ? 'N'.repeat(65_537) : denial);
        }
      })().catch((error: unknown) => {
        fixtureFailures.push(error);
        reply.destroy();
      });
    }
  );
  let local: LocalGatewayModelTransport | undefined;
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }),
      'saturation-listen'
    );
    const address = server.address();
    assert(address && typeof address !== 'string');
    const transport = new AccountGatewayModelTransport(
      `https://127.0.0.1:${address.port}`,
      () => `${token}-${++authorizations}`,
      (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    );
    if (mode === 'headers') {
      mock.timers.enable({ apis: ['setTimeout'] });
      timersMocked = true;
      let rejected = false;
      const pending = transport.responses(Buffer.from(body));
      void pending.catch(() => {
        rejected = true;
      });
      await firstDenied;
      mock.timers.tick(31_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        rejected,
        false,
        'successful headers may outlive the 30s denial-body bound'
      );
      releaseHeaders();
      const response = await bounded(pending, 'held-success-headers');
      const chunks: Buffer[] = [];
      await bounded(
        (async () => {
          for await (const chunk of response.body)
            chunks.push(Buffer.from(chunk));
        })(),
        'held-success-body'
      );
      assert.equal(response.httpStatus, 200);
      assert.equal(
        Buffer.concat(chunks).toString('utf8'),
        completed('after-saturation')
      );
      assert.equal(forwards, 1);
      assert.deepEqual(diagnostics, []);
    } else if (mode === 'truncated' || mode === 'overbound') {
      await assert.rejects(
        bounded(transport.responses(Buffer.from(body)), 'referenced-drain')
      );
      assert.equal(transport.lastRequestRef, 'synthetic-existing');
      assert.deepEqual(transport.lastFailure, {
        code: 'transport',
        effect: 'effect_unknown',
        requestRef: 'synthetic-existing',
      });
      await assert.rejects(transport.responses(Buffer.from(body)));
      assert.equal(
        requests,
        1,
        'failed referenced drainage must remain terminal'
      );
      assert.equal(forwards, 0);
    } else if (mode === 'abort') {
      const controller = new AbortController();
      const pending = transport.responses(Buffer.from(body), controller.signal);
      void pending.catch(() => {});
      await bounded(firstDenied, 'saturation-first-denial');
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      await assert.rejects(bounded(pending, 'saturation-abort'));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(
        requests,
        1,
        'abort while waiting must prevent the next POST'
      );
      assert.equal(forwards, 0);
    } else {
      local = await startLocalGatewayModelTransport(transport);
      const response = await bounded(post(local), 'saturation-response');
      const chunks: Buffer[] = [];
      await bounded(
        (async () => {
          for await (const chunk of response) chunks.push(Buffer.from(chunk));
        })(),
        'saturation-body'
      );
      assert.equal(response.statusCode, mode === 'success' ? 200 : 503);
      assert.equal(
        Buffer.concat(chunks).toString('utf8'),
        mode === 'success' ? completed('after-saturation') : denial,
        'no intermediate denial bytes may escape to the CLI'
      );
      assert.equal(
        requests,
        mode === 'success' || mode === 'exhausted' ? 2 : 1
      );
      assert.equal(forwards, mode === 'success' ? 1 : 0);
      if (mode === 'success') {
        assert.equal(transport.lastFailure, undefined);
        assert.equal(local.actualModel(), 'fixture-model');
        assert.deepEqual(
          diagnostics,
          [],
          'transient saturation is not a final warning'
        );
      } else {
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].stage, 'upstream_headers');
        const subsequent = await bounded(post(local), 'saturation-latched');
        subsequent.resume();
        assert.equal(subsequent.statusCode, 502);
        assert.equal(
          requests,
          mode === 'exhausted' ? 2 : 1,
          'a terminal response must never clear inference denial'
        );
      }
    }
    assert.equal(
      authorizations,
      requests,
      'each POST must obtain the current token'
    );
    assert.deepEqual(fixtureFailures, []);
  } finally {
    releaseHeaders();
    if (timersMocked) mock.timers.reset();
    await local?.dispose();
    server.closeAllConnections();
    if (server.listening)
      await bounded(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        ),
        'saturation-close'
      );
    clock?.mock.restore();
  }
}
// Same typed file becomes a compiled child observer. Node --test consumes file
// arguments itself, so the isolated child's --probe marker travels in its env.
if (process.env.RR_TERMINAL_CANCELLATION_PROBE === '--probe') {
  nodeTest(
    'successful headers retain the original request deadline beyond 30s',
    { timeout: 20_000 },
    () => relaySaturation('headers')
  );
  nodeTest(
    'referenced denial drainage failures retain same-operation readback',
    { timeout: 20_000 },
    async () => {
      for (const mode of ['truncated', 'overbound'] as const)
        await relaySaturation(mode);
    }
  );
  nodeTest(
    'positive relay saturation waits for one identical authorized POST and SSE',
    { timeout: 20_000 },
    () => relaySaturation('success')
  );
  nodeTest(
    'caller abort while saturated prevents another POST',
    { timeout: 20_000 },
    () => relaySaturation('abort')
  );
  nodeTest(
    'persistent saturation exhausts the finite monotonic wait budget',
    { timeout: 20_000 },
    () => relaySaturation('exhausted')
  );
  nodeTest(
    'non-attested 503 failures remain one attempt and terminal',
    { timeout: 20_000 },
    async () => {
      for (const mode of [
        'unknown',
        'other',
        'malformed',
        'referenced',
      ] as const)
        await relaySaturation(mode);
    }
  );
  for (const upstream502 of [false, true])
    nodeTest(
      upstream502
        ? 'upstream 502 is forwarded unchanged with received-response diagnostic'
        : 'local preheaders failure retains synthetic 502 with no-response diagnostic',
      { timeout: 20_000 },
      () => failedResponseDiagnostic(upstream502)
    );
  nodeTest(
    'completed SSE then client TCP close permits one sequential followup',
    { timeout: 20_000 },
    async () => {
      await terminalFollowup(true);
    }
  );
  nodeTest(
    'incomplete SSE then client TCP close remains denied without native replay',
    { timeout: 20_000 },
    async () => {
      await terminalFollowup(false);
    }
  );
  nodeTest(
    'completed SSE then unsolicited upstream TCP reset remains denied without native replay',
    { timeout: 20_000 },
    async () => {
      await terminalFollowup(true, true);
    }
  );
  nodeTest(
    'parsed SSE comments keep transport alive until the 60-300s completion event',
    { timeout: 90_000 },
    async () => {
      await parsedEventIdleRegression();
    }
  );
} else {
  test('real TLS/HTTP terminal cancellation permits only the completed client followup', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'reviewrouter-terminal-cancellation-test-')
    );
    const certificate = join(root, 'cert.pem'),
      key = join(root, 'key.pem');
    const opensslConfig = join(root, 'openssl.cnf');
    const observer = join(root, 'terminal-probe.cjs');
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
            RR_TERMINAL_CANCELLATION_PROBE: '--probe',
            RR_TERMINAL_CANCELLATION_PROBE_ROOT: root,
          },
        }
      );
      expect(result.stdout).toMatch(/# tests 12\b/);
      expect(result.stdout).toMatch(/# pass 12\b/);
      expect(result.stdout).toMatch(/# fail 0\b/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
}
