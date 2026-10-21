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

// Red: a transient request-stage failure or a ref-less edge rejection burns the
// whole provider run (social-monitor PR 573 class). Referenced responses and
// started streams stay terminal: unknown effects are never replayed.
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

type ProbeMode =
  | 'edge-rejection-recovery'
  | 'connection-failure-recovery'
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
        requests++;
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/api/action/v2/account-gateway/responses');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        assert.equal(Buffer.concat(chunks).toString('utf8'), body);
        if (mode === 'connection-failure-recovery' && requests === 1) {
          request.socket.destroy();
          return;
        }
        if (mode === 'mid-stream-terminal') {
          reply.writeHead(200, {
            'content-type': 'text/event-stream',
            'x-reviewrouter-request-ref': 'synthetic-mid-stream',
          });
          reply.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n');
          // Destroy only after the started stream reached the consumer; a
          // request-stage death would be a different (retryable) case.
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
        if (mode === 'edge-rejection-recovery' && requests === 1) {
          reply.writeHead(502, { 'content-type': 'text/plain' });
          reply.end('synthetic edge rejection');
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
      }
    );
    const response = await bounded(
      transport.responses(Buffer.from(body)),
      'transient-responses'
    );
    const text = await bounded(drain(response.body), 'transient-drain');
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
      'a transient request-stage failure or ref-less edge rejection must retry'
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
    'a ref-less 502 edge rejection is re-dispatched and recovers the stream',
    { timeout: 20_000 },
    () => transientRetry('edge-rejection-recovery')
  );
  nodeTest(
    'a request-stage connection failure is re-dispatched and recovers the stream',
    { timeout: 20_000 },
    () => transientRetry('connection-failure-recovery')
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
      expect(result.stdout).toMatch(/# tests 4\b/);
      expect(result.stdout).toMatch(/# pass 4\b/);
      expect(result.stdout).toMatch(/# fail 0\b/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
}
