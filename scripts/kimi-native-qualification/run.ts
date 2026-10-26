/** Credential-free native-client qualification. No live provider is contacted. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import {
  assertApprovedReviewAgentBinary,
  assertApprovedReviewAgentVersion,
  bundledReviewAgentForTransport,
} from '../../src/control-plane/approved-review-agent';
import { prepareCodexCliBeforeAuthRead } from '../../src/codex-oauth/codex-cli';
import gptModel from '../../src/codex-oauth/gpt-5.6-sol-model-0.147.0.json';

type JsonRecord = Record<string, unknown>;
type Mode = 'exec' | 'app-server';
type CapturedRequest = Readonly<{
  method: string;
  pathname: string;
  body: JsonRecord;
}>;
type ScenarioReceipt = Readonly<{
  mode: Mode;
  requests: number;
  functionRoundTrip: boolean;
  reasoningControlsAbsent: boolean;
  reasoningEnvelopes: readonly string[];
  omittedServiceTier: boolean;
  functionLeavesOnly: boolean;
  toolEnvelopes: readonly Readonly<{
    topLevelTypes: readonly string[];
    functionLeaves: readonly string[];
  }>[];
  exitCode: number | null;
}>;

const model = 'k3-256k';
const syntheticCapability = 'Bearer public-kimi-native-qualification-fixture';
const finalOutput = '{"findings":[],"revalidations":[]}';
const disabledFeatures = [
  'shell_tool',
  'unified_exec',
  'browser_use',
  'computer_use',
  'js_repl',
  'tool_search',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'hooks',
  'memories',
  'external_agent_memory_import',
  'chronicle',
  'web_search_request',
];

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(text: string): JsonRecord {
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error('fixture_json_object_required');
  return value;
}

function event(type: string, value: JsonRecord): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function containsFunctionOutput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFunctionOutput);
  if (!record(value)) return false;
  if (
    value.type === 'function_call_output' &&
    value.call_id === 'qualification-call' &&
    JSON.stringify(value.output).includes('KIMI_NATIVE_FIXTURE_READ')
  )
    return true;
  return Object.values(value).some(containsFunctionOutput);
}

function containsFinalOutput(value: unknown): boolean {
  if (!record(value)) return false;
  const item =
    value.type === 'item.completed' && record(value.item)
      ? value.item
      : value.method === 'item/completed' &&
          record(value.params) &&
          record(value.params.item)
        ? value.params.item
        : undefined;
  if (
    !item ||
    !['agent_message', 'agentMessage'].includes(String(item.type)) ||
    typeof item.text !== 'string'
  )
    return false;
  const parsed: unknown = JSON.parse(item.text);
  assert.deepEqual(parsed, { findings: [], revalidations: [] });
  return true;
}

function functionTool(value: unknown): value is JsonRecord & {
  type: 'function';
  name: string;
  parameters: JsonRecord;
} {
  return (
    record(value) &&
    value.type === 'function' &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    record(value.parameters)
  );
}

/** Namespace is routing metadata; every executable leaf must remain a function. */
function functionToolEnvelope(value: unknown): boolean {
  if (functionTool(value)) return true;
  return (
    record(value) &&
    value.type === 'namespace' &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.description === 'string' &&
    Object.keys(value).every((key) =>
      ['type', 'name', 'description', 'tools'].includes(key)
    ) &&
    Array.isArray(value.tools) &&
    value.tools.length > 0 &&
    value.tools.every(functionTool)
  );
}

function toolEnvelopeReceipt(body: JsonRecord): Readonly<{
  topLevelTypes: readonly string[];
  functionLeaves: readonly string[];
}> {
  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : [];
  return {
    topLevelTypes: [
      ...new Set(
        tools.flatMap((tool) =>
          record(tool) && typeof tool.type === 'string' ? [tool.type] : []
        )
      ),
    ],
    functionLeaves: tools.flatMap((tool) => {
      if (functionTool(tool)) return [tool.name];
      if (
        !record(tool) ||
        !Array.isArray(tool.tools) ||
        typeof tool.name !== 'string'
      )
        return [];
      const members: unknown[] = tool.tools;
      return members.flatMap((member) =>
        functionTool(member) ? [`${tool.name}.${member.name}`] : []
      );
    }),
  };
}

/** Bounded public fixture metadata; no provider/system instructions are copied. */
function catalog(): JsonRecord {
  return {
    models: [
      {
        ...gptModel,
        slug: model,
        display_name: 'Kimi Code qualification fixture',
        description: 'Public synthetic native-client qualification model.',
        base_instructions:
          'Review the synthetic input using the declared function.',
        model_messages: null,
        default_reasoning_level: null,
        supported_reasoning_levels: [],
        supports_reasoning_summary_parameter: false,
        supports_reasoning_summaries: false,
        default_reasoning_summary: 'none',
        support_verbosity: false,
        apply_patch_tool_type: null,
        tool_mode: 'direct',
        use_responses_lite: false,
        supports_search_tool: false,
        experimental_supported_tools: [],
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
        input_modalities: ['text'],
        context_window: 256000,
        max_context_window: 256000,
      },
    ],
  };
}

async function scenario(
  binary: string,
  out: string,
  mode: Mode
): Promise<ScenarioReceipt> {
  const work = path.join(out, mode);
  const home = path.join(work, 'home');
  const codexHome = path.join(work, 'codex-home');
  const workspace = path.join(work, 'workspace');
  for (const directory of [home, codexHome, workspace])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const toolReceipt = path.join(work, 'tool-calls.txt');
  const catalogPath = path.join(work, 'catalog.json');
  await writeFile(toolReceipt, '', { mode: 0o600 });
  await writeFile(catalogPath, JSON.stringify(catalog()) + '\n', {
    mode: 0o600,
  });
  const requests: CapturedRequest[] = [];
  let transportFailure: Error | undefined;
  let functionRoundTrip = false;
  const server = createServer((request, reply) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/responses');
      assert.equal(request.headers.authorization, syntheticCapability);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        assert(size <= 1024 * 1024, 'native_request_bound');
        chunks.push(bytes);
      }
      const body = parseRecord(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: request.method, pathname: request.url, body });
      await writeFile(
        path.join(work, 'requests.json'),
        JSON.stringify(requests, null, 2) + '\n',
        { mode: 0o600 }
      );
      assert.equal(body.model, model);
      assert(
        body.reasoning === undefined ||
          (record(body.reasoning) && Object.keys(body.reasoning).length === 0),
        'reasoning_controls_must_be_absent'
      );
      assert(
        !Object.hasOwn(body, 'service_tier'),
        'service_tier_must_be_omitted'
      );
      assert(
        Array.isArray(body.tools) && body.tools.length > 0,
        'function_tools_required'
      );
      const tools: unknown[] = body.tools;
      assert(tools.every(functionToolEnvelope), 'function_leaves_only');
      const namespace = tools.find(
        (tool) =>
          record(tool) &&
          tool.type === 'namespace' &&
          tool.name === 'mcp__reviewrouter'
      );
      assert(
        record(namespace) && Array.isArray(namespace.tools),
        'fixture_namespace_missing'
      );
      const members: unknown[] = namespace.tools;
      const selected = members.find(
        (tool) => functionTool(tool) && tool.name === 'read_fixture'
      );
      assert(functionTool(selected), 'fixture_function_missing');
      assert(requests.length <= 2, 'native_dispatch_count_exceeded');
      if (requests.length === 2) {
        functionRoundTrip = containsFunctionOutput(body.input);
        assert(functionRoundTrip, 'native_function_output_missing');
      }
      await writeFile(
        path.join(work, 'requests.json'),
        JSON.stringify(requests, null, 2) + '\n',
        { mode: 0o600 }
      );
      const responseId = `qualification-response-${requests.length}`;
      const item =
        requests.length === 1
          ? {
              type: 'function_call',
              id: 'qualification-function',
              call_id: 'qualification-call',
              namespace: 'mcp__reviewrouter',
              name: selected.name,
              arguments: '{}',
              status: 'completed',
            }
          : {
              type: 'message',
              id: 'qualification-message',
              role: 'assistant',
              status: 'completed',
              content: [
                { type: 'output_text', text: finalOutput, annotations: [] },
              ],
            };
      reply.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      reply.write(
        event('response.created', {
          response: {
            id: responseId,
            object: 'response',
            status: 'in_progress',
            model,
            output: [],
          },
        })
      );
      reply.write(
        event('response.output_item.added', { output_index: 0, item })
      );
      reply.write(
        event('response.output_item.done', { output_index: 0, item })
      );
      reply.end(
        event('response.completed', {
          response: {
            id: responseId,
            object: 'response',
            status: 'completed',
            model,
            output: [item],
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              total_tokens: 13,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        })
      );
    })().catch((error: unknown) => {
      transportFailure =
        error instanceof Error
          ? error
          : new Error('native_transport_assertion_failed');
      reply.writeHead(400, { 'content-type': 'application/json' });
      reply.end('{"error":{"message":"qualification_assertion_failed"}}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const configuration = [
    'model_provider="reviewrouter_kimi"',
    `model_providers={reviewrouter_kimi={name="ReviewRouter Kimi Code fixture",base_url="http://127.0.0.1:${address.port}",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=10000,env_http_headers={Authorization="REVIEWROUTER_LOCAL_MODEL_TOKEN"}}}`,
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
    'cli_auth_credentials_store="ephemeral"',
    'agents.enabled=false',
    'web_search="disabled"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'project_doc_max_bytes=0',
    `mcp_servers={reviewrouter={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(path.join(__dirname, 'mcp-fixture.js'))},${JSON.stringify(toolReceipt)}],required=true,enabled_tools=["read_fixture"]}}`,
  ];
  await writeFile(
    path.join(codexHome, 'config.toml'),
    configuration.join('\n') + '\n',
    { mode: 0o600 }
  );
  const args =
    mode === 'exec'
      ? [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--json',
          '--model',
          model,
        ]
      : ['app-server', '--stdio', '--strict-config'];
  for (const feature of disabledFeatures) args.push('--disable', feature);
  const prompt = `Read the fixture function once, then return exactly ${finalOutput}.`;
  if (mode === 'exec') args.push(prompt);
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    REVIEWROUTER_LOCAL_MODEL_TOKEN: syntheticCapability,
    CI: 'true',
  };
  const child = spawn(binary, args, {
    cwd: workspace,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdinFailure: Error | undefined;
  child.stdin.on('error', () => {
    stdinFailure ??= new Error(`native_${mode}_stdin_failed`);
    child.kill('SIGKILL');
  });
  if (mode === 'exec') child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const close = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  let protocolFailure: Error | undefined;
  try {
    if (mode === 'app-server') {
      let requestId = 0;
      const pending = new Map<
        number,
        { resolve(value: JsonRecord): void; reject(error: Error): void }
      >();
      let finishTurn: (() => void) | undefined;
      let rejectTurn: ((error: Error) => void) | undefined;
      const completed = new Promise<void>((resolve, reject) => {
        finishTurn = resolve;
        rejectTurn = reject;
      });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const message = parseRecord(line);
          if (typeof message.id === 'number') {
            const waiting = pending.get(message.id);
            if (!waiting) return;
            pending.delete(message.id);
            if (record(message.result)) waiting.resolve(message.result);
            else waiting.reject(new Error('native_rpc_error'));
          } else if (message.method === 'turn/completed') {
            if (
              !record(message.params) ||
              !record(message.params.turn) ||
              message.params.turn.status !== 'completed'
            )
              rejectTurn?.(new Error('native_turn_failed'));
            else finishTurn?.();
          }
        } catch (error) {
          rejectTurn?.(
            error instanceof Error ? error : new Error('native_rpc_invalid')
          );
        }
      });
      child.once('close', () => {
        for (const waiting of pending.values())
          waiting.reject(new Error('native_rpc_process_closed'));
        rejectTurn?.(new Error('native_turn_process_closed'));
      });
      const request = (
        method: string,
        params: JsonRecord
      ): Promise<JsonRecord> => {
        const id = ++requestId;
        const response = new Promise<JsonRecord>((resolve, reject) =>
          pending.set(id, { resolve, reject })
        );
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
        );
        return response;
      };
      // Attach immediately: process failure must not create an unhandled rejection.
      const turnResult = completed.catch((error: unknown) => {
        throw error;
      });
      void turnResult.catch(() => undefined);
      await request('initialize', {
        clientInfo: {
          name: 'review_router_action',
          title: 'ReviewRouter native qualification',
          version: '1',
        },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
      const started = await request('thread/start', {
        model,
        allowProviderModelFallback: false,
        cwd: workspace,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        ephemeral: true,
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        experimentalRawEvents: true,
      });
      assert(record(started.thread) && typeof started.thread.id === 'string');
      assert(
        started.reasoningEffort === null ||
          started.reasoningEffort === undefined,
        'native_reasoning_echo_must_be_absent'
      );
      await request('turn/start', {
        threadId: started.thread.id,
        clientUserMessageId: 'qualification-turn',
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        environments: [],
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      });
      await turnResult;
      child.stdin.end();
    }
    const exitCode = await close;
    if (stdinFailure) throw stdinFailure;
    if (transportFailure) throw transportFailure;
    assert.equal(exitCode, 0, `native_${mode}_failed: ${stderr.slice(-2000)}`);
    assert.equal(requests.length, 2);
    assert(functionRoundTrip);
    assert.equal((await readFile(toolReceipt, 'utf8')).trim(), 'read_fixture');
    assert(
      stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => {
          const value: unknown = JSON.parse(line);
          return containsFinalOutput(value);
        }),
      'native_final_json_missing'
    );
    await assert.rejects(stat(path.join(codexHome, 'auth.json')), {
      code: 'ENOENT',
    });
    return {
      mode,
      requests: requests.length,
      functionRoundTrip,
      reasoningControlsAbsent: true,
      reasoningEnvelopes: requests.map(({ body }) =>
        body.reasoning === undefined ? 'omitted' : 'empty_object'
      ),
      omittedServiceTier: true,
      functionLeavesOnly: true,
      toolEnvelopes: requests.map(({ body }) => toolEnvelopeReceipt(body)),
      exitCode,
    };
  } catch (error) {
    protocolFailure =
      stdinFailure ??
      (error instanceof Error
        ? error
        : new Error('native_qualification_failed'));
    throw protocolFailure;
  } finally {
    child.kill('SIGKILL');
    await close.catch(() => undefined);
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writeFile(path.join(work, 'stdout.jsonl'), stdout, { mode: 0o600 });
    await writeFile(path.join(work, 'stderr.txt'), stderr, { mode: 0o600 });
    await writeFile(
      path.join(work, 'scenario.json'),
      JSON.stringify(
        {
          mode,
          requests: requests.length,
          functionRoundTrip,
          failure: protocolFailure?.message ?? null,
          observed: requests.map(({ body }) => ({
            model: body.model ?? null,
            reasoningPresent: Object.hasOwn(body, 'reasoning'),
            reasoning: body.reasoning ?? null,
            serviceTierPresent: Object.hasOwn(body, 'service_tier'),
            serviceTier: body.service_tier ?? null,
            tools: body.tools ?? null,
          })),
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    );
    if (protocolFailure)
      await writeFile(
        path.join(work, 'failure.txt'),
        protocolFailure.message + '\n',
        { mode: 0o600 }
      );
  }
}

async function main(): Promise<void> {
  const out = path.resolve(process.argv[2] ?? 'tmp/kimi-native-qualification');
  await mkdir(out, { recursive: true, mode: 0o700 });
  const approved = bundledReviewAgentForTransport('provider_api');
  const override = process.argv[3];
  const prepared = override
    ? { binaryPath: path.resolve(override), clear: async () => undefined }
    : await prepareCodexCliBeforeAuthRead({ approvedAgent: approved });
  try {
    const bytes = await readFile(prepared.binaryPath);
    assertApprovedReviewAgentBinary(approved, bytes);
    const version = await promisify(execFile)(
      prepared.binaryPath,
      ['--version'],
      {
        env: { PATH: process.env.PATH, HOME: out, CODEX_HOME: out },
        timeout: 10000,
      }
    );
    assertApprovedReviewAgentVersion(
      approved,
      version.stdout.trim().replace(/^codex-cli /, '')
    );
    const scenarios: ScenarioReceipt[] = [];
    for (const mode of ['exec', 'app-server']) {
      assert(mode === 'exec' || mode === 'app-server');
      scenarios.push(await scenario(prepared.binaryPath, out, mode));
    }
    const receipt = {
      boundary:
        'actual pinned native Codex; loopback synthetic Responses/MCP only; no live provider or production credentials',
      binarySha256: createHash('sha256').update(bytes).digest('hex'),
      packageVersion: approved.packageVersion,
      scenarios,
    };
    await writeFile(
      path.join(out, 'receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { mode: 0o600 }
    );
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } finally {
    await prepared.clear?.();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.message : 'native_qualification_failed') +
      '\n'
  );
  process.exitCode = 1;
});
