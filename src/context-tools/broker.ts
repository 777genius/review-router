import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  canonicalJson,
  sha256,
} from '../context-gateway/context-gateway-contract';
import {
  ContextToolsPlan,
  ContextToolsError,
  contextToolsError,
  record,
} from './contract';
import { bindContextToolCredentials } from './credential-bindings';
import {
  connectHttpsContextTools,
  type RemoteContextTools,
} from './https-mcp-client';

export type ContextTool = Readonly<{
  definition: Tool;
  validateArguments?: (args: Record<string, unknown>) => boolean;
  call: (args: Record<string, unknown>) => Promise<CallToolResult>;
}>;
export type ContextToolsReceipt = Readonly<{
  planDigest: string;
  schemaDigest: string;
  availableTools: readonly string[];
  nativeConnected: boolean;
  calls: number;
  hadFailure: boolean;
}>;
export type ContextToolsBroker = Readonly<{
  config: Readonly<{
    url: string;
    capability: string;
    tools: readonly string[];
  }>;
  receipt: () => ContextToolsReceipt;
  beginNativeSession: () => void;
  close: () => Promise<void>;
}>;

/** The caller supplies only immutable repository reads and the scoped SaaS issue read port. */
export async function startContextToolsBroker(input: {
  plan: ContextToolsPlan;
  githubJson?: string;
  dashboardSecrets?: Readonly<Record<string, string>>;
  mask: (value: string) => void;
  builtins: Partial<
    Record<ContextToolsPlan['builtinTools'][number], ContextTool>
  >;
  deadlineMs: number;
}): Promise<ContextToolsBroker> {
  const credentials = bindContextToolCredentials(input);
  const remotes: RemoteContextTools[] = [];
  const bindings = new Map<string, ContextTool>();
  const add = (name: string, tool: ContextTool): void => {
    if (bindings.has(name)) throw contextToolsError('tool_collision');
    bindings.set(name, {
      ...tool,
      definition: { ...tool.definition, name },
      call: async (args) => {
        const result = await tool.call(args);
        return {
          content: result.content.map((block) =>
            block.type === 'text'
              ? {
                  type: 'text' as const,
                  text: credentials.redact(block.text) as string,
                }
              : {
                  type: 'text' as const,
                  text: JSON.stringify(credentials.redact(block)),
                }
          ),
          ...(result.isError === true ? { isError: true } : {}),
          ...(result.structuredContent
            ? {
                structuredContent: credentials.redact(
                  result.structuredContent
                ) as Record<string, unknown>,
              }
            : {}),
        };
      },
    });
  };
  const startupDeadline = Math.min(
    input.deadlineMs,
    Date.now() + input.plan.limits.startupTimeoutMs
  );
  try {
    for (const name of input.plan.builtinTools) {
      const builtin = input.builtins[name];
      if (!builtin) throw contextToolsError('builtin_unavailable');
      add(`rr_${name.replace(/\./g, '_')}`, builtin);
    }
    for (const server of input.plan.servers) {
      const remaining = startupDeadline - Date.now();
      if (remaining <= 0) throw contextToolsError('deadline');
      const remote = await connectHttpsContextTools({
        server,
        headers: credentials.headersFor(server),
        responseBytes: input.plan.limits.responseBytes,
        timeoutMs: remaining,
        callTimeoutMs: input.plan.limits.callTimeoutMs,
      });
      remotes.push(remote);
      for (const definition of remote.tools) {
        const fullName = `rr_mcp_${server.id}_${definition.name.replace(/[.-]/g, '_')}`;
        const name =
          fullName.length <= 64
            ? fullName
            : `${fullName.slice(0, 48)}_${sha256(fullName).slice(0, 15)}`;
        add(name, {
          definition: credentials.redact(definition) as Tool,
          call: (args) => remote.call(definition.name, args),
        });
      }
    }
    if (!bindings.size) throw contextToolsError('no_available_tools');
    return await serveContextTools({
      plan: input.plan,
      bindings,
      deadlineMs: input.deadlineMs,
      closeRemotes: async () => {
        await Promise.all(remotes.map((remote) => remote.close()));
      },
    });
  } catch {
    await Promise.allSettled(remotes.map((remote) => remote.close()));
    throw contextToolsError('selected_tools_unavailable');
  }
}

async function serveContextTools(input: {
  plan: ContextToolsPlan;
  bindings: ReadonlyMap<string, ContextTool>;
  deadlineMs: number;
  closeRemotes: () => Promise<void>;
}): Promise<ContextToolsBroker> {
  const capability = randomBytes(32).toString('hex');
  const definitions = [...input.bindings.values()].map(
    (tool) => tool.definition
  );
  const schemaDigest = `sha256:${sha256(canonicalJson(definitions))}`;
  const cache = new Map<string, Promise<CallToolResult>>();
  let calls = 0;
  let hadFailure = false;
  let nativeConnected = false;
  let host = '';
  let closed = false;
  const transports = new Set<StreamableHTTPServerTransport>();
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      hadFailure = true;
      if (!res.headersSent) {
        res.writeHead(400);
        res.end();
      } else res.destroy();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  server.maxConnections = 8;
  async function handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${capability}`;
    if (
      closed ||
      req.url !== '/mcp' ||
      req.headers.host !== host ||
      (req.headers.origin !== undefined &&
        req.headers.origin !== `http://${host}`) ||
      auth.length !== expected.length ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (
      req.headers['content-encoding'] !== undefined ||
      !req.headers['content-type']?.startsWith('application/json')
    ) {
      res.writeHead(415);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 131072) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!record(body) || Date.now() >= input.deadlineMs) {
      res.writeHead(400);
      res.end();
      return;
    }
    const sdk = new Server(
      { name: 'reviewrouter-context', version: '1' },
      { capabilities: { tools: {} } }
    );
    sdk.setRequestHandler(ListToolsRequestSchema, async () => {
      nativeConnected = true;
      return { tools: definitions };
    });
    sdk.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (hadFailure) throw contextToolsError('tool_unavailable');
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const binding = input.bindings.get(name);
      if (
        !binding ||
        !boundedArguments(args) ||
        (binding.validateArguments && !binding.validateArguments(args))
      )
        throw contextToolsError('arguments_invalid');
      const key = sha256(canonicalJson({ name, args }));
      const cached = cache.get(key);
      if (cached) return cached;
      if (++calls > input.plan.limits.maxCalls) {
        hadFailure = true;
        throw contextToolsError('call_limit');
      }
      // Retain rejected calls too: a failed response may have been dispatched; never blindly replay.
      const pending = (async () => {
        const timeoutMs = Math.min(
          input.plan.limits.callTimeoutMs,
          input.deadlineMs - Date.now()
        );
        if (timeoutMs <= 0) throw contextToolsError('deadline');
        let timer: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([
            binding.call(args),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(contextToolsError('deadline')),
                timeoutMs
              );
            }),
          ]);
          if (
            Buffer.byteLength(JSON.stringify(result)) >
            input.plan.limits.responseBytes
          )
            throw contextToolsError('response_too_large');
          return result;
        } catch (error) {
          if (
            error instanceof ContextToolsError &&
            (error.code === 'scope_denied' ||
              error.code === 'arguments_invalid')
          )
            throw error;
          hadFailure = true;
          throw contextToolsError('tool_unavailable');
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      cache.set(key, pending);
      return pending;
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transports.add(transport);
    res.once('close', () => {
      transports.delete(transport);
      void sdk.close().catch(() => undefined);
    });
    await sdk.connect(transport);
    await transport.handleRequest(req, res, body);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw contextToolsError('listen_failed');
  host = `127.0.0.1:${address.port}`;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    nativeConnected = false;
    clearTimeout(expiry);
    await Promise.allSettled(
      [...transports].map((transport) => transport.close())
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await input.closeRemotes();
    cache.clear();
  };
  const expiry = setTimeout(
    () => {
      void close().catch(() => undefined);
    },
    Math.max(1, input.deadlineMs - Date.now())
  );
  expiry.unref();
  return {
    config: {
      url: `http://${host}/mcp`,
      capability,
      tools: [...input.bindings.keys()],
    },
    beginNativeSession: () => {
      nativeConnected = false;
    },
    receipt: () => ({
      planDigest: input.plan.planDigest,
      schemaDigest,
      availableTools: [...input.bindings.keys()],
      nativeConnected,
      calls,
      hadFailure,
    }),
    close,
  };
}

// Untrusted remote schemas remain metadata: never compile/evaluate their patterns in the parent.
function boundedArguments(args: Record<string, unknown>): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: args, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 2048 || item.depth > 16) return false;
    if (typeof item.value === 'string' && Buffer.byteLength(item.value) > 65536)
      return false;
    if (item.value && typeof item.value === 'object') {
      const values = Object.values(item.value);
      if (values.length > 128) return false;
      for (const value of values) stack.push({ value, depth: item.depth + 1 });
    }
  }
  return true;
}
