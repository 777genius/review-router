import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  approvedEndpoint,
  ContextToolsServer,
  contextToolsError,
} from './contract';

/** Conservative public-unicast policy, including transition/documentation ranges. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 0 || b === 168 || b === 2 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%'))
    return false;
  // Expand compressed words before testing prefixes (2001::/23 must not bypass the policy).
  const parts = address.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const words = [
    ...head,
    ...Array(8 - head.length - tail.length).fill('0'),
    ...tail,
  ].map((word) => parseInt(word, 16));
  const [first, second] = words;
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    first !== 0x2002 &&
    first !== 0x3fff &&
    !(first === 0x2001 && (second < 0x0200 || second === 0x0db8))
  );
}

/** Node HTTPS owns DNS and sockets: no proxy env, redirects, OAuth or default fetch dial. */
export function createPinnedHttpsFetch(input: {
  endpoint: string;
  responseBytes: number;
  timeoutMs: number;
}): typeof fetch {
  const endpoint = approvedEndpoint(input.endpoint);
  return async (resource, init) => {
    const url = new URL(
      resource instanceof Request ? resource.url : String(resource)
    );
    if (url.href !== endpoint.href)
      throw contextToolsError('destination_changed');
    if (init?.signal?.aborted) throw contextToolsError('aborted');
    const began = Date.now();
    const addresses = isIP(url.hostname)
      ? [{ address: url.hostname, family: isIP(url.hostname) }]
      : await boundedLookup(url.hostname, input.timeoutMs);
    if (
      !addresses.length ||
      addresses.some((item) => !isPublicAddress(item.address))
    )
      throw contextToolsError('address_forbidden');
    if (init?.signal?.aborted) throw contextToolsError('aborted');
    if (Date.now() - began >= input.timeoutMs)
      throw contextToolsError('deadline');
    const address = addresses.find((item) => item.family === 4) ?? addresses[0];
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== 'string')
      throw contextToolsError('request_invalid');
    if (
      typeof body === 'string' &&
      Buffer.byteLength(body) > input.responseBytes
    )
      throw contextToolsError('request_too_large');
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (code: string): void => {
        if (!settled) {
          settled = true;
          reject(contextToolsError(code));
        }
      };
      const req = request(
        url,
        {
          method: init?.method ?? 'GET',
          headers,
          agent: false,
          family: address.family,
          servername: isIP(url.hostname) ? undefined : url.hostname,
          rejectUnauthorized: true,
          lookup: (_hostname, _options, callback) =>
            callback(null, address.address, address.family),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 599) {
            res.destroy();
            fail('response_invalid');
            return;
          }
          if (status >= 300 && status < 400) {
            res.destroy();
            fail('redirect_forbidden');
            return;
          }
          if (status === 401 || status === 403) {
            res.destroy();
            fail('remote_auth_unavailable');
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > input.responseBytes) {
              res.destroy();
              fail('response_too_large');
            } else chunks.push(chunk);
          });
          res.on('error', () => fail('response_failed'));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const responseHeaders = new Headers();
            for (const name of [
              'content-type',
              'mcp-session-id',
              'mcp-protocol-version',
            ]) {
              const value = res.headers[name];
              if (
                typeof value === 'string' &&
                /^[\x20-\x7e]{1,1024}$/.test(value)
              )
                responseHeaders.set(name, value);
            }
            resolve(
              new Response(
                status === 204 || status === 205 || status === 304
                  ? null
                  : Buffer.concat(chunks),
                { status, headers: responseHeaders }
              )
            );
          });
        }
      );
      const deadline = setTimeout(
        () => {
          fail('deadline');
          req.destroy();
        },
        Math.max(1, input.timeoutMs - (Date.now() - began))
      );
      deadline.unref();
      const abort = (): void => {
        fail('aborted');
        req.destroy();
      };
      init?.signal?.addEventListener('abort', abort, { once: true });
      req.on('socket', (socket) => {
        (socket as TLSSocket).once('secureConnect', () => {
          const actual = socket.remoteAddress?.replace(/^::ffff:/, '');
          if (
            !actual ||
            normalizeAddress(actual) !== normalizeAddress(address.address)
          ) {
            fail('destination_changed');
            req.destroy();
          }
        });
      });
      req.on('error', () => fail('request_failed'));
      req.on('close', () => {
        clearTimeout(deadline);
        init?.signal?.removeEventListener('abort', abort);
      });
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      req.end(body);
    });
  };
}

export type RemoteContextTools = Readonly<{
  tools: readonly Tool[];
  call: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<CallToolResult>;
  close: () => Promise<void>;
}>;
export async function connectHttpsContextTools(input: {
  server: ContextToolsServer;
  headers: Readonly<Record<string, string>>;
  responseBytes: number;
  timeoutMs: number;
  callTimeoutMs: number;
}): Promise<RemoteContextTools> {
  const client = new Client(
    { name: 'reviewrouter-context', version: '1' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(
    approvedEndpoint(input.server.url),
    {
      requestInit: { headers: input.headers },
      fetch: createPinnedHttpsFetch({
        endpoint: input.server.url,
        responseBytes: input.responseBytes,
        timeoutMs: input.callTimeoutMs,
      }),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    }
  );
  const startupDeadline = Date.now() + input.timeoutMs;
  let startupTimer: NodeJS.Timeout | undefined;
  try {
    const discovery = await Promise.race([
      (async () => {
        await client.connect(transport, {
          timeout: Math.max(1, startupDeadline - Date.now()),
        });
        if (Date.now() >= startupDeadline) throw contextToolsError('deadline');
        return await client.request(
          { method: 'tools/list', params: {} },
          ListToolsResultSchema,
          { timeout: startupDeadline - Date.now() }
        );
      })(),
      new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(
          () => reject(contextToolsError('deadline')),
          input.timeoutMs
        );
      }),
    ]);
    if (startupTimer) clearTimeout(startupTimer);
    if (
      discovery.nextCursor ||
      discovery.tools.length > 100 ||
      Buffer.byteLength(JSON.stringify(discovery)) > input.responseBytes
    )
      throw contextToolsError('discovery_invalid');
    const tools = input.server.tools.map((name) => {
      const matches = discovery.tools.filter((tool) => tool.name === name);
      if (
        matches.length !== 1 ||
        Buffer.byteLength(JSON.stringify(matches[0].inputSchema)) > 65536 ||
        (matches[0].description?.length ?? 0) > 8192 ||
        matches[0].execution?.taskSupport === 'required'
      )
        throw contextToolsError('tool_unavailable');
      // Explicit selection is authority; remote readOnlyHint is never treated as permission.
      return matches[0];
    });
    return {
      tools,
      call: async (name, args) => {
        if (!input.server.tools.includes(name))
          throw contextToolsError('tool_forbidden');
        let result: CallToolResult;
        try {
          // Low-level SDK request validates the MCP envelope without executing untrusted JSON-schema regexes.
          result = await client.request(
            { method: 'tools/call', params: { name, arguments: args } },
            CallToolResultSchema,
            { timeout: input.callTimeoutMs }
          );
        } catch (error) {
          if (
            error instanceof McpError &&
            error.code === ErrorCode.InvalidParams
          )
            throw contextToolsError('arguments_invalid');
          throw contextToolsError('tool_unavailable');
        }
        if (Buffer.byteLength(JSON.stringify(result)) > input.responseBytes)
          throw contextToolsError('response_too_large');
        return result as CallToolResult;
      },
      close: () => client.close(),
    };
  } catch {
    if (startupTimer) clearTimeout(startupTimer);
    await client.close().catch(() => undefined);
    throw contextToolsError('remote_unavailable');
  }
}

async function boundedLookup(
  hostname: string,
  timeoutMs: number
): Promise<{ address: string; family: number }[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(contextToolsError('deadline')),
          timeoutMs
        );
      }),
    ]);
  } catch {
    throw contextToolsError('dns_failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeAddress(value: string): string {
  if (isIP(value) === 4) return value;
  try {
    return new URL(`http://[${value}]/`).hostname;
  } catch {
    return '';
  }
}
