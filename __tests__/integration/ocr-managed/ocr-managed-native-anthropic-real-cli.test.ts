/** Real rr.6 binary against native Messages fixtures, never a paid provider. */
import { execFileSync } from 'child_process';
import { createServer } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildOcrChildEnvironment,
  buildOcrManagedConfigJson,
  buildOcrReviewArgv,
} from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';
import {
  buildOcrControlledRuleText,
  runOcrReviewProcess,
} from '../../../src/review-orchestration/infrastructure/ocr-review-invocation-adapter';
import {
  classifyOcrReviewOutcome,
  parseOcrNativeReviewResult,
} from '../../../src/review-orchestration/infrastructure/ocr-review-outcome-contract';

const binary =
  process.env.REVIEWROUTER_OCR_BINARY ??
  path.resolve(__dirname, '../../../tools/ocr/out/opencodereview');
let available = false;
try {
  available = execFileSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).includes('1.13.1-rr.6');
} catch {
  /* Optional build artifact; required jobs fail explicitly below. */
}
if (!available && process.env.REVIEWROUTER_OCR_REQUIRED === '1')
  throw new Error('required_managed_native_ocr_binary_unavailable');
const describeNative = available ? describe : describe.skip;
const capability = 'c'.repeat(64);
const qualifiedModels = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
] as const;

function git(repo: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=rr-native-fixture',
      '-c',
      'user.email=fixture@test.invalid',
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
  ).trim();
}

async function scenario(malformed: boolean, model: string) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ocr-native-'));
  const repo = path.join(workspace, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(
    path.join(repo, 'calc.ts'),
    'export function add(a: number, b: number) { return a + b; }\n'
  );
  git(repo, 'add', 'calc.ts');
  git(repo, 'commit', '-qm', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(
    path.join(repo, 'calc.ts'),
    'export function add(a: number, b: number) { return a - b; }\n'
  );
  git(repo, 'commit', '-qam', 'head');
  const headSha = git(repo, 'rev-parse', 'HEAD');
  const requests: Array<{
    path: string;
    authorization: string | undefined;
    apiKey: string | string[] | undefined;
    body: Record<string, unknown>;
  }> = [];
  let mainTurn = 0;
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'],
        body,
      });
      const tools = (body.tools ?? []).map(
        (tool: { name: string }) => tool.name
      );
      let content: Array<Record<string, unknown>>;
      let stopReason: string;
      if (tools.includes('task_done')) {
        mainTurn++;
        content = [
          {
            type: 'tool_use',
            id: `tool_${requests.length}`,
            name: mainTurn === 1 ? 'code_comment' : 'task_done',
            input:
              mainTurn === 1
                ? {
                    comments: [
                      {
                        path: 'calc.ts',
                        content:
                          'add() subtracts b, so add(2, 3) returns -1 instead of 5. Restore addition.',
                        severity: 'high',
                      },
                    ],
                  }
                : {},
          },
        ];
        stopReason = 'tool_use';
      } else if (tools.includes('approve_all_comments')) {
        content = [
          {
            type: 'tool_use',
            id: `tool_${requests.length}`,
            name: 'approve_all_comments',
            input: {},
          },
        ];
        stopReason = 'tool_use';
      } else {
        content = [
          {
            type: 'text',
            text: 'The affected expression is on line 1 of calc.ts.',
          },
        ];
        stopReason = 'end_turn';
      }
      reply.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model,
          content,
          ...(malformed ? {} : { stop_reason: stopReason }),
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
          },
        })
      );
    });
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture_loopback_unavailable');
    const home = path.join(workspace, 'home');
    fs.mkdirSync(path.join(home, '.opencodereview'), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(home, '.opencodereview/config.json'),
      buildOcrManagedConfigJson({
        baseUrl: `http://127.0.0.1:${address.port}`,
        rawCapability: capability,
        model,
        protocol: 'anthropic-messages',
        modelReasoningEffort: 'high',
        language: 'en',
        limits: { requestTimeoutSec: 10 },
      }),
      { mode: 0o600 }
    );
    const rulePath = path.join(workspace, 'rule.json');
    fs.writeFileSync(
      rulePath,
      buildOcrControlledRuleText({ language: 'en', assignedPaths: ['calc.ts'] })
    );
    const outputPath = path.join(workspace, 'result.json');
    const result = await runOcrReviewProcess({
      binaryPath: binary,
      argv: buildOcrReviewArgv({
        binaryPath: binary,
        repoPath: repo,
        mergeBaseSha: baseSha,
        headSha,
        model,
        rulePath,
        backgroundPath: null,
        outputPath,
        effort: 'medium',
        limits: { requestTimeoutSec: 10, maxTokens: 32768, timeoutMinutes: 1 },
        preview: false,
      }),
      env: buildOcrChildEnvironment({
        homeDirectory: home,
        capabilityAuthorization: `Bearer ${capability}`,
        path: process.env.PATH,
      }),
      cwd: workspace,
      signal: AbortSignal.timeout(60_000),
    });
    const raw = fs.existsSync(outputPath)
      ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      : undefined;
    return {
      requests,
      result,
      raw,
      admission: { baseSha, mergeBaseSha: baseSha, headSha },
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

describeNative('managed native Anthropic real OCR binary', () => {
  it.each(qualifiedModels)(
    'emits a real managed finding with exact qualified model %s and effort',
    async (model) => {
      const proof = await scenario(false, model);
      expect(proof.result.closed).toBe(true);
      expect(proof.result.exitCode).toBe(0);
      expect(proof.requests.length).toBeGreaterThanOrEqual(3);
      for (const request of proof.requests) {
        expect(request.path).toBe('/v1/messages');
        expect(request.authorization).toBe(`Bearer ${capability}`);
        expect(request.apiKey).toBeUndefined();
        expect(request.body).toMatchObject({
          model,
          output_config: { effort: 'high' },
        });
        expect(request.body).not.toHaveProperty('input');
        expect(request.body).not.toHaveProperty('service_tier');
        expect(request.body.stream).not.toBe(true);
      }
      const native = parseOcrNativeReviewResult(proof.raw, proof.admission);
      expect(native.comments).toHaveLength(1);
      expect(native.comments[0]).toMatchObject({
        path: 'calc.ts',
        severity: 'high',
      });
      expect(native.comments[0].content).toContain('add() subtracts b');
      expect(classifyOcrReviewOutcome(native.outcome).partial).toBe(false);
      expect(native.usage.inputTokens).toBeGreaterThan(0);
    },
    90_000
  );

  it('rejects a missing native terminal without replaying the provider request', async () => {
    const proof = await scenario(true, qualifiedModels[0]);
    expect(proof.result.closed).toBe(true);
    expect(proof.requests).toHaveLength(1);
    if (proof.raw) {
      const native = parseOcrNativeReviewResult(proof.raw, proof.admission);
      expect(classifyOcrReviewOutcome(native.outcome).partial).toBe(true);
      expect(native.comments).toHaveLength(0);
    } else expect(proof.result.exitCode).not.toBe(0);
  }, 90_000);
});
