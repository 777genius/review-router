import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as nodeTest } from 'node:test';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import {
  AccountGatewayModelTransport,
  LOCAL_MODEL_CAPABILITY_ENV,
  startLocalGatewayModelTransport,
  type LocalGatewayModelTransport,
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
function post(local: LocalGatewayModelTransport): Promise<IncomingMessage> {
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
    request.setTimeout(4000, () =>
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
      () => token
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
// Same typed file becomes a compiled child observer. Node --test consumes file
// arguments itself, so the isolated child's --probe marker travels in its env.
if (process.env.RR_TERMINAL_CANCELLATION_PROBE === '--probe') {
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
} else {
  test('real TLS/HTTP terminal cancellation permits only the completed client followup', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'reviewrouter-terminal-cancellation-test-')
    );
    const certificate = join(root, 'cert.pem'),
      key = join(root, 'key.pem');
    const observer = join(root, 'terminal-probe.cjs');
    const execute = promisify(execFile);
    try {
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
        { timeout: 10_000 }
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
          timeout: 30_000,
          killSignal: 'SIGKILL',
          maxBuffer: 1_048_576,
          env: {
            PATH: process.env.PATH,
            NODE_PATH: resolve('node_modules'),
            NODE_EXTRA_CA_CERTS: certificate,
            RR_TERMINAL_CANCELLATION_PROBE: '--probe',
            RR_TERMINAL_CANCELLATION_PROBE_ROOT: root,
          },
        }
      );
      expect(result.stdout).toMatch(/# tests 3\b/);
      expect(result.stdout).toMatch(/# pass 3\b/);
      expect(result.stdout).toMatch(/# fail 0\b/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
}
