import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AccountGatewayModelTransport,
  startLocalGatewayModelTransport,
} from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  canonicalJson,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import { startContextToolsBroker } from '../../../src/context-tools/broker';
import {
  parseContextToolsPlan,
  contextToolsError,
} from '../../../src/context-tools/contract';

const binary = process.env.REVIEWROUTER_TEST_APPROVED_OCR_BINARY;
const nativeTest = binary ? test : test.skip;
/** This qualification uses a synthetic local model endpoint and never reaches a provider. */
nativeTest.each([true, false])(
  'approved rr.3 native MCP list precedes its first grouping request; valid capability=%s',
  async (valid) => {
    expect(
      createHash('sha256').update(fs.readFileSync(binary!)).digest('hex')
    ).toBe('2f62d6fbb326e74d0fe9377f0224f1b56520bcefee688c58073fa1a30e45f1c9');
    fs.mkdirSync('tmp', { recursive: true });
    const scratch = fs.mkdtempSync(path.resolve('tmp/native-mcp-'));
    const repo = path.join(scratch, 'repo');
    const home = path.join(scratch, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(home, '.opencodereview'), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(home, 0o700);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'iliya',
          GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
          GIT_COMMITTER_NAME: 'iliya',
          GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
        },
      }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'test.ts'), 'export const n=1;\n');
    git('add', '.');
    git('commit', '-qm', 'test: baseline');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'test.ts'), 'export const n=2;\n');
    git('add', '.');
    git('commit', '-qm', 'test: change');
    const head = git('rev-parse', 'HEAD');
    const preimage = {
      version: 1,
      builtinTools: ['repository.docs.read'],
      servers: [],
      limits: {
        startupTimeoutMs: 30000,
        callTimeoutMs: 30000,
        responseBytes: 1048576,
        maxCalls: 128,
      },
    };
    const plan = parseContextToolsPlan(
      JSON.stringify({
        ...preimage,
        planDigest: `sha256:${sha256(canonicalJson(preimage))}`,
      })
    );
    const broker = await startContextToolsBroker({
      plan,
      mask: () => undefined,
      deadlineMs: Date.now() + 15000,
      builtins: {
        'repository.docs.read': {
          definition: { name: 'docs', inputSchema: { type: 'object' } },
          call: async () => ({
            content: [{ type: 'text', text: 'MCP_NATIVE_CONTEXT_USED' }],
          }),
        },
      },
    });
    let firstModelReceipt: ReturnType<typeof broker.receipt> | undefined;
    let requestCount = 0;
    let nativeDiagnostic = '';
    let sentContextCall = false;
    let stubModelRequests = 0;
    let resultUsed = false;
    let nativeExitCode: number | null = null;
    const controller = new AbortController();
    const upstream = new AccountGatewayModelTransport(
      'https://api.reviewrouter.org',
      () => 'synthetic-run-token'
    );
    const dispatch = jest
      .spyOn(upstream, 'responses')
      .mockImplementation(async (bytes) => {
        const chunks: Buffer[] = [];
        if (bytes instanceof Uint8Array) chunks.push(Buffer.from(bytes));
        else for await (const chunk of bytes) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          tools?: Array<{ name?: string }>;
          input?: unknown;
        };
        if (JSON.stringify(body.input).includes('MCP_NATIVE_CONTEXT_USED'))
          resultUsed = true;
        const available =
          body.tools?.some((tool) => tool.name === 'rr_repository_docs_read') ??
          false;
        const name =
          available && !sentContextCall
            ? 'rr_repository_docs_read'
            : 'task_done';
        if (name === 'rr_repository_docs_read') sentContextCall = true;
        const index = ++stubModelRequests;
        const payload = {
          type: 'response.completed',
          response: {
            id: `resp_${index}`,
            object: 'response',
            status: 'completed',
            model: 'test-model',
            output: [
              {
                type: 'function_call',
                id: `fc_${index}`,
                call_id: `call_${index}`,
                name,
                arguments: '{}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        };
        return {
          httpStatus: 200,
          contentType: 'text/event-stream',
          body: Readable.from([
            `event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`,
          ]),
          cancel: () => undefined,
        };
      });
    const model = await startLocalGatewayModelTransport(upstream);
    model.setContextToolsGuard!(() => {
      requestCount++;
      firstModelReceipt ??= broker.receipt();
      if (!broker.receipt().nativeConnected) {
        controller.abort();
        throw contextToolsError('required_context_unavailable');
      }
    });
    fs.writeFileSync(
      path.join(home, '.opencodereview', 'config.json'),
      JSON.stringify({
        provider: 'reviewrouter',
        custom_providers: {
          reviewrouter: {
            protocol: 'openai-responses',
            url: model.baseUrl,
            api_key: model.environment.REVIEWROUTER_LOCAL_MODEL_TOKEN!.slice(
              'Bearer '.length
            ),
            model: 'test-model',
            timeout_sec: 5,
          },
        },
        telemetry: { enabled: false },
        mcp_servers: {
          reviewrouter_context: {
            type: 'remote',
            url: broker.config.url,
            headers: {
              Authorization: `Bearer ${valid ? broker.config.capability : 'wrong'}`,
            },
            tools: broker.config.tools,
          },
        },
      }),
      { mode: 0o600 }
    );
    const rule = path.join(scratch, 'rule.json');
    fs.writeFileSync(
      rule,
      JSON.stringify({
        merge_system_rule: true,
        include: ['test.ts'],
        rules: [{ id: 'test', content: 'Review introduced changes.' }],
      })
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          binary!,
          [
            'review',
            '--reviewrouter-managed',
            '--repo',
            repo,
            '--from',
            base,
            '--to',
            head,
            '--provider',
            'reviewrouter',
            '--model',
            'test-model',
            '--rule',
            rule,
            '--concurrency',
            '1',
            '--format',
            'json',
            '--audience',
            'agent',
            '--output',
            path.join(scratch, 'result.json'),
          ],
          {
            env: {
              PATH: process.env.PATH,
              HOME: home,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_TERMINAL_PROMPT: '0',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
            signal: controller.signal,
          }
        );
        child.stderr.on('data', (chunk: Buffer) => {
          nativeDiagnostic = (nativeDiagnostic + chunk.toString()).slice(-4096);
        });
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('native grouping deadline'));
        }, 12000);
        child.once('error', (error) => {
          if (error.name !== 'AbortError') {
            clearTimeout(timeout);
            reject(error);
          }
        });
        child.once('close', (code) => {
          nativeExitCode = code;
          clearTimeout(timeout);
          resolve();
        });
      });
      if (!requestCount)
        throw new Error(
          nativeDiagnostic.replaceAll(broker.config.capability, '[CAPABILITY]')
        );
      expect(requestCount).toBeGreaterThanOrEqual(1);
      expect(firstModelReceipt?.nativeConnected).toBe(valid);
      expect(firstModelReceipt?.calls).toBe(0);
      if (valid) {
        expect(nativeExitCode).toBe(0);
        expect(sentContextCall).toBe(true);
        expect(resultUsed).toBe(true);
        expect(broker.receipt()).toMatchObject({
          nativeConnected: true,
          calls: 1,
          hadFailure: false,
        });
        expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
      } else {
        expect(model.requestCount?.()).toBe(0);
        expect(dispatch).not.toHaveBeenCalled();
      }
      if (!valid)
        expect(model.failureFact()).toEqual({
          code: 'context_tools_unavailable',
          effect: 'not_dispatched',
        });
    } finally {
      await broker.close();
      await model.dispose();
      dispatch.mockRestore();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
  20000
);
